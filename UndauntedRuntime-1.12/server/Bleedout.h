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

#pragma once
#include "core/Runtime.h"

// Gives an island game mode without a bleed-out duration 30 s. Once per world.
void EnsureBleedoutDuration(SDK::UObject* GameMode);

// The bleed-out function a ProcessEvent call is, or null: the names logged as
// [Bleedout] events.
const char* BleedoutEventName(const std::string& FunctionName);

// Logs a bleed-out event with the component's state and tracks how long the
// player stays downed.
void NoteBleedoutEvent(const char* EventName, void* Object);

// Warns ([BleedoutStuck]) about a player downed for over 2 minutes.
void TickBleedoutWatch();

// -UndauntedDiag=bleedout: every player state's bleed-out state and remaining
// time a few times a second, and knockouts.
void TickBleedoutDiagnostic();

extern void* OrigKnockout;
void KnockoutHook(void* self);
