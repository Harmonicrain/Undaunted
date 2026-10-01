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

#include "core/EngineTick.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "core/PlayerRoles.h"
#include "diagnostics/RuntimeDiagnostics.h"
#include "server/Replication.h"
#include "server/WorldLifecycle.h"
#include "server/RenderData.h"
#include "server/WorkingSet.h"
#include "server/TrainingLifecycle.h"
#include "server/AfkTimeout.h"
#include "server/TickFilter.h"
#include "server/FrameWait.h"
#include "diagnostics/ScriptProfile.h"
#include <psapi.h>

struct ManualNetTickFailureState {
    bool Active = false;
    uint64_t LastReportMs = 0;
    uint64_t FailuresSinceReport = 0;
};

static bool RegisterNetDriverInLevelCollections();
static void SanitizeNetDriverBeforeEngineTick();
static void ReportManualNetTickFailure(bool IsFlush, uint64_t Tick);
static void ReportManualNetTickRecovery(bool IsFlush, uint64_t Tick);
static int TickDispatchExceptionFilter(unsigned int Code, EXCEPTION_POINTERS* ExceptionInfo);
static bool SafeManualTickDispatch(UNetDriver* NetDriver, float DeltaTime);
static int TickFlushExceptionFilter(unsigned int Code, EXCEPTION_POINTERS* ExceptionInfo);
static bool SafeManualTickFlush(UNetDriver* NetDriver, float DeltaTime);
static bool ManualTickZeroDeltaTime();
static bool ManualTickHalfRate();
static bool NativeNetTick();
static void ForceServerMeshPose();
static void SampleBleedoutGrace();
static void SampleBleedoutGraceGuarded();
static void LogKnockout(void* self);

float TotalNoPlayersTime = 0.0f;

bool EnableWatchdog = true;

void* OrigGameEngineTick = nullptr;

void* OrigInteractionCalloutHideHoldText = nullptr;

void* OrigArchonLoadingScreenFadeIn = nullptr;

static void* g_regWorld = nullptr;

static void* g_deferredWorld = nullptr;

static void* g_rejectedWorld = nullptr;

static bool RegisterNetDriverInLevelCollections() {
    if (!Globals::Listening || !Networking::NetDriver || !IsReadablePointer(Networking::NetDriver, 0x198)) return false;
    UWorld* w = UWorld::GetWorld();
    if (!w || !IsReadablePointer(w, 0x160)) return false;
    if (g_regWorld == reinterpret_cast<void*>(w)) return true;

    void* drvWorld = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Networking::NetDriver) + 0x140);
    uintptr_t arr = *reinterpret_cast<uintptr_t*>(reinterpret_cast<uintptr_t>(w) + 0x148);
    int32_t count = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(w) + 0x150);
    bool collectionsOk = (arr && count > 0 && count <= 8 && IsReadablePointer(reinterpret_cast<void*>(arr), static_cast<size_t>(count) * 0x78));

    if (drvWorld != reinterpret_cast<void*>(w) || !collectionsOk) {
        if (g_deferredWorld != reinterpret_cast<void*>(w)) {
            g_deferredWorld = reinterpret_cast<void*>(w);
            MpLog("[CollectionFix] registration deferred: world=" + MpPtr(w) + " driverWorld=" + MpPtr(drvWorld)
                + " collections=" + (collectionsOk ? ("n=" + std::to_string(count)) : std::string("unavailable")));
        }
        return false;
    }

    void* gengine = IsReadablePointer(reinterpret_cast<void*>(Native112::At(Globals::BaseAddress, Native112::Rva_06CFBF60)), 8)
        ? *reinterpret_cast<void**>(Native112::At(Globals::BaseAddress, Native112::Rva_06CFBF60)) : nullptr;
    uint64_t nm = *reinterpret_cast<uint64_t*>(reinterpret_cast<uintptr_t>(Networking::NetDriver) + 0x190);
    void* reResolve = (gengine && IsReadablePointer(gengine, 0xC48))
        ? reinterpret_cast<void* (*)(void*, void*, uint64_t)>(Native112::At(Globals::BaseAddress, Native112::Rva_0403A830))(gengine, w, nm) : nullptr;
    if (reResolve != reinterpret_cast<void*>(Networking::NetDriver)) {
        if (g_rejectedWorld != reinterpret_cast<void*>(w)) {
            g_rejectedWorld = reinterpret_cast<void*>(w);
            MpLog("[CollectionFix] registration REJECTED (driver not in WorldContext; would re-null): world=" + MpPtr(w)
                + " byNameResolve=" + MpPtr(reResolve) + " driver=" + MpPtr(Networking::NetDriver) + " — NOT writing collections");
        }
        return false;
    }

    int populated = 0;
    for (int i = 0; i < count; ++i) {
        uintptr_t c = arr + static_cast<uintptr_t>(i) * 0x78;
        uint8_t type = *reinterpret_cast<uint8_t*>(c + 0x00);
        if (type == 0 || type == 2) {
            *reinterpret_cast<void**>(c + 0x10) = reinterpret_cast<void*>(Networking::NetDriver);
            ++populated;
        }
    }
    g_regWorld = reinterpret_cast<void*>(w);
    MpLog("[CollectionFix] set driver on " + std::to_string(populated) + " gameplay collection(s) world=" + MpPtr(w)
        + " driver=" + MpPtr(Networking::NetDriver) + " byNameResolve=" + MpPtr(reResolve) + " resolveMatches=Y");
    return true;
}

static void SanitizeNetDriverBeforeEngineTick() {
    if (!Globals::Listening || !Networking::NetDriver || !IsReadablePointer(Networking::NetDriver, 0x2B0)) {
        return;
    }

    UWorld* World = UWorld::GetWorld();
    if (!World || !IsReadablePointer(World, 0x40)) {
        return;
    }

    static FName GameNetDriverName = FName();
    static bool GameNetDriverNameInit = false;

    if (!GameNetDriverNameInit) {
        GameNetDriverName = UKismetStringLibrary::Conv_StringToName(L"GameNetDriver");
        GameNetDriverNameInit = true;
    }

    RegisterNetDriverInLevelCollections();
    Networking::NetDriver->World = World;
    Networking::NetDriver->NetDriverName = GameNetDriverName;
    Networking::NetDriver->ServerConnection = nullptr;
}

static ManualNetTickFailureState g_TickDispatchFailureState;

static ManualNetTickFailureState g_TickFlushFailureState;

static void ReportManualNetTickFailure(bool IsFlush, uint64_t Tick) {
    ManualNetTickFailureState& State = IsFlush ? g_TickFlushFailureState : g_TickDispatchFailureState;
    const char* Phase = IsFlush ? "TickFlush" : "TickDispatch";
    const uint64_t NowMs = GetTickCount64();
    ++State.FailuresSinceReport;

    if (!State.Active) {
        State.Active = true;
        State.LastReportMs = NowMs;
        MpLog("[NetTickFault] " + std::string(Phase) + " first exception at tick=" + std::to_string(Tick)
            + "; repeated failures will be summarized every 30s");
        State.FailuresSinceReport = 0;
        return;
    }

    if (NowMs - State.LastReportMs >= 30000) {
        MpLog("[NetTickFault] " + std::string(Phase) + " still failing at tick=" + std::to_string(Tick)
            + " failuresSinceLast=" + std::to_string(State.FailuresSinceReport));
        State.LastReportMs = NowMs;
        State.FailuresSinceReport = 0;
    }
}

static void ReportManualNetTickRecovery(bool IsFlush, uint64_t Tick) {
    ManualNetTickFailureState& State = IsFlush ? g_TickFlushFailureState : g_TickDispatchFailureState;
    if (!State.Active) return;

    const char* Phase = IsFlush ? "TickFlush" : "TickDispatch";
    MpLog("[NetTickFault] " + std::string(Phase) + " recovered at tick=" + std::to_string(Tick)
        + " unreportedFailures=" + std::to_string(State.FailuresSinceReport));
    State = {};
}

static int TickDispatchExceptionFilter(unsigned int Code, EXCEPTION_POINTERS* ExceptionInfo) {
    if (ExceptionInfo && IsReadablePointer(ExceptionInfo, sizeof(EXCEPTION_POINTERS)) &&
        IsReadablePointer(ExceptionInfo->ExceptionRecord, sizeof(EXCEPTION_RECORD))) {
        LogExceptionRecord(
            "ManualTickDispatchSEH",
            ExceptionInfo->ExceptionRecord,
            IsReadablePointer(ExceptionInfo->ContextRecord, sizeof(CONTEXT)) ? ExceptionInfo->ContextRecord : nullptr);
    }
    else {
        EXCEPTION_RECORD Record{};
        Record.ExceptionCode = Code;
        Record.ExceptionAddress = _ReturnAddress();
        LogExceptionRecord("ManualTickDispatchSEH", &Record, nullptr);
    }

    return EXCEPTION_EXECUTE_HANDLER;
}

static bool SafeManualTickDispatch(UNetDriver* NetDriver, float DeltaTime) {

    if (NativeNetTick()) return true;
    using TickDispatchFn = void(*)(UNetDriver*, float);

    __try {
        reinterpret_cast<TickDispatchFn>(Native112::At(Globals::BaseAddress, Native112::Rva_00A6F220))(NetDriver, DeltaTime);
        return true;
    }
    __except (TickDispatchExceptionFilter(GetExceptionCode(), GetExceptionInformation())) {
        return false;
    }
}

static int TickFlushExceptionFilter(unsigned int Code, EXCEPTION_POINTERS* ExceptionInfo) {
    if (ExceptionInfo && IsReadablePointer(ExceptionInfo, sizeof(EXCEPTION_POINTERS)) &&
        IsReadablePointer(ExceptionInfo->ExceptionRecord, sizeof(EXCEPTION_RECORD))) {
        LogExceptionRecord(
            "ManualTickFlushSEH",
            ExceptionInfo->ExceptionRecord,
            IsReadablePointer(ExceptionInfo->ContextRecord, sizeof(CONTEXT)) ? ExceptionInfo->ContextRecord : nullptr);
    }
    else {
        EXCEPTION_RECORD Record{};
        Record.ExceptionCode = Code;
        Record.ExceptionAddress = _ReturnAddress();
        LogExceptionRecord("ManualTickFlushSEH", &Record, nullptr);
    }
    return EXCEPTION_EXECUTE_HANDLER;
}

static bool SafeManualTickFlush(UNetDriver* NetDriver, float DeltaTime) {

    if (NativeNetTick()) return true;
    using TickFlushFn = void(*)(UNetDriver*, float);

    __try {
        reinterpret_cast<TickFlushFn>(Native112::At(Globals::BaseAddress, Native112::Rva_03D91DC0))(NetDriver, DeltaTime);
        return true;
    }
    __except (TickFlushExceptionFilter(GetExceptionCode(), GetExceptionInformation())) {
        return false;
    }
}

static bool ManualTickZeroDeltaTime() {
    static int c = -1;
    if (c < 0) {
        c = MpExeRelativeFlagPresent(L"MANUAL_TICK_ZERO_DT.flag") ? 1 : 0;
        MpLog(std::string("[ManualTickDT] MANUAL_TICK_ZERO_DT.flag ")
            + (c ? "PRESENT -> *** BROKEN: server will be UNJOINABLE (handshake timers frozen). REMOVE THIS FLAG. *** "
                   "Replication still runs; server stays joinable. Watch whether orbit/beam visuals correct "
                   "themselves while everything else is unchanged."
                 : "absent -> manual TickDispatch gets the real DeltaTime (default; clock may double-advance)."));
    }
    return c == 1;
}

static bool ManualTickHalfRate() {
    static int c = -1;
    if (c < 0) {
        c = MpExeRelativeFlagPresent(L"MANUAL_TICK_HALF_RATE.flag") ? 1 : 0;
        MpLog(std::string("[ManualTickRate] MANUAL_TICK_HALF_RATE.flag ")
            + (c ? "PRESENT -> manual TickDispatch/TickFlush run every OTHER frame (~30Hz SRA, matches "
                   "NetServerMaxTickRate). NOTE: also halves player-pawn replication rate."
                 : "absent -> manual drive runs every frame (default)."));
    }
    return c == 1;
}

static bool NativeNetTick() {
    static int c = -1;
    if (c < 0) {
        c = MpExeRelativeFlagPresent(L"NATIVE_NET_TICK.flag") ? 1 : 0;
        MpLog(std::string("[NativeNetTick] NATIVE_NET_TICK.flag ")
            + (c ? "PRESENT -> manual TickDispatch/TickFlush SKIPPED; native engine tick is the sole net driver. "
                   "Expect [SRA enter] ~30Hz (enable REPGRAPH_DIAG.flag to confirm). If [SRA enter] stops / goes ~0Hz, "
                   "native does NOT drive TickFlush here -> remove the flag (replication broken in this mode)."
                 : "absent -> manual TickDispatch/TickFlush ACTIVE (default; current double-drive ~60Hz behaviour)."));
    }
    return c == 1;
}

static void ForceServerMeshPose() {
    // The flag file is looked for every 4 s rather than every frame: a file
    // system call per frame showed in a world's profile (2026-10-01).
    static uint64_t s_lastMs = 0;
    uint64_t now = GetTickCount64();
    if (s_lastMs != 0 && now - s_lastMs < 4000) return;
    s_lastMs = now;
    if (!MpExeRelativeFlagPresent(L"FORCE_SERVER_MESH_POSE.flag")) return;
    if (!SDK::UObject::GObjects) return;

    SDK::UClass* MeshClass = SDK::USkeletalMeshComponent::StaticClass();
    if (!MeshClass) {
        MpLog("[ForceServerMeshPose] pass: USkeletalMeshComponent::StaticClass() returned null - class lookup failed");
        return;
    }

    const int Count = SDK::UObject::GObjects->Num();

    int walked = 0, matched = 0, unreadable = 0, changed = 0, logged = 0;
    const int LogCap = 500;
    const int NameSampleCap = 20;
    int nameSampled = 0;
    for (int i = 0; i < Count; i++) {
        SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);
        if (!Obj || Obj->IsDefaultObject()) continue;
        ++walked;
        if (!Obj->IsA(MeshClass)) continue;
        ++matched;

        uint8_t* opt = reinterpret_cast<uint8_t*>(reinterpret_cast<uintptr_t>(Obj) + 0x5FC);
        if (!IsReadablePointer(opt, 1)) {
            ++unreadable;
            if (nameSampled < NameSampleCap) {
                ++nameSampled;
                MpLog("[ForceServerMeshPose] MATCHED-BUT-UNREADABLE " + Obj->GetFullName() + " ptr=" + MpPtr(opt));
            }
            continue;
        }

        uint8_t oldVal = *opt;
        bool willChange = (oldVal == 1 || oldVal == 2 || oldVal == 3);
        if (willChange) {
            *opt = 0;
            ++changed;
        }
        if (logged < LogCap) {
            ++logged;
            MpLog("[ForceServerMeshPose] " + Obj->GetFullName()
                + " VisibilityBasedAnimTickOption " + std::to_string(oldVal)
                + (willChange ? " -> 0 (forced)" : " (already 0, no change)"));
        }
    }
    MpLog("[ForceServerMeshPose] pass walked " + std::to_string(walked) + " object(s), IsA-matched "
        + std::to_string(matched) + ", unreadable " + std::to_string(unreadable) + ", changed "
        + std::to_string(changed) + ", logged " + std::to_string(logged));
}

static void SampleBleedoutGrace() {
    UWorld* w = *reinterpret_cast<UWorld**>(Native112::At(Globals::BaseAddress, Native112::Rva_06D001B8));
    if (!w || !IsReadablePointer(w, 0x128)) return;
    void* gs = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(w) + 0x120);
    if (!gs || !IsReadablePointer(gs, 0x248)) return;
    void** psData = *reinterpret_cast<void***>(reinterpret_cast<uintptr_t>(gs) + 0x238);
    int psNum = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(gs) + 0x240);
    if (!psData || psNum <= 0 || psNum > 64 || !IsReadablePointer(psData, 8)) return;
    for (int i = 0; i < psNum; ++i) {
        void* ps = psData[i];
        if (!ps || !IsReadablePointer(ps, 0x3B8)) continue;
        int32_t state = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(ps) + 0x3AC);
        if (state == 0) continue;
        float len = *reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(ps) + 0x3B0);
        float rem = *reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(ps) + 0x3B4);
        MpLog("[GraceDiag] ps=" + reinterpret_cast<UObject*>(ps)->GetName()
            + " BleedoutState=" + std::to_string(state)
            + " timerLen=" + std::to_string(len)
            + " timeRemaining=" + std::to_string(rem));
    }
}

static void SampleBleedoutGraceGuarded() {
    __try { SampleBleedoutGrace(); } __except (EXCEPTION_EXECUTE_HANDLER) {}
}

void* OrigKnockout = nullptr;

static void LogKnockout(void* self) {
    std::string nm = (self && IsReadablePointer(self, 0x40)) ? reinterpret_cast<UObject*>(self)->GetName() : std::string("?");
    MpLog("[GraceDiag] KNOCKOUT actor=" + nm);
}

void KnockoutHook(void* self) {
    reinterpret_cast<void(*)(void*)>(OrigKnockout)(self);
    if (MpExeRelativeFlagPresent(L"TRIALS_GRACE_DIAG.flag")) {
        __try { LogKnockout(self); } __except (EXCEPTION_EXECUTE_HANDLER) {}
    }
}

// World servers log their frame statistics once a minute, so a world's cost can
// be read from its log: frames per second, the average and worst frame, and how
// much of each frame is the engine's tick versus this runtime's own work.
static LARGE_INTEGER g_PerfFrequency{};
static int64_t g_PerfLastEntry = 0, g_PerfWindowStart = 0, g_PerfEngineTicks = 0, g_PerfHookTicks = 0, g_PerfMaxFrameTicks = 0;
static uint64_t g_PerfFrames = 0;

static void RecordServerFrame(int64_t Entry, int64_t EngineTicks) {
    if (!Globals::AmServer) return;
    if (g_PerfFrequency.QuadPart == 0) QueryPerformanceFrequency(&g_PerfFrequency);
    LARGE_INTEGER Exit; QueryPerformanceCounter(&Exit);
    if (g_PerfLastEntry != 0) {
        const int64_t Frame = Entry - g_PerfLastEntry;
        if (Frame > g_PerfMaxFrameTicks) g_PerfMaxFrameTicks = Frame;
        ++g_PerfFrames;
    } else {
        g_PerfWindowStart = Entry;
    }
    g_PerfLastEntry = Entry;
    g_PerfEngineTicks += EngineTicks;
    g_PerfHookTicks += (Exit.QuadPart - Entry) - EngineTicks;

    const double Freq = static_cast<double>(g_PerfFrequency.QuadPart);
    const double WindowSec = (Entry - g_PerfWindowStart) / Freq;
    if (WindowSec < 60.0 || g_PerfFrames == 0) return;
    int32_t Connections = -1;
    if (Networking::NetDriver && IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Networking::NetDriver) + 0x98), 4)) {
        Connections = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(Networking::NetDriver) + 0x98);
    }
    char Line[256];
    sprintf_s(Line, "[Perf] %.0fs: %llu frames (%.1f/s), frame %.1f ms avg / %.1f ms max, engine tick %.2f ms, runtime %.2f ms per frame, connections %d",
        WindowSec, static_cast<unsigned long long>(g_PerfFrames), g_PerfFrames / WindowSec,
        WindowSec * 1000.0 / g_PerfFrames, g_PerfMaxFrameTicks * 1000.0 / Freq,
        g_PerfEngineTicks * 1000.0 / Freq / g_PerfFrames, g_PerfHookTicks * 1000.0 / Freq / g_PerfFrames, Connections);
    MpLog(Line);
    PROCESS_MEMORY_COUNTERS_EX Memory{};
    if (GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&Memory), sizeof(Memory))) {
        sprintf_s(Line, "[Memory] connections %d, working set %.1f MiB, private commit %.1f MiB, object slots %d",
            Connections, Memory.WorkingSetSize / 1048576.0, Memory.PrivateUsage / 1048576.0,
            SDK::UObject::GObjects ? SDK::UObject::GObjects->Num() : -1);
        MpLog(Line);
    }
    LogServerFrameWaitStats();
    LogParkedActorStats();
    LogTickFilterCensus();
    g_PerfWindowStart = Entry; g_PerfFrames = 0; g_PerfEngineTicks = 0; g_PerfHookTicks = 0; g_PerfMaxFrameTicks = 0;
}

// The server's frame rate. A world server runs the client executable, so it
// took t.MaxFPS from the host user's graphics settings (FrameRateLimit in
// GameUserSettings.ini: 90 on the maintainer's machine, unlimited for a host
// who turned the limit off), and the engine's frame limiter spun for the last
// ~2 ms of every frame (see server/FrameWait). Worlds now set their own rate: the active rate while a
// player is connected, and a low idle rate once the world has been empty for
// ten seconds, back to the active rate as soon as a connection arrives.
// Measured 2026-09-30 on an idle Training Grounds: 90 fps cost ~52% of a core.
//   -UndauntedServerFPS=<n>  active rate (default 90, the rate players know)
//   -UndauntedIdleFPS=<n>    empty-world rate (default 10)
// The value is written straight into t.MaxFPS: 4.26's ExecuteConsoleCommand
// only runs through a player controller, which an empty world doesn't have.
// It is checked every frame so a later settings apply can't undo it.
static int ServerFpsSetting(const wchar_t* Key, int Default) {
    const wchar_t* Found = wcsstr(GetCommandLineW(), Key);
    if (!Found) return Default;
    const int Value = _wtoi(Found + wcslen(Key));
    return (Value >= 1 && Value <= 240) ? Value : Default;
}

static void TickServerFrameRate(int32_t Connections, float DeltaTime) {
    static const int ActiveFps = ServerFpsSetting(L"-UndauntedServerFPS=", 90);
    static const int IdleFps = ServerFpsSetting(L"-UndauntedIdleFPS=", 10);
    static float EmptyFor = 0.0f;
    static int Applied = 0;
    if (Connections > 0) EmptyFor = 0.0f; else EmptyFor += DeltaTime;
    const int Want = (Connections <= 0 && EmptyFor >= 10.0f) ? IdleFps : ActiveFps;
    float* MaxFps = *reinterpret_cast<float**>(Native112::At(Globals::BaseAddress, Native112::CVarMaxFPSData));
    if (!IsReadablePointer(MaxFps, sizeof(float) * 2)) return;
    if (Want == Applied && MaxFps[0] == static_cast<float>(Want)) return;
    const float Before = MaxFps[0];
    MaxFps[0] = MaxFps[1] = static_cast<float>(Want);
    static int ExternalResets = 0;
    const bool Reset = (Want == Applied);
    if (!Reset || ++ExternalResets <= 5) {
        MpLog("[ServerFps] t.MaxFPS " + std::to_string(static_cast<int>(Before)) + " -> " + std::to_string(Want)
            + (Reset ? " (something else had changed it)"
               : Want == IdleFps && Want != ActiveFps ? " (no connections for 10s)"
                                                      : " (active; connections " + std::to_string(Connections) + ")"));
    }
    Applied = Want;
}

void GameEngineTickHook(UGameEngine* GameEngine, float DeltaTime, char CanRender) {
    static uint64_t tickCounter = 0;    ++tickCounter;
    LARGE_INTEGER PerfEntry; QueryPerformanceCounter(&PerfEntry);
    int64_t PerfEngineTicks = 0;
    struct FRecordFrameOnExit {
        const LARGE_INTEGER& Entry; int64_t& Engine;
        ~FRecordFrameOnExit() { RecordServerFrame(Entry.QuadPart, Engine); }
    } RecordFrameOnExit{ PerfEntry, PerfEngineTicks };

    DWORD CurTid = GetCurrentThreadId();
    InterlockedCompareExchange(
        reinterpret_cast<volatile LONG*>(&GameTickThreadId),
        static_cast<LONG>(CurTid),
        0);

    static bool tickHookLogged = false;
    if (!tickHookLogged) {
        tickHookLogged = true;
        MpLog("[GameEngineTick] first entry GameEngine=" + MpPtr(GameEngine)
            + " DeltaTime=" + std::to_string(DeltaTime)
            + " CanRender=" + std::to_string(static_cast<int>(CanRender))
            + " DoListen=" + std::to_string(Globals::DoListen ? 1 : 0)
            + " Listening=" + std::to_string(Globals::Listening ? 1 : 0)
            + " tid=" + std::to_string(CurTid));
    }

    if (Globals::AmServer) {
        *(uint8_t*)(Native112::At(Globals::BaseAddress, Native112::Rva_06B5325A)) = 0x1;
        *(uint8_t*)(Native112::At(Globals::BaseAddress, Native112::Rva_06B53259)) = 0x0;
    }

    SanitizeNetDriverBeforeEngineTick();

    LARGE_INTEGER PerfEngineStart; QueryPerformanceCounter(&PerfEngineStart);
    reinterpret_cast<void(*)(UGameEngine*, float, char)>(OrigGameEngineTick)(GameEngine, DeltaTime, CanRender);
    LARGE_INTEGER PerfEngineEnd; QueryPerformanceCounter(&PerfEngineEnd);
    PerfEngineTicks = PerfEngineEnd.QuadPart - PerfEngineStart.QuadPart;
    ScriptProfileEngineTick(PerfEngineTicks);

    if (Globals::AmServer) {
        ForceServerMeshPose();
    }

    if (Globals::AmServer) {
        static uint32_t s_graceTick = 0;
        static bool s_graceOn = false;
        ++s_graceTick;
        if ((s_graceTick & 0xFF) == 1) s_graceOn = MpExeRelativeFlagPresent(L"TRIALS_GRACE_DIAG.flag");
        if (s_graceOn && (s_graceTick & 7) == 0) {
            SampleBleedoutGraceGuarded();
        }
    }

    if (Globals::AmServer) {
        static uint32_t s_roleRetryTick = 0;
        if ((++s_roleRetryTick & 0x3F) == 0) {
            TickPlayerRoleRetries();
            TickPlayerRolePostActivationRefresh();
            TickTempestModifierEnsure();
        }
    }

    if (Globals::AmServer) {
        static uint32_t s_tempestDiagTick = 0;
        if ((++s_tempestDiagTick & 0x7) == 0) {
            TickTempestChargeDiag();
        }
    }

    if (Globals::AmServer) {
        *(uint8_t*)(Native112::At(Globals::BaseAddress, Native112::Rva_06B5325A)) = 0x1;
        *(uint8_t*)(Native112::At(Globals::BaseAddress, Native112::Rva_06B53259)) = 0x0;
    }

    if (!Globals::AmServer && GetAsyncKeyState(VK_F7)) {
        for (int i = 0; i < SDK::UObject::GObjects->Num(); i++)
        {
            SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);

            if (!Obj)
                continue;

            if (Obj->IsA(SDK::AActor::StaticClass()))
            {
                AActor* Quest = (AActor*)Obj;

                if (Quest->Role != ENetRole::ROLE_Authority) {
                    std::cout << (int)(uint8_t)Quest->Role << std::endl;

                    std::cout << Quest->GetFullName() << std::endl;
                }
            }
        }

        while (GetAsyncKeyState(VK_F7)) {

        }
    }

    if (Globals::Listening) {

        static int s_disableExpectedZero = -1;
        if (s_disableExpectedZero < 0) {
            s_disableExpectedZero = MpExeRelativeFlagPresent(L"DISABLE_EXPECTED_PLAYER_ZERO.flag") ? 1 : 0;
            MpLog(std::string("[ExpectedPlayerCount] DISABLE_EXPECTED_PLAYER_ZERO.flag ")
                + (s_disableExpectedZero ? "PRESENT -> zeroing DISABLED (native session state preserved)"
                                         : "absent -> zeroing ENABLED (default)"));
        }

        if (s_disableExpectedZero == 0 && SDK::UObject::GObjects) {
            static bool s_loggedGameMode  = false;
            static bool s_loggedGameState = false;

            // Walking every object each frame to find these cost about a third
            // of an idle world's CPU (measured 2026-09-30: 89% -> 59% of a core
            // on an idle Training Grounds). The game modes and game states live
            // as long as the world, so they are found once and looked for
            // again, at most once a second, only when one has gone. Every one
            // found is still zeroed every frame, as before.
            static std::vector<SDK::UObject*> s_expectedCountHolders;
            static uint64_t s_expectedCountSearchMs = 0;
            auto StillLive = [](SDK::UObject* Obj) {
                return IsReadablePointer(Obj, 0x28) && Obj->Index >= 0
                    && SDK::UObject::GObjects->GetByIndex(Obj->Index) == Obj;
            };
            bool HoldersLive = !s_expectedCountHolders.empty();
            for (SDK::UObject* Obj : s_expectedCountHolders) {
                if (!StillLive(Obj)) { HoldersLive = false; break; }
            }
            const uint64_t ExpectedCountNowMs = GetTickCount64();
            if (!HoldersLive && ExpectedCountNowMs - s_expectedCountSearchMs >= 1000) {
                s_expectedCountSearchMs = ExpectedCountNowMs;
                s_expectedCountHolders.clear();
                const int Count = SDK::UObject::GObjects->Num();
                for (int i = 0; i < Count; i++) {
                    SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);
                    if (!Obj || Obj->IsDefaultObject()) continue;
                    if (Obj->IsA(SDK::AArchonGameMode::StaticClass()) || Obj->IsA(SDK::AArchonGameState::StaticClass())) {
                        s_expectedCountHolders.push_back(Obj);
                    }
                }
            }

            for (SDK::UObject* Obj : s_expectedCountHolders) {
                if (!StillLive(Obj)) continue;

                if (Obj->IsA(SDK::AArchonGameMode::StaticClass())) {
                    int32_t* Field = reinterpret_cast<int32_t*>(
                        reinterpret_cast<uintptr_t>(Obj) + 0x0498);
                    if (IsReadablePointer(Field, sizeof(int32_t))) {
                        int32_t Before = *Field;
                        if (Before != 0) {
                            *Field = 0;
                            if (!s_loggedGameMode) {
                                s_loggedGameMode = true;
                                MpLog("[ExpectedPlayerCount@GameMode] zeroed  instance=" + MpPtr(Obj)
                                    + " class=" + Obj->Class->GetName()
                                    + " before=" + std::to_string(Before)
                                    + " after=0"
                                    + " offset=+0x0498");
                            }
                        }
                    }
                }

                if (Obj->IsA(SDK::AArchonGameState::StaticClass())) {
                    int32_t* Field = reinterpret_cast<int32_t*>(
                        reinterpret_cast<uintptr_t>(Obj) + 0x02E8);
                    if (IsReadablePointer(Field, sizeof(int32_t))) {
                        int32_t Before = *Field;
                        if (Before != 0) {
                            *Field = 0;
                            if (!s_loggedGameState) {
                                s_loggedGameState = true;
                                MpLog("[ExpectedPlayerCount@GameState] zeroed  instance=" + MpPtr(Obj)
                                    + " class=" + Obj->Class->GetName()
                                    + " before=" + std::to_string(Before)
                                    + " after=0"
                                    + " offset=+0x02E8");
                            }
                        }
                    }
                }
            }
        }

        static int netTickTraceBudget = 180;
        int32_t preConnectionCount = -1;
        int32_t preConnectionMax = -1;

        if (Networking::NetDriver &&
            IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Networking::NetDriver) + 0x98), sizeof(int32_t) * 2)) {
            preConnectionCount = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(Networking::NetDriver) + 0x98);
            preConnectionMax = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(Networking::NetDriver) + 0x9C);
        }

        {
            ScriptProfileTickScope ProfileMaintenance(ScriptTickPhase::Maintenance);
            if (preConnectionCount >= 0) {
                TickServerFrameRate(preConnectionCount, DeltaTime);
            }
            TickServerRenderDataRelease();
            TickServerWorkingSetTrim(preConnectionCount);
            TickTrainingLifecycle(preConnectionCount);
            TickServerAfkTimeout();
        }
        ScriptProfileTick();

        {
            static int32_t s_lastConnCount = -2;
            if (preConnectionCount != s_lastConnCount) {
                MpLog("[NetConnEdge] tick=" + std::to_string(tickCounter)
                    + " connCount " + std::to_string(s_lastConnCount)
                    + " -> " + std::to_string(preConnectionCount)
                    + " connMax=" + std::to_string(preConnectionMax)
                    + " NetDriver=" + MpPtr(Networking::NetDriver));

                LogArchonLifecycle(("ConnEdge " + std::to_string(s_lastConnCount) + "->" + std::to_string(preConnectionCount)).c_str());
                s_lastConnCount = preConnectionCount;
            }
        }

        {
            static AArchonGameMode* s_gm = nullptr;
            static uint64_t s_lastFindMs = 0;
            static int32_t s_lastMatchIdx = -0x7fffffff;
            uint64_t nowMs = static_cast<uint64_t>(GetTickCount64());

            bool gmOk = s_gm && IsReadablePointer(s_gm, 0x4A0) && s_gm->IsA(AArchonGameMode::StaticClass());
            if (!gmOk && (nowMs - s_lastFindMs) > 1000) {
                s_lastFindMs = nowMs;
                s_gm = nullptr;
                if (SDK::UObject::GObjects) {
                    const int n = SDK::UObject::GObjects->Num();
                    for (int i = 0; i < n; i++) {
                        SDK::UObject* o = SDK::UObject::GObjects->GetByIndex(i);
                        if (!o || o->IsDefaultObject()) { continue; }
                        if (o->IsA(AArchonGameMode::StaticClass())) { s_gm = reinterpret_cast<AArchonGameMode*>(o); break; }
                    }
                }
                gmOk = s_gm && IsReadablePointer(s_gm, 0x4A0);
            }

            if (gmOk) {
                int32_t idx = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(s_gm) + 0x02C0);
                if (idx != s_lastMatchIdx) {
                    std::string ms = reinterpret_cast<SDK::FName*>(reinterpret_cast<uintptr_t>(s_gm) + 0x02C0)->ToString();
                    MpLog("[MatchStateChange] tick=" + std::to_string(tickCounter) + " -> " + ms
                        + " (idx " + std::to_string(s_lastMatchIdx) + "->" + std::to_string(idx) + ")");
                    LogArchonLifecycle(("MatchState=" + ms).c_str());
                    s_lastMatchIdx = idx;
                }
            }
        }

        bool traceNetTick = VerboseDiag() && netTickTraceBudget > 0;
        if (traceNetTick && netTickTraceBudget > 0) {
            --netTickTraceBudget;
        }

        if (traceNetTick) {
            MpLog("[NetTickTrace] tick=" + std::to_string(tickCounter)
                + " before TickNetworking NetDriver=" + MpPtr(Networking::NetDriver)
                + " connCount=" + std::to_string(preConnectionCount)
                + " connMax=" + std::to_string(preConnectionMax)
                + " GIsServer=" + std::to_string(*(uint8_t*)(Native112::At(Globals::BaseAddress, Native112::Rva_06B5325A)))
                + " GIsClient=" + std::to_string(*(uint8_t*)(Native112::At(Globals::BaseAddress, Native112::Rva_06B53259))));
        }

        Networking::TickNetworking();

        if (traceNetTick) {
            MpLog("[NetTickTrace] tick=" + std::to_string(tickCounter) + " after TickNetworking");
        }

        if (traceNetTick) {
            MpLog("[NetTickTrace] tick=" + std::to_string(tickCounter)
                + " before TickDispatch fn=" + MpAddress(reinterpret_cast<void*>(Native112::At(Globals::BaseAddress, Native112::Rva_00A6F220))));
        }

        static uint64_t s_manualTickFrame = 0;
        const bool SkipManualDriveThisFrame = ManualTickHalfRate() && ((++s_manualTickFrame & 1ull) != 0ull);

        bool tickDispatchOk = true;
        if (SkipManualDriveThisFrame) {
            tickDispatchOk = false;
        }
        else if (!SanitizeNetDriverClientConnections(Networking::NetDriver, "GameEngineTickBeforeTickDispatch")) {
            MpLog("[NetTickTrace] tick=" + std::to_string(tickCounter)
                + " skipped TickDispatch after sanitizing unsafe NetDriver state");
            tickDispatchOk = false;
        }

        else if (![&] {
            ScriptProfileTickScope ProfileDispatch(ScriptTickPhase::Dispatch);
            return SafeManualTickDispatch(Networking::NetDriver,
                ManualTickZeroDeltaTime() ? 0.0f : DeltaTime);
        }()) {
            ReportManualNetTickFailure(false, tickCounter);
            tickDispatchOk = false;
        }
        else {
            ReportManualNetTickRecovery(false, tickCounter);
        }

        if (traceNetTick) {
            int32_t postConnectionCount = -1;
            if (Networking::NetDriver &&
                IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Networking::NetDriver) + 0x98), sizeof(int32_t))) {
                postConnectionCount = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(Networking::NetDriver) + 0x98);
            }

            MpLog("[NetTickTrace] tick=" + std::to_string(tickCounter)
                + " after TickDispatch ok=" + std::to_string(tickDispatchOk ? 1 : 0)
                + " connCount=" + std::to_string(postConnectionCount));
        }

        if (traceNetTick) {
            MpLog("[NetTickTrace] tick=" + std::to_string(tickCounter)
                + " before TickFlush fn=" + MpAddress(reinterpret_cast<void*>(Native112::At(Globals::BaseAddress, Native112::Rva_03D91DC0))));
        }

        bool tickFlushOk = true;
        if (SkipManualDriveThisFrame) {
            tickFlushOk = false;
        }
        else if (!SanitizeNetDriverClientConnections(Networking::NetDriver, "GameEngineTickBeforeTickFlush")) {
            MpLog("[NetTickTrace] tick=" + std::to_string(tickCounter)
                + " skipped TickFlush after sanitizing unsafe NetDriver state");
            tickFlushOk = false;
        }
        else if (![&] {
            ScriptProfileTickScope ProfileFlush(ScriptTickPhase::Flush);
            return SafeManualTickFlush(Networking::NetDriver, DeltaTime);
        }()) {
            ReportManualNetTickFailure(true, tickCounter);
            tickFlushOk = false;
        }
        else {
            ReportManualNetTickRecovery(true, tickCounter);
        }

        if (traceNetTick) {
            MpLog("[NetTickTrace] tick=" + std::to_string(tickCounter)
                + " after TickFlush ok=" + std::to_string(tickFlushOk ? 1 : 0));
        }

        static bool netDiagLogged = false;
        if (!netDiagLogged) {
            netDiagLogged = true;
            MpLog(std::string("[NetDiag] GIsServer=") + std::to_string(*(uint8_t*)(Native112::At(Globals::BaseAddress, Native112::Rva_06B5325A)))
                + " GIsClient=" + std::to_string(*(uint8_t*)(Native112::At(Globals::BaseAddress, Native112::Rva_06B53259))));
        }
    }

    if (Globals::DoListen) {
        Globals::DoListen = false;

        MpLog("[GameEngineTick] calling Networking::Listen(port=" + std::to_string(Globals::Port) + ")");
        Networking::Listen(UEngine::GetEngine(), Globals::Port);
        MpLog("[GameEngineTick] Networking::Listen returned OK");

        Globals::Listening = true;
        MpLog("[GameEngineTick] Listening armed; skipping post-listen watchdog this tick");

        StartEmptyWatchdogThread();
        return;
    }

    if (Globals::Listening && Networking::NetDriver) {
        bool HasConnection = false;

        auto ClientConnectionData = *reinterpret_cast<UNetConnection***>((uintptr_t)Networking::NetDriver + 0x90);
        int32_t ClientConnectionCount = *reinterpret_cast<int32_t*>((uintptr_t)Networking::NetDriver + 0x98);
        int32_t ClientConnectionMax = *reinterpret_cast<int32_t*>((uintptr_t)Networking::NetDriver + 0x9C);

        if (!IsSanePointerArray(ClientConnectionData, ClientConnectionCount, ClientConnectionMax, 1024)) {
            MpLog("[GameEngineTick] Invalid ClientConnections array; skipping watchdog/stamina");
        }
        else {
            for (int32_t Index = 0; Index < ClientConnectionCount; ++Index) {
                UNetConnection* Connection = ClientConnectionData[Index];
                if (!IsReadablePointer(Connection, 0x140)) {
                    continue;
                }

                if (!Connection->OwningActor || *(uint32_t*)((uintptr_t)Connection + 0x134) != 3)
                    continue;

                HasConnection = true;
            }

            if (EnableWatchdog) {

                int EmptyState = GameModeEmptyState();
                bool IsEmpty = (EmptyState == 1) || (EmptyState == -1 && !HasConnection);

                if (IsEmpty) {
                    TotalNoPlayersTime += DeltaTime;

                    if (TotalNoPlayersTime >= 50.0f && g_wdIsHub.load(std::memory_order_relaxed) == 0) {

                        MpReapExit(("tick-path: disposable instance empty 50s continuous (gmState="
                            + std::to_string(EmptyState) + ")").c_str());
                    }
                }
                else {

                    TotalNoPlayersTime = 0.0f;
                }
            }

            ScriptProfileTickScope ProfilePlayerUpkeep(ScriptTickPhase::PlayerUpkeep);
            for (int32_t Index = 0; Index < ClientConnectionCount; ++Index) {
                UNetConnection* Conn = ClientConnectionData[Index];
                if (!IsReadablePointer(Conn, 0x140)) {
                    continue;
                }

                if (Conn->PlayerController && Conn->PlayerController->Pawn && Conn->PlayerController->Pawn->IsA(ABP_PlayerCharacter_C::StaticClass())) {
                    // With the server tick filter the character's own ReceiveTick runs TickStamina.
                    if (!ServerTickFilterEnabled()) {
                        ((ABP_PlayerCharacter_C*)Conn->PlayerController->Pawn)->TickStamina(ECityExecFilter::Both, ERemoteExecFilter::All);
                    }

                    if (PlayerRepBoost()) {
                        AActor* pawn = Conn->PlayerController->Pawn;
                        if (IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(pawn) + 0x110), 4)) {
                            *reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(pawn) + 0x108) = 60.0f;
                            *reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(pawn) + 0x10C) = 30.0f;
                        }
                    }
                }
            }
        }
    }
}

void InteractionCalloutHideHoldTextHook(void* Widget) {
    if (!IsReadablePointer(Widget, 0x3C8)) {
        MpLog("[InteractionCalloutHideHoldText] skipping unreadable widget=" + MpPtr(Widget));
        return;
    }

    void* HoldTextController = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Widget) + 0x3C0);
    if (!IsReadablePointer(HoldTextController, sizeof(void*))) {
        MpLog("[InteractionCalloutHideHoldText] skipping null/unreadable widget+0x3C0 widget="
            + MpPtr(Widget)
            + " member=" + MpPtr(HoldTextController));
        return;
    }

    reinterpret_cast<void(*)(void*)>(OrigInteractionCalloutHideHoldText)(Widget);
}

void ArchonLoadingScreenFadeInHook(void* LoadingScreen, uint8_t FadeMode) {
    void* PrimaryFadeWidget = nullptr;
    void* SecondaryFadeWidget = nullptr;

    if (IsReadablePointer(LoadingScreen, 0x3F0)) {
        PrimaryFadeWidget = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(LoadingScreen) + 0x3E8);
        SecondaryFadeWidget = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(LoadingScreen) + 0x3E0);
    }

    const bool WidgetsValid =
        LoadingScreen != nullptr &&
        PrimaryFadeWidget != nullptr &&
        SecondaryFadeWidget != nullptr &&
        IsReadablePointer(PrimaryFadeWidget, sizeof(void*)) &&
        IsReadablePointer(SecondaryFadeWidget, sizeof(void*));

    if (!WidgetsValid) {
        MpLog("[ArchonLoadingScreenFadeIn] suppressed (null-widget guard) loadingScreen="
            + MpPtr(LoadingScreen)
            + " primary(+0x3E8)=" + MpPtr(PrimaryFadeWidget)
            + " secondary(+0x3E0)=" + MpPtr(SecondaryFadeWidget)
            + " mode=" + std::to_string(FadeMode));
        return;
    }

    static bool s_loggedMode[256] = {};
    if (!s_loggedMode[FadeMode]) {
        s_loggedMode[FadeMode] = true;
        MpLog("[ArchonLoadingScreenFadeIn] pass-through (widgets valid) loadingScreen="
            + MpPtr(LoadingScreen)
            + " primary(+0x3E8)=" + MpPtr(PrimaryFadeWidget)
            + " secondary(+0x3E0)=" + MpPtr(SecondaryFadeWidget)
            + " mode=" + std::to_string(FadeMode)
            + " -> calling original");
    }

    reinterpret_cast<void(*)(void*, uint8_t)>(OrigArchonLoadingScreenFadeIn)(LoadingScreen, FadeMode);
}
