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

#pragma once
#include "native/Addresses112.h"
#include "core/Runtime.h"

extern bool s_ProgressionHudRefreshPending;

extern uint32_t s_ProgressionHudRefreshAttempts;

extern uint64_t s_ProgressionHudRefreshNotBeforeMs;

extern UObject* s_AirshipHUD;

extern UObject* s_AirshipGameState;

void ReconcileAirshipGameplayHUD(const char* TriggerLabel);

void TickProgressionHudRefresh();



inline constexpr uintptr_t kHudLegendaryHandleWeaponEquippedRva = Native112::LegendaryWeaponEquipped;

extern void* OrigHudLegendaryHandleWeaponEquipped;

void HudLegendaryHandleWeaponEquippedHook(void* Widget, void* InWeapon);
