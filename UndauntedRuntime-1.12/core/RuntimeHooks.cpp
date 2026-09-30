/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Further modified in September 2026 for the Undaunted fork (Harmonicrain/Undaunted):
 * the backend address comes from the command line and requests go to the
 * Undaunted metagame over plain HTTP/WebSocket; the PlayerController
 * pre-channel guard reads ReplicateSingleActor's arguments in the executable's
 * order; the client skips the legendary-ability HUD's weapon update until a
 * weapon is equipped; the seasonal event feature flags the metagame lists are
 * forced on; world servers answer event schedule checks from the metagame's
 * seasonal event schedule; validated archive passes can be shown by the native
 * Hunt Pass selector. Not an official release of
 * Mystic Paradox or Undaunted.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "core/RuntimeHooks.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "core/Logging.h"

using PFN_D3D11CreateDevice = long (WINAPI*)(void*, unsigned int, HMODULE, unsigned int,
    const void*, unsigned int, unsigned int, void**, void*, void**);

using PFN_D3D11CreateDeviceAndSwapChain = long (WINAPI*)(void*, unsigned int, HMODULE, unsigned int,
    const void*, unsigned int, unsigned int, const void*, void**, void**, void*, void**);

using PFN_LoadLibraryExW = HMODULE (WINAPI*)(const wchar_t*, HANDLE, DWORD);

static bool MpPathHasD3D11(const wchar_t* Path);
static long WINAPI D3D11CreateDeviceHook(void* pAdapter, unsigned int DriverType, HMODULE Software,
    unsigned int Flags, const void* pFeatureLevels, unsigned int FeatureLevels, unsigned int SDKVersion,
    void** ppDevice, void* pFeatureLevel, void** ppImmediateContext);
static long WINAPI D3D11CreateDeviceAndSwapChainHook(void* pAdapter, unsigned int DriverType, HMODULE Software,
    unsigned int Flags, const void* pFeatureLevels, unsigned int FeatureLevels, unsigned int SDKVersion,
    const void* pSwapChainDesc, void** ppSwapChain, void** ppDevice, void* pFeatureLevel, void** ppImmediateContext);
static void MpTryHookD3D11(HMODULE Mod);
static HMODULE WINAPI LoadLibraryExWHook(const wchar_t* lpLibFileName, HANDLE hFile, DWORD dwFlags);

void InstallApiHook(LPCWSTR Module, LPCSTR ProcName, LPVOID Detour, LPVOID* Original, const char* Tag) {
    LPVOID Target = nullptr;
    MH_STATUS CreateStatus = MH_CreateHookApiEx(Module, ProcName, Detour, Original, &Target);
    MH_STATUS EnableStatus = CreateStatus == MH_OK ? RuntimeHooks::Enable(Target) : CreateStatus;

    MpLog("[ExitTrace] hook " + std::string(Tag)
        + " create=" + MH_StatusToString(CreateStatus)
        + " enable=" + MH_StatusToString(EnableStatus)
        + " target=" + MpPtr(Target));
}

bool MpForceWarpEnabled() {
    static const bool Enabled = MpExeRelativeFlagPresent(L"MP_FORCE_WARP.flag");
    return Enabled;
}

static bool MpPathHasD3D11(const wchar_t* Path) {
    if (!Path) { return false; }
    const wchar_t* Needle = L"d3d11";
    for (const wchar_t* P = Path; *P; ++P) {
        int i = 0;
        for (; Needle[i] && P[i]; ++i) {
            wchar_t a = P[i];
            if (a >= L'A' && a <= L'Z') { a = (wchar_t)(a + 32); }
            if (a != Needle[i]) { break; }
        }
        if (!Needle[i]) { return true; }
    }
    return false;
}

static PFN_D3D11CreateDevice OrigD3D11CreateDevice = nullptr;

static PFN_D3D11CreateDeviceAndSwapChain OrigD3D11CreateDeviceAndSwapChain = nullptr;

static volatile LONG g_D3D11Hooked = 0;

static long WINAPI D3D11CreateDeviceHook(void* pAdapter, unsigned int DriverType, HMODULE Software,
    unsigned int Flags, const void* pFeatureLevels, unsigned int FeatureLevels, unsigned int SDKVersion,
    void** ppDevice, void* pFeatureLevel, void** ppImmediateContext) {
    (void)pAdapter; (void)DriverType;

    return OrigD3D11CreateDevice(nullptr, 5, Software, Flags, pFeatureLevels, FeatureLevels,
        SDKVersion, ppDevice, pFeatureLevel, ppImmediateContext);
}

static long WINAPI D3D11CreateDeviceAndSwapChainHook(void* pAdapter, unsigned int DriverType, HMODULE Software,
    unsigned int Flags, const void* pFeatureLevels, unsigned int FeatureLevels, unsigned int SDKVersion,
    const void* pSwapChainDesc, void** ppSwapChain, void** ppDevice, void* pFeatureLevel, void** ppImmediateContext) {
    (void)pAdapter; (void)DriverType;
    return OrigD3D11CreateDeviceAndSwapChain(nullptr, 5, Software, Flags, pFeatureLevels, FeatureLevels,
        SDKVersion, pSwapChainDesc, ppSwapChain, ppDevice, pFeatureLevel, ppImmediateContext);
}

static void MpTryHookD3D11(HMODULE Mod) {
    if (!Mod) { return; }
    if (InterlockedCompareExchange(&g_D3D11Hooked, 1, 0) != 0) { return; }
    void* pCreate = reinterpret_cast<void*>(GetProcAddress(Mod, "D3D11CreateDevice"));
    void* pCreateSC = reinterpret_cast<void*>(GetProcAddress(Mod, "D3D11CreateDeviceAndSwapChain"));
    if (pCreate) {
        RUNTIME_CREATE_HOOK(pCreate, reinterpret_cast<void*>(D3D11CreateDeviceHook),
            reinterpret_cast<void**>(&OrigD3D11CreateDevice));
        RuntimeHooks::Enable(pCreate);
    }
    if (pCreateSC) {
        RUNTIME_CREATE_HOOK(pCreateSC, reinterpret_cast<void*>(D3D11CreateDeviceAndSwapChainHook),
            reinterpret_cast<void**>(&OrigD3D11CreateDeviceAndSwapChain));
        RuntimeHooks::Enable(pCreateSC);
    }
}

static PFN_LoadLibraryExW OrigLoadLibraryExW = nullptr;

static HMODULE WINAPI LoadLibraryExWHook(const wchar_t* lpLibFileName, HANDLE hFile, DWORD dwFlags) {
    HMODULE Result = OrigLoadLibraryExW(lpLibFileName, hFile, dwFlags);
    if (Result && !g_D3D11Hooked && MpPathHasD3D11(lpLibFileName)) {
        MpTryHookD3D11(Result);
    }
    return Result;
}

void InstallWarpForceHooks() {
    MpLog("[WARP] installing (MP_FORCE_WARP.flag present)");

    {
        DWORD OldProtect = 0;
        unsigned char* Site = reinterpret_cast<unsigned char*>(Native112::At(Globals::BaseAddress, Native112::Rva_032DAA1B));
        unsigned char Before = 0xFF, After = 0xFF;
        if (VirtualProtect(Site, 1, PAGE_EXECUTE_READWRITE, &OldProtect)) {
            Before = *Site;
            if (*Site == 0x75) { *Site = 0xEB; }
            After = *Site;
            VirtualProtect(Site, 1, OldProtect, &OldProtect);
        }
        MpLog(std::string("[WARP] gate patch @+0x32DAA1B before=") + MpHex(Before) + " after=" + MpHex(After)
            + ((After == 0xEB) ? " (OK)" : " (UNEXPECTED: byte!=0x75 -> DLL likely loaded AFTER engine PreInit)"));
    }

    HMODULE Kernel = GetModuleHandleW(L"kernel32.dll");
    void* pLLEW = Kernel ? reinterpret_cast<void*>(GetProcAddress(Kernel, "LoadLibraryExW")) : nullptr;
    if (pLLEW) {
        RUNTIME_CREATE_HOOK(pLLEW, reinterpret_cast<void*>(LoadLibraryExWHook),
            reinterpret_cast<void**>(&OrigLoadLibraryExW));
        RuntimeHooks::Enable(pLLEW);
    }
    HMODULE Existing = GetModuleHandleW(L"d3d11.dll");
    MpLog(std::string("[WARP] LoadLibraryExW hook=") + (pLLEW ? "on" : "FAIL")
        + " d3d11Resident=" + (Existing ? "yes(hook now)" : "no(hook on load)"));
    if (Existing) { MpTryHookD3D11(Existing); }
}

namespace RuntimeHooks {
    MH_STATUS Create(void* Target, void* Detour, void** Original, const char* Name) {
        const MH_STATUS Status = MH_CreateHook(Target, Detour, Original);
        MpLog(std::string("[Hooks] create ") + Name + " target=" + MpAddress(Target)
            + " status=" + MH_StatusToString(Status));
        return Status;
    }

    MH_STATUS Enable(void* Target) {
        const MH_STATUS Status = MH_EnableHook(Target);
        MpLog("[Hooks] enable target=" + MpAddress(Target)
            + " status=" + MH_StatusToString(Status));
        return Status;
    }
}
