/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), September 2026.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

#include "server/WorkingSet.h"
#include "core/RuntimeState.h"
#include "core/Logging.h"
#include "native/Addresses112.h"
#include <psapi.h>

// A world server loads the game's startup content and its map (~800-890 MB
// committed) but touches little of it afterwards. Measured 2026-09-30 by
// emptying a world's working set and watching what came back: an idle
// Ramsgate settled at 85 MB, Ramsgate with a player running around at
// 125-180 MB, a hunt island with a player fighting its behemoth at 160 MB.
// The engine's garbage collection touches ~55 MB more when it runs. The rest
// was only read while loading.
//
// So the world empties its working set 30 s after it starts listening (the
// render data release has run by then), 60 s after a player joins (a join
// loads that player's gear and touches much more than play does: 213 MB
// resident two minutes after a join without this trim, 125-180 MB with it)
// and whenever it has been empty for 15 s. The pages stay committed and fault
// back in on use. Trimmed pages go to
// Windows' modified list: they stay in RAM while memory is plentiful and are
// the first to go to the pagefile (or compressed memory) when it runs short,
// so a host needs pagefile for the full commit but RAM only for what the
// worlds use. Trimming with a player connected cost no visible frame time
// (worst frame 13 ms at 90 fps in town, 30 ms while a fight started).
// Periodic trimming is off by default: it would also drop the pages garbage
// collection walks every few minutes, which then come back from the pagefile
// at the next collection on a host short of memory.
//   -UndauntedTrimSeconds=<n>  also trim every n seconds (default 0, off)
//   -UndauntedKeepWorkingSet   turns trimming off

namespace {
bool KeepWorkingSet() {
    static const bool Keep = wcsstr(GetCommandLineW(), L"-UndauntedKeepWorkingSet") != nullptr;
    return Keep;
}

int TrimIntervalSeconds() {
    static const int Seconds = [] {
        const wchar_t* Key = L"-UndauntedTrimSeconds=";
        const wchar_t* Found = wcsstr(GetCommandLineW(), Key);
        if (!Found) return 0;
        const int Value = _wtoi(Found + wcslen(Key));
        return (Value >= 0 && Value <= 86400) ? Value : 0;
    }();
    return Seconds;
}

volatile LONG g_TrimRunning = 0;

DWORD WINAPI TrimThread(LPVOID Param) {
    const char* Reason = static_cast<const char*>(Param);
    PROCESS_MEMORY_COUNTERS_EX Before{}, After{};
    GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&Before), sizeof(Before));
    LARGE_INTEGER Start, End, Frequency;
    QueryPerformanceCounter(&Start);
    const BOOL Ok = SetProcessWorkingSetSizeEx(GetCurrentProcess(), static_cast<SIZE_T>(-1), static_cast<SIZE_T>(-1), 0);
    QueryPerformanceCounter(&End);
    QueryPerformanceFrequency(&Frequency);
    GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&After), sizeof(After));
    char Line[200];
    sprintf_s(Line, "[WorkingSet] trimmed (%s): working set %llu -> %llu MB, commit %llu MB, %.1f ms%s", Reason,
        static_cast<unsigned long long>(Before.WorkingSetSize >> 20), static_cast<unsigned long long>(After.WorkingSetSize >> 20),
        static_cast<unsigned long long>(After.PrivateUsage >> 20),
        (End.QuadPart - Start.QuadPart) * 1000.0 / Frequency.QuadPart, Ok ? "" : " (failed)");
    MpLog(Line);
    InterlockedExchange(&g_TrimRunning, 0);
    return 0;
}

// The engine commits a 32 MB pool at startup, never touches it and frees it
// only when an allocation fails, to make room for a crash report. On a world
// server that is 32 MB of commit per world for a crash we'd see in the log
// anyway; the out-of-memory handler skips the pool once it's null.
void ReleaseBackupOomPool() {
    void** Pool = reinterpret_cast<void**>(Native112::At(Globals::BaseAddress, Native112::BackupOOMMemoryPool));
    void* Block = *Pool;
    MEMORY_BASIC_INFORMATION Info{};
    if (!Block || !VirtualQuery(Block, &Info, sizeof(Info)) || Info.AllocationBase != Block || Info.RegionSize != (32u << 20)) {
        MpLog("[WorkingSet] backup out-of-memory pool not found as expected; left alone");
        return;
    }
    *Pool = nullptr;
    VirtualFree(Block, 0, MEM_RELEASE);
    MpLog("[WorkingSet] released the engine's 32 MB backup out-of-memory pool");
}

bool RequestTrim(const char* Reason) {
    if (InterlockedCompareExchange(&g_TrimRunning, 1, 0) != 0) return false;
    if (HANDLE Thread = CreateThread(nullptr, 0, TrimThread, const_cast<char*>(Reason), 0, nullptr)) {
        CloseHandle(Thread);
        return true;
    }
    InterlockedExchange(&g_TrimRunning, 0);
    return false;
}
}

void TickServerWorkingSetTrim(int32_t Connections) {
    if (!Globals::AmServer || KeepWorkingSet()) return;
    static uint64_t ListeningSinceMs = 0, EmptySinceMs = 0, JoinTrimAtMs = 0, LastTrimMs = 0;
    static int32_t LastConnections = 0;
    static bool LoadTrimmed = false, EmptyTrimmed = false;
    const uint64_t NowMs = GetTickCount64();
    if (ListeningSinceMs == 0) ListeningSinceMs = NowMs;

    if (Connections > 0) {
        EmptySinceMs = 0;
        EmptyTrimmed = false;
        if (Connections > LastConnections) JoinTrimAtMs = NowMs + 60000;
    } else if (Connections == 0 && EmptySinceMs == 0) {
        EmptySinceMs = NowMs;
    }
    if (Connections >= 0) LastConnections = Connections;

    const char* Reason = nullptr;
    if (!LoadTrimmed) {
        static bool PoolReleased = false;
        if (!PoolReleased && NowMs - ListeningSinceMs >= 30000) { PoolReleased = true; ReleaseBackupOomPool(); }
        if (NowMs - ListeningSinceMs >= 30000) Reason = "loaded";
    } else if (Connections == 0 && !EmptyTrimmed && NowMs - EmptySinceMs >= 15000) {
        Reason = "empty";
    } else if (Connections > 0 && JoinTrimAtMs != 0 && NowMs >= JoinTrimAtMs) {
        Reason = "joined";
    } else if (TrimIntervalSeconds() > 0 && NowMs - LastTrimMs >= static_cast<uint64_t>(TrimIntervalSeconds()) * 1000) {
        Reason = "periodic";
    }
    if (!Reason || !RequestTrim(Reason)) return;

    LastTrimMs = NowMs;
    LoadTrimmed = true;
    JoinTrimAtMs = 0;
    if (Connections == 0) EmptyTrimmed = true;
}
