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

#include "server/Replication.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "diagnostics/ScriptProfile.h"
#include <unordered_map>
#include "server/WorldLifecycle.h"

static bool UseArchonRepGraph();
static bool UseNativeGraph();
static bool DriveArchonGraph();
static bool PlayerAlwaysRelevant();
static int SafeCallGraphServerReplicate(void* graph, float dt);
static bool SraRateCap();
static void* FindArchonReplicationGraphClass();
static bool RepGraphSelfConstruct();
static void BoostPlayerCharCDONetFreq();
static bool NativePlayerStart();
static APlayerStart* NthPlayerStart(int n);

void* OrigHasFinishedLoading = nullptr;

bool DiagNaturalMode() {
    static int cached = -1;
    if (cached < 0) {
        cached = (MpWorkingDirectoryFlagPresent(L".\\debug\\DIAG_NATURAL.flag")) ? 1 : 0;
        MpLog(std::string("[Diag] natural-mode ") + (cached ? "ON (gameplay bypasses DISABLED)" : "off (bypasses active)"));
    }
    return cached == 1;
}

static bool UseArchonRepGraph() {

    static bool s_loggedRepGraph = false;
    if (!s_loggedRepGraph) {
        s_loggedRepGraph = true;
        MpLog("[Phase0f] ReplicationGraph = ArchonReplicationGraph (game's own) [permanent]");
    }
    return true;
}

bool HasFinishedLoadingHook(UObject* a1) {
    bool Ret = reinterpret_cast<bool(*)(UObject*)>(OrigHasFinishedLoading)(a1);

    if (!Ret) {
        if (DiagNaturalMode()) {

            static std::atomic<int> s_hfl{ 0 };
            if (s_hfl.fetch_add(1, std::memory_order_relaxed) < 20)
                MpLog(std::string("[Diag] HasFinishedLoading NOT forced (natural mode) -> false obj=") + a1->GetFullName());
            return false;
        }

        {
            UObject* cls = a1 ? *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(a1) + 0x10) : nullptr;
            std::string cn = (cls && IsReadablePointer(cls, 0x20)) ? cls->GetName() : std::string();
            if (cn == "bp_archon_inventory_C" || cn.find("ArchonInventory") != std::string::npos) {
                static std::atomic<int> s_invReal{ 0 };
                if (s_invReal.fetch_add(1, std::memory_order_relaxed) < 10)
                    MpLog(std::string("[ScopedBypass] inventory NOT forced (real result -> loadout stays pending) obj=") + a1->GetFullName());
                return false;
            }
        }
        if (Globals::EnableLogging)
        std::cout << "[FORCEREADY] " << a1->GetFullName() << std::endl;
        return true;
    }

    return Ret;
}

bool IsNetReadyHook() {
    return true;
}

int NetModeHook(void* a1) {
    return 1;
}

bool IsLevelInitForActorHook(void* a1, char a2) {
    bool real = reinterpret_cast<bool (*)(void*, char)>(OrigIsLevelInitForActor)(a1, a2);

    static bool s_loggedLevelInit = false;
    if (!s_loggedLevelInit) {
        s_loggedLevelInit = true;
        MpLog("[Phase0P] IsLevelInitForActor force DISABLED (respect real visibility) [permanent]");
    }
    return real;
}

void* OrigSetReplicationDriver = nullptr;

void* OrigServerReplicateActors = nullptr;

static bool UseNativeGraph() {
    static int c = -1;
    if (c < 0) c = MpExeRelativeFlagPresent(L"EMERGENCY_LEGACY_REPLICATION.flag") ? 0 : 1;
    return c == 1;
}

bool RepGraphDiag() {
    static int c = -1;
    if (c < 0) c = MpExeRelativeFlagPresent(L"REPGRAPH_DIAG.flag") ? 1 : 0;
    return c == 1;
}

static bool DriveArchonGraph() {
    return UseNativeGraph();
}

bool PlayerRepBoost() {
    static int c = -1;
    if (c < 0) c = MpExeRelativeFlagPresent(L"DISABLE_PLAYER_REP_BOOST.flag") ? 0 : 1;
    return c == 1;
}

static bool PlayerAlwaysRelevant() {
    static int c = -1;
    if (c < 0) c = MpExeRelativeFlagPresent(L"PLAYER_ALWAYS_RELEVANT.flag") ? 1 : 0;
    return c == 1;
}

bool OwnerPawnRelevancyFix() {
    static int c = -1;
    if (c < 0) c = MpExeRelativeFlagPresent(L"DISABLE_OWNER_PAWN_RELEVANCY.flag") ? 0 : 1;
    return c == 1;
}

static int SafeCallGraphServerReplicate(void* graph, float dt) {
    __try {
        return reinterpret_cast<int(__fastcall*)(void*, float)>(Native112::At(Globals::BaseAddress, Native112::Rva_01AB43D0))(graph, dt);
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return -999;
    }
}

void* OrigRepGraphReplicateSingleActor = nullptr;

// Both guards below run for every actor sent to every connection. Checking
// each actor with IsReadablePointer (a VirtualQuery system call) took ~19% of
// a two-player hunting ground's game thread (profile 2026-10-01), yet only
// player controllers are guarded. So the actor is first identified with
// guarded reads, and only player controllers get the full checks.
static bool IsLivePlayerController(void* Actor, SDK::UClass* PlayerControllerClass) {
    __try {
        return Actor && PlayerControllerClass && IsRegisteredLiveObject(Actor)
            && reinterpret_cast<UObject*>(Actor)->IsA(PlayerControllerClass);
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

static void* ChannelActor(UActorChannel* Channel) {
    __try {
        return *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Channel) + 0x70);
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return nullptr;
    }
}

// Undaunted: the connection map comes fifth and the connection manager sixth
// (UReplicationGraph::ReplicateSingleActor, RVA 0x00ECEC50 in 1.12.0: it loads
// its sixth argument at +0x00ECEC81 and reads NetConnection at +0x28 of it at
// +0x00ECECA0). Upstream read them the other way round, so the guard compared
// the controller against a field of the map and blocked the owning connection
// from its own PlayerController, whose components then never replicated.
uint64_t __fastcall RepGraphReplicateSingleActorGuardHook(
    void* Graph, void* Actor, void* ConnActorInfo, void* GlobalInfo,
    void* ActorInfoMap, void* ConnManager, uint32_t Frame) {
    SDK::UClass* const PlayerControllerClass = SDK::APlayerController::StaticClass();
    if (Actor && ConnManager
        && IsLivePlayerController(Actor, PlayerControllerClass)
        && IsReadablePointer(Actor, 0x420)
        && IsReadablePointer(ConnManager, 0x30)) {
        void* Connection = *reinterpret_cast<void**>(
            reinterpret_cast<uintptr_t>(ConnManager) + 0x28);
        void* ConnectionPC = (Connection && IsReadablePointer(Connection, 0xA0))
            ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Connection) + 0x30)
            : nullptr;
        void* OwningActor = (Connection && IsReadablePointer(Connection, 0xA0))
            ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Connection) + 0x98)
            : nullptr;
        void* ActorConnection = *reinterpret_cast<void**>(
            reinterpret_cast<uintptr_t>(Actor) + 0x418);
        const bool ConnectionHasIdentity = ConnectionPC || OwningActor;
        const bool IsRemoteByConnection =
            ActorConnection && Connection && ActorConnection != Connection;
        const bool IsRemoteByIdentity =
            !ActorConnection && ConnectionHasIdentity
            && Actor != ConnectionPC && Actor != OwningActor;

        if (IsRemoteByConnection || IsRemoteByIdentity) {
            static std::atomic<uint32_t> BlockedCount{ 0 };
            const uint32_t Count = BlockedCount.fetch_add(1, std::memory_order_relaxed);
            if (Count < 64) {
                MpLog("[PlayerControllerPreChannelGuard] BLOCK actor=" + MpPtr(Actor)
                    + " actorNetConnection=" + MpPtr(ActorConnection)
                    + " targetConnection=" + MpPtr(Connection)
                    + " targetPC=" + MpPtr(ConnectionPC)
                    + " targetOwningActor=" + MpPtr(OwningActor)
                    + " connManager=" + MpPtr(ConnManager)
                    + " connActorInfo=" + MpPtr(ConnActorInfo)
                    + " globalInfo=" + MpPtr(GlobalInfo)
                    + " frame=" + std::to_string(Frame)
                    + " reason=" + (IsRemoteByConnection
                        ? "actor-netconnection-mismatch"
                        : "target-identity-mismatch")
                    + " result=SKIP_BEFORE_CREATE_CHANNEL");
            }
            return 0;
        }

        static std::atomic<uint32_t> AllowedCount{ 0 };
        if (AllowedCount.fetch_add(1, std::memory_order_relaxed) < 4) {
            MpLog("[PlayerControllerPreChannelGuard] ALLOW actor=" + MpPtr(Actor)
                + " actorNetConnection=" + MpPtr(ActorConnection)
                + " targetConnection=" + MpPtr(Connection)
                + " targetPC=" + MpPtr(ConnectionPC)
                + " frame=" + std::to_string(Frame));
        }
    }

    return reinterpret_cast<uint64_t(__fastcall*)(
        void*, void*, void*, void*, void*, void*, uint32_t)>(
            OrigRepGraphReplicateSingleActor)(
                Graph, Actor, ConnActorInfo, GlobalInfo,
                ActorInfoMap, ConnManager, Frame);
}

// Final fail-closed ownership invariant. The native function returns a 64-bit replication count,
// not bool; preserving the ABI matters because its caller adds this result to its running total.
void* OrigReplicateActorFreq = nullptr;

static void* ActorClassOf(void* Actor) {
    __try {
        return Actor ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Actor) + 0x10) : nullptr;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return nullptr;
    }
}

// The native call, timed per actor class when -UndauntedScriptProfile is on.
static uint64_t CallReplicateActor(UActorChannel* Channel, void* Actor) {
    using ReplicateActorFn = uint64_t(__fastcall*)(UActorChannel*);
    if (!ScriptProfileEnabled()) return reinterpret_cast<ReplicateActorFn>(OrigReplicateActorFreq)(Channel);
    LARGE_INTEGER Start, End;
    QueryPerformanceCounter(&Start);
    const uint64_t Result = reinterpret_cast<ReplicateActorFn>(OrigReplicateActorFreq)(Channel);
    QueryPerformanceCounter(&End);
    ScriptProfileReplicated(ActorClassOf(Actor), End.QuadPart - Start.QuadPart, Result);
    return Result;
}

// Behemoths keep pools of projectiles and loot drops (a Lerawr: 60 rage fire
// projectiles, 30 fire projectiles, 20 shiny and 20 cosmetic drops) hidden
// at the world origin and always relevant, so the replication graph checked
// each of them about 10 times a second for every connection and found
// nothing to send: 4,800 checks a second costing 13.5 ms/s in Emberthorne
// Cove with two Lerawrs and two players (profile 2026-10-01). Once a parked
// actor's check for a channel sends nothing, later checks are skipped until
// it leaves the pool (shown, moved or attached), with one check every 2 s
// regardless. Leaving the pool replicates at once, as before.
//   -UndauntedKeepParkedReplication  checks parked actors as before
namespace {
constexpr uint64_t ParkedRecheckMs = 2000;
struct ParkedChannel { void* Actor; uint64_t LastCheckMs; bool Quiet; };
// Replication runs on the game thread only.
std::unordered_map<void*, ParkedChannel> g_ParkedChannels;
uint64_t g_ParkedSkipped = 0;
uint64_t g_ParkedChecked = 0;

bool KeepParkedReplication() {
    static const bool Keep = wcsstr(GetCommandLineW(), L"-UndauntedKeepParkedReplication") != nullptr;
    return Keep;
}

bool IsParkedInPool(void* Actor) {
    __try {
        const uint8_t* Bytes = reinterpret_cast<const uint8_t*>(Actor);
        if ((Bytes[0x58] & 0x20) == 0) return false;                                    // AActor::bHidden
        const uint8_t* Root = *reinterpret_cast<const uint8_t* const*>(Bytes + 0x130);  // RootComponent
        if (!Root || *reinterpret_cast<void* const*>(Root + 0xC0)) return false;        // AttachParent
        const float* Location = reinterpret_cast<const float*>(Root + 0x11C);          // RelativeLocation
        return Location[0] == 0.0f && Location[1] == 0.0f && Location[2] == 0.0f;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

// Player controllers and behemoth parts are checked every frame (their
// NetUpdateFrequency is 100) but rarely change. A player controller carries
// the player's progression components (quests: 91 series and ~4,500 objects
// under them; mastery, achievements, bounties, the Hunt Pass), so each check
// cost ~135 us and found nothing to send; a part carries an ability system
// component (~9 us). Together 14.6 ms/s in Emberthorne Cove with two players
// (profile 2026-10-01). After a check that sends nothing the next two are
// skipped (10 Hz while quiet); a check that sends something goes back to
// every frame. The first change after a quiet spell can arrive up to 66 ms
// later at 30 fps.
//   -UndauntedKeepQuietReplication  checks them every frame as before
constexpr uint32_t QuietSkips = 2;
struct QuietChannel { void* Actor; uint32_t SkipsLeft; };
std::unordered_map<void*, QuietChannel> g_QuietChannels;
std::unordered_map<void*, bool> g_MonsterPartClasses;
uint64_t g_QuietSkipped = 0;

bool KeepQuietReplication() {
    static const bool Keep = wcsstr(GetCommandLineW(), L"-UndauntedKeepQuietReplication") != nullptr;
    return Keep;
}

bool IsInstanceOf(void* Object, SDK::UClass* Class) {
    __try {
        return Class && reinterpret_cast<UObject*>(Object)->IsA(Class);
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

bool IsMonsterPartActor(void* Actor) {
    void* const Class = ActorClassOf(Actor);
    if (!Class) return false;
    const auto Found = g_MonsterPartClasses.find(Class);
    if (Found != g_MonsterPartClasses.end()) return Found->second;
    const bool IsPart = IsInstanceOf(Actor, SDK::AMonsterPartActor::StaticClass());
    if (g_MonsterPartClasses.size() < 4096) g_MonsterPartClasses[Class] = IsPart;
    return IsPart;
}
}

static uint64_t ReplicateWithSkips(UActorChannel* Channel, void* Actor, bool IsPlayerController) {
    if (!Actor) return CallReplicateActor(Channel, Actor);
    if (KeepParkedReplication() || !IsParkedInPool(Actor)) {
        if (!g_ParkedChannels.empty()) g_ParkedChannels.erase(Channel);
        if (KeepQuietReplication() || (!IsPlayerController && !IsMonsterPartActor(Actor))) {
            return CallReplicateActor(Channel, Actor);
        }
        QuietChannel& Quiet = g_QuietChannels[Channel];
        if (Quiet.Actor != Actor) Quiet = { Actor, 0 };
        if (Quiet.SkipsLeft > 0) {
            --Quiet.SkipsLeft;
            ++g_QuietSkipped;
            return 0;
        }
        const uint64_t Result = CallReplicateActor(Channel, Actor);
        Quiet.SkipsLeft = Result == 0 ? QuietSkips : 0;
        if (g_QuietChannels.size() > 50000) g_QuietChannels.clear();
        return Result;
    }
    const uint64_t NowMs = GetTickCount64();
    ParkedChannel& State = g_ParkedChannels[Channel];
    if (State.Actor != Actor) State = { Actor, 0, false };
    if (State.Quiet && NowMs - State.LastCheckMs < ParkedRecheckMs) {
        ++g_ParkedSkipped;
        return 0;
    }
    const uint64_t Result = CallReplicateActor(Channel, Actor);
    ++g_ParkedChecked;
    State.LastCheckMs = NowMs;
    State.Quiet = Result == 0;
    // Closed channels leave entries behind; never let that grow unbounded.
    if (g_ParkedChannels.size() > 50000) g_ParkedChannels.clear();
    return Result;
}

void LogParkedActorStats() {
    if (g_QuietSkipped != 0) {
        MpLog("[QuietReplication] skipped " + std::to_string(g_QuietSkipped)
            + " checks of player controllers and behemoth parts with nothing to send");
        g_QuietSkipped = 0;
    }
    if (KeepParkedReplication() || (g_ParkedSkipped == 0 && g_ParkedChecked == 0)) return;
    MpLog("[ParkedActors] skipped " + std::to_string(g_ParkedSkipped) + " replication checks of pooled actors, ran "
        + std::to_string(g_ParkedChecked) + ", " + std::to_string(g_ParkedChannels.size()) + " channels tracked");
    g_ParkedSkipped = 0;
    g_ParkedChecked = 0;
}

uint64_t __fastcall ReplicateActorFreqHook(UActorChannel* channel) {
    SDK::UClass* const PlayerControllerClass = SDK::APlayerController::StaticClass();
    void* const ChannelActorPtr = channel ? ChannelActor(channel) : nullptr;
    const bool IsPlayerController = IsLivePlayerController(ChannelActorPtr, PlayerControllerClass);
    if (!IsPlayerController && !RepGraphDiag()) {
        return ReplicateWithSkips(channel, ChannelActorPtr, false);
    }
    if (channel && IsReadablePointer(reinterpret_cast<void*>(channel), 0x78)) {
        void* Actor = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(channel) + 0x70);
        if (Actor && IsReadablePointer(Actor, 0x20)) {
            if (IsPlayerController && Actor == ChannelActorPtr) {
                void* Connection = *reinterpret_cast<void**>(
                    reinterpret_cast<uintptr_t>(channel) + 0x28);
                void* ConnectionPC = (Connection && IsReadablePointer(Connection, 0xA0))
                    ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Connection) + 0x30)
                    : nullptr;
                void* OwningActor = (Connection && IsReadablePointer(Connection, 0xA0))
                    ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Connection) + 0x98)
                    : nullptr;
                void* ActorConnection = IsReadablePointer(Actor, 0x420)
                    ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Actor) + 0x418)
                    : nullptr;
                const bool ConnectionHasIdentity = ConnectionPC || OwningActor;
                const bool IsRemoteByConnection =
                    ActorConnection && Connection && ActorConnection != Connection;
                const bool IsRemoteByIdentity =
                    !ActorConnection && ConnectionHasIdentity
                    && Actor != ConnectionPC && Actor != OwningActor;

                if (IsRemoteByConnection || IsRemoteByIdentity) {
                    static std::atomic<uint32_t> BlockedCount{ 0 };
                    const uint32_t Count = BlockedCount.fetch_add(1, std::memory_order_relaxed);
                    if (Count < 64) {
                        MpLog("[PlayerControllerChannelGuard] BLOCK actor=" + MpPtr(Actor)
                            + " actorNetConnection=" + MpPtr(ActorConnection)
                            + " targetConnection=" + MpPtr(Connection)
                            + " targetPC=" + MpPtr(ConnectionPC)
                            + " targetOwningActor=" + MpPtr(OwningActor)
                            + " reason=" + (IsRemoteByConnection
                                ? "actor-netconnection-mismatch"
                                : "target-identity-mismatch"));
                    }
                    return 0;
                }
            }

            if (!RepGraphDiag()) {
                return ReplicateWithSkips(channel, ChannelActorPtr, IsPlayerController && Actor == ChannelActorPtr);
            }

            void* Class = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Actor) + 0x10);
            if (Class && IsReadablePointer(Class, 0x20)) {
                static std::vector<std::pair<std::string, int>> Counts;
                static uint64_t WindowStartMs = 0;
                std::string ClassName = reinterpret_cast<UObject*>(Class)->GetName();
                bool Found = false;
                for (auto& Entry : Counts) {
                    if (Entry.first == ClassName) {
                        Entry.second++;
                        Found = true;
                        break;
                    }
                }
                if (!Found && Counts.size() < 64) {
                    Counts.push_back(std::make_pair(ClassName, 1));
                }
                uint64_t Now = static_cast<uint64_t>(GetTickCount64());
                if (WindowStartMs == 0) WindowStartMs = Now;
                if (Now - WindowStartMs > 1000) {
                    std::string Line;
                    for (auto& Entry : Counts) {
                        Line += " " + Entry.first + "=" + std::to_string(Entry.second);
                    }
                    MpLog("[RepFreq] window=" + std::to_string(Now - WindowStartMs)
                        + "ms reps/class:" + Line);
                    Counts.clear();
                    WindowStartMs = Now;
                }
            }
        }
    }
    return CallReplicateActor(channel, ChannelActorPtr);
}

static bool SraRateCap() {
    static int c = -1;
    if (c < 0) {
        c = MpExeRelativeFlagPresent(L"SRA_RATE_CAP.flag") ? 1 : 0;
        MpLog(std::string("[SraRateCap] SRA_RATE_CAP.flag ")
            + (c ? "PRESENT -> ServerReplicateActors coalesced to NetServerMaxTickRate (SRA ~= configured "
                   "net rate). TickDispatch/handshakes untouched -> server stays joinable. Watch [SRA enter]."
                 : "absent -> SRA runs every TickFlush (default; ~engine frame rate)."));
    }
    return c == 1;
}

int __fastcall ServerReplicateActorsHook(void* NetDriver, float DeltaSeconds) {
    static uint64_t s_lastMs = 0;
    uint64_t now = static_cast<uint64_t>(GetTickCount64());
    bool doLog = RepGraphDiag() && (now - s_lastMs) > 1000;

    void* graph = (NetDriver && IsReadablePointer(reinterpret_cast<void*>((uintptr_t)NetDriver + 0x6F0), 8))
                  ? *reinterpret_cast<void**>((uintptr_t)NetDriver + 0x6E8) : nullptr;
    auto readIntAt = [](void* base, uintptr_t off) -> int {
        return (base && IsReadablePointer(reinterpret_cast<void*>((uintptr_t)base + off), 4))
               ? *reinterpret_cast<int*>((uintptr_t)base + off) : -1;
    };
    int ancBefore   = readIntAt(graph, 0x4C0);
    int connMgrs    = readIntAt(graph, 0x40);
    int clientConns = readIntAt(NetDriver, 0x98);

    if (SraRateCap()) {
        static uint64_t s_lastSraDispatchMs = 0;
        int maxRate = readIntAt(NetDriver, 0x58);
        if (maxRate > 0) {
            double minIntervalMs = (1000.0 / static_cast<double>(maxRate)) * 0.9;
            if (s_lastSraDispatchMs != 0 && static_cast<double>(now - s_lastSraDispatchMs) < minIntervalMs) {
                return 0;
            }
            s_lastSraDispatchMs = now;
        }
    }

    static int s_sraCalls = 0;
    s_sraCalls++;
    if (doLog) {
        uint64_t elapsed = now - s_lastMs;
        float sraHz = (elapsed > 0) ? (s_sraCalls * 1000.0f / static_cast<float>(elapsed)) : 0.0f;
        int nstr = readIntAt(NetDriver, 0x58);
        int mntr = readIntAt(NetDriver, 0x5C);
        s_lastMs = now;
        s_sraCalls = 0;
        MpLog("[SRA enter] NetDriver=" + MpPtr(NetDriver) + " RepDriver=" + MpPtr(graph)
            + " ActorsNoConn_before=" + std::to_string(ancBefore)
            + " ConnMgrs=" + std::to_string(connMgrs) + " ClientConns=" + std::to_string(clientConns)
            + " | SRA=" + std::to_string(sraHz) + "Hz NetServerMaxTickRate=" + std::to_string(nstr)
            + " MaxNetTickRate=" + std::to_string(mntr));
    }

    void* graphNetDriver = (graph && IsReadablePointer(graph, 0x38)) ? *reinterpret_cast<void**>((uintptr_t)graph + 0x30) : nullptr;
    static thread_local bool s_inGraphSRA = false;
    int ret;
    const char* mode;
    if (DriveArchonGraph() && graph && !s_inGraphSRA && graphNetDriver == NetDriver && IsReadablePointer(graph, 0x4C8)) {
        s_inGraphSRA = true;
        ret = SafeCallGraphServerReplicate(graph, DeltaSeconds);
        s_inGraphSRA = false;
        mode = "ArchonDirect";
    } else {
        ret = reinterpret_cast<int(__fastcall*)(void*, float)>(OrigServerReplicateActors)(NetDriver, DeltaSeconds);
        mode = DriveArchonGraph() ? "Original(guard-failed)" : "Original";
    }

    if (doLog) {
        int ancAfter = readIntAt(graph, 0x4C0);
        MpLog(std::string("[SRA exit ] mode=") + mode + " ret=" + std::to_string(ret)
            + " ActorsNoConn " + std::to_string(ancBefore) + " -> " + std::to_string(ancAfter)
            + " graph.NetDriver=" + MpPtr(graphNetDriver));
    }
    return ret;
}

uint32_t* g_RepDriverEnableFlag = nullptr;

static void*    g_ArchonRepGraphClass = nullptr;

static bool     g_ArchonRepGraphSearched = false;

static void* FindArchonReplicationGraphClass() {
    if (g_ArchonRepGraphSearched) return g_ArchonRepGraphClass;
    g_ArchonRepGraphSearched = true;
    if (!SDK::UObject::GObjects) return nullptr;
    const int Count = SDK::UObject::GObjects->Num();

    void* archonClass = nullptr;
    void* basicClass = nullptr;
    void* concreteArchonSubclass = nullptr;
    for (int i = 0; i < Count; i++) {
        SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);
        if (!Obj) continue;
        const std::string nm = Obj->GetName();
        if (nm == "ArchonReplicationGraph")           archonClass = Obj;
        else if (nm == "BasicReplicationGraph")       basicClass = Obj;

    }

    std::string report;
    report += "archonClass=" + MpPtr(archonClass);
    report += " basicClass=" + MpPtr(basicClass);
    report += " concreteArchonSubclass=" + MpPtr(concreteArchonSubclass);
    MpLog("[FindArchonRepGraph] candidates: " + report);

    void* chosen;
    if (UseArchonRepGraph() && archonClass) {
        chosen = archonClass;
    } else {
        chosen = concreteArchonSubclass ? concreteArchonSubclass
               : (basicClass ? basicClass
                              : archonClass);
    }
    if (chosen) {
        uintptr_t base = reinterpret_cast<uintptr_t>(chosen);

        std::string wideProbe;
        for (uintptr_t off = 0xA0; off <= 0x120; off += 4) {
            if (IsReadablePointer(reinterpret_cast<void*>(base + off), 4)) {
                uint32_t v = *reinterpret_cast<uint32_t*>(base + off);
                if (v != 0) {
                    char b[32]; _snprintf_s(b, _TRUNCATE, "+0x%02llX=0x%08X", (long long)off, v);
                    if (!wideProbe.empty()) wideProbe += " ";
                    wideProbe += b;
                }
            }
        }
        SDK::UObject* co = reinterpret_cast<SDK::UObject*>(chosen);
        MpLog(std::string("[FindArchonRepGraph] chose ") + co->GetName()
            + " ptr=" + MpPtr(chosen)
            + " metaclass=" + (co->Class ? co->Class->GetName() : "(null)")
            + " nonzero-dwords: " + wideProbe);

        void* transientPkg = nullptr;
        uintptr_t transAddr = Native112::At(Globals::BaseAddress, Native112::Rva_06B8BC00);
        if (IsReadablePointer(reinterpret_cast<void*>(transAddr), 8)) {
            transientPkg = *reinterpret_cast<void**>(transAddr);
        }
        std::string pkgName = "(null-package)";
        if (transientPkg && IsReadablePointer(transientPkg, 0x20)) {
            SDK::UObject* pkg = reinterpret_cast<SDK::UObject*>(transientPkg);
            pkgName = pkg->GetName();
        }
        MpLog(std::string("[FindArchonRepGraph] TransientPackage @ RVA_0x06B8BC00 = ")
            + MpPtr(transientPkg) + " (" + pkgName + ")");

        void* cdoPtr = nullptr;
        if (IsReadablePointer(reinterpret_cast<void*>(base + 0x118), 8)) {
            cdoPtr = *reinterpret_cast<void**>(base + 0x118);
        }
        std::string cdoName = "(null)";
        if (cdoPtr && IsReadablePointer(cdoPtr, 0x20)) {
            cdoName = reinterpret_cast<SDK::UObject*>(cdoPtr)->GetName();
        }
        MpLog(std::string("[FindArchonRepGraph] ClassDefaultObject(+0x118)=") + MpPtr(cdoPtr) + " (" + cdoName + ")");
    } else {
        MpLog("[FindArchonRepGraph] NOTHING found in GObjects (Count=" + std::to_string(Count) + ")");
    }
    g_ArchonRepGraphClass = chosen;
    return g_ArchonRepGraphClass;
}

void* OrigCreateRepDriver = nullptr;

void** g_RepGraphFeatureArrayData = nullptr;

int*   g_RepGraphFeatureArrayNum  = nullptr;

static bool RepGraphSelfConstruct() {
    return UseNativeGraph();
}

void* __fastcall CreateRepDriverHook(void* NetDriver, void* p2, void* p3) {
    static std::atomic<int> s_crdCount{0};
    int n = s_crdCount.fetch_add(1, std::memory_order_relaxed);

    if (g_RepDriverEnableFlag && IsReadablePointer(g_RepDriverEnableFlag, 4)) {
        uint32_t before = *g_RepDriverEnableFlag;
        *g_RepDriverEnableFlag = 1u;
        if (n < 3) MpLog("[CreateRepDriverHook #" + std::to_string(n) + "] "
            "forced RepDriverEnable flag: before=" + std::to_string(before)
            + " after=1  addr=" + MpPtr(g_RepDriverEnableFlag));
    }

    if (n < 3 && g_RepGraphFeatureArrayNum && IsReadablePointer(g_RepGraphFeatureArrayNum, 4)) {
        int num = *g_RepGraphFeatureArrayNum;
        void* data0 = (g_RepGraphFeatureArrayData && IsReadablePointer(g_RepGraphFeatureArrayData, 8))
                       ? *g_RepGraphFeatureArrayData : nullptr;
        std::string helperClass = "(null)";
        void* firstHelper = nullptr;
        if (data0 && num > 0 && IsReadablePointer(data0, 8)) {
            firstHelper = *reinterpret_cast<void**>(data0);
            if (firstHelper && IsReadablePointer(firstHelper, 0x20)) {
                UObject* cls = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(firstHelper) + 0x10);
                if (cls && IsReadablePointer(cls, 0x20)) helperClass = cls->GetName();
            }
        }
        MpLog("[CreateRepDriverHook #" + std::to_string(n) + "] "
            "RepGraphFeature array: count=" + std::to_string(num)
            + " data[0]=" + MpPtr(firstHelper) + " (" + helperClass + ")");
    }

    void*  beforeCls = nullptr;
    void*  afterCls  = nullptr;
    if (NetDriver && IsReadablePointer(NetDriver, 0x200)) {
        void** classField = reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(NetDriver) + 0x178);
        beforeCls = *classField;
        if (!beforeCls) {
            void* cls = FindArchonReplicationGraphClass();
            if (cls) {
                *classField = cls;
                afterCls = cls;
            }
        } else {
            afterCls = beforeCls;
        }
    }

    if (n < 6) {
        std::string clsName = "(null)";
        if (afterCls && IsReadablePointer(afterCls, 0x20)) {
            clsName = reinterpret_cast<UObject*>(afterCls)->GetName();
        }
        MpLog("[CreateRepDriverHook #" + std::to_string(n) + "] NetDriver=" + MpPtr(NetDriver)
            + " NetDriver+0x178 before=" + MpPtr(beforeCls) + " after=" + MpPtr(afterCls)
            + " (" + clsName + ")");
    }

    int savedCount = 0;
    bool didSuppress = false;
    if (g_RepGraphFeatureArrayNum && IsReadablePointer(g_RepGraphFeatureArrayNum, 4)) {
        savedCount = *g_RepGraphFeatureArrayNum;
        if (savedCount > 0) {
            *g_RepGraphFeatureArrayNum = 0;
            didSuppress = true;
        }
    }

    if (n < 3 && afterCls && IsReadablePointer(afterCls, 0x130)) {
        std::stringstream ss;
        for (uintptr_t off = 0x40; off <= 0x120; off += 4) {
            uint32_t v = *reinterpret_cast<uint32_t*>(reinterpret_cast<uintptr_t>(afterCls) + off);
            ss << "+0x" << std::hex << off << "=0x" << v << " ";
        }

        void* cdo = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(afterCls) + 0x118);
        std::string cdoName = "(null)";
        if (cdo && IsReadablePointer(cdo, 0x20)) cdoName = reinterpret_cast<UObject*>(cdo)->GetName();
        MpLog("[CreateRepDriverHook #" + std::to_string(n) + "] classConstructScan afterCls=" + MpPtr(afterCls)
            + " CDO(+0x118)=" + MpPtr(cdo) + " (" + cdoName + ")  " + ss.str());
    }

    uint32_t savedClassFlags = 0;
    bool didClearAbstract = false;
    if (afterCls && IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(afterCls) + 0xCC), 4)) {
        uint32_t* flagsPtr = reinterpret_cast<uint32_t*>(reinterpret_cast<uintptr_t>(afterCls) + 0xCC);
        savedClassFlags = *flagsPtr;
        if (savedClassFlags & 0x00000001u) {
            *flagsPtr = savedClassFlags & ~0x00000001u;
            didClearAbstract = true;
        }
    }

    if (RepGraphSelfConstruct() && NetDriver && afterCls) {

        int fcount = (g_RepGraphFeatureArrayNum && IsReadablePointer(g_RepGraphFeatureArrayNum, 4))
                     ? *g_RepGraphFeatureArrayNum : -1;
        void* pkg = reinterpret_cast<void*(__fastcall*)()>(Native112::At(Globals::BaseAddress, Native112::Rva_02659120))();
        void* params[10] = {};
        params[0] = afterCls;
        params[1] = pkg;
        void* obj = reinterpret_cast<void*(__fastcall*)(void*)>(Native112::At(Globals::BaseAddress, Native112::Rva_026CEC20))(&params[0]);
        std::string on = "(null)";
        if (obj && IsReadablePointer(obj, 0x20)) {
            UObject* c = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(obj) + 0x10);
            if (c && IsReadablePointer(c, 0x20)) on = c->GetName();
        }
        std::string pn = "(null)";
        if (pkg && IsReadablePointer(pkg, 0x20)) pn = reinterpret_cast<UObject*>(pkg)->GetName();
        MpLog("[RGSelf #" + std::to_string(n) + "] featureCount=" + std::to_string(fcount)
            + " pkg=" + MpPtr(pkg) + " (" + pn + ") cls=" + MpPtr(afterCls)
            + " -> StaticConstructObject=" + MpPtr(obj) + " (" + on + ")");
        if (obj) {
            if (didClearAbstract && afterCls) {
                *reinterpret_cast<uint32_t*>(reinterpret_cast<uintptr_t>(afterCls) + 0xCC) = savedClassFlags;
            }
            if (didSuppress) *g_RepGraphFeatureArrayNum = savedCount;
            MpLog("[RGSelf #" + std::to_string(n) + "] installing self-constructed driver " + MpPtr(obj));
            return obj;
        }
        MpLog("[RGSelf #" + std::to_string(n) + "] self-construct returned null; falling back to Orig");
    }

    void* ret = reinterpret_cast<void*(__fastcall*)(void*, void*, void*)>(OrigCreateRepDriver)(NetDriver, p2, p3);

    if (didClearAbstract && afterCls) {
        uint32_t* flagsPtr = reinterpret_cast<uint32_t*>(reinterpret_cast<uintptr_t>(afterCls) + 0xCC);
        *flagsPtr = savedClassFlags;
    }
    if (didSuppress) *g_RepGraphFeatureArrayNum = savedCount;

    if (n < 6) {
        std::string retClass = "(null)";
        if (ret && IsReadablePointer(ret, 0x20)) {
            UObject* cls = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(ret) + 0x10);
            if (cls && IsReadablePointer(cls, 0x20)) retClass = cls->GetName();
        }
        MpLog("[CreateRepDriverHook #" + std::to_string(n) + "] Orig returned=" + MpPtr(ret)
            + " (" + retClass + ")  suppressedHelper=" + (didSuppress ? "1" : "0")
            + "  clearedAbstract=" + (didClearAbstract ? "1" : "0")
            + "  savedFlags=0x" + [&]{ char b[16]; _snprintf_s(b, _TRUNCATE, "%08X", savedClassFlags); return std::string(b); }());
    }
    return ret;
}

static void* g_PlayerCharCDO = nullptr;

static bool  g_PlayerCharCDOSearched = false;

static void BoostPlayerCharCDONetFreq() {
    if (!g_PlayerCharCDOSearched) {
        g_PlayerCharCDOSearched = true;
        if (SDK::UObject::GObjects) {
            const int Count = SDK::UObject::GObjects->Num();
            for (int i = 0; i < Count; i++) {
                SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);
                if (!Obj) continue;
                if (Obj->GetName() == "Default__BP_PlayerCharacter_C") { g_PlayerCharCDO = Obj; break; }
            }
        }
        MpLog(std::string("[PlayerRepBoost] Default__BP_PlayerCharacter_C CDO = ") + MpPtr(g_PlayerCharCDO));
    }
    if (g_PlayerCharCDO && IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(g_PlayerCharCDO) + 0x110), 4)) {
        uintptr_t Cdo = reinterpret_cast<uintptr_t>(g_PlayerCharCDO);
        if (PlayerRepBoost()) {
            float* nuf  = reinterpret_cast<float*>(Cdo + 0x108);
            float* mnuf = reinterpret_cast<float*>(Cdo + 0x10C);
            static bool s_logged = false;
            if (!s_logged) { s_logged = true; MpLog("[PlayerRepBoost] CDO NetUpdateFrequency " + std::to_string(*nuf) + " -> 60, MinNetUpdateFrequency " + std::to_string(*mnuf) + " -> 30"); }
            *nuf = 60.0f;
            *mnuf = 30.0f;
        }
        if (PlayerAlwaysRelevant() && IsReadablePointer(reinterpret_cast<void*>(Cdo + 0x58), 1)) {

            uint8_t* flags = reinterpret_cast<uint8_t*>(Cdo + 0x58);
            static bool s_arLogged = false;
            if (!s_arLogged) { s_arLogged = true; MpLog("[PlayerAlwaysRelevant] CDO bAlwaysRelevant byte(+0x58)=0x" + std::to_string(*flags) + " -> set bit3"); }
            *flags |= 0x08;
        }
    }
}

void SetReplicationDriverHook(UNetDriver* NetDriver, UReplicationDriver* RepDriver) {
    static std::atomic<int> s_setRepDrvCount{0};
    int n = s_setRepDrvCount.fetch_add(1, std::memory_order_relaxed);

    if (n < 16) {
        std::string clsName = "(null-driver)";
        if (RepDriver && IsReadablePointer(reinterpret_cast<void*>(RepDriver), 0x20)) {
            UObject* CLS = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(RepDriver) + 0x10);
            if (CLS && IsReadablePointer(CLS, 0x20)) {
                clsName = reinterpret_cast<UObject*>(CLS)->GetName();
            } else {
                clsName = "(no-class)";
            }
        }
        MpLog("[SetReplicationDriverHook #" + std::to_string(n) + "] NetDriver=" + MpPtr(NetDriver)
            + " RepDriver=" + MpPtr(RepDriver) + " class=" + clsName);
    }
    if (PlayerRepBoost() || PlayerAlwaysRelevant()) BoostPlayerCharCDONetFreq();
    reinterpret_cast<void(*)(UNetDriver*, UReplicationDriver*)>(OrigSetReplicationDriver)(NetDriver, RepDriver);

    if (n < 16 && RepDriver && IsReadablePointer(reinterpret_cast<void*>(RepDriver), 0xB8)) {
        uintptr_t g = reinterpret_cast<uintptr_t>(RepDriver);
        void* gDriver    = *reinterpret_cast<void**>(g + 0x30);
        void* connMgrCls = *reinterpret_cast<void**>(g + 0x28);
        int globalNodes  = *reinterpret_cast<int*>(g + 0xA0);
        int prepNodes    = *reinterpret_cast<int*>(g + 0xB0);
        int connMgrs     = *reinterpret_cast<int*>(g + 0x40);
        int pendConns    = *reinterpret_cast<int*>(g + 0x50);
        void* ndWorld    = (NetDriver && IsReadablePointer(reinterpret_cast<void*>((uintptr_t)NetDriver + 0x148), 8))
                           ? *reinterpret_cast<void**>((uintptr_t)NetDriver + 0x140) : nullptr;
        void* ndRepDrv   = (NetDriver && IsReadablePointer(reinterpret_cast<void*>((uintptr_t)NetDriver + 0x6F0), 8))
                           ? *reinterpret_cast<void**>((uintptr_t)NetDriver + 0x6E8) : nullptr;
        std::string sub = "";
        if (IsReadablePointer(reinterpret_cast<void*>(g), 0x4C8)) {
            void* gridNode  = *reinterpret_cast<void**>(g + 0x498);
            void* alwaysRel = *reinterpret_cast<void**>(g + 0x4A0);
            int arfc        = *reinterpret_cast<int*>(g + 0x4B0);
            int actorsNoC   = *reinterpret_cast<int*>(g + 0x4C0);
            sub = " GridNode=" + MpPtr(gridNode) + " AlwaysRelevantNode=" + MpPtr(alwaysRel)
                + " ARFCList=" + std::to_string(arfc) + " ActorsNoConn=" + std::to_string(actorsNoC);
        }
        MpLog("[SetReplicationDriverHook #" + std::to_string(n) + "] POST-INSTALL graph=" + MpPtr(RepDriver)
            + " graph.NetDriver=" + MpPtr(gDriver) + " ConnMgrClass=" + MpPtr(connMgrCls)
            + " GlobalGraphNodes=" + std::to_string(globalNodes) + " PrepareNodes=" + std::to_string(prepNodes)
            + " ConnMgrs=" + std::to_string(connMgrs) + " PendingConns=" + std::to_string(pendConns)
            + sub
            + " | NetDriver.World=" + MpPtr(ndWorld) + " NetDriver.RepDriver=" + MpPtr(ndRepDrv));
    }
    return;
}

void* OrigGetStartSpot = nullptr;

static bool NativePlayerStart() {

    return true;
}

static APlayerStart* NthPlayerStart(int n) {
    if (!SDK::UObject::GObjects) { return nullptr; }
    const int Num = SDK::UObject::GObjects->Num();
    int Total = 0;
    for (int i = 0; i < Num; i++) {
        SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);
        if (Obj && !Obj->IsDefaultObject() && Obj->IsA(SDK::APlayerStart::StaticClass())) { Total++; }
    }
    if (Total == 0) { return nullptr; }
    const int Target = ((n % Total) + Total) % Total;
    int Idx = 0;
    for (int i = 0; i < Num; i++) {
        SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);
        if (Obj && !Obj->IsDefaultObject() && Obj->IsA(SDK::APlayerStart::StaticClass())) {
            if (Idx == Target) { return (APlayerStart*)Obj; }
            Idx++;
        }
    }
    return nullptr;
}

APlayerStart* GetStartSpotHook(void* a1, void* a2, void* a3) {
    APlayerStart* Chosen = nullptr;
    const char* Mode = "forced";

    if (NativePlayerStart()) {
        Chosen = reinterpret_cast<APlayerStart*(*)(void*, void*, void*)>(OrigGetStartSpot)(a1, a2, a3);
        Mode = "native";
        if (!Chosen) {
            static std::atomic<int> s_fallbackIdx{ 0 };
            Chosen = NthPlayerStart(s_fallbackIdx.fetch_add(1, std::memory_order_relaxed));
            Mode = "fallback";
        }
    } else {
        Chosen = NthPlayerStart(0);
    }

    static std::atomic<int> s_psLog{ 0 };
    if (s_psLog.fetch_add(1, std::memory_order_relaxed) < 40) {
        void* netConn = (a2 && IsReadablePointer(a2, 0x420)) ? *reinterpret_cast<void**>((uintptr_t)a2 + 0x418) : nullptr;
        std::string startName = (Chosen && IsReadablePointer(Chosen, 0x40)) ? reinterpret_cast<UObject*>(Chosen)->GetName() : std::string("null");
        std::string pcName = (a2 && IsReadablePointer(a2, 0x40)) ? reinterpret_cast<UObject*>(a2)->GetName() : std::string("?");
        MpLog(std::string("[PlayerStart] mode=") + Mode + " pc=" + MpPtr(a2) + "/" + pcName
            + " netConn=" + MpPtr(netConn) + " chose=" + MpPtr(Chosen) + "/" + startName);
    }
    return Chosen;
}
