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

#include "core/PlayerRoles.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "client/GameplayHUD.h"
#include "client/ClientEvents.h"
#include "core/EngineTick.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "diagnostics/RuntimeDiagnostics.h"
#include "server/ServerEvents.h"

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

struct PendingPlayerRoleRetry {
    void* LoadoutPtr = nullptr;
    uint64_t FirstSeenInvalidMs = 0;
    uint64_t LastRetryMs = 0;
    int RetryCount = 0;
    bool InUse = false;
};

static int RoutePlayerRoleToOwningConnectionRaw(void* PlayerRole, void** OutConnection,
                                                 void** OutGraph, void** OutNode,
                                                 int* OutBootstrapResult);
static void RoutePlayerRoleToOwningConnection(void* PlayerRole);
static void NoteTempestModifierRole(void* PlayerRole);
static bool DispatchTempestModifierApply(void* PlayerRole, uintptr_t ArrayOffset,
                                         const char* FunctionName, const char* Kind);
static void NoteTempestChargeDiagRole(void* PlayerRole);
static void GetPlayerRoleAndSlot(void* LoadoutPtr, void** OutRole, void** OutSlot);
static bool IsPlayerRoleAppliedToPawn(void* LoadoutPtr, void** OutRole = nullptr, void** OutSlot = nullptr,
                                     void** OutPawn = nullptr, void** OutPawnRole = nullptr);
static void NotePlayerRoleValidity(void* LoadoutPtr, bool AppliedToPawn);
static bool TryApplyPlayerRoleRetryGuarded(
    void* LoadoutPtr, void** OutRole, void** OutSlot, void** OutPawn, void** OutPawnRole,
    bool* OutAppliedBefore, bool* OutAppliedAfter);
static void RefreshPlayerRoleGameplayLifecycle(UObject* PC, const char* TriggerLabel);

UObject* s_LastPossessedPC = nullptr;

UObject* s_LastRestartPawn = nullptr;

uint64_t s_LastPossessedAtMs = 0;

bool s_ArchonInputActivated = false;

void TriggerArchonInputActivation(UObject* PC, const char* TriggerLabel) {
    uint8_t onlineReady = SafeReadByte(reinterpret_cast<uintptr_t>(PC), 0xC59, 0xEE);

    if (onlineReady != 1) {

        bool wrote = SafeWriteByte(reinterpret_cast<uintptr_t>(PC), 0xC59, 1);
        uint8_t after = SafeReadByte(reinterpret_cast<uintptr_t>(PC), 0xC59, 0xEE);
        MpLog(std::string("[ArchonInputActivate] trigger=") + TriggerLabel + " Force-set bOnlineDataReady: "
            + "was=" + std::to_string(onlineReady)
            + " wrote=" + (wrote ? "ok" : "FAIL")
            + " after=" + std::to_string(after)
            + " PC=" + PC->GetFullName());

        if (after != 1) {

            return;
        }

    }

    s_ArchonInputActivated = true;

    MpLog(std::string("[ArchonInputActivate] trigger=") + TriggerLabel + " PC=" + PC->GetFullName()
        + " bOnlineDataReady@0xC59=1 (forced or natural)");

    static UFunction* s_EnableCharacterInputFn = nullptr;
    if (!s_EnableCharacterInputFn) {
        s_EnableCharacterInputFn = PC->Class->GetFunction("ArchonPlayerController", "EnableCharacterInput");
        MpLog(std::string("[ArchonInputActivate] Resolve EnableCharacterInput  → ")
            + MpPtr(s_EnableCharacterInputFn));
    }
    if (s_EnableCharacterInputFn) {
        struct { bool bEnableInput; } enableCharParms = { true };
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            PC, s_EnableCharacterInputFn, &enableCharParms);
        MpLog("[ArchonInputActivate] Called AArchonPlayerController::EnableCharacterInput(true)");
    }

    static UFunction* s_GetLoadoutFn = nullptr;
    if (!s_GetLoadoutFn) {
        s_GetLoadoutFn = PC->Class->GetFunction("ArchonPlayerController", "GetLoadout");
    }
    if (s_GetLoadoutFn) {
        struct { UObject* ReturnValue; } getLoadoutParms = { nullptr };
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            PC, s_GetLoadoutFn, &getLoadoutParms);
        if (getLoadoutParms.ReturnValue) {
            static UFunction* s_SetLoadoutSlotFn = getLoadoutParms.ReturnValue->Class->GetFunction("ArchonLoadout", "ServerInternalSetActiveLoadoutSlotIndex");
            if (s_SetLoadoutSlotFn) {
                struct { int32 InDesiredLoadoutSlotIndex; bool bForceApply; } setSlotParms = { 0, true };
                reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
                    getLoadoutParms.ReturnValue, s_SetLoadoutSlotFn, &setSlotParms);
                MpLog("[ArchonInputActivate] Forced AArchonLoadout::ServerInternalSetActiveLoadoutSlotIndex(0, true)");

                if (OrigApplyPlayerRole) {
                    ApplyPlayerRoleHook(getLoadoutParms.ReturnValue);
                    MpLog("[ArchonInputActivate] Re-applied local PlayerRole after selecting loadout slot 0");

                    RefreshPlayerRoleGameplayLifecycle(PC, "post-apply");
                }
            }
        }
        else {
            MpLog("[ArchonInputActivate] PC->GetLoadout() returned null, unable to force ActiveLoadoutSlotIndex");
        }
    }

    static UFunction* s_ResetIgnoreMoveInputFn = nullptr;
    static UFunction* s_ResetIgnoreLookInputFn = nullptr;
    static UFunction* s_SetCinematicModeFn    = nullptr;
    if (!s_ResetIgnoreMoveInputFn) {
        s_ResetIgnoreMoveInputFn = PC->Class->GetFunction("Controller", "ResetIgnoreMoveInput");
        MpLog(std::string("[ArchonInputActivate] Resolve ResetIgnoreMoveInput → ")
            + MpPtr(s_ResetIgnoreMoveInputFn));
    }
    if (!s_ResetIgnoreLookInputFn) {
        s_ResetIgnoreLookInputFn = PC->Class->GetFunction("Controller", "ResetIgnoreLookInput");
        MpLog(std::string("[ArchonInputActivate] Resolve ResetIgnoreLookInput → ")
            + MpPtr(s_ResetIgnoreLookInputFn));
    }
    if (!s_SetCinematicModeFn) {
        s_SetCinematicModeFn = PC->Class->GetFunction("PlayerController", "SetCinematicMode");
        MpLog(std::string("[ArchonInputActivate] Resolve SetCinematicMode → ")
            + MpPtr(s_SetCinematicModeFn));
    }
    if (s_ResetIgnoreMoveInputFn) {
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            PC, s_ResetIgnoreMoveInputFn, nullptr);
        MpLog("[ArchonInputActivate] Called AController::ResetIgnoreMoveInput()");
    }
    if (s_ResetIgnoreLookInputFn) {
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            PC, s_ResetIgnoreLookInputFn, nullptr);
        MpLog("[ArchonInputActivate] Called AController::ResetIgnoreLookInput()");
    }
    if (s_SetCinematicModeFn) {
        struct {
            bool bInCinematicMode;
            bool bHidePlayer;
            bool bAffectsHUD;
            bool bAffectsMovement;
            bool bAffectsTurning;
        } cineParms = { false, false, false, false, false };
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            PC, s_SetCinematicModeFn, &cineParms);
        MpLog("[ArchonInputActivate] Called APlayerController::SetCinematicMode(false, ...)");
    }

    static UFunction* s_ApplyInputConfigFn = nullptr;
    static UFunction* s_ApplyInputConfigFromSettingsFn = nullptr;
    static UFunction* s_PCSetupArchonInputFn = nullptr;
    if (!s_ApplyInputConfigFn) {
        s_ApplyInputConfigFn = PC->Class->GetFunction(
            "ArchonPlayerControllerBase", "ApplyInputConfiguration");
        MpLog(std::string("[InputConfigCascade] Resolve ApplyInputConfiguration → ")
            + MpPtr(s_ApplyInputConfigFn));
    }
    if (!s_ApplyInputConfigFromSettingsFn) {
        s_ApplyInputConfigFromSettingsFn = PC->Class->GetFunction(
            "ArchonPlayerControllerBase", "ApplyInputConfigurationFromSettings");
        MpLog(std::string("[InputConfigCascade] Resolve ApplyInputConfigurationFromSettings → ")
            + MpPtr(s_ApplyInputConfigFromSettingsFn));
    }
    if (!s_PCSetupArchonInputFn) {

        s_PCSetupArchonInputFn = PC->Class->GetFunction(
            "player_controller_bp_C", "SetupArchonInput");
        if (!s_PCSetupArchonInputFn) {

            s_PCSetupArchonInputFn = PC->Class->GetFunction(
                "ArchonPlayerController", "SetupArchonInput");
        }
        MpLog(std::string("[InputConfigCascade] Resolve PC SetupArchonInput → ")
            + MpPtr(s_PCSetupArchonInputFn));
    }

    if (s_ApplyInputConfigFn) {
        struct {
            uint8_t InputConfiguration;
            uint8_t Pad[3];
            bool    ReturnValue;
        } cfgParms = { 1, {0,0,0}, false };
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            PC, s_ApplyInputConfigFn, &cfgParms);
        MpLog(std::string("[InputConfigCascade] Called ApplyInputConfiguration(Hunter=1) → ret=")
            + std::to_string(cfgParms.ReturnValue ? 1 : 0));

        if (!cfgParms.ReturnValue) {
            cfgParms.InputConfiguration = 0;
            cfgParms.ReturnValue = false;
            reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
                PC, s_ApplyInputConfigFn, &cfgParms);
            MpLog(std::string("[InputConfigCascade] Hunter unavailable, fell back to Default(0) → ret=")
                + std::to_string(cfgParms.ReturnValue ? 1 : 0));
        }
    }

    if (s_ApplyInputConfigFromSettingsFn) {
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            PC, s_ApplyInputConfigFromSettingsFn, nullptr);
        MpLog("[InputConfigCascade] Called ApplyInputConfigurationFromSettings()");
    }

    if (s_PCSetupArchonInputFn) {
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            PC, s_PCSetupArchonInputFn, nullptr);
        MpLog("[InputConfigCascade] Called player_controller_bp_C::SetupArchonInput()");
    }

    uintptr_t pawnPtr = SafeReadPtr(reinterpret_cast<uintptr_t>(PC), 0x0250);
    if (pawnPtr) {
        UObject* Pawn = reinterpret_cast<UObject*>(pawnPtr);
        static UFunction* s_PawnSetupArchonInputFn = nullptr;
        if (!s_PawnSetupArchonInputFn) {
            s_PawnSetupArchonInputFn = Pawn->Class->GetFunction(
                "BP_PlayerCharacter_C", "SetupArchonInput");
            if (!s_PawnSetupArchonInputFn) {
                s_PawnSetupArchonInputFn = Pawn->Class->GetFunction(
                    "ArchonCharacter", "SetupArchonInput");
            }
            MpLog(std::string("[InputConfigCascade] Resolve pawn SetupArchonInput → ")
                + MpPtr(s_PawnSetupArchonInputFn));
        }
        if (s_PawnSetupArchonInputFn) {
            reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
                Pawn, s_PawnSetupArchonInputFn, nullptr);
            MpLog("[InputConfigCascade] Called pawn SetupArchonInput()");
        }
    }

    ReconcileAirshipGameplayHUD("input-activation");
}

bool RunClientRolePumpGuarded(UObject* PC) {
    __try {
        TickPlayerRoleRetries();
        if (PC) RefreshPlayerRoleGameplayLifecycle(PC, "pump");
        ReconcileAirshipGameplayHUD("role-retry-pump");
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

void Move10_PatchMovByteImm(uintptr_t Rva, uintptr_t TargetOff, uint8_t ExpectImm, uint8_t NewImm,
                                   const char* Tag, std::string& Status) {
    uint8_t* p = (uint8_t*)(Globals::BaseAddress + Rva);
    const bool opcodeOk = (p[0] == 0xC6 && p[1] == 0x05);
    const int32_t disp = (int32_t)((uint32_t)p[2] | ((uint32_t)p[3] << 8) | ((uint32_t)p[4] << 16) | ((uint32_t)p[5] << 24));
    const bool targetOk = ((p + 7 + disp) == (uint8_t*)(Globals::BaseAddress + TargetOff));
    const bool immOk = (p[6] == ExpectImm);
    if (opcodeOk && immOk && targetOk) {
        DWORD oldP = 0;
        if (VirtualProtect(p + 6, 1, PAGE_EXECUTE_READWRITE, &oldP)) {
            p[6] = NewImm;
            DWORD tmpP = 0; VirtualProtect(p + 6, 1, oldP, &tmpP);
            FlushInstructionCache(GetCurrentProcess(), p, 7);
            Status += std::string("\n  ") + Tag + " OK imm " + std::to_string((int)ExpectImm) + "->" + std::to_string((int)NewImm);
        } else {
            Status += std::string("\n  ") + Tag + " ABORT VirtualProtect-failed";
        }
    } else {
        Status += std::string("\n  ") + Tag + " ABORT opcodeOk=" + std::to_string((int)opcodeOk)
            + " immOk=" + std::to_string((int)immOk) + " targetOk=" + std::to_string((int)targetOk)
            + " bytes=" + std::to_string((int)p[0]) + "," + std::to_string((int)p[1]) + "," + std::to_string((int)p[2])
            + "," + std::to_string((int)p[3]) + "," + std::to_string((int)p[4]) + "," + std::to_string((int)p[5]) + "," + std::to_string((int)p[6]);
    }
}

void Move10_PatchMovRegToImm0(uintptr_t Rva, uintptr_t TargetOff, const char* Tag, std::string& Status) {
    uint8_t* p = (uint8_t*)(Globals::BaseAddress + Rva);
    const bool opcodeOk = (p[0] == 0x44 && p[1] == 0x88 && p[2] == 0x25);
    const int32_t disp = (int32_t)((uint32_t)p[3] | ((uint32_t)p[4] << 8) | ((uint32_t)p[5] << 16) | ((uint32_t)p[6] << 24));
    const bool targetOk = ((p + 7 + disp) == (uint8_t*)(Globals::BaseAddress + TargetOff));
    if (opcodeOk && targetOk) {
        DWORD oldP = 0;
        if (VirtualProtect(p, 7, PAGE_EXECUTE_READWRITE, &oldP)) {
            const uint8_t d0 = p[3], d1 = p[4], d2 = p[5], d3 = p[6];
            p[0] = 0xC6; p[1] = 0x05; p[2] = d0; p[3] = d1; p[4] = d2; p[5] = d3; p[6] = 0x00;
            DWORD tmpP = 0; VirtualProtect(p, 7, oldP, &tmpP);
            FlushInstructionCache(GetCurrentProcess(), p, 7);
            Status += std::string("\n  ") + Tag + " OK rewrite MOV[..],R12B -> MOV[..],0";
        } else {
            Status += std::string("\n  ") + Tag + " ABORT VirtualProtect-failed";
        }
    } else {
        Status += std::string("\n  ") + Tag + " ABORT opcodeOk=" + std::to_string((int)opcodeOk)
            + " targetOk=" + std::to_string((int)targetOk)
            + " bytes=" + std::to_string((int)p[0]) + "," + std::to_string((int)p[1]) + "," + std::to_string((int)p[2])
            + "," + std::to_string((int)p[3]) + "," + std::to_string((int)p[4]) + "," + std::to_string((int)p[5]) + "," + std::to_string((int)p[6]);
    }
}

void Move10_NopMovByteAlStore(uintptr_t Rva, uintptr_t TargetOff, const char* Tag, std::string& Status) {
    uint8_t* p = (uint8_t*)(Globals::BaseAddress + Rva);
    const bool opcodeOk = (p[0] == 0x88 && p[1] == 0x05);
    const int32_t disp = (int32_t)((uint32_t)p[2] | ((uint32_t)p[3] << 8) | ((uint32_t)p[4] << 16) | ((uint32_t)p[5] << 24));
    const bool targetOk = ((p + 6 + disp) == (uint8_t*)(Globals::BaseAddress + TargetOff));
    if (opcodeOk && targetOk) {
        DWORD oldP = 0;
        if (VirtualProtect(p, 6, PAGE_EXECUTE_READWRITE, &oldP)) {
            p[0] = 0x90; p[1] = 0x90; p[2] = 0x90; p[3] = 0x90; p[4] = 0x90; p[5] = 0x90;
            DWORD tmpP = 0; VirtualProtect(p, 6, oldP, &tmpP);
            FlushInstructionCache(GetCurrentProcess(), p, 6);
            Status += std::string("\n  ") + Tag + " OK NOPx6 (was MOV[..],AL)";
        } else {
            Status += std::string("\n  ") + Tag + " ABORT VirtualProtect-failed";
        }
    } else {
        Status += std::string("\n  ") + Tag + " ABORT opcodeOk=" + std::to_string((int)opcodeOk)
            + " targetOk=" + std::to_string((int)targetOk)
            + " bytes=" + std::to_string((int)p[0]) + "," + std::to_string((int)p[1]) + "," + std::to_string((int)p[2])
            + "," + std::to_string((int)p[3]) + "," + std::to_string((int)p[4]) + "," + std::to_string((int)p[5]);
    }
}

void Move10_PatchCallToMovAl1(uintptr_t Rva, uintptr_t ExpectTargetOff, const char* Tag, std::string& Status) {
    uint8_t* p = (uint8_t*)(Globals::BaseAddress + Rva);
    const bool opcodeOk = (p[0] == 0xE8);
    const int32_t rel = (int32_t)((uint32_t)p[1] | ((uint32_t)p[2] << 8) | ((uint32_t)p[3] << 16) | ((uint32_t)p[4] << 24));
    const bool targetOk = ((p + 5 + rel) == (uint8_t*)(Globals::BaseAddress + ExpectTargetOff));
    if (opcodeOk && targetOk) {
        DWORD oldP = 0;
        if (VirtualProtect(p, 5, PAGE_EXECUTE_READWRITE, &oldP)) {
            p[0] = 0xB0; p[1] = 0x01; p[2] = 0x90; p[3] = 0x90; p[4] = 0x90;
            DWORD tmpP = 0; VirtualProtect(p, 5, oldP, &tmpP);
            FlushInstructionCache(GetCurrentProcess(), p, 5);
            Status += std::string("\n  ") + Tag + " OK CALL->MOV AL,1;NOPx3";
        } else {
            Status += std::string("\n  ") + Tag + " ABORT VirtualProtect-failed";
        }
    } else {
        Status += std::string("\n  ") + Tag + " ABORT opcodeOk=" + std::to_string((int)opcodeOk)
            + " targetOk=" + std::to_string((int)targetOk)
            + " bytes=" + std::to_string((int)p[0]) + "," + std::to_string((int)p[1]) + "," + std::to_string((int)p[2])
            + "," + std::to_string((int)p[3]) + "," + std::to_string((int)p[4]);
    }
}

void* OrigApplyPlayerRole = nullptr;

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

        void* Node = reinterpret_cast<void*(*)(void*, void*)>(Native112::At(Globals::BaseAddress, Native112::Rva_01A8F4C0))(Graph, Connection);
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
    if (!Globals::AmServer || !PlayerRole
        || MpExeRelativeFlagPresent(L"DISABLE_PLAYER_ROLE_OWNER_ROUTE.flag")) return;
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
    if (!Globals::AmServer || !OrigProcessEvent
        || MpExeRelativeFlagPresent(L"DISABLE_PLAYER_ROLE_OWNER_ROUTE.flag")) return;

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

static void NoteTempestChargeDiagRole(void* PlayerRole) {
    if (!Globals::AmServer || !PlayerRole
        || !MpExeRelativeFlagPresent(L"TEMPEST_CHARGE_DIAG.flag")) return;
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
    if (!Globals::AmServer || !MpExeRelativeFlagPresent(L"TEMPEST_CHARGE_DIAG.flag")) return;
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

        const float Current = SafeCallPlayerRoleFloat(Role, 0x01B983E0);
        const float MaxCharge = SafeCallPlayerRoleFloat(Role, 0x01B99F30);
        const int CanActivate = SafeCallPlayerRoleBoolRva(Role, 0x01B8D8A0);
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

constexpr int kMaxPendingPlayerRoleRetries = 8;

constexpr uint64_t kPlayerRoleRetryIntervalMs = 1500;

constexpr int kMaxPlayerRoleRetryAttempts = 20;

static PendingPlayerRoleRetry s_pendingPlayerRoleRetries[kMaxPendingPlayerRoleRetries];

static void GetPlayerRoleAndSlot(void* LoadoutPtr, void** OutRole, void** OutSlot) {
    *OutRole = nullptr; *OutSlot = nullptr;
    if (!LoadoutPtr || !IsReadablePointer(LoadoutPtr, 0x40)) return;
    void* Inter = reinterpret_cast<void*(*)(void*)>(Native112::At(Globals::BaseAddress, Native112::Rva_01A52080))(LoadoutPtr);
    if (!Inter || !IsReadablePointer(Inter, 0x40)) return;
    *OutRole = reinterpret_cast<void*(*)(void*)>(Native112::At(Globals::BaseAddress, Native112::Rva_01A95C60))(Inter);
    *OutSlot = reinterpret_cast<void*(*)(void*)>(Native112::At(Globals::BaseAddress, Native112::Rva_0173F670))(Inter);
}

static bool IsPlayerRoleAppliedToPawn(void* LoadoutPtr, void** OutRole , void** OutSlot ,
                                     void** OutPawn , void** OutPawnRole ) {
    void* Role = nullptr; void* Slot = nullptr;
    GetPlayerRoleAndSlot(LoadoutPtr, &Role, &Slot);

    void* PC = (LoadoutPtr && IsReadablePointer(LoadoutPtr, 0x638))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(LoadoutPtr) + 0x630) : nullptr;
    void* Pawn = (PC && IsReadablePointer(PC, 0x258))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(PC) + 0x250) : nullptr;
    void* PawnRole = (Pawn && IsReadablePointer(Pawn, 0x740))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Pawn) + 0x738) : nullptr;

    if (OutRole) *OutRole = Role;
    if (OutSlot) *OutSlot = Slot;
    if (OutPawn) *OutPawn = Pawn;
    if (OutPawnRole) *OutPawnRole = PawnRole;

    if (!Role || !Slot || !Pawn || !PawnRole) return false;
    const std::string InputId = CoreCapFString(
        reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Role) + 0x70));
    const std::string PawnId = CoreCapFString(
        reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(PawnRole) + 0x240));
    return !InputId.empty() && InputId == PawnId;
}

static void NotePlayerRoleValidity(void* LoadoutPtr, bool AppliedToPawn) {
    int FreeSlot = -1;
    for (int i = 0; i < kMaxPendingPlayerRoleRetries; ++i) {
        if (s_pendingPlayerRoleRetries[i].InUse && s_pendingPlayerRoleRetries[i].LoadoutPtr == LoadoutPtr) {
            if (AppliedToPawn) s_pendingPlayerRoleRetries[i] = PendingPlayerRoleRetry{};
            return;
        }
        if (FreeSlot < 0 && !s_pendingPlayerRoleRetries[i].InUse) FreeSlot = i;
    }
    if (AppliedToPawn || FreeSlot < 0) return;
    s_pendingPlayerRoleRetries[FreeSlot] = PendingPlayerRoleRetry{ LoadoutPtr, GetTickCount64(), 0, 0, true };
}

static bool TryApplyPlayerRoleRetryGuarded(
    void* LoadoutPtr, void** OutRole, void** OutSlot, void** OutPawn, void** OutPawnRole,
    bool* OutAppliedBefore, bool* OutAppliedAfter)
{
    __try {
        *OutAppliedBefore = IsPlayerRoleAppliedToPawn(LoadoutPtr, OutRole, OutSlot, OutPawn, OutPawnRole);
        if (!*OutAppliedBefore && OrigApplyPlayerRole) {
            reinterpret_cast<void(*)(void*)>(OrigApplyPlayerRole)(LoadoutPtr);
        }
        *OutAppliedAfter = IsPlayerRoleAppliedToPawn(LoadoutPtr);
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

void TickPlayerRoleRetries() {
    uint64_t Now = GetTickCount64();
    for (int i = 0; i < kMaxPendingPlayerRoleRetries; ++i) {
        PendingPlayerRoleRetry& Entry = s_pendingPlayerRoleRetries[i];
        if (!Entry.InUse) continue;

        if (!IsReadablePointer(Entry.LoadoutPtr, 0x40) || Entry.RetryCount >= kMaxPlayerRoleRetryAttempts) {
            Entry = PendingPlayerRoleRetry{};
            continue;
        }
        if (Now - Entry.LastRetryMs < kPlayerRoleRetryIntervalMs) continue;

        if (!IsRegisteredLiveObject(Entry.LoadoutPtr)) {
            MpLog("[ApplyPlayerRole][RetryTimeout] loadout=" + MpPtr(Entry.LoadoutPtr)
                + " no longer a live registered object (owning world torn down, e.g. Ramsgate->Training"
                " travel) - discarding retry entry WITHOUT calling native code");
            Entry = PendingPlayerRoleRetry{};
            continue;
        }

        void* RoleBefore = nullptr; void* SlotBefore = nullptr;
        void* PawnBefore = nullptr; void* PawnRoleBefore = nullptr;
        bool AppliedBefore = false; bool AppliedAfter = false;
        const bool Survived = TryApplyPlayerRoleRetryGuarded(
            Entry.LoadoutPtr, &RoleBefore, &SlotBefore, &PawnBefore, &PawnRoleBefore,
            &AppliedBefore, &AppliedAfter);

        if (!Survived) {
            MpLog("[ApplyPlayerRole][RetryTimeout] loadout=" + MpPtr(Entry.LoadoutPtr)
                + " FAULTED re-running native apply (stale pointer, likely a level travel tore down"
                " the owning pawn/loadout) - caught, discarding retry entry instead of crashing");
            Entry = PendingPlayerRoleRetry{};
            continue;
        }

        if (AppliedBefore) {
            Entry = PendingPlayerRoleRetry{};
            continue;
        }

        Entry.LastRetryMs = Now;
        Entry.RetryCount++;
        MpLog("[ApplyPlayerRole][RetryTimeout] attempt=" + std::to_string(Entry.RetryCount)
            + " loadout=" + MpPtr(Entry.LoadoutPtr) + " elapsedMs=" + std::to_string(Now - Entry.FirstSeenInvalidMs)
            + " role=" + MpPtr(RoleBefore) + " slot=" + MpPtr(SlotBefore)
            + " pawn=" + MpPtr(PawnBefore) + " pawnRole=" + MpPtr(PawnRoleBefore)
            + " - re-running native apply");

        if (AppliedAfter) {
            MpLog("[ApplyPlayerRole][RetryTimeout] resolved after " + std::to_string(Entry.RetryCount)
                + " attempt(s), matching role is now installed on pawn loadout=" + MpPtr(Entry.LoadoutPtr));
            Entry = PendingPlayerRoleRetry{};
        }
    }
}

#pragma intrinsic(_ReturnAddress)
void ApplyPlayerRoleHook(void* a1) {

    uintptr_t Ret = reinterpret_cast<uintptr_t>(_ReturnAddress());
    uintptr_t RetRva = (Ret >= Globals::BaseAddress) ? (Ret - Globals::BaseAddress) : Ret;
    const char* Caller =
        (RetRva >= 0x01A664A0 && RetRva < 0x01A66900) ? "possession(0x01A664A0)" :
        (RetRva >= 0x01A4B6C0 && RetRva < 0x01A4B720) ? "apply-all(0x01A4B6C0)" :
        (RetRva >= 0x01A4B720 && RetRva < 0x01A4B790) ? "repfield-case8(0x01A4B720)" :
        (RetRva >= 0x01A72900 && RetRva < 0x01A72A80) ? "caller4(~0x01A729C3)" : "other";

    static std::atomic<int> s_aprSeq{ 0 };
    int Seq = s_aprSeq.fetch_add(1, std::memory_order_relaxed);

    void* Role = nullptr; void* Slot = nullptr;
    GetPlayerRoleAndSlot(a1, &Role, &Slot);
    std::string Name = (a1 && IsReadablePointer(a1, 0x40)) ? reinterpret_cast<UObject*>(a1)->GetName() : std::string("?");

    MpLog("[ApplyPlayerRole #" + std::to_string(Seq) + "] ENTER this=" + MpPtr(a1) + "/" + Name
        + " caller=" + Caller + " retRva=+" + MpHex(RetRva)
        + " PlayerRole=" + (Role ? "Valid" : "INVALID") + "(" + MpPtr(Role) + ")"
        + " Slot=" + (Slot ? "Valid" : "INVALID") + "(" + MpPtr(Slot) + ")");

    reinterpret_cast<void(*)(void*)>(OrigApplyPlayerRole)(a1);

    std::string InputRoleId = CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Role) + 0x70));
    std::string InputRoleInstance = CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Role) + 0x88));
    void* SlotCachedItem = (Slot && IsReadablePointer(Slot, 0xC0))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Slot) + 0xB8) : nullptr;
    std::string SlotCachedId = SlotCachedItem
        ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(SlotCachedItem) + 0x70)) : std::string();

    void* PC = (a1 && IsReadablePointer(a1, 0x638))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(a1) + 0x630) : nullptr;
    void* Pawn = (PC && IsReadablePointer(PC, 0x258))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(PC) + 0x250) : nullptr;
    void* PawnRole = (Pawn && IsReadablePointer(Pawn, 0x740))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Pawn) + 0x738) : nullptr;
    void* PlayerState = (Pawn && IsReadablePointer(Pawn, 0x248))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Pawn) + 0x240) : nullptr;
    std::string PlayerStateRoleId = (PlayerState && IsReadablePointer(PlayerState, 0x648))
        ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(PlayerState) + 0x638))
        : std::string();
    std::string PawnRoleId = PawnRole
        ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(PawnRole) + 0x240)) : std::string();
    std::string PawnRoleInstance = PawnRole
        ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(PawnRole) + 0x250)) : std::string();
    int Equipped = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x2F4) : -1;
    int EquippedGameplay = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x2F5) : -1;
    int ActiveGameplay = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x2F6) : -1;
    int BpEquipCalled = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x2F7) : -1;
    int RoleActorFlags58 = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x58) : -1;
    int RoleActorFlags59 = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x59) : -1;
    int RoleActorFlags5B = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x5B) : -1;
    int RoleActorRole = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0xF0) : -1;
    int RoleActorRemoteRole = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x5F) : -1;
    void* RoleActorOwner = (PawnRole && IsReadablePointer(PawnRole, 0xE8))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(PawnRole) + 0xE0) : nullptr;
    const bool AppliedToPawn = Role && Slot && Pawn && PawnRole
        && !InputRoleId.empty() && InputRoleId == PawnRoleId;
    NotePlayerRoleValidity(a1, AppliedToPawn);
    if (AppliedToPawn) {
        RoutePlayerRoleToOwningConnection(PawnRole);
        NoteTempestModifierRole(PawnRole);
        NoteTempestChargeDiagRole(PawnRole);
    }
    const std::string RoleCharge = PlayerRoleChargeSummary(PawnRole);
    MpLog("[PlayerRoleState #" + std::to_string(Seq) + "] inputId=" + InputRoleId
        + " inputInstance=" + InputRoleInstance + " slotCached=" + MpPtr(SlotCachedItem)
        + "/" + SlotCachedId + " pc=" + MpPtr(PC) + " pawn=" + MpPtr(Pawn)
        + " playerState=" + MpPtr(PlayerState) + " playerStateRoleId=" + PlayerStateRoleId
        + " pawnRole=" + MpPtr(PawnRole) + " pawnRoleId=" + PawnRoleId
        + " pawnRoleInstance=" + PawnRoleInstance + " equipped=" + std::to_string(Equipped)
        + " gameplayEquipped=" + std::to_string(EquippedGameplay)
        + " activeGameplay=" + std::to_string(ActiveGameplay)
        + " bpEquipCalled=" + std::to_string(BpEquipCalled)
        + " roleActorOwner=" + MpPtr(RoleActorOwner)
        + " netFlags58=" + std::to_string(RoleActorFlags58)
        + " netFlags59=" + std::to_string(RoleActorFlags59)
        + " netFlags5B=" + std::to_string(RoleActorFlags5B)
        + " role=" + std::to_string(RoleActorRole)
        + " remoteRole=" + std::to_string(RoleActorRemoteRole)
        + " charge={" + RoleCharge + "}"
        + " modifiers={" + PlayerRoleModifierSummary(PawnRole) + "}"
        + " appliedToPawn=" + std::to_string(AppliedToPawn ? 1 : 0));

    MpLog("[ApplyPlayerRole #" + std::to_string(Seq) + "] EXIT  this=" + MpPtr(a1) + "/" + Name + " caller=" + Caller);
}

static void RefreshPlayerRoleGameplayLifecycle(UObject* PC, const char* TriggerLabel) {
    if (Globals::AmServer || !PC || !OrigProcessEventClient || !IsReadablePointer(PC, 0x258)) return;

    if (!IsRegisteredLiveObject(PC)) return;

    void* Pawn = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(PC) + 0x250);
    if (!Pawn || !IsReadablePointer(Pawn, 0x740)) return;
    void* PlayerState = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Pawn) + 0x240);
    void* PlayerRole = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Pawn) + 0x738);
    if (!PlayerState || !IsReadablePointer(PlayerState, 0x691)) return;

    if (!PlayerRole) {
        const std::string ReplicatedRoleId = IsReadablePointer(PlayerState, 0x648)
            ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(PlayerState) + 0x638))
            : std::string();

        static void* s_LastRoleNotifyPawn = nullptr;
        static std::string s_LastRoleNotifyId;
        static uint64_t s_LastRoleNotifyMs = 0;
        static int s_RoleNotifyAttempts = 0;
        static uint64_t s_RoleNotifyExhaustedAtMs = 0;
        static void* s_LastEmptyRoleIdPawn = nullptr;
        const uint64_t NotifyNow = GetTickCount64();
        if (ReplicatedRoleId.empty()) {
            if (s_LastEmptyRoleIdPawn != Pawn) {
                s_LastEmptyRoleIdPawn = Pawn;
                MpLog(std::string("[PlayerRoleRepNotify] trigger=") + TriggerLabel
                    + " pawn=" + MpPtr(Pawn) + " playerState=" + MpPtr(PlayerState)
                    + " PlayerRoleId is empty; waiting for replication");
            }
            return;
        }
        if (s_LastRoleNotifyPawn != Pawn || s_LastRoleNotifyId != ReplicatedRoleId) {
            s_LastRoleNotifyPawn = Pawn;
            s_LastRoleNotifyId = ReplicatedRoleId;
            s_LastRoleNotifyMs = 0;
            s_RoleNotifyAttempts = 0;
            s_RoleNotifyExhaustedAtMs = 0;
        }

        constexpr uint64_t kRoleNotifyGiveUpCooldownMs = 30000;
        if (s_RoleNotifyAttempts >= kMaxPlayerRoleRetryAttempts) {
            if (s_RoleNotifyExhaustedAtMs == 0) s_RoleNotifyExhaustedAtMs = NotifyNow;
            if (NotifyNow - s_RoleNotifyExhaustedAtMs < kRoleNotifyGiveUpCooldownMs) return;
            MpLog(std::string("[PlayerRoleRepNotify] pawn=") + MpPtr(Pawn)
                + " exhausted " + std::to_string(kMaxPlayerRoleRetryAttempts)
                + " attempts with no success - retrying after a "
                + std::to_string(kRoleNotifyGiveUpCooldownMs / 1000)
                + "s cooldown instead of giving up for the rest of the hunt");
            s_RoleNotifyAttempts = 0;
            s_RoleNotifyExhaustedAtMs = 0;
        }
        if (s_LastRoleNotifyPawn == Pawn && NotifyNow - s_LastRoleNotifyMs < 1500) return;
        s_LastRoleNotifyMs = NotifyNow;
        ++s_RoleNotifyAttempts;

        UObject* PlayerStateObject = reinterpret_cast<UObject*>(PlayerState);
        {

            UObject* PCObject = reinterpret_cast<UObject*>(PC);
            static UFunction* s_RepairGetLoadoutFn = nullptr;
            if (!s_RepairGetLoadoutFn && PCObject->Class) {
                s_RepairGetLoadoutFn = PCObject->Class->GetFunction("ArchonPlayerController", "GetLoadout");
            }
            void* Loadout = nullptr;
            if (s_RepairGetLoadoutFn) {
                struct { void* ReturnValue; } getLoadout{ nullptr };
                reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
                    PCObject, s_RepairGetLoadoutFn, &getLoadout);
                Loadout = getLoadout.ReturnValue;
            }
            if (!Loadout || !IsRegisteredLiveObject(Loadout)) {
                MpLog(std::string("[PlayerRoleRepNotify] trigger=") + TriggerLabel
                    + " pawn=" + MpPtr(Pawn) + " attempt=" + std::to_string(s_RoleNotifyAttempts)
                    + " replicatedId=" + ReplicatedRoleId
                    + " could not resolve a live owning loadout to re-apply; will retry");
                return;
            }
            void* RoleRef = nullptr; void* SlotRef = nullptr; void* PawnRef = nullptr; void* PawnRoleRef = nullptr;
            bool AppliedBefore = false; bool AppliedAfter = false;
            const bool Survived = TryApplyPlayerRoleRetryGuarded(
                Loadout, &RoleRef, &SlotRef, &PawnRef, &PawnRoleRef, &AppliedBefore, &AppliedAfter);
            PlayerRole = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Pawn) + 0x738);
            MpLog(std::string("[PlayerRoleRepNotify] trigger=") + TriggerLabel
                + " pawn=" + MpPtr(Pawn) + " playerState=" + MpPtr(PlayerState)
                + " attempt=" + std::to_string(s_RoleNotifyAttempts)
                + " replicatedId=" + ReplicatedRoleId + " re-ran REAL ApplyPlayerRole"
                + " loadout=" + MpPtr(Loadout)
                + " loadoutRoleRef=" + MpPtr(RoleRef) + " loadoutSlotRef=" + MpPtr(SlotRef)
                + " survived=" + std::to_string(Survived ? 1 : 0)
                + " pawnRoleAfter=" + MpPtr(PlayerRole));
            if (!PlayerRole) return;
        }
    }
    if (!IsReadablePointer(PlayerRole, 0x2F8)) return;

    const uint8_t PlayerStateActive = SafeReadByte(reinterpret_cast<uintptr_t>(PlayerState), 0x690, 0xEE);
    const uint8_t EquippedGameplayBefore = SafeReadByte(reinterpret_cast<uintptr_t>(PlayerRole), 0x2F5, 0xEE);
    const uint8_t RoleActiveBefore = SafeReadByte(reinterpret_cast<uintptr_t>(PlayerRole), 0x2F6, 0xEE);
    const uint8_t BpCalledBefore = SafeReadByte(reinterpret_cast<uintptr_t>(PlayerRole), 0x2F7, 0xEE);
    if (PlayerStateActive != 1
        || (EquippedGameplayBefore == 1 && RoleActiveBefore == 1 && BpCalledBefore == 1)) return;

    static void* s_LastLifecyclePawn = nullptr;
    static void* s_LastLifecycleRole = nullptr;
    if (s_LastLifecyclePawn == Pawn && s_LastLifecycleRole == PlayerRole) return;
    s_LastLifecyclePawn = Pawn;
    s_LastLifecycleRole = PlayerRole;

    UObject* PawnObject = reinterpret_cast<UObject*>(Pawn);
    UFunction* HandleActiveFn = PawnObject->Class
        ? PawnObject->Class->GetFunction("ArchonCharacter", "HandleActiveGameplayStateChanged")
        : nullptr;
    if (!HandleActiveFn) {
        static bool s_LoggedMissingHandleActive = false;
        if (!s_LoggedMissingHandleActive) {
            s_LoggedMissingHandleActive = true;
            MpLog("[PlayerRoleLifecycle] HandleActiveGameplayStateChanged UFunction not found");
        }
        return;
    }

    struct {
        bool bInIsActiveGameplay;
        bool bForceUpdate;
    } Params = { true, true };
    reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
        PawnObject, HandleActiveFn, &Params);

    const uint8_t EquippedGameplayAfter = SafeReadByte(reinterpret_cast<uintptr_t>(PlayerRole), 0x2F5, 0xEE);
    const uint8_t RoleActiveAfter = SafeReadByte(reinterpret_cast<uintptr_t>(PlayerRole), 0x2F6, 0xEE);
    const uint8_t BpCalledAfter = SafeReadByte(reinterpret_cast<uintptr_t>(PlayerRole), 0x2F7, 0xEE);
    MpLog(std::string("[PlayerRoleLifecycle] trigger=") + TriggerLabel
        + " pc=" + MpPtr(PC) + " pawn=" + MpPtr(Pawn) + " role=" + MpPtr(PlayerRole)
        + " playerStateActive=" + std::to_string(PlayerStateActive)
        + " gameplayEquipped=" + std::to_string(EquippedGameplayBefore)
        + "->" + std::to_string(EquippedGameplayAfter)
        + " roleActive=" + std::to_string(RoleActiveBefore)
        + "->" + std::to_string(RoleActiveAfter)
        + " bpEquipCalled=" + std::to_string(BpCalledBefore)
        + "->" + std::to_string(BpCalledAfter));
}
