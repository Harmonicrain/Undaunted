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
 * Hunt Pass selector. In October 2026 this file was split out of
 * diagnostics/RuntimeDiagnostics.cpp. Not an official release of
 * Mystic Paradox or Undaunted.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "diagnostics/EscalationTrace.h"
#include "diagnostics/PlayerRoleDiagnostics.h"
#include "core/RuntimeState.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "client/PlayerRoleActivation.h"
#include "core/Settings.h"

static UObject* ResolveEscalationFlowPlayer(UObject* Object, const std::string& FunctionName,
                                            void* Parms, const char* Side);
static std::string EscalationArrayState(UObject* Object);
static std::string EscalationFlowParams(const std::string& FunctionName, void* Parms);
static std::string EscalationFlowContext(UObject* Object, const std::string& FunctionName,
                                         void* Parms, const char* Side);

bool IsEscalationFlowFunction(const std::string& FunctionName) {
    // Every marker below contains "scalation"; this runs on every ProcessEvent.
    if (FunctionName.find("scalation") == std::string::npos) return false;
    const char* Markers[] = {
        "EscalationGameModeComponent.SpawnPlayerBuffChoicesForFinishedRound",
        "EscalationGameModeComponent.OnPlayerActivatedCrystal",
        "EscalationGameModeComponent.PlayerChoseRelic",
        "EscalationGameModeComponent.PlayerEscalationRelicsChanged",
        "EscalationGameModeComponent.RelicSelectedBP",
        "EscalationGameModeComponent.SpawnAllRelics",
        "EscalationGameModeComponent.SpawnRelics",
        "EscalationGameModeComponent.SpawnSpecificRelic",
        "EscalationGameModeComponent.SpawnPersonalBuffPickupsForPlayer",
        "PlayerEscalationComponent.ClientDisplayRelicChoiceUI",
        "PlayerEscalationComponent.OnRep_EscalationRelics",
        "PlayerEscalationComponent.OnShowRelicChoiceScreen",
        "PlayerEscalationComponent.RoundEnded",
        "PlayerEscalationComponent.SelectRelicOption",
        "PlayerEscalationComponent.ServerSelectRelicOption",
        "PlayerEscalationComponent.ServerForceReplication",
        "PlayerEscalationComponent.RelicSelectedNative",
        "PlayerEscalationComponent.OnRelicSelected",
        "escalation_buff_gatherable_bp_C.OnInteractionEnabled",
        "escalation_buff_gatherable_bp_C.OnCrystalActivated",
        "escalation_buff_gatherable_bp_C.Failsafe_EnableInteraction",
        "escalation_buff_gatherable_bp_C.OnUserCanceledInteraction",
        "escalation_buff_gatherable_bp_C.OnUserStartedInteraction",
        "escalation_buff_gatherable_bp_C.OnUserCompletedInteraction",
        "escalation_buff_gatherable_bp_C.AuthEnableInteractable",
        "EscalationRelicChoiceScreen.EnableRelicInteractions",
        "EscalationRelicChoiceScreen.HandleRelicSelected",
        "escalation_relic_choice_screen_C.EnableRelicInteraction",
        "escalation_relic_choice_screen_C.BeginRelicAnimations"
    };
    for (const char* Marker : Markers) {
        if (FunctionName.find(Marker) != std::string::npos) return true;
    }
    return false;
}

static UObject* ResolveEscalationFlowPlayer(UObject* Object, const std::string& FunctionName,
                                            void* Parms, const char* Side) {
    const bool FirstParamIsPlayer =
        FunctionName.find("OnPlayerActivatedCrystal") != std::string::npos
        || FunctionName.find("PlayerChoseRelic") != std::string::npos
        || FunctionName.find("RelicSelectedNative") != std::string::npos
        || FunctionName.find("RelicSelectedBP") != std::string::npos
        || FunctionName.find("SpawnAllRelics") != std::string::npos
        || FunctionName.find("SpawnRelics") != std::string::npos
        || FunctionName.find("SpawnSpecificRelic") != std::string::npos
        || FunctionName.find("SpawnPersonalBuffPickupsForPlayer") != std::string::npos;
    if (FirstParamIsPlayer && Parms && IsReadablePointer(Parms, sizeof(void*))) {
        UObject* Player = *reinterpret_cast<UObject**>(Parms);
        if (Player && IsReadablePointer(Player, 0x258)) return Player;
    }

    if (Object && FunctionName.find("escalation_buff_gatherable_bp_C.") != std::string::npos
        && IsReadablePointer(Object, 0x500)) {
        UObject* Player = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(Object) + 0x4F8);
        if (Player && IsReadablePointer(Player, 0x258)) return Player;
    }

    UObject* Cursor = Object;
    for (int Depth = 0; Cursor && Depth < 4; ++Depth) {
        if (IsReadablePointer(Cursor, 0x28)
            && Cursor->IsA(SDK::APlayerController::StaticClass())) return Cursor;
        Cursor = IsReadablePointer(Cursor, 0x28) ? Cursor->Outer : nullptr;
    }

    if (Side && strcmp(Side, "Client") == 0 && s_LastPossessedPC
        && IsReadablePointer(s_LastPossessedPC, 0x258)) return s_LastPossessedPC;
    return nullptr;
}

static std::string EscalationArrayState(UObject* Object) {
    if (!Object || !IsReadablePointer(Object, 0x158)
        || !Object->IsA(SDK::UPlayerEscalationComponent::StaticClass())) return "component=n/a";
    const uintptr_t Base = reinterpret_cast<uintptr_t>(Object);
    const int Seasons = SafeReadI32At(Base, 0x128);
    const int SeasonsMax = SafeReadI32At(Base, 0x12C);
    const int Choices = SafeReadI32At(Base, 0x138);
    const int ChoicesMax = SafeReadI32At(Base, 0x13C);
    const int Options = SafeReadI32At(Base, 0x148);
    const int OptionsMax = SafeReadI32At(Base, 0x14C);
    const int Rewards = SafeReadI32At(Base, 0x150);
    return "component=" + MpPtr(Object)
        + " seasons=" + std::to_string(Seasons) + "/" + std::to_string(SeasonsMax)
        + " choices=" + std::to_string(Choices) + "/" + std::to_string(ChoicesMax)
        + " options=" + std::to_string(Options) + "/" + std::to_string(OptionsMax)
        + " roundRewards=" + std::to_string(Rewards);
}

static std::string EscalationFlowParams(const std::string& FunctionName, void* Parms) {
    if (!Parms) return "none";
    const uintptr_t P = reinterpret_cast<uintptr_t>(Parms);
    if (FunctionName.find("ClientDisplayRelicChoiceUI") != std::string::npos) {
        return "relicOptions=" + std::to_string(SafeReadI32At(P, 0x8))
            + " debugChances=" + std::to_string(SafeReadI32At(P, 0x18))
            + " advances=" + std::to_string(SafeReadU8At(P, 0x20));
    }
    if (FunctionName.find("SelectRelicOption") != std::string::npos) {
        std::string RelicId = IsReadablePointer(Parms, 0x8)
            ? reinterpret_cast<SDK::FName*>(Parms)->ToString() : std::string("?");
        return "relicId=" + RelicId + " advances=" + std::to_string(SafeReadU8At(P, 0x8));
    }
    if (FunctionName.find("RelicSelectedNative") != std::string::npos
        || FunctionName.find("RelicSelectedBP") != std::string::npos) {
        return "player=" + MpPtr(*reinterpret_cast<void**>(Parms))
            + " advances=" + std::to_string(SafeReadU8At(P, 0x8));
    }
    if (FunctionName.find("OnPlayerActivatedCrystal") != std::string::npos
        || FunctionName.find("PlayerChoseRelic") != std::string::npos
        || FunctionName.find("SpawnAllRelics") != std::string::npos
        || FunctionName.find("SpawnRelics") != std::string::npos
        || FunctionName.find("SpawnSpecificRelic") != std::string::npos
        || FunctionName.find("SpawnPersonalBuffPickupsForPlayer") != std::string::npos) {
        return "player=" + MpPtr(*reinterpret_cast<void**>(Parms));
    }
    if (FunctionName.find("OnShowRelicChoiceScreen") != std::string::npos
        || FunctionName.find("HandleRelicSelected") != std::string::npos
        || FunctionName.find("OnUserStartedInteraction") != std::string::npos
        || FunctionName.find("OnUserCompletedInteraction") != std::string::npos
        || FunctionName.find("OnUserCanceledInteraction") != std::string::npos) {
        return "arg0=" + MpPtr(*reinterpret_cast<void**>(Parms));
    }
    return "present";
}

static std::string EscalationFlowContext(UObject* Object, const std::string& FunctionName,
                                         void* Parms, const char* Side) {
    UObject* Player = ResolveEscalationFlowPlayer(Object, FunctionName, Parms, Side);
    void* PlayerState = (Player && IsReadablePointer(Player, 0x230))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Player) + 0x228) : nullptr;
    const std::string PlayerName = (PlayerState && IsReadablePointer(PlayerState, 0x310))
        ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(PlayerState) + 0x300))
        : std::string();
    UObject* Outer = (Object && IsReadablePointer(Object, 0x28)) ? Object->Outer : nullptr;
    return " obj=" + MpPtr(Object) + "/" + SafeObjectNameForDiagnostic(Object)
        + " outer=" + MpPtr(Outer) + "/" + SafeObjectNameForDiagnostic(Outer)
        + " player=" + MpPtr(Player) + "/" + SafeObjectNameForDiagnostic(Player)
        + " playerState=" + MpPtr(PlayerState)
        + " playerName=" + (PlayerName.empty() ? std::string("?") : PlayerName)
        + " state={" + EscalationArrayState(Object) + "}"
        + " params={" + EscalationFlowParams(FunctionName, Parms) + "}";
}

int TraceEscalationFlowEnter(const char* Side, UObject* Object,
                                    const std::string& FunctionName, void* Parms) {
    static const bool Enabled = Settings::Diag(L"escalation");
    if (!Enabled || !IsEscalationFlowFunction(FunctionName)) return -1;
    static std::atomic<int> s_EscalationFlowSequence{ 0 };
    const int Seq = s_EscalationFlowSequence.fetch_add(1, std::memory_order_relaxed);
    if (Seq >= 512) return -1;
    MpLog(std::string("[EscalationFlow][") + Side + "][ENTER #" + std::to_string(Seq)
        + "] fn=" + FunctionName + EscalationFlowContext(Object, FunctionName, Parms, Side));
    return Seq;
}

void TraceEscalationFlowExit(const char* Side, int Seq, UObject* Object,
                                   const std::string& FunctionName, void* Parms) {
    if (Seq < 0) return;
    MpLog(std::string("[EscalationFlow][") + Side + "][EXIT #" + std::to_string(Seq)
        + "] fn=" + FunctionName + EscalationFlowContext(Object, FunctionName, Parms, Side));
}
