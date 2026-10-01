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

#include "client/PlayerRoleActivation.h"
#include "core/PlayerRoles.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "client/GameplayHUD.h"
#include "client/ClientEvents.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "diagnostics/PlayerRoleDiagnostics.h"

// The client's side of player roles: activating the possessed pawn's input and
// gameplay once its role is applied.

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
