/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), September 2026.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

#include "server/RenderData.h"
#include "core/RuntimeState.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "core/RuntimeHooks.h"
#include "native/Addresses112.h"
#include "native/Layouts112.h"
#include <unordered_map>
#include <unordered_set>

// World servers run the client executable with -nullrhi. A client uploads mesh
// vertex and index data to the GPU and frees its CPU copy; with the null
// renderer nothing is uploaded, so every loaded mesh kept its CPU copy. On an
// empty Ramsgate (measured 2026-09-30) static and skeletal meshes were ~480 MB
// of the ~860 MB of loaded content. A dedicated-server cook would have
// stripped it; this client cook can't be changed, so it is freed after load.
//
// Each loaded static and skeletal mesh's render resource arrays get their own
// Discard(), the call the null renderer makes when it creates a buffer. It
// keeps anything the engine flagged as needed on the CPU. The arrays are found
// by their vtables' code rather than by struct offsets: in this build every
// TResourceArray's slot 4 (Discard) starts "cmp byte ptr [rcx+18h],0", slot 5
// (IsStatic) is "xor al,al; ret" and slot 6 (GetAllowCPUAccess) is
// "movzx eax, byte ptr [rcx+18h]; ret". Slot 3 is GetResourceDataSize.
//
// Textures are the same story: a client uploads a texture's resident mips and
// frees them; here they stayed (~155 MB on the same Ramsgate, mostly UI and
// engine textures, a 32 MB bloom kernel among them). Each mip's bulk data is
// freed through the engine's allocator and its pointer cleared, which is what
// the bulk data does itself when a single-use payload has been consumed.
// Memory-mapped payloads and ones with a read in flight are left alone. Cube
// maps get the same treatment (17 MB on Ramsgate, a 512x512 sky among them).
//
// An allocation profile of Ramsgate (diagnostics/AllocProfile, 2026-09-30)
// found three more rendering-only stores: static meshes' distance fields
// (105 MB), skeletal render sections' duplicated-vertex buffers for the GPU
// skin cache (29 MB) and morph targets' vertex deltas (30 MB). They're
// emptied too.
//
// Skeletal meshes flag every buffer as needed on the CPU while
// r.FreeSkeletalMeshBuffers is 0, its default, which keeps them for mesh
// merging (~150 MB on an empty Ramsgate, ~12 MB more per player). None of the
// 184 skeletal meshes on an empty Ramsgate asked for CPU data themselves (no
// CPU-access LODs, sampling regions or per-poly collision), and this build has
// no mesh-merging API. The variable can't be set from the command line in a
// shipping build, so it is set to 1 as soon as the executable registers it,
// before any mesh loads; the engine then keeps CPU copies only for meshes that
// need them, and the Discard() pass above frees the rest.
//   -UndauntedKeepRenderData  turns all of this off.
//
// The WebBrowserWidget plugin's startup creates the web browser singleton,
// which initialises Chromium and starts UnrealCEFSubProcess.exe even with
// -nocef. A world server shows no web pages; on an empty Ramsgate (2026-09-30)
// the helper process held 119 MB private and Chromium ~10 MB inside the world.
// With that startup skipped nothing else asked for the singleton, so the
// server runs without Chromium.
//   -UndauntedKeepWebBrowser  leaves it alone.

namespace {
using namespace Native112::RenderDataLayout;

struct FReleaseStats { uint64_t Meshes = 0, Arrays = 0, Kept = 0, Bytes = 0, KeptBytes = 0, Faults = 0; };

uintptr_t ImageEnd() {
    static uintptr_t End = 0;
    if (End == 0) {
        auto* Dos = reinterpret_cast<IMAGE_DOS_HEADER*>(Globals::BaseAddress);
        auto* Nt = reinterpret_cast<IMAGE_NT_HEADERS64*>(Globals::BaseAddress + Dos->e_lfanew);
        End = Globals::BaseAddress + Nt->OptionalHeader.SizeOfImage;
    }
    return End;
}

bool InImage(uintptr_t Address) { return Address >= Globals::BaseAddress && Address < ImageEnd(); }

bool CodeStartsWith(uintptr_t Function, const unsigned char* Bytes, size_t Count) {
    return InImage(Function) && IsReadablePointer(reinterpret_cast<void*>(Function & ~uintptr_t(7)), 16)
        && memcmp(reinterpret_cast<const void*>(Function), Bytes, Count) == 0;
}

bool IsResourceArrayVTable(uintptr_t VTable) {
    static std::unordered_map<uintptr_t, bool> Known;
    if (!InImage(VTable) || (VTable & 7) != 0) return false;
    const auto Found = Known.find(VTable);
    if (Found != Known.end()) return Found->second;
    static const unsigned char Discard[] = { 0x80, 0x79, 0x18, 0x00 };
    static const unsigned char IsStatic[] = { 0x32, 0xC0, 0xC3 };
    static const unsigned char AllowCpu[] = { 0x0F, 0xB6, 0x41, 0x18, 0xC3 };
    bool Match = false;
    if (IsReadablePointer(reinterpret_cast<void*>(VTable), 7 * sizeof(uintptr_t))) {
        const uintptr_t* Slots = reinterpret_cast<const uintptr_t*>(VTable);
        Match = CodeStartsWith(Slots[4], Discard, sizeof(Discard))
            && CodeStartsWith(Slots[5], IsStatic, sizeof(IsStatic))
            && CodeStartsWith(Slots[6], AllowCpu, sizeof(AllowCpu));
    }
    Known.emplace(VTable, Match);
    return Match;
}

bool IsHeapPointer(uintptr_t Value, size_t Bytes) {
    return Value > 0x10000 && (Value & 7) == 0 && !InImage(Value)
        && IsReadablePointer(reinterpret_cast<void*>(Value), Bytes);
}

// The resource arrays inside one LOD struct, and one pointer level below it
// (vertex data lives in separately allocated objects).
void CollectResourceArrays(uintptr_t Lod, std::unordered_set<uintptr_t>& Arrays) {
    for (size_t Offset = 0; Offset < LodScanBytes; Offset += sizeof(uintptr_t)) {
        const uintptr_t Word = *reinterpret_cast<const uintptr_t*>(Lod + Offset);
        if (IsResourceArrayVTable(Word)) { Arrays.insert(Lod + Offset); continue; }
        if (!IsHeapPointer(Word, PointeeScanBytes)) continue;
        for (size_t Inner = 0; Inner < PointeeScanBytes; Inner += sizeof(uintptr_t)) {
            if (IsResourceArrayVTable(*reinterpret_cast<const uintptr_t*>(Word + Inner))) Arrays.insert(Word + Inner);
        }
    }
}

// Frees a plain TArray (data, num, max) through the engine's allocator and
// leaves it empty. Returns the bytes it held.
uint64_t FreeEngineArray(uintptr_t ArrayAddress, size_t ElementSize) {
    void** Data = reinterpret_cast<void**>(ArrayAddress);
    int32_t* Num = reinterpret_cast<int32_t*>(ArrayAddress + 8);
    int32_t* Max = reinterpret_cast<int32_t*>(ArrayAddress + 12);
    if (!*Data || *Num < 0 || *Max <= 0 || *Max < *Num || !IsHeapPointer(reinterpret_cast<uintptr_t>(*Data), 8)) return 0;
    const uint64_t Bytes = static_cast<uint64_t>(*Max) * ElementSize;
    void* Payload = *Data;
    *Data = nullptr; *Num = 0; *Max = 0;
    EngineRealloc(Payload, 0);
    return Bytes;
}

// A static mesh LOD's distance field (its compressed volume) only feeds
// distance-field lighting and shadows.
void ReleaseDistanceField(uintptr_t Lod, FReleaseStats& Stats) {
    const uintptr_t Field = *reinterpret_cast<const uintptr_t*>(Lod + StaticLodDistanceField);
    if (!IsHeapPointer(Field, DistanceFieldVolume + 16)
        || *reinterpret_cast<const uintptr_t*>(Field) != Native112::At(Globals::BaseAddress, Native112::DistanceFieldVolumeDataVTable)) return;
    if (const uint64_t Bytes = FreeEngineArray(Field + DistanceFieldVolume, 1)) { ++Stats.Arrays; Stats.Bytes += Bytes; }
}

// Each skeletal render section's duplicated-vertices buffer is only read by the
// GPU skin cache (recomputed tangents). The engine always flags it as needed
// on the CPU, so its own Discard() keeps it; clear the flag, then Discard().
void ReleaseSectionDuplicates(uintptr_t Lod, FReleaseStats& Stats) {
    const uintptr_t Sections = *reinterpret_cast<const uintptr_t*>(Lod + SkeletalLodSections);
    const int32_t Count = *reinterpret_cast<const int32_t*>(Lod + SkeletalLodSections + 8);
    if (Count <= 0 || Count > 256 || !IsHeapPointer(Sections, Count * RenderSectionStride)) return;
    for (int32_t Index = 0; Index < Count; ++Index) {
        for (const size_t Offset : { SectionDupVertData, SectionDupVertIndexData }) {
            const uintptr_t Array = Sections + Index * RenderSectionStride + Offset;
            if (!IsResourceArrayVTable(*reinterpret_cast<const uintptr_t*>(Array))) continue;
            const uintptr_t* Slots = *reinterpret_cast<uintptr_t* const*>(Array);
            void* This = reinterpret_cast<void*>(Array);
            const uint32_t Size = reinterpret_cast<uint32_t(*)(void*)>(Slots[3])(This);
            if (Size == 0) continue;
            *reinterpret_cast<uint8_t*>(Array + 0x18) = 0;   // bNeedsCPUAccess, read by GetAllowCPUAccess
            reinterpret_cast<void(*)(void*)>(Slots[4])(This);
            ++Stats.Arrays; Stats.Bytes += Size;
        }
    }
}

void ReleaseMesh(SDK::UObject* Mesh, bool IsStatic, FReleaseStats& Stats) {
    const uintptr_t RenderData = *reinterpret_cast<const uintptr_t*>(reinterpret_cast<uintptr_t>(Mesh) + (IsStatic ? StaticMeshRenderData : SkeletalMeshRenderData));
    if (!IsHeapPointer(RenderData, 16)) return;
    const uintptr_t* Lods = *reinterpret_cast<uintptr_t* const*>(RenderData);
    const int32_t LodCount = *reinterpret_cast<const int32_t*>(RenderData + 8);
    if (LodCount <= 0 || LodCount > 16 || !IsHeapPointer(reinterpret_cast<uintptr_t>(Lods), LodCount * sizeof(uintptr_t))) return;
    std::unordered_set<uintptr_t> Arrays;
    for (int32_t Index = 0; Index < LodCount; ++Index) {
        if (!IsHeapPointer(Lods[Index], LodScanBytes)) continue;
        if (IsStatic) ReleaseDistanceField(Lods[Index], Stats);
        else ReleaseSectionDuplicates(Lods[Index], Stats);
        CollectResourceArrays(Lods[Index], Arrays);
    }
    ++Stats.Meshes;
    for (const uintptr_t Array : Arrays) {
        const uintptr_t* Slots = *reinterpret_cast<uintptr_t* const*>(Array);
        void* This = reinterpret_cast<void*>(Array);
        const uint32_t Size = reinterpret_cast<uint32_t(*)(void*)>(Slots[3])(This);
        if (reinterpret_cast<bool(*)(void*)>(Slots[6])(This)) { ++Stats.Kept; Stats.KeptBytes += Size; continue; }
        if (Size == 0) continue;
        reinterpret_cast<void(*)(void*)>(Slots[4])(This);
        ++Stats.Arrays; Stats.Bytes += Size;
    }
}

bool ReleaseMeshGuarded(SDK::UObject* Mesh, bool IsStatic, FReleaseStats& Stats) {
    __try { ReleaseMesh(Mesh, IsStatic, Stats); return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

// A morph target's vertex deltas only move rendered vertices. Animation
// activates morph targets by name and weight; with no deltas the engine treats
// one as holding no data.
void ReleaseMorphTarget(SDK::UObject* Target, FReleaseStats& Stats) {
    const uintptr_t Object = reinterpret_cast<uintptr_t>(Target);
    const uintptr_t Models = *reinterpret_cast<const uintptr_t*>(Object + MorphTargetLodModels);
    const int32_t Count = *reinterpret_cast<const int32_t*>(Object + MorphTargetLodModels + 8);
    if (Count <= 0 || Count > 16 || !IsHeapPointer(Models, Count * MorphLodModelStride)) return;
    ++Stats.Meshes;
    for (int32_t Index = 0; Index < Count; ++Index) {
        if (const uint64_t Bytes = FreeEngineArray(Models + Index * MorphLodModelStride, MorphTargetDeltaSize)) { ++Stats.Arrays; Stats.Bytes += Bytes; }
    }
}

bool ReleaseMorphTargetGuarded(SDK::UObject* Target, FReleaseStats& Stats) {
    __try { ReleaseMorphTarget(Target, Stats); return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

void ReleaseTexture(SDK::UObject* Texture, size_t PlatformDataOffset, FReleaseStats& Stats) {
    constexpr uint32_t DataIsMemoryMapped = 0x40000, HasAsyncReadPending = 0x80000;
    const uintptr_t PlatformData = *reinterpret_cast<const uintptr_t*>(reinterpret_cast<uintptr_t>(Texture) + PlatformDataOffset);
    if (!IsHeapPointer(PlatformData, PlatformDataMips + 16)) return;
    const int32_t SizeX = *reinterpret_cast<const int32_t*>(PlatformData), SizeY = *reinterpret_cast<const int32_t*>(PlatformData + 4);
    const uintptr_t* Mips = *reinterpret_cast<uintptr_t* const*>(PlatformData + PlatformDataMips);
    const int32_t MipCount = *reinterpret_cast<const int32_t*>(PlatformData + PlatformDataMips + 8);
    if (SizeX <= 0 || SizeX > 16384 || SizeY <= 0 || SizeY > 16384 || MipCount <= 0 || MipCount > 16
        || !IsHeapPointer(reinterpret_cast<uintptr_t>(Mips), MipCount * sizeof(uintptr_t))) return;
    ++Stats.Meshes;
    for (int32_t Index = 0; Index < MipCount; ++Index) {
        const uintptr_t Mip = Mips[Index];
        if (!IsHeapPointer(Mip, MipBulkFlags + 4)) continue;
        void** Data = reinterpret_cast<void**>(Mip + MipBulkData);
        const int64_t Size = *reinterpret_cast<const int64_t*>(Mip + MipBulkSize);
        const uint32_t Flags = *reinterpret_cast<const uint32_t*>(Mip + MipBulkFlags);
        if (!*Data || Size <= 0 || Size > (256ll << 20) || (Flags & (DataIsMemoryMapped | HasAsyncReadPending)) != 0) continue;
        if (!IsHeapPointer(reinterpret_cast<uintptr_t>(*Data), 8)) continue;
        void* Payload = *Data;
        *Data = nullptr;
        EngineRealloc(Payload, 0);
        ++Stats.Arrays; Stats.Bytes += static_cast<uint64_t>(Size);
    }
}

bool ReleaseTextureGuarded(SDK::UObject* Texture, size_t PlatformDataOffset, FReleaseStats& Stats) {
    __try { ReleaseTexture(Texture, PlatformDataOffset, Stats); return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

bool KeepRenderData() {
    static const bool Keep = wcsstr(GetCommandLineW(), L"-UndauntedKeepRenderData") != nullptr;
    return Keep;
}

// DllMain runs before the executable's static initializers register console
// variables, so wait for this one; it is registered within milliseconds, long
// before the first mesh loads.
DWORD WINAPI FreeSkeletalMeshBuffersThread(LPVOID) {
    int32_t* volatile* Slot = reinterpret_cast<int32_t* volatile*>(
        Native112::At(Globals::BaseAddress, Native112::CVarFreeSkeletalMeshBuffersData));
    const uint64_t StartMs = GetTickCount64();
    while (GetTickCount64() - StartMs < 30000) {
        if (int32_t* Value = *Slot) {
            Value[0] = Value[1] = 1;
            MpLog("[RenderData] r.FreeSkeletalMeshBuffers 0 -> 1 after "
                + std::to_string(GetTickCount64() - StartMs) + " ms");
            return 0;
        }
        Sleep(1);
    }
    MpLog("[RenderData] r.FreeSkeletalMeshBuffers was never registered; skeletal meshes keep CPU copies");
    return 0;
}
}

void StartServerRenderDataOptions() {
    if (!Globals::AmServer || KeepRenderData()) return;
    if (HANDLE Thread = CreateThread(nullptr, 0, FreeSkeletalMeshBuffersThread, nullptr, 0, nullptr)) CloseHandle(Thread);
}

static void WebBrowserWidgetStartupSkip(void*) {
    MpLog("[RenderData] skipped the WebBrowserWidget module startup; no Chromium on this world server");
}

void InstallServerWebBrowserSkip() {
    if (!Globals::AmServer || wcsstr(GetCommandLineW(), L"-UndauntedKeepWebBrowser") != nullptr) return;
    void* Target = reinterpret_cast<void*>(Native112::At(Globals::BaseAddress, Native112::WebBrowserWidgetStartupModule));
    // mov rax,rsp; push rsi; sub rsp,70h; cmp qword ptr [rcx+8],0 (WebBrowserAssetMgr)
    static const unsigned char Expected[] = { 0x48, 0x8B, 0xC4, 0x56, 0x48, 0x83, 0xEC, 0x70, 0x48, 0x83, 0x79, 0x08, 0x00 };
    if (memcmp(Target, Expected, sizeof(Expected)) != 0) {
        MpLog("[RenderData] WebBrowserWidget startup has unexpected bytes; Chromium left enabled");
        return;
    }
    const MH_STATUS Create = RUNTIME_CREATE_HOOK(Target, WebBrowserWidgetStartupSkip, nullptr);
    const MH_STATUS Enable = RuntimeHooks::Enable(Target);
    MpLog(std::string("[RenderData] WebBrowserWidget startup skip create=") + MH_StatusToString(Create)
        + " enable=" + MH_StatusToString(Enable));
}

void TickServerRenderDataRelease() {
    if (!Globals::AmServer || !SDK::UObject::GObjects) return;
    static uint64_t NextMs = 0;
    const uint64_t NowMs = GetTickCount64();
    if (KeepRenderData() || NowMs < NextMs) return;
    NextMs = NowMs + 10000;

    static std::unordered_set<uint64_t> Done;
    SDK::UClass* StaticMeshClass = SDK::UStaticMesh::StaticClass();
    SDK::UClass* SkeletalMeshClass = SDK::USkeletalMesh::StaticClass();
    SDK::UClass* Texture2DClass = SDK::UTexture2D::StaticClass();
    SDK::UClass* TextureCubeClass = SDK::UTextureCube::StaticClass();
    SDK::UClass* MorphTargetClass = SDK::UMorphTarget::StaticClass();
    constexpr int32_t NotReady = 0x10 | 0x400 | 0x1000 | 0x2000 | 0x8000 | 0x10000;  // CDO, loading, post-load pending, destroying
    FReleaseStats Stats;
    const int32_t Count = SDK::UObject::GObjects->Num();
    for (int32_t Index = 0; Index < Count; ++Index) {
        SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(Index);
        if (!Obj || (static_cast<int32_t>(Obj->Flags) & NotReady) != 0) continue;
        const bool IsStatic = Obj->IsA(StaticMeshClass);
        const bool IsSkeletal = !IsStatic && Obj->IsA(SkeletalMeshClass);
        const bool IsMorph = !IsStatic && !IsSkeletal && Obj->IsA(MorphTargetClass);
        size_t TextureData = 0;
        if (!IsStatic && !IsSkeletal && !IsMorph) {
            if (Obj->IsA(Texture2DClass)) TextureData = TexturePlatformData;
            else if (Obj->IsA(TextureCubeClass)) TextureData = TextureCubePlatformData;
            else continue;
        }
        const uint64_t Key = reinterpret_cast<uintptr_t>(Obj) ^ (static_cast<uint64_t>(Obj->Index) * 0x9E3779B97F4A7C15ull);
        if (!Done.insert(Key).second) continue;
        const bool Ok = TextureData ? ReleaseTextureGuarded(Obj, TextureData, Stats)
                      : IsMorph     ? ReleaseMorphTargetGuarded(Obj, Stats)
                                    : ReleaseMeshGuarded(Obj, IsStatic, Stats);
        if (!Ok) ++Stats.Faults;
    }
    if (Stats.Meshes == 0 && Stats.Faults == 0) return;
    char Line[200];
    sprintf_s(Line, "[RenderData] freed %.1f MB in %llu arrays from %llu new assets; kept %llu CPU-access arrays (%.1f MB); %llu faulted",
        Stats.Bytes / 1048576.0, static_cast<unsigned long long>(Stats.Arrays), static_cast<unsigned long long>(Stats.Meshes),
        static_cast<unsigned long long>(Stats.Kept), Stats.KeptBytes / 1048576.0, static_cast<unsigned long long>(Stats.Faults));
    MpLog(Line);
}
