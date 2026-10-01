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

// What the game thread was doing, for the world watchdog's hang reports.

inline constexpr int kPeRing = 32;
extern char           g_gtPeNameRing[kPeRing][160];
extern std::atomic<uint32_t> g_gtPeRingPos;
extern std::atomic<void*>    g_gtPeCurFunc;
extern std::atomic<void*>    g_gtPeCurObj;

// Records a ProcessEvent call made on the game thread (others are ignored).
void NoteGameThreadEvent(void* Function, void* Object, const std::string& FunctionName);

// Samples the game thread from another thread and logs where it is
// ([HangTrace]): spinning or blocked, an unwound stack, recent calls and every
// thread's instruction pointer.
void LogHungGameThread();
