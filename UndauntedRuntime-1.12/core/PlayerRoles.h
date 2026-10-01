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
 * Hunt Pass selector. In October 2026 its client and world server parts moved to
 * client/PlayerRoleActivation.h and server/PlayerRoleRouting.h. Not an official release of
 * Mystic Paradox or Undaunted.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#pragma once
#include "core/Runtime.h"

extern void* OrigApplyPlayerRole;

// UArchonLoadout's ApplyPlayerRole, hooked on clients and world servers.
void ApplyPlayerRoleHook(void* a1);

// Retries applying player roles that didn't reach their pawn, each up to this
// many times (the client's role notifications use the same limit).
inline constexpr int kMaxPlayerRoleRetryAttempts = 20;
void TickPlayerRoleRetries();

bool TryApplyPlayerRoleRetryGuarded(
    void* LoadoutPtr, void** OutRole, void** OutSlot, void** OutPawn, void** OutPawnRole,
    bool* OutAppliedBefore, bool* OutAppliedAfter);

// Called with the pawn's player role once ApplyPlayerRole has put it on the
// pawn; world servers set it (server/PlayerRoleRouting).
using PlayerRoleAppliedFn = void(*)(void* PawnRole);
void SetPlayerRoleAppliedHandler(PlayerRoleAppliedFn Handler);
