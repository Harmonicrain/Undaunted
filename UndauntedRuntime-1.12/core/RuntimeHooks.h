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
#include "core/Runtime.h"

void InstallApiHook(LPCWSTR Module, LPCSTR ProcName, LPVOID Detour, LPVOID* Original, const char* Tag);

bool MpForceWarpEnabled();

void InstallWarpForceHooks();

namespace RuntimeHooks {
    MH_STATUS Create(void* Target, void* Detour, void** Original, const char* Name);
    MH_STATUS Enable(void* Target);
}

// Preserve each installer's original create/enable order and status checks.
// Names and executable-relative addresses are recorded without command lines.
#define RUNTIME_CREATE_HOOK(Target, Detour, Original) \
    RuntimeHooks::Create(Target, reinterpret_cast<void*>(Detour), \
        reinterpret_cast<void**>(Original), #Detour)
