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
#include "core/Settings.h"

static int SafeCallGraphServerReplicate(void* graph, float dt);
static void* FindArchonReplicationGraphClass();
static void BoostPlayerCharCDONetFreq();
static APlayerStart* NthPlayerStart(int n);


bool IsNetReadyHook() {
    return true;
}

int NetModeHook(void* a1) {
    return 1;
}

void* OrigSetReplicationDriver = nullptr;

void* OrigServerReplicateActors = nullptr;

bool RepGraphDiag() {
    static const bool Enabled = Settings::Diag(L"repgraph");
    return Enabled;
}

static int SafeCallGraphServerReplicate(void* graph, float dt) {
    __try {
        return reinterpret_cast<int(__fastcall*)(void*, float)>(Native112::At(Globals::BaseAddress, Native112::RepGraphServerReplicateActors))(graph, dt);
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
    static const bool Keep = Settings::Has(L"KeepParkedReplication");
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
    static const bool Keep = Settings::Has(L"KeepQuietReplication");
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
    // The counts below are read only for the repgraph diagnostic.
    const int ancBefore = doLog ? readIntAt(graph, 0x4C0) : -1;

    static int s_sraCalls = 0;
    s_sraCalls++;
    if (doLog) {
        const int connMgrs = readIntAt(graph, 0x40);
        const int clientConns = readIntAt(NetDriver, 0x98);
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
    if (graph && !s_inGraphSRA && graphNetDriver == NetDriver && IsReadablePointer(graph, 0x4C8)) {
        s_inGraphSRA = true;
        ret = SafeCallGraphServerReplicate(graph, DeltaSeconds);
        s_inGraphSRA = false;
        mode = "ArchonDirect";
    } else {
        ret = reinterpret_cast<int(__fastcall*)(void*, float)>(OrigServerReplicateActors)(NetDriver, DeltaSeconds);
        mode = "Original(guard-failed)";
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

// The replication graph class worlds construct: the game's own
// ArchonReplicationGraph, or the engine's BasicReplicationGraph if it is missing.
static void* FindArchonReplicationGraphClass() {
    if (g_ArchonRepGraphSearched) return g_ArchonRepGraphClass;
    g_ArchonRepGraphSearched = true;
    if (!SDK::UObject::GObjects) return nullptr;
    const int Count = SDK::UObject::GObjects->Num();
    void* archonClass = nullptr;
    void* basicClass = nullptr;
    for (int i = 0; i < Count; i++) {
        SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);
        if (!Obj) continue;
        const std::string nm = Obj->GetName();
        if (nm == "ArchonReplicationGraph")           archonClass = Obj;
        else if (nm == "BasicReplicationGraph")       basicClass = Obj;
    }
    g_ArchonRepGraphClass = archonClass ? archonClass : basicClass;
    MpLog("[FindArchonRepGraph] ArchonReplicationGraph=" + MpPtr(archonClass) + " BasicReplicationGraph="
        + MpPtr(basicClass) + " using " + MpPtr(g_ArchonRepGraphClass));
    return g_ArchonRepGraphClass;
}

void* OrigCreateRepDriver = nullptr;

void** g_RepGraphFeatureArrayData = nullptr;

int*   g_RepGraphFeatureArrayNum  = nullptr;

// The world's replication driver is the game's ArchonReplicationGraph, which a
// client build won't create for itself. The hook turns the driver flag on,
// gives the net driver the graph class (+0x178) when it has none, and builds
// the graph with StaticConstructObject in the transient package, with the
// class's abstract flag and the registered graph features (which would add
// client-only helpers) set aside for the call; if that fails, the engine's own
// CreateReplicationDriver runs under the same conditions.
void* __fastcall CreateRepDriverHook(void* NetDriver, void* p2, void* p3) {
    static std::atomic<int> s_crdCount{0};
    const int n = s_crdCount.fetch_add(1, std::memory_order_relaxed);

    if (g_RepDriverEnableFlag && IsReadablePointer(g_RepDriverEnableFlag, 4)) *g_RepDriverEnableFlag = 1u;

    void* GraphClass = nullptr;
    if (NetDriver && IsReadablePointer(NetDriver, 0x200)) {
        void** ClassField = reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(NetDriver) + 0x178);
        if (!*ClassField) {
            if (void* Found = FindArchonReplicationGraphClass()) *ClassField = Found;
        }
        GraphClass = *ClassField;
    }

    int SavedFeatureCount = 0;
    bool SuppressedFeatures = false;
    if (g_RepGraphFeatureArrayNum && IsReadablePointer(g_RepGraphFeatureArrayNum, 4)) {
        SavedFeatureCount = *g_RepGraphFeatureArrayNum;
        if (SavedFeatureCount > 0) {
            *g_RepGraphFeatureArrayNum = 0;
            SuppressedFeatures = true;
        }
    }
    uint32_t SavedClassFlags = 0;
    bool ClearedAbstract = false;
    if (GraphClass && IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(GraphClass) + 0xCC), 4)) {
        uint32_t* Flags = reinterpret_cast<uint32_t*>(reinterpret_cast<uintptr_t>(GraphClass) + 0xCC);
        SavedClassFlags = *Flags;
        if (SavedClassFlags & 0x00000001u) {          // CLASS_Abstract
            *Flags = SavedClassFlags & ~0x00000001u;
            ClearedAbstract = true;
        }
    }
    auto Restore = [&] {
        if (ClearedAbstract) *reinterpret_cast<uint32_t*>(reinterpret_cast<uintptr_t>(GraphClass) + 0xCC) = SavedClassFlags;
        if (SuppressedFeatures) *g_RepGraphFeatureArrayNum = SavedFeatureCount;
    };

    void* Driver = nullptr;
    const char* How = "engine";
    if (NetDriver && GraphClass) {
        void* Package = reinterpret_cast<void*(__fastcall*)()>(Native112::At(Globals::BaseAddress, Native112::GetTransientPackage))();
        void* Params[10] = {};                         // FStaticConstructObjectParameters: Class, Outer
        Params[0] = GraphClass;
        Params[1] = Package;
        Driver = reinterpret_cast<void*(__fastcall*)(void*)>(Native112::At(Globals::BaseAddress, Native112::StaticConstructObjectInternal))(&Params[0]);
        How = "constructed";
    }
    if (!Driver) {
        Driver = reinterpret_cast<void*(__fastcall*)(void*, void*, void*)>(OrigCreateRepDriver)(NetDriver, p2, p3);
        How = NetDriver && GraphClass ? "engine (construction returned null)" : "engine";
    }
    Restore();

    if (n < 6) {
        MpLog("[CreateRepDriverHook #" + std::to_string(n) + "] NetDriver=" + MpPtr(NetDriver)
            + " class=" + SafeObjectNameForDiagnostic(GraphClass) + " driver=" + MpPtr(Driver) + " via " + How
            + " (features set aside " + std::to_string(SuppressedFeatures ? SavedFeatureCount : 0)
            + ", abstract cleared " + std::to_string(ClearedAbstract ? 1 : 0) + ")");
    }
    return Driver;
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
        float* nuf  = reinterpret_cast<float*>(Cdo + 0x108);
        float* mnuf = reinterpret_cast<float*>(Cdo + 0x10C);
        static bool s_logged = false;
        if (!s_logged) { s_logged = true; MpLog("[PlayerRepBoost] CDO NetUpdateFrequency " + std::to_string(*nuf) + " -> 60, MinNetUpdateFrequency " + std::to_string(*mnuf) + " -> 30"); }
        *nuf = 60.0f;
        *mnuf = 30.0f;
    }
}

// Also gives the player character's class default its replication rate
// before the driver is installed.
void SetReplicationDriverHook(UNetDriver* NetDriver, UReplicationDriver* RepDriver) {
    static std::atomic<int> s_setRepDrvCount{0};
    if (s_setRepDrvCount.fetch_add(1, std::memory_order_relaxed) < 16) {
        UObject* DriverClass = (RepDriver && IsReadablePointer(reinterpret_cast<void*>(RepDriver), 0x20))
            ? *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(RepDriver) + 0x10) : nullptr;
        MpLog("[SetReplicationDriverHook] NetDriver=" + MpPtr(NetDriver) + " RepDriver=" + MpPtr(RepDriver)
            + " class=" + SafeObjectNameForDiagnostic(DriverClass));
    }
    BoostPlayerCharCDONetFreq();
    reinterpret_cast<void(*)(UNetDriver*, UReplicationDriver*)>(OrigSetReplicationDriver)(NetDriver, RepDriver);
}

void* OrigGetStartSpot = nullptr;

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
    APlayerStart* Chosen = reinterpret_cast<APlayerStart*(*)(void*, void*, void*)>(OrigGetStartSpot)(a1, a2, a3);
    const char* Mode = "native";
    if (!Chosen) {
        static std::atomic<int> s_fallbackIdx{ 0 };
        Chosen = NthPlayerStart(s_fallbackIdx.fetch_add(1, std::memory_order_relaxed));
        Mode = "fallback";
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
