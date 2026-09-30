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

#include "client/ClientEvents.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "client/Challenges.h"
#include "client/GameplayHUD.h"
#include "client/ClientHooks.h"
#include "client/HuntPass.h"
#include "client/Middleman.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "core/PlayerRoles.h"
#include "diagnostics/RuntimeDiagnostics.h"
#include "server/Replication.h"

#include <fstream>
void* OrigProcessEventClient = nullptr;

void ProcessEventClientHook(UObject* Object, UFunction* Function, void* Parms) {

    static thread_local int s_processEventDepthClient = 0;
    struct DepthGuardClient {
        DepthGuardClient()  { ++s_processEventDepthClient; }
        ~DepthGuardClient() { --s_processEventDepthClient; }
    } g_depthGuardClient;

    if (s_processEventDepthClient > 32) {
        static thread_local bool s_reportedRecursionClient = false;
        if (!s_reportedRecursionClient) {
            s_reportedRecursionClient = true;
            std::string FunctionName = Function ? Function->GetFullName() : "null";
            std::string ObjectName = Object ? Object->GetFullName() : "null";
            MpLog("[ProcessEventClientHook] REENTRANCY-GUARD tripped (depth="
                + std::to_string(s_processEventDepthClient) + ") — ABSORBING call. "
                + "fn=" + FunctionName + " obj=" + ObjectName);
        }
        return;
    }

    std::string FunctionName = Function ? Function->GetFullName() : "null";
    if (!MiddlemanBeforeEvent(Object, FunctionName)) return;
    if (!HuntPassBeforeEvent(Object, FunctionName)) return;
    const int EscalationFlowClientSeq = TraceEscalationFlowEnter(
        "Client", Object, FunctionName, Parms);

    const bool AirshipStateUpdateEvent = Function && Object
        && FunctionName.find(".OnAirshipStateUpdate") != std::string::npos;
    if (AirshipStateUpdateEvent && Parms && IsReadablePointer(Parms, sizeof(void*))) {
        UObject* GameState = *reinterpret_cast<UObject**>(Parms);
        if (GameState && IsReadablePointer(GameState, 0x2D1)) {
            s_AirshipHUD = Object;
            s_AirshipGameState = GameState;
        }
    }

    const bool AirshipHUDMayHaveBeenShown = Function && (
        FunctionName.find(".ShowGameplayHUD") != std::string::npos
        || FunctionName.find(".Player_HUD_Ready") != std::string::npos
        || FunctionName.find(".Progression_HUD_Ready") != std::string::npos
        || FunctionName.find(".ReceiveGameplayStart") != std::string::npos
        || FunctionName.find(".Refresh_HUD_Widget_Visibility") != std::string::npos
        || FunctionName.find(".Show_HUD") != std::string::npos
        || FunctionName.find(".Show HUD") != std::string::npos);

    int WeaponXpClientEventSeq = -1;
    const FExperienceGrant* WeaponXpClientGrant = nullptr;
    if (Function && Parms && IsClientExperienceGrantConsumer(FunctionName)
        && IsReadablePointer(Parms, sizeof(FExperienceGrant))) {
        static std::atomic<int> s_weaponXpClientEventCount{ 0 };
        WeaponXpClientEventSeq = s_weaponXpClientEventCount.fetch_add(1, std::memory_order_relaxed);
        if (WeaponXpClientEventSeq < 256) {
            WeaponXpClientGrant = reinterpret_cast<const FExperienceGrant*>(Parms);
            MpLog("[WeaponXP][ClientEvent] ENTER seq=" + std::to_string(WeaponXpClientEventSeq)
                + " fn=" + FunctionName
                + " obj=" + MpPtr(Object) + "/" + SafeObjectNameForDiagnostic(Object)
                + " " + ExperienceGrantSummary(*WeaponXpClientGrant));
        }
    }

    if (Function && Parms
        && FunctionName.find("ArchonProgressBar.AnimatePointsAdded") != std::string::npos
        && IsReadablePointer(Parms, sizeof(int32_t))) {
        static std::atomic<int> s_weaponXpBarAnimationCount{ 0 };
        int Seq = s_weaponXpBarAnimationCount.fetch_add(1, std::memory_order_relaxed);
        if (Seq < 256) {
            int32_t AddedAmount = *reinterpret_cast<const int32_t*>(Parms);
            MpLog("[WeaponXP][ClientBar] seq=" + std::to_string(Seq)
                + " added=" + std::to_string(AddedAmount)
                + " obj=" + MpPtr(Object) + "/" + SafeObjectNameForDiagnostic(Object)
                + " fn=" + FunctionName);
        }
    }

    int TempestPerfectDodgeClientSeq = -1;
    if (Function && FunctionName.find("PerfectDodge") != std::string::npos) {
        static std::atomic<int> s_tempestPerfectDodgeClientCount{ 0 };
        TempestPerfectDodgeClientSeq = s_tempestPerfectDodgeClientCount.fetch_add(1, std::memory_order_relaxed);
        if (TempestPerfectDodgeClientSeq < 64) {
            MpLog("[TempestPerfectDodge][Client] ENTER seq=" + std::to_string(TempestPerfectDodgeClientSeq)
                + " fn=" + FunctionName + " obj=" + MpPtr(Object) + "/"
                + SafeObjectNameForDiagnostic(Object));
        }
    }

    const bool PlayerRoleInputEvent = Object && (
        FunctionName.find("BP_PlayerCharacter_C.LanternAbilityPress") != std::string::npos
        || FunctionName.find("BP_PlayerCharacter_C.LanternAbilityRelease") != std::string::npos
        || FunctionName.find("BP_PlayerCharacter_C.HandleLanternShortPressInput") != std::string::npos
        || FunctionName.find("BP_PlayerCharacter_C.HandleLanternLongPressInput") != std::string::npos
        || FunctionName.find("BP_PlayerCharacter_C.PlayerRoleAttackPress") != std::string::npos
        || FunctionName.find("BP_PlayerCharacter_C.Client_TryActivateAbility") != std::string::npos);
    void* InputDiagRole = nullptr;
    void* InputDiagAbilityClass = nullptr;
    float HeldLanternBefore = -1.0f;
    if (PlayerRoleInputEvent && IsReadablePointer(Object, 0x15CC)) {
        InputDiagRole = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Object) + 0x738);
        HeldLanternBefore = *reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(Object) + 0x15C8);
        if (FunctionName.find("Client_TryActivateAbility") != std::string::npos
            && Parms && IsReadablePointer(Parms, sizeof(void*))) {
            InputDiagAbilityClass = *reinterpret_cast<void**>(Parms);
        }
    }

    const bool IsAccessoryItemCheckFn = Function && (
        FunctionName.find("CanUseAccessory") != std::string::npos
        || FunctionName.find("IsUnlockedAsTransmogTarget") != std::string::npos
        || FunctionName.find("CanBeTransmogTarget") != std::string::npos);
    const bool IsInventoryDataQueryFn = Function && (
        FunctionName.find("GetInventoryData") != std::string::npos
        || FunctionName.find("GetItemFromInstanceId") != std::string::npos);

    const bool IsWidgetUpdateViewFn = Function && FunctionName.find("UpdateView") != std::string::npos;
    const bool IsAccessoryUnlockDiagFn = IsAccessoryItemCheckFn || IsInventoryDataQueryFn || IsWidgetUpdateViewFn;
    std::string AccessoryUnlockDiagItemId, AccessoryUnlockDiagInstanceId, AccessoryUnlockDiagParmsBefore;
    if (IsAccessoryItemCheckFn && Object) {
        AccessoryUnlockDiagItemId = IsReadablePointer(Object, 0x80)
            ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Object) + 0x70))
            : std::string("?");
        AccessoryUnlockDiagInstanceId = IsReadablePointer(Object, 0x98)
            ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Object) + 0x88))
            : std::string("?");
    }
    std::string AccessoryUnlockDiagQueriedInstanceId;
    if (IsAccessoryUnlockDiagFn) {
        AccessoryUnlockDiagParmsBefore = (Parms && IsReadablePointer(Parms, 24))
            ? DumpBytesHex(Parms, 24) : std::string("(unreadable)");

        if (FunctionName.find("GetItemFromInstanceId") != std::string::npos
            && Parms && IsReadablePointer(Parms, 0x10)) {
            AccessoryUnlockDiagQueriedInstanceId = CoreCapFString(Parms);
        }
    }

    if (s_processEventDepthClient == 1) {
        static uint32_t s_clientRoleRetryPump = 0;
        if ((++s_clientRoleRetryPump & 0xFF) == 0) {
            if (!RunClientRolePumpGuarded(s_LastPossessedPC)) {
                MpLog("[ClientRolePump] FAULTED (stale pointer, likely a level travel tore down"
                    " the owning pawn/PC) - caught, skipping this pump cycle instead of crashing");
            }

            if (s_LastPossessedPC && s_LastPossessedAtMs != 0
                && !s_ArchonInputActivated && !DiagNaturalMode())
            {
                constexpr uint64_t kInputActivateTimeoutMs = 8000;
                uint64_t Elapsed = GetTickCount64() - s_LastPossessedAtMs;
                if (Elapsed >= kInputActivateTimeoutMs) {
                    MpLog(std::string("[ArchonInputActivate] trigger=timeout normal OnInputModeChanged never fired within ")
                        + std::to_string(Elapsed) + "ms of ClientRestart - forcing activation now");
                    TriggerArchonInputActivation(s_LastPossessedPC, "timeout");
                }
            }

            TickProgressionHudRefresh();
        }
    }

    if (SuppressEacPopupEnabled() && FunctionName.find("EasyAntiCheatErrorProc") != std::string::npos) {

        if (Parms && IsReadablePointer(Parms, 0x11)) {
            *reinterpret_cast<uint8_t*>(reinterpret_cast<uintptr_t>(Parms) + 0x10) = 0;
        }
        static bool s_loggedEacSuppression = false;
        if (!s_loggedEacSuppression) {
            s_loggedEacSuppression = true;
            MpLog("[EACPopup] suppressed ArchonGameInstance.EasyAntiCheatErrorProc");
        }
        return;
    }

    reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(Object, Function, Parms);
    MiddlemanAfterEvent(Object, FunctionName);
    HuntPassAfterEvent(Object, FunctionName);
    ChallengesAfterEvent(Object, FunctionName);

    if (IsAccessoryUnlockDiagFn) {
        static std::atomic<int> s_accessoryUnlockDiagCount{ 0 };
        if (s_accessoryUnlockDiagCount.fetch_add(1, std::memory_order_relaxed) < 2000) {
            std::string ParmsAfter = (Parms && IsReadablePointer(Parms, 24))
                ? DumpBytesHex(Parms, 24) : std::string("(unreadable)");

            void* ReturnValueAtOffset0 = (Parms && IsReadablePointer(Parms, 8))
                ? *reinterpret_cast<void**>(Parms) : nullptr;
            void* ReturnValueAtOffset0x10 = (Parms && IsReadablePointer(Parms, 0x18))
                ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Parms) + 0x10) : nullptr;
            MpLog("[AccessoryUnlockDiag] fn=" + FunctionName
                + " obj=" + MpPtr(Object) + "/" + SafeObjectNameForDiagnostic(Object)
                + " itemId=" + AccessoryUnlockDiagItemId
                + " instanceId=" + AccessoryUnlockDiagInstanceId
                + " queriedInstanceId=" + AccessoryUnlockDiagQueriedInstanceId
                + " retAt0x0=" + MpPtr(ReturnValueAtOffset0)
                + " retAt0x10=" + MpPtr(ReturnValueAtOffset0x10)
                + " parmsBefore=[" + AccessoryUnlockDiagParmsBefore + "]"
                + " parmsAfter=[" + ParmsAfter + "]");
        }
    }

    if (AirshipStateUpdateEvent) {
        ReconcileAirshipGameplayHUD("state-update");
    }
    else if (AirshipHUDMayHaveBeenShown) {
        ReconcileAirshipGameplayHUD("hud-show-path");
    }

    if (WeaponXpClientGrant && WeaponXpClientEventSeq >= 0 && WeaponXpClientEventSeq < 256) {
        MpLog("[WeaponXP][ClientEvent] EXIT seq=" + std::to_string(WeaponXpClientEventSeq)
            + " fn=" + FunctionName + " " + ExperienceGrantSummary(*WeaponXpClientGrant));
    }

    TraceEscalationFlowExit("Client", EscalationFlowClientSeq, Object, FunctionName, Parms);

    if (TempestPerfectDodgeClientSeq >= 0 && TempestPerfectDodgeClientSeq < 64) {
        MpLog("[TempestPerfectDodge][Client] EXIT seq=" + std::to_string(TempestPerfectDodgeClientSeq)
            + " fn=" + FunctionName);
    }

    if (PlayerRoleInputEvent) {
        static std::atomic<int> s_playerRoleInputLogCount{ 0 };
        if (s_playerRoleInputLogCount.fetch_add(1, std::memory_order_relaxed) < 128) {
            const float HeldLanternAfter = IsReadablePointer(Object, 0x15CC)
                ? *reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(Object) + 0x15C8) : -1.0f;
            const int CharacterActive = IsReadablePointer(Object, 0xA1B)
                ? SafeReadByte(reinterpret_cast<uintptr_t>(Object), 0xA1A, 0xEE) : -1;
            const int GameplayEquipped = InputDiagRole
                ? SafeReadByte(reinterpret_cast<uintptr_t>(InputDiagRole), 0x2F5, 0xEE) : -1;
            const int RoleActive = InputDiagRole
                ? SafeReadByte(reinterpret_cast<uintptr_t>(InputDiagRole), 0x2F6, 0xEE) : -1;
            const int BpEquipCalled = InputDiagRole
                ? SafeReadByte(reinterpret_cast<uintptr_t>(InputDiagRole), 0x2F7, 0xEE) : -1;
            MpLog("[PlayerRoleInput] fn=" + FunctionName
                + " pawn=" + MpPtr(Object) + " role=" + MpPtr(InputDiagRole)
                + " held=" + std::to_string(HeldLanternBefore) + "->" + std::to_string(HeldLanternAfter)
                + " charActive=" + std::to_string(CharacterActive)
                + " gameplayEquipped=" + std::to_string(GameplayEquipped)
                + " roleActive=" + std::to_string(RoleActive)
                + " bpEquipCalled=" + std::to_string(BpEquipCalled)
                + " abilityClass=" + MpPtr(InputDiagAbilityClass) + "/"
                + SafeObjectNameForDiagnostic(InputDiagAbilityClass)
                + " charge={" + PlayerRoleChargeSummary(InputDiagRole) + "}"
                + " modifiers={" + PlayerRoleModifierSummary(InputDiagRole) + "}");
        }
    }

    if (Function && Parms && Object
        && FunctionName == "Function BP_PlayerCharacter.BP_PlayerCharacter_C.OnInputModeChanged")
    {
        bool bGameInputEnabled = *reinterpret_cast<bool*>(Parms);
        MpLog(std::string("[InputModeVal] pawn=") + Object->GetFullName()
            + " bGameInputEnabled=" + (bGameInputEnabled ? "true" : "false"));

        if (!s_ArchonInputActivated && s_LastPossessedPC && !DiagNaturalMode()) {
            TriggerArchonInputActivation(s_LastPossessedPC, "event");
        }
    }

    if (Function && Object
        && FunctionName == "Function BP_PlayerCharacter.BP_PlayerCharacter_C.OnInputModeChanged")
    {
        uintptr_t pawnAddr = reinterpret_cast<uintptr_t>(Object);
        uint8_t canMove = SafeReadByte(pawnAddr, 0x15E0, 0xEE);
        uintptr_t charMove = SafeReadPtr(pawnAddr, 0x0288);
        uintptr_t rootComp = SafeReadPtr(pawnAddr, 0x0130);
        uint8_t replMovMode = SafeReadByte(pawnAddr, 0x0328, 0xEE);

        uint8_t actorRole = SafeReadByte(pawnAddr, 0x00F0, 0xEE);
        uint8_t remoteRole = SafeReadByte(pawnAddr, 0x005F, 0xEE);
        uint8_t movMode = 0xEE, defaultLandMode = 0xEE, customMovMode = 0xEE;
        uintptr_t updatedComp = 0, pawnOwner = 0, characterOwner = 0;
        float velX = 0, velY = 0, velZ = 0, maxWalkSpeed = 0, maxAccel = 0, gravScale = 0;
        if (charMove) {
            movMode = SafeReadByte(charMove, 0x0168, 0xEE);
            customMovMode = SafeReadByte(charMove, 0x0169, 0xEE);
            defaultLandMode = SafeReadByte(charMove, 0x03B8, 0xEE);
            updatedComp = SafeReadPtr(charMove, 0x00B0);
            pawnOwner   = SafeReadPtr(charMove, 0x0130);
            characterOwner = SafeReadPtr(charMove, 0x0148);
            velX = SafeReadFloat(reinterpret_cast<uint8_t*>(charMove) + 0x00C4, 0);
            velY = SafeReadFloat(reinterpret_cast<uint8_t*>(charMove) + 0x00C8, 0);
            velZ = SafeReadFloat(reinterpret_cast<uint8_t*>(charMove) + 0x00CC, 0);
            maxWalkSpeed = SafeReadFloat(reinterpret_cast<uint8_t*>(charMove) + 0x018C, 0);
            maxAccel = SafeReadFloat(reinterpret_cast<uint8_t*>(charMove) + 0x01A0, 0);
            gravScale = SafeReadFloat(reinterpret_cast<uint8_t*>(charMove) + 0x0150, 0);
        }

        uint8_t mobility = 0xEE;
        float locX = 0, locY = 0, locZ = 0;
        if (rootComp) {
            mobility = SafeReadByte(rootComp, 0x014F, 0xEE);
            locX = SafeReadFloat(reinterpret_cast<uint8_t*>(rootComp) + 0x011C, 0);
            locY = SafeReadFloat(reinterpret_cast<uint8_t*>(rootComp) + 0x0120, 0);
            locZ = SafeReadFloat(reinterpret_cast<uint8_t*>(rootComp) + 0x0124, 0);
        }

        char buf[768];
        _snprintf_s(buf, sizeof(buf), _TRUNCATE,
            "pawn=%s CanMove_=%u Role=%u RemoteRole=%u"
            " CharMove=%p RootComp=%p Updated=%p"
            " PawnOwner=%p CharOwner=%p Mobility=%u"
            " MovMode=%u CustomMovMode=%u DefaultLandMode=%u ReplMovMode=%u"
            " Vel=(%.1f,%.1f,%.1f) MaxWalk=%.1f MaxAcc=%.1f Grav=%.2f"
            " Loc=(%.1f,%.1f,%.1f)",
            Object->GetFullName().c_str(),
            canMove, actorRole, remoteRole,
            reinterpret_cast<void*>(charMove),
            reinterpret_cast<void*>(rootComp),
            reinterpret_cast<void*>(updatedComp),
            reinterpret_cast<void*>(pawnOwner),
            reinterpret_cast<void*>(characterOwner),
            mobility,
            movMode, customMovMode, defaultLandMode, replMovMode,
            velX, velY, velZ, maxWalkSpeed, maxAccel, gravScale,
            locX, locY, locZ);
        MpLog(std::string("[MovementDiag] ") + buf);

        if (canMove != 1) {
            SafeWriteByte(pawnAddr, 0x15E0, 1);
            SafeWriteByte(pawnAddr, 0x1604, 1);
            MpLog("[ForceCanMove] wrote 1 to pawn+0x15E0 (CanMove_)");
        }

        if (charMove && movMode == 0) {
            bool ok1 = SafeWriteByte(charMove, 0x0168, 1);
            bool ok2 = SafeWriteByte(charMove, 0x03B8, 1);
            bool ok3 = SafeWriteByte(pawnAddr, 0x0328, 1);
            MpLog(std::string("[ForceMovementMode] wrote MOVE_Walking → CharMove+0x168 (")
                + (ok1 ? "ok" : "FAIL") + ") DefaultLandMode (" + (ok2 ? "ok" : "FAIL")
                + ") ReplMovMode (" + (ok3 ? "ok" : "FAIL") + ")");
        }

        if (rootComp && mobility != 2) {
            bool ok = SafeWriteByte(rootComp, 0x014F, 2);
            MpLog(std::string("[ForceMobility] RootComp+0x14F: was=") + std::to_string(mobility)
                + " wrote 2 (Movable) " + (ok ? "ok" : "FAIL"));
        }

        if (actorRole != 2 && actorRole != 3) {
            bool ok = SafeWriteByte(pawnAddr, 0x00F0, 2);
            MpLog(std::string("[ForceRole] pawn+0xF0: was=") + std::to_string(actorRole)
                + " wrote 2 (AutonomousProxy) " + (ok ? "ok" : "FAIL"));
        }
    }

    if (Function && FunctionName.contains("AddMovementInput")) {

        float dx = 0, dy = 0, dz = 0, scale = 0;
        if (Parms) {
            dx = SafeReadFloat(reinterpret_cast<uint8_t*>(Parms) + 0x0, 0);
            dy = SafeReadFloat(reinterpret_cast<uint8_t*>(Parms) + 0x4, 0);
            dz = SafeReadFloat(reinterpret_cast<uint8_t*>(Parms) + 0x8, 0);
            scale = SafeReadFloat(reinterpret_cast<uint8_t*>(Parms) + 0xC, 0);
        }
        char buf[128];
        _snprintf_s(buf, sizeof(buf), _TRUNCATE, "%.2f,%.2f,%.2f scale=%.2f", dx, dy, dz, scale);
        MpLog(std::string("[AddMovementInput] obj=") + (Object ? Object->GetFullName() : "null")
            + " dir=(" + buf + ")");
    }
    if (Function && FunctionName.contains("SetMovementMode") && Parms) {
        uint8_t newMode = SafeReadByte(reinterpret_cast<uintptr_t>(Parms), 0, 0xEE);
        MpLog(std::string("[SetMovementMode] obj=") + (Object ? Object->GetFullName() : "null")
            + " newMode=" + std::to_string(newMode));
    }
    if (Function && FunctionName.contains("K2_OnMovementModeChanged") && Parms) {

        uint8_t prev = SafeReadByte(reinterpret_cast<uintptr_t>(Parms), 0, 0xEE);
        uint8_t next = SafeReadByte(reinterpret_cast<uintptr_t>(Parms), 1, 0xEE);
        MpLog(std::string("[K2_OnMovementModeChanged] obj=") + (Object ? Object->GetFullName() : "null")
            + " prev=" + std::to_string(prev) + " new=" + std::to_string(next));
    }

    if (Function && Parms && FunctionName.contains("BP_PlayerCharacter_C.InpAxisEvt_")) {
        float axisValue = SafeReadFloat(Parms, 0.f);

        bool isForward = FunctionName.contains("InpAxisEvt_MoveForward");
        bool isRight   = FunctionName.contains("InpAxisEvt_MoveRight");
        if ((isForward || isRight) && Object && s_LastPossessedPC
            && (axisValue > 0.05f || axisValue < -0.05f))
        {
            float yawDeg = SafeReadFloat(
                reinterpret_cast<uint8_t*>(s_LastPossessedPC) + 0x288 + 4, 0.f);
            float yawRad = yawDeg * 0.01745329252f;
            float cosY = std::cos(yawRad);
            float sinY = std::sin(yawRad);
            float dirX, dirY;
            if (isForward) {

                dirX = cosY;
                dirY = sinY;
            } else {

                dirX = -sinY;
                dirY = cosY;
            }

            uintptr_t pawnAddr = reinterpret_cast<uintptr_t>(Object);
            uintptr_t charMove = SafeReadPtr(pawnAddr, 0x0288);
            if (charMove) {
                float speed = 500.0f;
                float vx = dirX * speed * axisValue;
                float vy = dirY * speed * axisValue;

                static int s_velLogCount = 0;
                if (++s_velLogCount <= 1) {
                    char buf[128];
                    _snprintf_s(buf, sizeof(buf), _TRUNCATE,
                        "DISABLED — target=(%.1f,%.1f) via %s (server RemoteRole fix should suffice)",
                        vx, vy, isForward ? "MoveForward" : "MoveRight");
                    MpLog(std::string("[ForceVelocity] ") + buf);
                }
            }

            static int s_tpDisabledLogCount = 0;
            if (++s_tpDisabledLogCount == 1) {
                MpLog("[ForceTeleport] DISABLED — relying on server-side RemoteRole fix");
            }
        }
    }

    if (Function && Object
        && FunctionName == "Function Engine.PlayerController.ClientRestart")
    {
        UObject* NewPawn = Parms
            ? reinterpret_cast<UObject*>(SafeReadPtr(reinterpret_cast<uintptr_t>(Parms), 0))
            : nullptr;
        const bool NewPossession = Object != s_LastPossessedPC || NewPawn != s_LastRestartPawn;
        s_LastPossessedPC = Object;
        s_LastRestartPawn = NewPawn;

        if (NewPossession) {
            s_LastPossessedAtMs = GetTickCount64();
            s_ArchonInputActivated = false;
            s_ProgressionHudRefreshPending = true;
            s_ProgressionHudRefreshAttempts = 0;

            s_ProgressionHudRefreshNotBeforeMs = s_LastPossessedAtMs + 1500;
        }
        MpLog(std::string("[ClientRestartObserved] PC=") + Object->GetFullName()
            + " pawn=" + MpPtr(NewPawn)
            + " newPossession=" + std::to_string(NewPossession ? 1 : 0)
            + " activationRearmed=" + std::to_string(NewPossession ? 1 : 0)
            + " progressionHudRefreshRearmed=" + std::to_string(NewPossession ? 1 : 0));
    }
}
