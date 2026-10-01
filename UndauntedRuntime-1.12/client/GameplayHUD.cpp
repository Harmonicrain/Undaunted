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

#include "client/GameplayHUD.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "client/ClientEvents.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "core/PlayerRoles.h"
#include "client/PlayerRoleActivation.h"

enum class HudFnCallResult { Ok, NotFound, Faulted };

static HudFnCallResult CallHudLifecycleFunctionGuarded(UObject* HudObject, const char* Outer, const char* FuncName);
static void TickProgressionHudRefreshHeartbeat();
static void TickProgressionHudRefreshInner();
static bool TickProgressionHudRefreshGuarded();

bool s_ProgressionHudRefreshPending = false;

uint32_t s_ProgressionHudRefreshAttempts = 0;

uint64_t s_ProgressionHudRefreshNotBeforeMs = 0;

UObject* s_AirshipHUD = nullptr;

UObject* s_AirshipGameState = nullptr;

static bool s_AirshipHUDCompatHidden = false;

static int NumTimesOnAirshipUpdated = 0;

bool DidDoTravelReset = false;

static HudFnCallResult CallHudLifecycleFunctionGuarded(UObject* HudObject, const char* Outer, const char* FuncName) {
    __try {
        if (!HudObject || !HudObject->Class) return HudFnCallResult::NotFound;
        UFunction* Fn = HudObject->Class->GetFunction(Outer, FuncName);
        if (!Fn) return HudFnCallResult::NotFound;
        if (OrigProcessEventClient) {
            reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(HudObject, Fn, nullptr);
        }
        return HudFnCallResult::Ok;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return HudFnCallResult::Faulted;
    }
}

void ReconcileAirshipGameplayHUD(const char* TriggerLabel) {
    if (Globals::AmServer || !OrigProcessEventClient || !s_AirshipHUD || !s_AirshipGameState) return;

    if (!IsRegisteredLiveObject(s_AirshipHUD) || !IsRegisteredLiveObject(s_AirshipGameState)) {
        s_AirshipHUD = nullptr;
        s_AirshipGameState = nullptr;
        return;
    }
    if (!IsReadablePointer(s_AirshipHUD, 0x522)
        || !IsReadablePointer(s_AirshipGameState, 0x2D1)
        || !s_AirshipHUD->Class) {
        return;
    }

    const uint8_t InPreMatchAirship = SafeReadByte(
        reinterpret_cast<uintptr_t>(s_AirshipGameState), 0x2D0, 0xEE);
    const uint8_t VisibilityBefore = SafeReadByte(
        reinterpret_cast<uintptr_t>(s_AirshipHUD), 0x361, 0xEE);
    const uint8_t AirshipUIActive = SafeReadByte(
        reinterpret_cast<uintptr_t>(s_AirshipHUD), 0x520, 0xEE);

    if (InPreMatchAirship == 1) {
        const HudFnCallResult HideResult = CallHudLifecycleFunctionGuarded(s_AirshipHUD, "ArchonHUD", "HideGameplayHUD");
        if (HideResult == HudFnCallResult::Faulted) {
            MpLog(std::string("[AirshipHUD] FAULTED calling HideGameplayHUD trigger=") + TriggerLabel
                + " hud=" + MpPtr(s_AirshipHUD)
                + " (stale pointer, likely a level travel repurposed this object's memory) - caught, skipping");
            return;
        }
        if (HideResult == HudFnCallResult::NotFound) {
            static bool s_LoggedMissingHide = false;
            if (!s_LoggedMissingHide) {
                s_LoggedMissingHide = true;
                MpLog("[AirshipHUD] HideGameplayHUD UFunction not found");
            }
            return;
        }

        const uint8_t VisibilityAfter = SafeReadByte(
            reinterpret_cast<uintptr_t>(s_AirshipHUD), 0x361, 0xEE);

        static int s_HideLogCount = 0;
        if (!s_AirshipHUDCompatHidden || VisibilityBefore != VisibilityAfter || s_HideLogCount == 0) {
            if (s_HideLogCount++ < 32) {
                MpLog(std::string("[AirshipHUD] HIDE trigger=") + TriggerLabel
                    + " hud=" + MpPtr(s_AirshipHUD)
                    + " gameState=" + MpPtr(s_AirshipGameState)
                    + " inPreMatchAirship=1"
                    + " airshipUIActive=" + std::to_string(AirshipUIActive)
                    + " gameplayVisibility=" + std::to_string(VisibilityBefore)
                    + "->" + std::to_string(VisibilityAfter));
            }
        }
        s_AirshipHUDCompatHidden = true;
        return;
    }

    if (InPreMatchAirship == 0 && s_AirshipHUDCompatHidden) {
        const HudFnCallResult ShowResult = CallHudLifecycleFunctionGuarded(s_AirshipHUD, "ArchonHUD", "ShowGameplayHUD");
        if (ShowResult == HudFnCallResult::Faulted) {
            MpLog(std::string("[AirshipHUD] FAULTED calling ShowGameplayHUD trigger=") + TriggerLabel
                + " hud=" + MpPtr(s_AirshipHUD)
                + " (stale pointer, likely a level travel repurposed this object's memory) - caught, skipping");
            return;
        }
        if (ShowResult == HudFnCallResult::NotFound) {
            static bool s_LoggedMissingShow = false;
            if (!s_LoggedMissingShow) {
                s_LoggedMissingShow = true;
                MpLog("[AirshipHUD] ShowGameplayHUD UFunction not found");
            }
            return;
        }

        const uint8_t VisibilityAfter = SafeReadByte(
            reinterpret_cast<uintptr_t>(s_AirshipHUD), 0x361, 0xEE);
        MpLog(std::string("[AirshipHUD] RESTORE trigger=") + TriggerLabel
            + " hud=" + MpPtr(s_AirshipHUD)
            + " gameState=" + MpPtr(s_AirshipGameState)
            + " inPreMatchAirship=0"
            + " airshipUIActive=" + std::to_string(AirshipUIActive)
            + " gameplayVisibility=" + std::to_string(VisibilityBefore)
            + "->" + std::to_string(VisibilityAfter));
        s_AirshipHUDCompatHidden = false;
    }
}

static void TickProgressionHudRefreshHeartbeat() {
    static uint64_t s_calls = 0;
    static uint64_t s_lastHeartbeatMs = 0;
    ++s_calls;
    const uint64_t Now = GetTickCount64();
    if (s_lastHeartbeatMs != 0 && Now - s_lastHeartbeatMs < 5000) return;
    s_lastHeartbeatMs = Now;
    MpLog("[WeaponXP][HudInit][Heartbeat] calls=" + std::to_string(s_calls)
        + " pending=" + std::to_string(s_ProgressionHudRefreshPending ? 1 : 0)
        + " attempts=" + std::to_string(s_ProgressionHudRefreshAttempts)
        + " ArchonInputActivated=" + std::to_string(s_ArchonInputActivated ? 1 : 0)
        + " LastPossessedPC=" + MpPtr(s_LastPossessedPC));
}

static void TickProgressionHudRefreshInner() {
    if (!s_ProgressionHudRefreshPending) return;

    static uint64_t s_lastGuardLogMs = 0;
    const uint64_t NowGuard = GetTickCount64();
    const bool GuardBlocked = Globals::AmServer || !OrigProcessEventClient
        || !s_ArchonInputActivated || !s_LastPossessedPC;
    if (GuardBlocked) {
        if (s_lastGuardLogMs == 0 || NowGuard - s_lastGuardLogMs >= 2000) {
            s_lastGuardLogMs = NowGuard;
            MpLog("[WeaponXP][HudInit] blocked at top guard: AmServer="
                + std::to_string(Globals::AmServer ? 1 : 0)
                + " OrigProcessEventClient=" + MpPtr(OrigProcessEventClient)
                + " ArchonInputActivated=" + std::to_string(s_ArchonInputActivated ? 1 : 0)
                + " LastPossessedPC=" + MpPtr(s_LastPossessedPC));
        }
        return;
    }

    const uint64_t Now = GetTickCount64();
    if (Now < s_ProgressionHudRefreshNotBeforeMs) return;

    constexpr uint32_t kMaxAttempts = 45;
    constexpr uint64_t kRetryDelayMs = 1000;
    ++s_ProgressionHudRefreshAttempts;
    s_ProgressionHudRefreshNotBeforeMs = Now + kRetryDelayMs;

    UObject* PC = s_LastPossessedPC;

    if (!IsRegisteredLiveObject(PC)) {
        s_ProgressionHudRefreshPending = false;
        return;
    }
    const uint8_t OnlineReady = SafeReadByte(reinterpret_cast<uintptr_t>(PC), 0xC59, 0xEE);
    if (OnlineReady != 1 || !PC->Class) {
        if (s_ProgressionHudRefreshAttempts >= kMaxAttempts) {
            MpLog("[WeaponXP][HudInit] giving up: player controller never became online-ready");
            s_ProgressionHudRefreshPending = false;
        }
        return;
    }

    static UFunction* s_GetProgressionFn = nullptr;
    static UFunction* s_GetPlayerExperienceFn = nullptr;
    static UFunction* s_GetHUDFn = nullptr;
    if (!s_GetProgressionFn) {
        s_GetProgressionFn = PC->Class->GetFunction(
            "ArchonPlayerController", "GetProgressionComponent");
    }
    if (!s_GetPlayerExperienceFn) {
        s_GetPlayerExperienceFn = PC->Class->GetFunction(
            "ArchonPlayerController", "GetPlayerExperienceComponent");
    }
    if (!s_GetHUDFn) {
        s_GetHUDFn = PC->Class->GetFunction("PlayerController", "GetHUD");
    }

    UObject* Progression = nullptr;
    UObject* PlayerExperience = nullptr;
    UObject* HUD = nullptr;
    if (s_GetProgressionFn) {
        struct { UObject* ReturnValue; } Parms = { nullptr };
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            PC, s_GetProgressionFn, &Parms);
        Progression = Parms.ReturnValue;
    }
    if (s_GetPlayerExperienceFn) {
        struct { UObject* ReturnValue; } Parms = { nullptr };
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            PC, s_GetPlayerExperienceFn, &Parms);
        PlayerExperience = Parms.ReturnValue;
    }
    if (s_GetHUDFn) {
        struct { UObject* ReturnValue; } Parms = { nullptr };
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            PC, s_GetHUDFn, &Parms);
        HUD = Parms.ReturnValue;
    }

    const int ProgressionReady = Progression
        ? SafeReadU8At(reinterpret_cast<uintptr_t>(Progression), 0x290) : -1;
    int ExperienceCount = PlayerExperience
        ? SafeReadI32At(reinterpret_cast<uintptr_t>(PlayerExperience), 0x140) : -1;

    if (!Progression || !PlayerExperience || !HUD || ProgressionReady != 1) {
        if (s_ProgressionHudRefreshAttempts == 1
            || s_ProgressionHudRefreshAttempts == kMaxAttempts) {
            MpLog("[WeaponXP][HudInit] waiting attempt="
                + std::to_string(s_ProgressionHudRefreshAttempts)
                + " progression=" + MpPtr(Progression)
                + " progressionReady=" + std::to_string(ProgressionReady)
                + " playerExperience=" + MpPtr(PlayerExperience)
                + " experienceCount=" + std::to_string(ExperienceCount)
                + " hud=" + MpPtr(HUD));
        }
        if (s_ProgressionHudRefreshAttempts >= kMaxAttempts) {
            MpLog("[WeaponXP][HudInit] giving up after bounded readiness retries");
            s_ProgressionHudRefreshPending = false;
        }
        return;
    }

    bool InitializedExperiences = false;
    bool InitializeResult = true;
    if (ExperienceCount == 0 && PlayerExperience->Class) {
        UFunction* InitializeExperiencesFn = PlayerExperience->Class->GetFunction(
            "PlayerExperienceComponent", "InitializeExperiences");
        if (InitializeExperiencesFn) {
            struct {
                UObject* InProgressionComponent;
                bool ReturnValue;
                uint8_t Pad[7];
            } Parms = { Progression, false, {0, 0, 0, 0, 0, 0, 0} };
            reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
                PlayerExperience, InitializeExperiencesFn, &Parms);
            InitializedExperiences = true;
            InitializeResult = Parms.ReturnValue;
            ExperienceCount = SafeReadI32At(
                reinterpret_cast<uintptr_t>(PlayerExperience), 0x140);
        }
    }

    if (ExperienceCount <= 0) {

        const uintptr_t ExperienceTablePtr = SafeReadPtr(reinterpret_cast<uintptr_t>(PlayerExperience), 0x130);
        const uintptr_t ExperienceTrackTablePtr = SafeReadPtr(reinterpret_cast<uintptr_t>(PlayerExperience), 0x148);
        MpLog("[WeaponXP][HudInit] experience objects unavailable attempt="
            + std::to_string(s_ProgressionHudRefreshAttempts)
            + " initializeCalled=" + std::to_string(InitializedExperiences ? 1 : 0)
            + " initializeResult=" + std::to_string(InitializeResult ? 1 : 0)
            + " experienceCount=" + std::to_string(ExperienceCount)
            + " experienceTable=" + MpPtr(reinterpret_cast<void*>(ExperienceTablePtr))
            + " experienceTrackTable=" + MpPtr(reinterpret_cast<void*>(ExperienceTrackTablePtr)));
        if (s_ProgressionHudRefreshAttempts >= kMaxAttempts) {
            s_ProgressionHudRefreshPending = false;
        }
        return;
    }

    UFunction* ProgressionHudReadyFn = HUD->Class
        ? HUD->Class->GetFunction("BPH_ArchonHUD_C", "Progression HUD Ready") : nullptr;
    bool UsedComponentFallback = false;
    if (ProgressionHudReadyFn) {
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            HUD, ProgressionHudReadyFn, nullptr);
    }
    else if (Progression->Class) {
        ProgressionHudReadyFn = Progression->Class->GetFunction(
            "ProgressionComponent", "OnPlayerHUDReady");
        if (ProgressionHudReadyFn) {
            UsedComponentFallback = true;
            reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
                Progression, ProgressionHudReadyFn, nullptr);
        }
    }

    if (!ProgressionHudReadyFn) {
        MpLog("[WeaponXP][HudInit] no Progression HUD Ready function found");
        if (s_ProgressionHudRefreshAttempts >= kMaxAttempts) {
            s_ProgressionHudRefreshPending = false;
        }
        return;
    }

    MpLog("[WeaponXP][HudInit] refreshed native progression HUD"
        " attempt=" + std::to_string(s_ProgressionHudRefreshAttempts)
        + " progressionReady=" + std::to_string(ProgressionReady)
        + " experienceCount=" + std::to_string(ExperienceCount)
        + " initializeCalled=" + std::to_string(InitializedExperiences ? 1 : 0)
        + " initializeResult=" + std::to_string(InitializeResult ? 1 : 0)
        + " componentFallback=" + std::to_string(UsedComponentFallback ? 1 : 0));
    s_ProgressionHudRefreshPending = false;

    ReconcileAirshipGameplayHUD("progression-hud-refresh");
}

static bool TickProgressionHudRefreshGuarded() {
    __try {
        TickProgressionHudRefreshInner();
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

void TickProgressionHudRefresh() {
    TickProgressionHudRefreshHeartbeat();
    if (!TickProgressionHudRefreshGuarded()) {
        MpLog("[WeaponXP][HudInit] FAULTED (stale pointer, likely a level travel repurposed the"
            " cached player controller) - caught, giving up for this session instead of crashing");
        s_ProgressionHudRefreshPending = false;
    }
}

void* OrigHudLegendaryHandleWeaponEquipped = nullptr;

void HudLegendaryHandleWeaponEquippedHook(void* Widget, void* InWeapon) {
    if (!InWeapon) {
        static std::atomic<int> s_skipped{ 0 };
        if (s_skipped.fetch_add(1, std::memory_order_relaxed) < 20)
            MpLog("[HudLegendaryGuard] HandleWeaponEquipped with no weapon skipped widget=" + MpPtr(Widget));
        return;
    }
    reinterpret_cast<void(*)(void*, void*)>(OrigHudLegendaryHandleWeaponEquipped)(Widget, InWeapon);
}
