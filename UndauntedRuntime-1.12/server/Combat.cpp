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

#include "server/Combat.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "diagnostics/RuntimeDiagnostics.h"

bool ServerTryActivateAbilityInternal(UAbilitySystemComponent* Component, FGameplayAbilitySpecHandle& AbilityHandle, bool InputPressed, FPredictionKey& PredictionKey, FGameplayEventData* TriggerEventData) {
    const AbilitySpecDiagnostic Spec = FindAbilitySpecDiagnostic(Component, AbilityHandle.Handle);
    void* OwnerActor = (Component && IsReadablePointer(Component, 0x3E0))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Component) + 0x3D0) : nullptr;
    void* AvatarActor = (Component && IsReadablePointer(Component, 0x3E0))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Component) + 0x3D8) : nullptr;
    void* PlayerRole = (AvatarActor && IsReadablePointer(AvatarActor, 0x740))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(AvatarActor) + 0x738) : nullptr;
    const std::string ChargeBefore = PlayerRoleChargeSummary(PlayerRole);

    if(InputPressed)
        Component->ServerSetInputPressed(AbilityHandle);

    void* InstancedAbility = nullptr;

    bool Activated = reinterpret_cast<bool(*)(UAbilitySystemComponent*, uint32_t, FPredictionKey*, void**, void*, FGameplayEventData*)>(Native112::At(Globals::BaseAddress, Native112::Rva_015B9E20))(Component, AbilityHandle.Handle, &PredictionKey, &InstancedAbility, nullptr, TriggerEventData);

    if (!Activated && InputPressed)
        Component->ServerSetInputReleased(AbilityHandle);

    static std::atomic<int> s_abilityActivateLogCount{ 0 };
    if (s_abilityActivateLogCount.fetch_add(1, std::memory_order_relaxed) < 128) {
        MpLog("[AbilityActivate] component=" + MpPtr(Component)
            + " handle=" + std::to_string(AbilityHandle.Handle)
            + " inputPressed=" + std::to_string(InputPressed ? 1 : 0)
            + " activated=" + std::to_string(Activated ? 1 : 0)
            + " owner=" + MpPtr(OwnerActor) + "/" + SafeObjectNameForDiagnostic(OwnerActor)
            + " avatar=" + MpPtr(AvatarActor) + "/" + SafeObjectNameForDiagnostic(AvatarActor)
            + " ability=" + MpPtr(Spec.Ability) + "/" + SafeObjectNameForDiagnostic(Spec.Ability)
            + " source=" + MpPtr(Spec.SourceObject) + "/" + SafeObjectNameForDiagnostic(Spec.SourceObject)
            + " level=" + std::to_string(Spec.Level) + " inputId=" + std::to_string(Spec.InputId)
            + " chargeBefore={" + ChargeBefore + "} chargeAfter={" + PlayerRoleChargeSummary(PlayerRole) + "}");
    }

    return Activated;
}
