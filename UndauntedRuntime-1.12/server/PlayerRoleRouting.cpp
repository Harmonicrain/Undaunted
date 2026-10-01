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
 * Hunt Pass selector. In October 2026 this was split out of core/PlayerRoles.cpp. Not an official release of
 * Mystic Paradox or Undaunted.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "server/PlayerRoleRouting.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "core/Settings.h"
#include "diagnostics/PlayerRoleDiagnostics.h"
#include "server/Networking.h"
#include "server/ServerEvents.h"

// A world server's side of player roles: the role actor is routed to its
// owner's connection in the replication graph, refreshed once it is fully
// active, and Tempest roles get their modifiers re-applied when they are lost.

struct PlayerRoleGraphActorInfo {
    void* Actor;
    SDK::FName StreamingLevelName;
    void* Class;
};

struct PlayerRoleGraphRoute {
    void* Actor = nullptr;
    void* Node = nullptr;
    void* Connection = nullptr;
    uint64_t ActiveSeenMs = 0;
    uint64_t LastRefreshMs = 0;
    int RefreshAttempts = 0;
    bool WasFullyActive = false;
    bool PostActiveRefreshComplete = false;
};

struct TempestModifierEnsureEntry {
    void* PlayerRole = nullptr;
    uint64_t ActiveSeenMs = 0;
    uint64_t LastRepairMs = 0;
    uint64_t LastStateLogMs = 0;
    int RepairAttempts = 0;
    bool InUse = false;
};

struct TempestRawUeArray {
    void* Data;
    int32_t Num;
    int32_t Max;
};

struct TempestChargeDiagEntry {
    void* PlayerRole = nullptr;
    bool InUse = false;
    int LastCanActivate = -99;
    int LastChargeMilli = INT32_MIN;
    uint64_t LastHeartbeatMs = 0;
};

static int RoutePlayerRoleToOwningConnectionRaw(void* PlayerRole, void** OutConnection,
                                                 void** OutGraph, void** OutNode,
                                                 int* OutBootstrapResult);
static void RoutePlayerRoleToOwningConnection(void* PlayerRole);
static void NoteTempestModifierRole(void* PlayerRole);
static bool DispatchTempestModifierApply(void* PlayerRole, uintptr_t ArrayOffset,
                                         const char* FunctionName, const char* Kind);
static void NoteTempestChargeDiagRole(void* PlayerRole);

static_assert(sizeof(PlayerRoleGraphActorInfo) == 0x18, "1.12 FNewReplicatedActorInfo layout drift");

static PlayerRoleGraphRoute s_playerRoleGraphRoutes[64]{};

static int RoutePlayerRoleToOwningConnectionRaw(void* PlayerRole, void** OutConnection,
                                                 void** OutGraph, void** OutNode,
                                                 int* OutBootstrapResult) {
    if (OutConnection) *OutConnection = nullptr;
    if (OutGraph) *OutGraph = nullptr;
    if (OutNode) *OutNode = nullptr;
    if (OutBootstrapResult) *OutBootstrapResult = 0;
    __try {
        if (!PlayerRole || !Networking::NetDriver || !IsReadablePointer(PlayerRole, 0x100)
            || !IsReadablePointer(Networking::NetDriver, 0x6F0)) return 0;

        uintptr_t VTable = *reinterpret_cast<uintptr_t*>(PlayerRole);
        if (!VTable || !IsReadablePointer(reinterpret_cast<void*>(VTable + 0x4C0), 8)) return 0;
        void* GetNetConnectionFn = *reinterpret_cast<void**>(VTable + 0x4C0);
        if (!GetNetConnectionFn) return 0;
        void* Connection = reinterpret_cast<void*(*)(void*)>(GetNetConnectionFn)(PlayerRole);
        if (OutConnection) *OutConnection = Connection;
        if (!Connection || !IsReadablePointer(Connection, 0x140)) return 0;

        void* Graph = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Networking::NetDriver) + 0x6E8);
        if (OutGraph) *OutGraph = Graph;
        if (!Graph || !IsReadablePointer(Graph, 0x4C8)) return 0;
        if (*reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Graph) + 0x30)
            != reinterpret_cast<void*>(Networking::NetDriver)) return 0;

        void* Node = reinterpret_cast<void*(*)(void*, void*)>(Native112::At(Globals::BaseAddress, Native112::RepGraphFindConnectionManager))(Graph, Connection);
        if (OutNode) *OutNode = Node;
        if (!Node || !IsReadablePointer(Node, 0x20)) return 0;

        for (PlayerRoleGraphRoute& Existing : s_playerRoleGraphRoutes) {
            if (Existing.Actor == PlayerRole && Existing.Node == Node) {
                Existing.Connection = Connection;

                const int BootstrapResult = Networking::BootstrapActorChannel(
                    reinterpret_cast<AActor*>(PlayerRole), reinterpret_cast<UNetConnection*>(Connection));
                if (OutBootstrapResult) *OutBootstrapResult = BootstrapResult;
                return 2;
            }
        }

        int FreeSlot = -1;
        for (int i = 0; i < static_cast<int>(std::size(s_playerRoleGraphRoutes)); ++i) {
            if (!s_playerRoleGraphRoutes[i].Actor && FreeSlot < 0) FreeSlot = i;
        }
        if (FreeSlot < 0) return 0;

        void** NodeVTable = *reinterpret_cast<void***>(Node);
        if (!NodeVTable || !IsReadablePointer(NodeVTable + (0x270 / 8), 8)) return 0;
        void* NotifyAdd = NodeVTable[0x270 / 8];
        if (!NotifyAdd) return 0;

        PlayerRoleGraphActorInfo Info{};
        Info.Actor = PlayerRole;
        Info.StreamingLevelName = SDK::FName();
        Info.Class = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(PlayerRole) + 0x10);
        reinterpret_cast<void(*)(void*, const PlayerRoleGraphActorInfo&)>(NotifyAdd)(Node, Info);
        s_playerRoleGraphRoutes[FreeSlot] = { PlayerRole, Node, Connection };

        const int BootstrapResult = Networking::BootstrapActorChannel(reinterpret_cast<AActor*>(PlayerRole),
            reinterpret_cast<UNetConnection*>(Connection));
        if (OutBootstrapResult) *OutBootstrapResult = BootstrapResult;
        return 1;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return -1;
    }
}

static void RoutePlayerRoleToOwningConnection(void* PlayerRole) {
    if (!Globals::AmServer || !PlayerRole) return;
    void* Connection = nullptr; void* Graph = nullptr; void* Node = nullptr;
    int BootstrapResult = 0;
    const int Result = RoutePlayerRoleToOwningConnectionRaw(PlayerRole, &Connection, &Graph, &Node,
        &BootstrapResult);
    if (Result == 1 || Result == 2 || Result == -1) {
        MpLog("[PlayerRoleGraphRoute] role=" + MpPtr(PlayerRole)
            + " conn=" + MpPtr(Connection) + " graph=" + MpPtr(Graph) + " node=" + MpPtr(Node)
            + " result=" + (Result == 1 ? std::string("ADDED")
                : (Result == 2 ? std::string("EXISTING_REFRESHED") : std::string("FAULT")))
            + " bootstrap=" + std::to_string(BootstrapResult));
    }
}

static constexpr uint64_t kPlayerRolePostActiveSettleMs = 1500;

static constexpr uint64_t kPlayerRolePostActiveRetryMs = 1500;

static constexpr int kPlayerRolePostActiveMaxAttempts = 3;

void TickPlayerRolePostActivationRefresh() {
    if (!Globals::AmServer || !OrigProcessEvent) return;

    const uint64_t Now = GetTickCount64();
    for (PlayerRoleGraphRoute& Entry : s_playerRoleGraphRoutes) {
        if (!Entry.Actor) continue;
        if (!IsReadablePointer(Entry.Actor, 0x360)
            || !IsReadablePointer(Entry.Connection, 0x140)
            || !IsReadablePointer(Entry.Node, 0x20)) {
            Entry = PlayerRoleGraphRoute{};
            continue;
        }

        const uintptr_t Role = reinterpret_cast<uintptr_t>(Entry.Actor);
        const int Equipped = SafeReadU8At(Role, 0x2F4);
        const int GameplayEquipped = SafeReadU8At(Role, 0x2F5);
        const int ActiveGameplay = SafeReadU8At(Role, 0x2F6);
        const int BpEquipCalled = SafeReadU8At(Role, 0x2F7);
        const bool FullyActive = Equipped == 1 && GameplayEquipped == 1
            && ActiveGameplay == 1 && BpEquipCalled == 1;

        if (!FullyActive) {

            Entry.ActiveSeenMs = 0;
            Entry.LastRefreshMs = 0;
            Entry.RefreshAttempts = 0;
            Entry.WasFullyActive = false;
            Entry.PostActiveRefreshComplete = false;
            continue;
        }

        if (!Entry.WasFullyActive) {
            Entry.WasFullyActive = true;
            Entry.ActiveSeenMs = Now;
            MpLog("[PlayerRolePostActiveRefresh] WAIT role=" + MpPtr(Entry.Actor)
                + " itemId=" + CoreCapFString(reinterpret_cast<void*>(Role + 0x240))
                + " conn=" + MpPtr(Entry.Connection)
                + " settleMs=" + std::to_string(kPlayerRolePostActiveSettleMs)
                + " charge={" + PlayerRoleChargeSummary(Entry.Actor) + "}");
            continue;
        }
        if (Entry.PostActiveRefreshComplete
            || Now - Entry.ActiveSeenMs < kPlayerRolePostActiveSettleMs
            || (Entry.LastRefreshMs != 0 && Now - Entry.LastRefreshMs < kPlayerRolePostActiveRetryMs)) {
            continue;
        }

        if (Entry.RefreshAttempts >= kPlayerRolePostActiveMaxAttempts) {
            Entry.PostActiveRefreshComplete = true;
            MpLog("[PlayerRolePostActiveRefresh] EXHAUSTED role=" + MpPtr(Entry.Actor)
                + " itemId=" + CoreCapFString(reinterpret_cast<void*>(Role + 0x240))
                + " attempts=" + std::to_string(Entry.RefreshAttempts)
                + " charge={" + PlayerRoleChargeSummary(Entry.Actor) + "}");
            continue;
        }

        UObject* RoleObject = reinterpret_cast<UObject*>(Entry.Actor);
        static UFunction* s_FlushNetDormancyFn = nullptr;
        static UFunction* s_ForceNetUpdateFn = nullptr;
        if (RoleObject->Class) {
            if (!s_FlushNetDormancyFn) {
                s_FlushNetDormancyFn = RoleObject->Class->GetFunction("Actor", "FlushNetDormancy");
            }
            if (!s_ForceNetUpdateFn) {
                s_ForceNetUpdateFn = RoleObject->Class->GetFunction("Actor", "ForceNetUpdate");
            }
        }

        const int DormancyBefore = SafeReadU8At(Role, 0xF1);
        const bool FlushDispatched = s_FlushNetDormancyFn != nullptr;
        const bool ForceDispatched = s_ForceNetUpdateFn != nullptr;
        if (s_FlushNetDormancyFn) {
            reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEvent)(
                RoleObject, s_FlushNetDormancyFn, nullptr);
        }
        if (s_ForceNetUpdateFn) {
            reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEvent)(
                RoleObject, s_ForceNetUpdateFn, nullptr);
        }

        Entry.LastRefreshMs = Now;
        ++Entry.RefreshAttempts;
        const int BootstrapResult = Networking::BootstrapActorChannel(
            reinterpret_cast<AActor*>(Entry.Actor),
            reinterpret_cast<UNetConnection*>(Entry.Connection));
        const bool WroteData = BootstrapResult == 2 || BootstrapResult == 3;
        if (WroteData) Entry.PostActiveRefreshComplete = true;

        MpLog("[PlayerRolePostActiveRefresh] PUSH attempt=" + std::to_string(Entry.RefreshAttempts)
            + " role=" + MpPtr(Entry.Actor)
            + " itemId=" + CoreCapFString(reinterpret_cast<void*>(Role + 0x240))
            + " conn=" + MpPtr(Entry.Connection)
            + " activeForMs=" + std::to_string(Now - Entry.ActiveSeenMs)
            + " dormancy=" + std::to_string(DormancyBefore)
            + " flush=" + std::to_string(FlushDispatched ? 1 : 0)
            + " force=" + std::to_string(ForceDispatched ? 1 : 0)
            + " bootstrap=" + std::to_string(BootstrapResult)
            + " wroteData=" + std::to_string(WroteData ? 1 : 0)
            + " complete=" + std::to_string(Entry.PostActiveRefreshComplete ? 1 : 0)
            + " charge={" + PlayerRoleChargeSummary(Entry.Actor) + "}");
    }
}

static TempestModifierEnsureEntry s_tempestModifierEnsure[16]{};

static constexpr uint64_t kTempestModifierSettleMs = 3000;

static constexpr uint64_t kTempestModifierRetryMs = 3500;

static constexpr int kTempestModifierMaxAttempts = 3;

static void NoteTempestModifierRole(void* PlayerRole) {
    if (!Globals::AmServer || !PlayerRole || !IsReadablePointer(PlayerRole, 0x300)) return;
    const std::string ItemId = CoreCapFString(
        reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(PlayerRole) + 0x240));
    if (ItemId != "PR_TEMPEST") return;

    int FreeSlot = -1;
    for (int i = 0; i < static_cast<int>(std::size(s_tempestModifierEnsure)); ++i) {
        TempestModifierEnsureEntry& Entry = s_tempestModifierEnsure[i];
        if (Entry.InUse && Entry.PlayerRole == PlayerRole) return;
        if (!Entry.InUse && FreeSlot < 0) FreeSlot = i;
    }
    if (FreeSlot < 0) {
        MpLog("[TempestModifierEnsure] tracking table full; role=" + MpPtr(PlayerRole));
        return;
    }
    s_tempestModifierEnsure[FreeSlot].PlayerRole = PlayerRole;
    s_tempestModifierEnsure[FreeSlot].InUse = true;
    MpLog("[TempestModifierEnsure] TRACK role=" + MpPtr(PlayerRole)
        + " state={" + PlayerRoleModifierSummary(PlayerRole) + "}");
}

static_assert(sizeof(TempestRawUeArray) == 0x10, "UE TArray layout drift");

static bool DispatchTempestModifierApply(void* PlayerRole, uintptr_t ArrayOffset,
                                         const char* FunctionName, const char* Kind) {
    if (!PlayerRole || !OrigProcessEvent || !IsReadablePointer(PlayerRole, ArrayOffset + 0x10)) {
        MpLog(std::string("[TempestModifierEnsure] ") + Kind + " dispatch prerequisites missing role="
            + MpPtr(PlayerRole) + " origPE=" + MpPtr(OrigProcessEvent));
        return false;
    }

    const TempestRawUeArray Source = *reinterpret_cast<const TempestRawUeArray*>(
        reinterpret_cast<uintptr_t>(PlayerRole) + ArrayOffset);
    if (!Source.Data || Source.Num <= 0 || Source.Num > 256 || Source.Max < Source.Num
        || !IsReadablePointer(Source.Data, 1)) {
        MpLog(std::string("[TempestModifierEnsure] ") + Kind + " catalog array invalid data="
            + MpPtr(Source.Data) + " num=" + std::to_string(Source.Num)
            + " max=" + std::to_string(Source.Max));
        return false;
    }

    UObject* RoleObject = reinterpret_cast<UObject*>(PlayerRole);
    UFunction* ApplyFunction = RoleObject->Class
        ? RoleObject->Class->GetFunction("ArchonEquipment", FunctionName) : nullptr;
    if (!ApplyFunction) {
        MpLog(std::string("[TempestModifierEnsure] ") + Kind + " UFunction missing: " + FunctionName);
        return false;
    }

    TempestRawUeArray Params = Source;
    reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEvent)(
        RoleObject, ApplyFunction, &Params);
    return true;
}

void TickTempestModifierEnsure() {
    if (!Globals::AmServer) return;
    const uint64_t Now = GetTickCount64();

    for (TempestModifierEnsureEntry& Entry : s_tempestModifierEnsure) {
        if (!Entry.InUse) continue;
        void* PlayerRole = Entry.PlayerRole;
        if (!PlayerRole || !IsReadablePointer(PlayerRole, 0x300)) {
            Entry = TempestModifierEnsureEntry{};
            continue;
        }
        const std::string ItemId = CoreCapFString(
            reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(PlayerRole) + 0x240));
        if (ItemId != "PR_TEMPEST") {
            Entry = TempestModifierEnsureEntry{};
            continue;
        }

        const int Equipped = SafeReadU8At(reinterpret_cast<uintptr_t>(PlayerRole), 0x2F4);
        const int GameplayEquipped = SafeReadU8At(reinterpret_cast<uintptr_t>(PlayerRole), 0x2F5);
        const int ActiveGameplay = SafeReadU8At(reinterpret_cast<uintptr_t>(PlayerRole), 0x2F6);
        const int BpEquipCalled = SafeReadU8At(reinterpret_cast<uintptr_t>(PlayerRole), 0x2F7);
        if (Equipped != 1 || GameplayEquipped != 1 || ActiveGameplay != 1 || BpEquipCalled != 1) {
            Entry.ActiveSeenMs = 0;
            continue;
        }

        if (Entry.ActiveSeenMs == 0) {
            Entry.ActiveSeenMs = Now;
            Entry.LastStateLogMs = Now;
            MpLog("[TempestModifierEnsure] ACTIVE_WAIT role=" + MpPtr(PlayerRole)
                + " settleMs=" + std::to_string(kTempestModifierSettleMs)
                + " state={" + PlayerRoleModifierSummary(PlayerRole) + "}");
            continue;
        }
        if (Now - Entry.ActiveSeenMs < kTempestModifierSettleMs) continue;

        const PlayerRoleModifierSnapshot Before = CapturePlayerRoleModifiers(PlayerRole);
        if (!Before.Valid) {
            if (Now - Entry.LastStateLogMs >= 10000) {
                Entry.LastStateLogMs = Now;
                MpLog("[TempestModifierEnsure] INVALID_SNAPSHOT role=" + MpPtr(PlayerRole));
            }
            continue;
        }

        if (Before.DesiredBuffs <= 0 || Before.DesiredAbilities <= 0) {
            if (Now - Entry.LastStateLogMs >= 10000) {
                Entry.LastStateLogMs = Now;
                MpLog("[TempestModifierEnsure] CATALOG_EMPTY role=" + MpPtr(PlayerRole)
                    + " state={" + PlayerRoleModifierSummary(PlayerRole) + "}");
            }
            continue;
        }

        const int AppliedBuffs = Before.Group ? Before.AppliedBuffs : 0;
        const int AppliedAbilities = Before.Group ? Before.AppliedAbilities : 0;
        const int PendingBuffs = Before.Group ? Before.PendingBuffs : 0;
        const int PendingAbilities = Before.Group ? Before.PendingAbilities : 0;

        if (AppliedBuffs > 0 && AppliedAbilities > 0) {
            MpLog("[TempestModifierEnsure] HEALTHY role=" + MpPtr(PlayerRole)
                + " native catalog modifiers already applied; state={"
                + PlayerRoleModifierSummary(PlayerRole) + "}");
            Entry = TempestModifierEnsureEntry{};
            continue;
        }

        if (PendingBuffs > 0 || PendingAbilities > 0) {
            if (Now - Entry.LastStateLogMs >= 10000) {
                Entry.LastStateLogMs = Now;
                MpLog("[TempestModifierEnsure] NATIVE_PENDING role=" + MpPtr(PlayerRole)
                    + " elapsedActiveMs=" + std::to_string(Now - Entry.ActiveSeenMs)
                    + " state={" + PlayerRoleModifierSummary(PlayerRole) + "}");
            }
            continue;
        }

        const bool NeedBuffs = AppliedBuffs <= 0;
        const bool NeedAbilities = AppliedAbilities <= 0;
        if ((!NeedBuffs && !NeedAbilities)
            || (Entry.LastRepairMs != 0 && Now - Entry.LastRepairMs < kTempestModifierRetryMs)) continue;
        if (Entry.RepairAttempts >= kTempestModifierMaxAttempts) {
            MpLog("[TempestModifierEnsure] EXHAUSTED role=" + MpPtr(PlayerRole)
                + " attempts=" + std::to_string(Entry.RepairAttempts)
                + " state={" + PlayerRoleModifierSummary(PlayerRole) + "}");
            Entry = TempestModifierEnsureEntry{};
            continue;
        }

        Entry.LastRepairMs = Now;
        ++Entry.RepairAttempts;
        const bool BuffDispatch = !NeedBuffs || DispatchTempestModifierApply(
            PlayerRole, 0x2A8, "ApplyGameplayBuffsToOwner", "buff");
        const bool AbilityDispatch = !NeedAbilities || DispatchTempestModifierApply(
            PlayerRole, 0x2C8, "ApplyGameplayAbilitiesToOwner", "ability");
        MpLog("[TempestModifierEnsure] REPAIR attempt=" + std::to_string(Entry.RepairAttempts)
            + " role=" + MpPtr(PlayerRole)
            + " requestedBuff=" + std::to_string(NeedBuffs ? 1 : 0)
            + " requestedAbility=" + std::to_string(NeedAbilities ? 1 : 0)
            + " dispatchBuff=" + std::to_string(BuffDispatch ? 1 : 0)
            + " dispatchAbility=" + std::to_string(AbilityDispatch ? 1 : 0)
            + " before={group=" + MpPtr(Before.Group)
            + " appliedBuffs=" + std::to_string(AppliedBuffs)
            + " appliedAbilities=" + std::to_string(AppliedAbilities) + "}"
            + " after={" + PlayerRoleModifierSummary(PlayerRole) + "}");
    }
}

static TempestChargeDiagEntry s_tempestChargeDiag[16]{};

// -UndauntedDiag=tempest: Tempest player roles' charge and activation.
static bool TempestChargeDiag() {
    static const bool Enabled = Settings::Diag(L"tempest");
    return Enabled;
}

static void NoteTempestChargeDiagRole(void* PlayerRole) {
    if (!Globals::AmServer || !PlayerRole || !TempestChargeDiag()) return;
    for (const TempestChargeDiagEntry& E : s_tempestChargeDiag) {
        if (E.InUse && E.PlayerRole == PlayerRole) return;
    }
    for (TempestChargeDiagEntry& E : s_tempestChargeDiag) {
        if (!E.InUse) {
            E = TempestChargeDiagEntry{};
            E.PlayerRole = PlayerRole;
            E.InUse = true;
            MpLog("[TempestChargeDiag] TRACK role=" + MpPtr(PlayerRole)
                + " state={" + PlayerRoleChargeSummary(PlayerRole) + "}");
            return;
        }
    }
}

void TickTempestChargeDiag() {
    if (!Globals::AmServer || !TempestChargeDiag()) return;
    const uint64_t Now = GetTickCount64();
    for (TempestChargeDiagEntry& E : s_tempestChargeDiag) {
        if (!E.InUse) continue;
        void* Role = E.PlayerRole;
        if (!Role || !IsReadablePointer(Role, 0x360) || !IsRegisteredLiveObject(Role)) {
            E = TempestChargeDiagEntry{}; continue;
        }
        const std::string ItemId = CoreCapFString(
            reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Role) + 0x240));
        if (ItemId != "PR_TEMPEST") { E = TempestChargeDiagEntry{}; continue; }

        const float Current = SafeCallPlayerRoleFloat(Role, Native112::PlayerRoleCurrentCharge);
        const float MaxCharge = SafeCallPlayerRoleFloat(Role, Native112::PlayerRoleMaxCharge);
        const int CanActivate = SafeCallPlayerRoleBoolRva(Role, Native112::PlayerRoleCanActivate);
        if (Current <= -9990.0f) continue;
        const int CurMilli = static_cast<int>(Current * 1000.0f);

        const bool Activation = (E.LastChargeMilli != INT32_MIN)
            && (CurMilli < E.LastChargeMilli - 400);
        const bool CanFlip = (E.LastCanActivate != -99) && (CanActivate != E.LastCanActivate);
        const bool Heartbeat = (Now - E.LastHeartbeatMs) >= 5000;

        if (Activation || CanFlip || Heartbeat) {
            const char* Evt = Activation ? "ACTIVATION" : (CanFlip ? "CANACT_FLIP" : "heartbeat");
            const bool ChargeFull = MaxCharge > 0.0f && Current >= MaxCharge - 0.05f;
            const char* StacksHint = (!ChargeFull) ? "unknown(charge<max)"
                : (CanActivate == 1 ? "PRESENT(>=1)" : "ABSENT(0)");
            MpLog(std::string("[TempestChargeDiag] role=") + MpPtr(Role)
                + " event=" + Evt
                + " charge=" + std::to_string(Current) + "/" + std::to_string(MaxCharge)
                + " canActivate=" + std::to_string(CanActivate)
                + " (was " + std::to_string(E.LastCanActivate) + ")"
                + " windFuryStacks=" + StacksHint);
            if (Heartbeat) E.LastHeartbeatMs = Now;
        }
        E.LastChargeMilli = CurMilli;
        if (CanActivate >= 0) E.LastCanActivate = CanActivate;
    }
}

void OnServerPlayerRoleApplied(void* PawnRole) {
    RoutePlayerRoleToOwningConnection(PawnRole);
    NoteTempestModifierRole(PawnRole);
    NoteTempestChargeDiagRole(PawnRole);
}
