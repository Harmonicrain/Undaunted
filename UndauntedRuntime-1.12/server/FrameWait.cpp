/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

#include "server/FrameWait.h"
#include "core/RuntimeState.h"
#include "core/RuntimeHooks.h"
#include "core/Logging.h"
#include "native/Addresses112.h"

// UEngine::UpdateTimeAndHandleMaxTickRate holds each frame to t.MaxFPS. A
// dedicated-server build sleeps for the whole wait. This client build sleeps
// for all but the last 2 ms (and only when the wait is over 5 ms), then calls
// FPlatformProcess::SleepNoStats(0), which is SwitchToThread, in a loop until
// FPlatformTime::Seconds() reaches the frame's end time. Measured 2026-10-01
// on Ramsgate with a player at 90 fps: the game thread used 45.6% of a core
// while the engine tick and this runtime's work came to ~25%; most of the
// rest was that loop.
//
// World servers hook SleepNoStats through a stub that also passes xmm7, where
// the limiter keeps the frame's end time, and the caller's return address.
// The limiter's two calls wait on a high-resolution timer until <slack> before
// the end time and its loop spins only what's left, so frames still end on
// time. Every other caller goes straight to the engine's SleepNoStats. The
// timer woke a median 150-270 us late on the maintainer's PC, 550 us at p90.
//   -UndauntedFrameSlackUs=<n>  how early to wake, in microseconds (default 500)
//   -UndauntedKeepFrameSpin     leaves the engine's wait alone

#ifndef CREATE_WAITABLE_TIMER_HIGH_RESOLUTION
#define CREATE_WAITABLE_TIMER_HIGH_RESOLUTION 0x00000002
#endif

namespace {
using SleepNoStatsFn = void(*)(float);
SleepNoStatsFn OrigSleepNoStats = nullptr;
uintptr_t AfterSlackSleep = 0;
uintptr_t AfterSpinSleep = 0;
const double* SecondsPerCycle = nullptr;
HANDLE FrameTimer = nullptr;
double SlackSeconds = 0.0005;

// Only the game thread runs the limiter and logs these.
uint64_t TimerWaits = 0;
uint64_t SpinCalls = 0;
double WakeSum = 0.0;
double WakeLatest = 0.0;

// FPlatformTime::Seconds(), computed as the limiter does.
double EngineSeconds() {
    LARGE_INTEGER Cycles;
    QueryPerformanceCounter(&Cycles);
    return static_cast<double>(Cycles.QuadPart) * *SecondsPerCycle + 16777216.0;
}

void FrameWaitSleep(float Seconds, double FrameEnd, uintptr_t ReturnAddress) {
    const bool SlackSleep = ReturnAddress == AfterSlackSleep;
    if (!SlackSleep && ReturnAddress != AfterSpinSleep) {
        OrigSleepNoStats(Seconds);
        return;
    }
    // t.MaxFPS is at least 1, so a real end time is under a second away
    // (and a NaN fails the comparison too).
    const double Remaining = FrameEnd - EngineSeconds();
    if (!(Remaining < 1.5)) {
        OrigSleepNoStats(Seconds);
        return;
    }
    const LONGLONG Ticks = static_cast<LONGLONG>((Remaining - SlackSeconds) * 1e7);
    if (Ticks > 0) {
        LARGE_INTEGER Due;
        Due.QuadPart = -Ticks;
        if (SetWaitableTimerEx(FrameTimer, &Due, 0, nullptr, nullptr, nullptr, 0)
            && WaitForSingleObject(FrameTimer, INFINITE) == WAIT_OBJECT_0) {
            const double Wake = EngineSeconds() - FrameEnd;
            if (TimerWaits == 0 || Wake > WakeLatest) WakeLatest = Wake;
            ++TimerWaits;
            WakeSum += Wake;
            return;
        }
        OrigSleepNoStats(Seconds);
        return;
    }
    // Inside the slack: the limiter's loop spins out the rest of the frame.
    if (SlackSleep) return;
    ++SpinCalls;
    OrigSleepNoStats(Seconds);
}

// movsd xmm1, xmm7; mov r8, [rsp]; jmp [rip+0]; dq FrameWaitSleep. The stub
// is entered by a jump, so FrameWaitSleep returns straight to the caller.
void* MakeFrameWaitStub() {
    unsigned char Code[22] = { 0xF2, 0x0F, 0x10, 0xCF, 0x4C, 0x8B, 0x04, 0x24, 0xFF, 0x25, 0x00, 0x00, 0x00, 0x00 };
    const uintptr_t Target = reinterpret_cast<uintptr_t>(&FrameWaitSleep);
    memcpy(Code + 14, &Target, sizeof(Target));
    void* Stub = VirtualAlloc(nullptr, sizeof(Code), MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!Stub) return nullptr;
    memcpy(Stub, Code, sizeof(Code));
    DWORD Old = 0;
    if (!VirtualProtect(Stub, sizeof(Code), PAGE_EXECUTE_READ, &Old)) {
        VirtualFree(Stub, 0, MEM_RELEASE);
        return nullptr;
    }
    FlushInstructionCache(GetCurrentProcess(), Stub, sizeof(Code));
    return Stub;
}

bool BytesAt(uintptr_t Rva, const unsigned char* Bytes, size_t Size) {
    return memcmp(reinterpret_cast<const void*>(Native112::At(Globals::BaseAddress, Rva)), Bytes, Size) == 0;
}

bool CallsSleepNoStats(uintptr_t CallRva) {
    const unsigned char* Call = reinterpret_cast<const unsigned char*>(Native112::At(Globals::BaseAddress, CallRva));
    int32_t Offset = 0;
    memcpy(&Offset, Call + 1, sizeof(Offset));
    return Call[0] == 0xE8
        && static_cast<int64_t>(CallRva) + 5 + Offset == static_cast<int64_t>(Native112::SleepNoStats);
}

int SlackMicroseconds() {
    const wchar_t* Key = L"-UndauntedFrameSlackUs=";
    const wchar_t* Found = wcsstr(GetCommandLineW(), Key);
    if (!Found) return 500;
    const int Value = _wtoi(Found + wcslen(Key));
    return Value >= 0 && Value <= 2000 ? Value : 500;
}
}

void InstallServerFrameWait() {
    if (!Globals::AmServer || wcsstr(GetCommandLineW(), L"-UndauntedKeepFrameSpin") != nullptr) return;
    // SleepNoStats: mulss xmm0, [1000.0]; cvttss2si rax, xmm0; test eax, eax; jne
    static const unsigned char SleepBytes[] = { 0xF3, 0x0F, 0x59, 0x05, 0x70, 0x79, 0x93, 0x02, 0xF3, 0x48, 0x0F, 0x2C, 0xC0, 0x85, 0xC0, 0x75, 0x07 };
    // cvtss2sd xmm7, xmm9; mulsd xmm11, [GSecondsPerCycle]; addsd xmm7, xmm6:
    // the end time is the frame's current time plus its wait.
    static const unsigned char EndTime[] = { 0xF3, 0x41, 0x0F, 0x5A, 0xF9, 0xF2, 0x44, 0x0F, 0x59, 0x1D, 0xD8, 0xA1, 0xAC, 0x02, 0xF2, 0x0F, 0x58, 0xFE };
    // comisd xmm0, xmm7: Seconds() against the end time, before and in the loop.
    static const unsigned char CompareEnd[] = { 0x66, 0x0F, 0x2F, 0xC7 };
    if (!BytesAt(Native112::SleepNoStats, SleepBytes, sizeof(SleepBytes))
        || !BytesAt(Native112::FrameLimiterEndTime, EndTime, sizeof(EndTime))
        || !BytesAt(Native112::FrameLimiterFirstCompare, CompareEnd, sizeof(CompareEnd))
        || !BytesAt(Native112::FrameLimiterLoopCompare, CompareEnd, sizeof(CompareEnd))
        || !CallsSleepNoStats(Native112::FrameLimiterSlackSleepCall)
        || !CallsSleepNoStats(Native112::FrameLimiterSpinSleepCall)) {
        MpLog("[FrameWait] the frame limiter has unexpected bytes; left alone");
        return;
    }
    FrameTimer = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
    if (!FrameTimer) {
        MpLog("[FrameWait] no high-resolution timer (error " + std::to_string(GetLastError()) + "); frame limiter left alone");
        return;
    }
    void* FrameWaitStub = MakeFrameWaitStub();
    if (!FrameWaitStub) {
        CloseHandle(FrameTimer);
        FrameTimer = nullptr;
        MpLog("[FrameWait] could not allocate the stub; frame limiter left alone");
        return;
    }
    SlackSeconds = SlackMicroseconds() / 1e6;
    SecondsPerCycle = reinterpret_cast<const double*>(Native112::At(Globals::BaseAddress, Native112::GSecondsPerCycle));
    AfterSlackSleep = Native112::At(Globals::BaseAddress, Native112::FrameLimiterSlackSleepCall) + 5;
    AfterSpinSleep = Native112::At(Globals::BaseAddress, Native112::FrameLimiterSpinSleepCall) + 5;
    void* Target = reinterpret_cast<void*>(Native112::At(Globals::BaseAddress, Native112::SleepNoStats));
    const MH_STATUS Create = RUNTIME_CREATE_HOOK(Target, FrameWaitStub, &OrigSleepNoStats);
    const MH_STATUS Enable = Create == MH_OK ? RuntimeHooks::Enable(Target) : Create;
    MpLog(std::string("[FrameWait] frame limiter sleeps on a timer, waking ") + std::to_string(SlackMicroseconds())
        + " us early; create=" + MH_StatusToString(Create) + " enable=" + MH_StatusToString(Enable));
}

void LogServerFrameWaitStats() {
    if (!FrameTimer) return;
    char Line[200];
    sprintf_s(Line, "[FrameWait] %llu timer waits, woke %+.0f us from the frame end on average (latest %+.0f us), %llu spin calls",
        static_cast<unsigned long long>(TimerWaits), TimerWaits ? WakeSum / TimerWaits * 1e6 : 0.0,
        TimerWaits ? WakeLatest * 1e6 : 0.0, static_cast<unsigned long long>(SpinCalls));
    MpLog(Line);
    TimerWaits = 0;
    SpinCalls = 0;
    WakeSum = 0.0;
    WakeLatest = 0.0;
}
