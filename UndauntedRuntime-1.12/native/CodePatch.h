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
 * Hunt Pass selector. In October 2026 the instruction patches moved here from
 * core/PlayerRoles.cpp. Not an official release of Mystic Paradox or Undaunted.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#pragma once
#include "core/Runtime.h"

// Rewrites instructions in the executable after checking they are what this
// build has there, and logs each result ([CodePatch] <name> ...). Each returns
// whether it patched. Rvas and targets are executable-relative.

// Replaces Size bytes at Rva when they equal Expected.
bool PatchBytes(const char* Name, uintptr_t Rva, const uint8_t* Expected, const uint8_t* Replacement, size_t Size);

// mov byte ptr [Target], ExpectImm  ->  mov byte ptr [Target], NewImm
bool PatchStoreImmediate(const char* Name, uintptr_t Rva, uintptr_t Target, uint8_t ExpectImm, uint8_t NewImm);

// mov byte ptr [Target], r12b  ->  mov byte ptr [Target], 0
bool PatchStoreR12ToZero(const char* Name, uintptr_t Rva, uintptr_t Target);

// mov byte ptr [Target], al  ->  six nops
bool RemoveStoreAl(const char* Name, uintptr_t Rva, uintptr_t Target);

// call CallTarget  ->  mov al, 1 (the call answers true)
bool PatchCallToTrue(const char* Name, uintptr_t Rva, uintptr_t CallTarget);
