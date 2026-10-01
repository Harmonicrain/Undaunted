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
 * Hunt Pass selector. In October 2026 the server half of core/EngineTick.cpp
 * moved here as named steps, without its unused experiments. Not an official release of
 * Mystic Paradox or Undaunted.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "server/ServerTick.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "core/PlayerRoles.h"
#include "server/PlayerRoleRouting.h"
#include "core/Settings.h"
#include "diagnostics/ExitTrace.h"
#include "diagnostics/ScriptProfile.h"
#include "server/AfkTimeout.h"
#include "server/Bleedout.h"
#include "server/FrameWait.h"
#include "server/Networking.h"
#include "server/RenderData.h"
#include "server/Replication.h"
#include "server/TickFilter.h"
#include "server/TrainingLifecycle.h"
#include "server/WorkingSet.h"
#include "server/WorldLifecycle.h"
#include "server/WorldState.h"
#include "server/WorldWatchdog.h"
#include <psapi.h>

// A world server's frame, around the engine's own tick (UGameEngine::Tick):
//   before   pin the server globals and the net driver
//   engine   UGameEngine::Tick
//   after    player role upkeep, maintenance (frame rate, memory, Training
//            Grounds sleep, AFK timeout), the net driver's dispatch and flush,
//            starting to listen, the empty-world watchdog and player upkeep

void* OrigGameEngineTick = nullptr;

namespace {
struct ManualNetTickFailureState {
    bool Active = false;
    uint64_t LastReportMs = 0;
    uint64_t FailuresSinceReport = 0;
};

void* g_regWorld = nullptr;
void* g_deferredWorld = nullptr;
void* g_rejectedWorld = nullptr;

bool RegisterNetDriverInLevelCollections() {
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

    void* gengine = IsReadablePointer(reinterpret_cast<void*>(Native112::At(Globals::BaseAddress, Native112::GEngine)), 8)
        ? *reinterpret_cast<void**>(Native112::At(Globals::BaseAddress, Native112::GEngine)) : nullptr;
    uint64_t nm = *reinterpret_cast<uint64_t*>(reinterpret_cast<uintptr_t>(Networking::NetDriver) + 0x190);
    void* reResolve = (gengine && IsReadablePointer(gengine, 0xC48))
        ? reinterpret_cast<void* (*)(void*, void*, uint64_t)>(Native112::At(Globals::BaseAddress, Native112::EngineFindNamedNetDriver))(gengine, w, nm) : nullptr;
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

// The net driver belongs to this world under the name GameNetDriver, with no
// server connection of its own (it is the server). Checked before the engine
// tick and before the runtime's dispatch, since the engine can reset them.
void PinNetDriver() {
    if (!Globals::Listening || !Networking::NetDriver || !IsReadablePointer(Networking::NetDriver, 0x2B0)) return;
    UWorld* World = UWorld::GetWorld();
    if (!World || !IsReadablePointer(World, 0x40)) return;
    static const FName GameNetDriverName = UKismetStringLibrary::Conv_StringToName(L"GameNetDriver");
    RegisterNetDriverInLevelCollections();
    Networking::NetDriver->World = World;
    Networking::NetDriver->NetDriverName = GameNetDriverName;
    Networking::NetDriver->ServerConnection = nullptr;
}

// GIsServer on and GIsClient off, as a dedicated server has them; startup sets
// them (Init and the startup patches), and they are pinned around the engine
// tick as well.
void PinServerRoleGlobals() {
    *reinterpret_cast<uint8_t*>(Native112::At(Globals::BaseAddress, Native112::GIsServer)) = 0x1;
    *reinterpret_cast<uint8_t*>(Native112::At(Globals::BaseAddress, Native112::GIsClient)) = 0x0;
}

static ManualNetTickFailureState g_TickDispatchFailureState;

static ManualNetTickFailureState g_TickFlushFailureState;

void ReportManualNetTickFailure(bool IsFlush, uint64_t Tick) {
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

void ReportManualNetTickRecovery(bool IsFlush, uint64_t Tick) {
    ManualNetTickFailureState& State = IsFlush ? g_TickFlushFailureState : g_TickDispatchFailureState;
    if (!State.Active) return;

    const char* Phase = IsFlush ? "TickFlush" : "TickDispatch";
    MpLog("[NetTickFault] " + std::string(Phase) + " recovered at tick=" + std::to_string(Tick)
        + " unreportedFailures=" + std::to_string(State.FailuresSinceReport));
    State = {};
}

int NetTickExceptionFilter(const char* Tag, unsigned int Code, EXCEPTION_POINTERS* ExceptionInfo) {
    if (ExceptionInfo && IsReadablePointer(ExceptionInfo, sizeof(EXCEPTION_POINTERS)) &&
        IsReadablePointer(ExceptionInfo->ExceptionRecord, sizeof(EXCEPTION_RECORD))) {
        LogExceptionRecord(Tag, ExceptionInfo->ExceptionRecord,
            IsReadablePointer(ExceptionInfo->ContextRecord, sizeof(CONTEXT)) ? ExceptionInfo->ContextRecord : nullptr);
    }
    else {
        EXCEPTION_RECORD Record{};
        Record.ExceptionCode = Code;
        Record.ExceptionAddress = _ReturnAddress();
        LogExceptionRecord(Tag, &Record, nullptr);
    }
    return EXCEPTION_EXECUTE_HANDLER;
}

// UNetDriver::TickDispatch or TickFlush, which the runtime runs itself each
// frame; an exception is logged and the frame goes on.
bool SafeNetDriverTick(uintptr_t Rva, const char* Tag, UNetDriver* NetDriver, float DeltaTime) {
    using NetDriverTickFn = void(*)(UNetDriver*, float);
    __try {
        reinterpret_cast<NetDriverTickFn>(Native112::At(Globals::BaseAddress, Rva))(NetDriver, DeltaTime);
        return true;
    }
    __except (NetTickExceptionFilter(Tag, GetExceptionCode(), GetExceptionInformation())) {
        return false;
    }
}

// World servers log their frame statistics once a minute, so a world's cost can
// be read from its log: frames per second, the average and worst frame, and how
// much of each frame is the engine's tick versus this runtime's own work.
LARGE_INTEGER g_PerfFrequency{};
int64_t g_PerfLastEntry = 0, g_PerfWindowStart = 0, g_PerfEngineTicks = 0, g_PerfHookTicks = 0, g_PerfMaxFrameTicks = 0;
uint64_t g_PerfFrames = 0;

void RecordServerFrame(int64_t Entry, int64_t EngineTicks) {
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
void TickServerFrameRate(int32_t Connections, float DeltaTime) {
    static const int ActiveFps = Settings::Int(L"ServerFPS", 90, 1, 240, 90);
    static const int IdleFps = Settings::Int(L"IdleFPS", 10, 1, 240, 10);
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

// ExpectedPlayerCount on the game mode (+0x498) and game state (+0x2E8) is
// kept at zero.
void ZeroExpectedPlayerCounts() {
    static bool s_loggedGameMode = false;
    static bool s_loggedGameState = false;
    if (SDK::UObject* Obj = CurrentGameMode()) {
        int32_t* Field = reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(Obj) + 0x0498);
        if (IsReadablePointer(Field, sizeof(int32_t)) && *Field != 0) {
            const int32_t Before = *Field;
            *Field = 0;
            if (!s_loggedGameMode) {
                s_loggedGameMode = true;
                MpLog("[ExpectedPlayerCount@GameMode] zeroed  instance=" + MpPtr(Obj)
                    + " class=" + Obj->Class->GetName() + " before=" + std::to_string(Before) + " after=0 offset=+0x0498");
            }
        }
    }
    if (SDK::UObject* Obj = CurrentGameState()) {
        int32_t* Field = reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(Obj) + 0x02E8);
        if (IsReadablePointer(Field, sizeof(int32_t)) && *Field != 0) {
            const int32_t Before = *Field;
            *Field = 0;
            if (!s_loggedGameState) {
                s_loggedGameState = true;
                MpLog("[ExpectedPlayerCount@GameState] zeroed  instance=" + MpPtr(Obj)
                    + " class=" + Obj->Class->GetName() + " before=" + std::to_string(Before) + " after=0 offset=+0x02E8");
            }
        }
    }
}

// Logs connection count changes and the game mode's match state changes.
void LogConnectionAndMatchChanges(uint64_t Tick, int32_t Connections, int32_t ConnectionMax) {
    static int32_t s_lastConnCount = -2;
    if (Connections != s_lastConnCount) {
        MpLog("[NetConnEdge] tick=" + std::to_string(Tick) + " connCount " + std::to_string(s_lastConnCount)
            + " -> " + std::to_string(Connections) + " connMax=" + std::to_string(ConnectionMax)
            + " NetDriver=" + MpPtr(Networking::NetDriver));
        LogArchonLifecycle(("ConnEdge " + std::to_string(s_lastConnCount) + "->" + std::to_string(Connections)).c_str());
        s_lastConnCount = Connections;
    }
    static int32_t s_lastMatchIdx = -0x7fffffff;
    SDK::AArchonGameMode* GameMode = CurrentGameMode();
    if (!GameMode || !IsReadablePointer(GameMode, 0x4A0)) return;
    const int32_t Index = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(GameMode) + 0x02C0);
    if (Index == s_lastMatchIdx) return;
    const std::string MatchState = reinterpret_cast<SDK::FName*>(reinterpret_cast<uintptr_t>(GameMode) + 0x02C0)->ToString();
    MpLog("[MatchStateChange] tick=" + std::to_string(Tick) + " -> " + MatchState
        + " (idx " + std::to_string(s_lastMatchIdx) + "->" + std::to_string(Index) + ")");
    LogArchonLifecycle(("MatchState=" + MatchState).c_str());
    s_lastMatchIdx = Index;
}

// The net driver's dispatch (receive) and flush (send), which the runtime runs
// each frame. -UndauntedDiag=verbose traces the first 180 frames.
void TickNetDriver(uint64_t Tick, float DeltaTime, int32_t Connections) {
    static int TraceFramesLeft = 180;
    static const bool Verbose = Settings::Diag(L"verbose");
    const bool Trace = Verbose && TraceFramesLeft > 0;
    if (Trace) --TraceFramesLeft;

    PinNetDriver();
    Networking::LogReplicationGraphState();

    if (!SanitizeNetDriverClientConnections(Networking::NetDriver, "GameEngineTickBeforeTickDispatch")) {
        MpLog("[NetTickTrace] tick=" + std::to_string(Tick) + " skipped TickDispatch after sanitizing unsafe NetDriver state");
    }
    else {
        bool Ok;
        {
            ScriptProfileTickScope ProfileDispatch(ScriptTickPhase::Dispatch);
            Ok = SafeNetDriverTick(Native112::NetDriverTickDispatch, "ManualTickDispatchSEH", Networking::NetDriver, DeltaTime);
        }
        if (Ok) ReportManualNetTickRecovery(false, Tick); else ReportManualNetTickFailure(false, Tick);
        if (Trace) MpLog("[NetTickTrace] tick=" + std::to_string(Tick) + " TickDispatch ok=" + std::to_string(Ok ? 1 : 0)
            + " connCount " + std::to_string(Connections));
    }

    if (!SanitizeNetDriverClientConnections(Networking::NetDriver, "GameEngineTickBeforeTickFlush")) {
        MpLog("[NetTickTrace] tick=" + std::to_string(Tick) + " skipped TickFlush after sanitizing unsafe NetDriver state");
    }
    else {
        bool Ok;
        {
            ScriptProfileTickScope ProfileFlush(ScriptTickPhase::Flush);
            Ok = SafeNetDriverTick(Native112::NetDriverTickFlush, "ManualTickFlushSEH", Networking::NetDriver, DeltaTime);
        }
        if (Ok) ReportManualNetTickRecovery(true, Tick); else ReportManualNetTickFailure(true, Tick);
        if (Trace) MpLog("[NetTickTrace] tick=" + std::to_string(Tick) + " TickFlush ok=" + std::to_string(Ok ? 1 : 0));
    }
}

// Once listening: maintenance, logs and the net driver.
void TickListeningWorld(uint64_t Tick, float DeltaTime) {
    ZeroExpectedPlayerCounts();

    int32_t Connections = -1;
    int32_t ConnectionMax = -1;
    if (Networking::NetDriver
        && IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Networking::NetDriver) + 0x98), sizeof(int32_t) * 2)) {
        Connections = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(Networking::NetDriver) + 0x98);
        ConnectionMax = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(Networking::NetDriver) + 0x9C);
    }
    {
        ScriptProfileTickScope ProfileMaintenance(ScriptTickPhase::Maintenance);
        if (Connections >= 0) TickServerFrameRate(Connections, DeltaTime);
        TickServerRenderDataRelease();
        TickServerWorkingSetTrim(Connections);
        TickTrainingLifecycle(Connections);
        TickServerAfkTimeout();
    }
    ScriptProfileTick();
    LogConnectionAndMatchChanges(Tick, Connections, ConnectionMax);
    TickNetDriver(Tick, DeltaTime, Connections);
}

// Creates the net driver and listens on the world's port, once the world is up.
void StartListening() {
    Globals::DoListen = false;
    MpLog("[GameEngineTick] calling Networking::Listen(port=" + std::to_string(Globals::Port) + ")");
    Networking::Listen(UEngine::GetEngine(), Globals::Port);
    MpLog("[GameEngineTick] Networking::Listen returned OK");
    Globals::Listening = true;
    StartWorldWatchdogThread();
}

// The empty-world watchdog, the bleed-out duration and watch, and each
// connected player's stamina (unless the player's own tick runs it) and
// replication rate.
void TickConnections(float DeltaTime) {
    auto ClientConnectionData = *reinterpret_cast<UNetConnection***>((uintptr_t)Networking::NetDriver + 0x90);
    int32_t ClientConnectionCount = *reinterpret_cast<int32_t*>((uintptr_t)Networking::NetDriver + 0x98);
    int32_t ClientConnectionMax = *reinterpret_cast<int32_t*>((uintptr_t)Networking::NetDriver + 0x9C);
    if (!IsSanePointerArray(ClientConnectionData, ClientConnectionCount, ClientConnectionMax, 1024)) {
        MpLog("[GameEngineTick] Invalid ClientConnections array; skipping watchdog/stamina");
        return;
    }

    bool HasConnection = false;
    for (int32_t Index = 0; Index < ClientConnectionCount; ++Index) {
        UNetConnection* Connection = ClientConnectionData[Index];
        if (!IsReadablePointer(Connection, 0x140)) continue;
        if (Connection->OwningActor && *(uint32_t*)((uintptr_t)Connection + 0x134) == 3) HasConnection = true;
    }
    TickWorldWatchdog(DeltaTime, HasConnection);
    if (SDK::AArchonGameMode* GameMode = CurrentGameMode()) EnsureBleedoutDuration(GameMode);
    TickBleedoutWatch();

    ScriptProfileTickScope ProfilePlayerUpkeep(ScriptTickPhase::PlayerUpkeep);
    for (int32_t Index = 0; Index < ClientConnectionCount; ++Index) {
        UNetConnection* Conn = ClientConnectionData[Index];
        if (!IsReadablePointer(Conn, 0x140)) continue;
        if (!Conn->PlayerController || !Conn->PlayerController->Pawn
            || !Conn->PlayerController->Pawn->IsA(ABP_PlayerCharacter_C::StaticClass())) continue;
        // With the server tick filter the character's own ReceiveTick runs TickStamina.
        if (!ServerTickFilterEnabled()) {
            ((ABP_PlayerCharacter_C*)Conn->PlayerController->Pawn)->TickStamina(ECityExecFilter::Both, ERemoteExecFilter::All);
        }
        // NetUpdateFrequency 60, MinNetUpdateFrequency 30 (as the player
        // character's class default gets in SetReplicationDriverHook).
        AActor* Pawn = Conn->PlayerController->Pawn;
        if (IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Pawn) + 0x110), 4)) {
            *reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(Pawn) + 0x108) = 60.0f;
            *reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(Pawn) + 0x10C) = 30.0f;
        }
    }
}
}

void GameEngineTickHook(UGameEngine* GameEngine, float DeltaTime, char CanRender) {
    static uint64_t Tick = 0;
    ++Tick;
    LARGE_INTEGER PerfEntry; QueryPerformanceCounter(&PerfEntry);
    int64_t PerfEngineTicks = 0;
    struct FRecordFrameOnExit {
        const LARGE_INTEGER& Entry; int64_t& Engine;
        ~FRecordFrameOnExit() { RecordServerFrame(Entry.QuadPart, Engine); }
    } RecordFrameOnExit{ PerfEntry, PerfEngineTicks };

    const DWORD ThreadId = GetCurrentThreadId();
    if (InterlockedCompareExchange(reinterpret_cast<volatile LONG*>(&GameTickThreadId), static_cast<LONG>(ThreadId), 0) == 0) {
        MpLog("[GameEngineTick] first entry GameEngine=" + MpPtr(GameEngine) + " DeltaTime=" + std::to_string(DeltaTime)
            + " CanRender=" + std::to_string(static_cast<int>(CanRender)) + " DoListen=" + std::to_string(Globals::DoListen ? 1 : 0)
            + " Listening=" + std::to_string(Globals::Listening ? 1 : 0) + " tid=" + std::to_string(ThreadId));
    }

    PinServerRoleGlobals();
    PinNetDriver();

    LARGE_INTEGER PerfEngineStart; QueryPerformanceCounter(&PerfEngineStart);
    reinterpret_cast<void(*)(UGameEngine*, float, char)>(OrigGameEngineTick)(GameEngine, DeltaTime, CanRender);
    LARGE_INTEGER PerfEngineEnd; QueryPerformanceCounter(&PerfEngineEnd);
    PerfEngineTicks = PerfEngineEnd.QuadPart - PerfEngineStart.QuadPart;
    ScriptProfileEngineTick(PerfEngineTicks);

    TickBleedoutDiagnostic();
    if ((Tick & 0x3F) == 0) {
        TickPlayerRoleRetries();
        TickPlayerRolePostActivationRefresh();
        TickTempestModifierEnsure();
    }
    if ((Tick & 0x7) == 0) TickTempestChargeDiag();
    PinServerRoleGlobals();

    if (Globals::Listening) TickListeningWorld(Tick, DeltaTime);

    if (Globals::DoListen) {
        StartListening();
        return;
    }

    if (Globals::Listening && Networking::NetDriver) TickConnections(DeltaTime);
}
