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
 * Hunt Pass selector. In October 2026 the world watchdog was split out of
 * diagnostics/RuntimeDiagnostics.cpp and its two empty-world shutdowns became
 * one. Not an official release of Mystic Paradox or Undaunted.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#pragma once
#include "core/Runtime.h"

// Off for a world started by hand (without the deploy server's arguments).
extern bool EnableWatchdog;

// Ends this world server at once (TerminateProcess, skipping the engine's
// teardown), logging why.
void MpReapExit(const char* Reason, UINT ExitCode = 0);

// Once a frame on the game thread: a hunt island (not Ramsgate or the Training
// Grounds) with no players for 50 s shuts down. HasConnection is the fallback
// when there is no game mode to count players.
void TickWorldWatchdog(float DeltaTime, bool HasConnection);

// Starts the thread that watches for a hung game thread on a hunt island that
// has had a player: it logs where the thread is after 20 s without a tick and
// shuts the world down after 180 s.
void StartWorldWatchdogThread();
