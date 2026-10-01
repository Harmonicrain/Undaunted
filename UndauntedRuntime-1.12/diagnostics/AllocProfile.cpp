/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), September 2026.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

#include "diagnostics/AllocProfile.h"
#include "core/RuntimeState.h"
#include "core/RuntimeHooks.h"
#include "core/Logging.h"
#include "native/Addresses112.h"
#include "core/Settings.h"
#include <algorithm>
#include <cstdio>
#include <vector>

// The engine allocator (GMalloc, FMallocBinned2) is hooked at its Malloc,
// Realloc and Free. Every live allocation is kept in an open-addressing table
// with its size and the id of the call stack that made it; each stack keeps
// its live byte and allocation counts. Both tables live outside the engine's
// allocator (VirtualAlloc) and are guarded by one SRWLOCK. Nested calls (a
// Realloc that mallocs) are recorded once, by the outermost hook.

namespace {
constexpr int kFrames = 10;
constexpr uint64_t kAllocSlots = 1ull << 24;
constexpr uint64_t kStackSlots = 1ull << 20;

struct FAllocSlot { uint64_t Ptr; uint32_t Size; uint32_t Stack; };
struct FStackSlot { uint64_t Hash; int64_t Bytes; int64_t Count; uint32_t Frames[kFrames]; };
constexpr uint64_t kDiagnosticBytes = kAllocSlots * sizeof(FAllocSlot) + kStackSlots * sizeof(FStackSlot);

FAllocSlot* g_Allocs = nullptr;
FStackSlot* g_Stacks = nullptr;
SRWLOCK g_Lock = SRWLOCK_INIT;
uint64_t g_LiveAllocs = 0, g_UsedStacks = 0, g_Dropped = 0;
int64_t g_LiveBytes = 0;
uintptr_t g_ImageEnd = 0;
thread_local int t_Depth = 0;

using FMallocFn = void* (*)(void*, SIZE_T, uint32_t);
using FReallocFn = void* (*)(void*, void*, SIZE_T, uint32_t);
using FFreeFn = void (*)(void*, void*);
FMallocFn OrigMalloc = nullptr;
FReallocFn OrigRealloc = nullptr;
FFreeFn OrigFree = nullptr;

uint64_t AllocIndex(uint64_t Ptr) { return ((Ptr >> 4) * 0x9E3779B97F4A7C15ull) >> (64 - 24); }

uint32_t StackId(uint64_t Hash, const uint32_t* Frames) {
    uint64_t Index = Hash & (kStackSlots - 1);
    for (uint64_t Probe = 0; Probe < kStackSlots; ++Probe, Index = (Index + 1) & (kStackSlots - 1)) {
        FStackSlot& Slot = g_Stacks[Index];
        if (Slot.Hash == Hash) return static_cast<uint32_t>(Index);
        if (Slot.Hash == 0) {
            Slot.Hash = Hash;
            memcpy(Slot.Frames, Frames, sizeof(Slot.Frames));
            ++g_UsedStacks;
            return static_cast<uint32_t>(Index);
        }
    }
    return UINT32_MAX;
}

// Linear probing with backward-shift deletion (no tombstones).
void ForgetLocked(uint64_t Ptr) {
    uint64_t Index = AllocIndex(Ptr);
    for (;;) {
        FAllocSlot& Slot = g_Allocs[Index];
        if (Slot.Ptr == 0) return;
        if (Slot.Ptr == Ptr) break;
        Index = (Index + 1) & (kAllocSlots - 1);
    }
    FStackSlot& Stack = g_Stacks[g_Allocs[Index].Stack];
    Stack.Bytes -= g_Allocs[Index].Size; --Stack.Count;
    g_LiveBytes -= g_Allocs[Index].Size; --g_LiveAllocs;
    uint64_t Hole = Index;
    for (uint64_t Next = (Hole + 1) & (kAllocSlots - 1);; Next = (Next + 1) & (kAllocSlots - 1)) {
        if (g_Allocs[Next].Ptr == 0) break;
        const uint64_t Home = AllocIndex(g_Allocs[Next].Ptr);
        // Move Next into the hole unless its home lies cyclically in (Hole, Next].
        const bool HomeBetween = Hole <= Next ? (Home > Hole && Home <= Next) : (Home > Hole || Home <= Next);
        if (!HomeBetween) { g_Allocs[Hole] = g_Allocs[Next]; Hole = Next; }
    }
    g_Allocs[Hole] = {};
}

void Record(void* Ptr, SIZE_T Size) {
    void* Raw[kFrames];
    const USHORT Got = RtlCaptureStackBackTrace(2, kFrames, Raw, nullptr);
    uint32_t Frames[kFrames] = {};
    uint64_t Hash = 1469598103934665603ull;
    for (int i = 0; i < kFrames; ++i) {
        const uintptr_t Address = i < Got ? reinterpret_cast<uintptr_t>(Raw[i]) : 0;
        Frames[i] = (Address >= Globals::BaseAddress && Address < g_ImageEnd) ? static_cast<uint32_t>(Address - Globals::BaseAddress)
                  : Address ? 0xFFFFFFFFu : 0u;
        Hash = (Hash ^ Frames[i]) * 1099511628211ull;
    }
    if (Hash == 0) Hash = 1;
    const uint32_t Size32 = Size > UINT32_MAX ? UINT32_MAX : static_cast<uint32_t>(Size);
    const uint64_t Key = reinterpret_cast<uint64_t>(Ptr);
    AcquireSRWLockExclusive(&g_Lock);
    ForgetLocked(Key);
    const uint32_t Id = StackId(Hash, Frames);
    if (Id == UINT32_MAX || g_LiveAllocs >= kAllocSlots * 3 / 4) {
        ++g_Dropped;
    } else {
        uint64_t Index = AllocIndex(Key);
        while (g_Allocs[Index].Ptr != 0) Index = (Index + 1) & (kAllocSlots - 1);
        g_Allocs[Index] = { Key, Size32, Id };
        g_Stacks[Id].Bytes += Size32; ++g_Stacks[Id].Count;
        g_LiveBytes += Size32; ++g_LiveAllocs;
    }
    ReleaseSRWLockExclusive(&g_Lock);
}

void Forget(void* Ptr) {
    AcquireSRWLockExclusive(&g_Lock);
    ForgetLocked(reinterpret_cast<uint64_t>(Ptr));
    ReleaseSRWLockExclusive(&g_Lock);
}

void* MallocHook(void* Self, SIZE_T Count, uint32_t Alignment) {
    ++t_Depth;
    void* Result = OrigMalloc(Self, Count, Alignment);
    if (--t_Depth == 0 && Result) Record(Result, Count);
    return Result;
}

void* ReallocHook(void* Self, void* Original, SIZE_T Count, uint32_t Alignment) {
    if (t_Depth == 0 && Original) Forget(Original);
    ++t_Depth;
    void* Result = OrigRealloc(Self, Original, Count, Alignment);
    if (--t_Depth == 0 && Result && Count) Record(Result, Count);
    return Result;
}

void FreeHook(void* Self, void* Original) {
    if (t_Depth == 0 && Original) Forget(Original);
    ++t_Depth;
    OrigFree(Self, Original);
    --t_Depth;
}

void WriteProfile() {
    struct FRow { int64_t Bytes, Count; uint32_t Frames[kFrames]; };
    std::vector<FRow> Rows;
    int64_t LiveBytes; uint64_t LiveAllocs, UsedStacks, Dropped;
    AcquireSRWLockShared(&g_Lock);
    LiveBytes = g_LiveBytes; LiveAllocs = g_LiveAllocs; UsedStacks = g_UsedStacks; Dropped = g_Dropped;
    for (uint64_t i = 0; i < kStackSlots; ++i) {
        const FStackSlot& Slot = g_Stacks[i];
        if (Slot.Hash && Slot.Bytes >= 16384) {
            FRow Row{ Slot.Bytes, Slot.Count };
            memcpy(Row.Frames, Slot.Frames, sizeof(Row.Frames));
            Rows.push_back(Row);
        }
    }
    ReleaseSRWLockShared(&g_Lock);
    std::sort(Rows.begin(), Rows.end(), [](const FRow& A, const FRow& B) { return A.Bytes > B.Bytes; });

    char Path[MAX_PATH]{};
    GetModuleFileNameA(nullptr, Path, MAX_PATH);
    if (char* Slash = strrchr(Path, '\\')) sprintf_s(Slash + 1, MAX_PATH - (Slash + 1 - Path), "allocprofile-%lu.tsv", GetCurrentProcessId());
    char Temp[MAX_PATH + 8];
    sprintf_s(Temp, "%s.tmp", Path);
    FILE* File = nullptr;
    if (fopen_s(&File, Temp, "w") != 0 || !File) return;
    fprintf(File, "# live %lld bytes in %llu allocations, %llu stacks, %llu dropped\n",
        static_cast<long long>(LiveBytes), static_cast<unsigned long long>(LiveAllocs),
        static_cast<unsigned long long>(UsedStacks), static_cast<unsigned long long>(Dropped));
    fprintf(File, "# diagnostic tables %llu bytes, outside tracked engine allocations; included in process private commit\n",
        static_cast<unsigned long long>(kDiagnosticBytes));
    for (const FRow& Row : Rows) {
        fprintf(File, "%lld\t%lld", static_cast<long long>(Row.Bytes), static_cast<long long>(Row.Count));
        for (uint32_t Frame : Row.Frames) fprintf(File, "\t%x", Frame);
        fputc('\n', File);
    }
    fclose(File);
    MoveFileExA(Temp, Path, MOVEFILE_REPLACE_EXISTING);
    char Line[160];
    sprintf_s(Line, "[AllocProfile] %.1f MB live in %llu allocations, %llu stacks (%zu written)",
        LiveBytes / 1048576.0, static_cast<unsigned long long>(LiveAllocs), static_cast<unsigned long long>(UsedStacks), Rows.size());
    MpLog(Line);
}

int ProfileSeconds() {
    return Settings::Int(L"AllocProfile", 0, 5, 3600, 60);
}

DWORD WINAPI ProfileThread(LPVOID) {
    void* volatile* Slot = reinterpret_cast<void* volatile*>(Native112::At(Globals::BaseAddress, Native112::GMalloc));
    void* Malloc = nullptr;
    for (int Waited = 0; Waited < 30000 && !(Malloc = *Slot); ++Waited) Sleep(1);
    if (!Malloc) { MpLog("[AllocProfile] GMalloc never appeared"); return 0; }
    const uintptr_t* VTable = *reinterpret_cast<uintptr_t* const*>(Malloc);
    const uintptr_t Base = Globals::BaseAddress;
    if (VTable[2] != Base + Native112::MallocBinned2Malloc || VTable[4] != Base + Native112::MallocBinned2Realloc
        || VTable[6] != Base + Native112::MallocBinned2Free) {
        MpLog("[AllocProfile] GMalloc is not the expected FMallocBinned2; not profiling");
        return 0;
    }
    RUNTIME_CREATE_HOOK(reinterpret_cast<void*>(VTable[2]), MallocHook, &OrigMalloc);
    RUNTIME_CREATE_HOOK(reinterpret_cast<void*>(VTable[4]), ReallocHook, &OrigRealloc);
    RUNTIME_CREATE_HOOK(reinterpret_cast<void*>(VTable[6]), FreeHook, &OrigFree);
    const MH_STATUS Enable = RuntimeHooks::Enable(reinterpret_cast<void*>(VTable[2]));
    RuntimeHooks::Enable(reinterpret_cast<void*>(VTable[4]));
    RuntimeHooks::Enable(reinterpret_cast<void*>(VTable[6]));
    MpLog(std::string("[AllocProfile] hooked GMalloc: ") + MH_StatusToString(Enable));
    const int Seconds = ProfileSeconds();
    for (;;) { Sleep(Seconds * 1000); WriteProfile(); }
}
}

void StartAllocProfile() {
    if (!Globals::AmServer || ProfileSeconds() == 0) return;
    auto* Dos = reinterpret_cast<IMAGE_DOS_HEADER*>(Globals::BaseAddress);
    auto* Nt = reinterpret_cast<IMAGE_NT_HEADERS64*>(Globals::BaseAddress + Dos->e_lfanew);
    g_ImageEnd = Globals::BaseAddress + Nt->OptionalHeader.SizeOfImage;
    g_Allocs = static_cast<FAllocSlot*>(VirtualAlloc(nullptr, kAllocSlots * sizeof(FAllocSlot), MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE));
    g_Stacks = static_cast<FStackSlot*>(VirtualAlloc(nullptr, kStackSlots * sizeof(FStackSlot), MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE));
    if (!g_Allocs || !g_Stacks) { MpLog("[AllocProfile] could not reserve its tables"); return; }
    char Line[192];
    sprintf_s(Line, "[AllocProfile] diagnostic tables commit %.1f MiB outside tracked engine allocations; compare memory with profiling disabled",
        kDiagnosticBytes / 1048576.0);
    MpLog(Line);
    if (HANDLE Thread = CreateThread(nullptr, 0, ProfileThread, nullptr, 0, nullptr)) CloseHandle(Thread);
}
