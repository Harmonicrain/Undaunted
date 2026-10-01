/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), September 2026.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

#pragma once
#include "core/Runtime.h"

// Diagnostic, off unless -UndauntedAllocProfile=<seconds> is on a world
// server's command line: records which call stacks own the engine
// allocator's live memory and writes the largest to allocprofile-<pid>.tsv
// next to the executable every <seconds>. Slows loading; for test worlds.
// Call from Init() after MH_Initialize.
void StartAllocProfile();
