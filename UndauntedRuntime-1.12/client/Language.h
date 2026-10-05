/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

#pragma once

// Switches the client to the language given with -culture= once the game is
// running (see Language.cpp). Safe to call on every ProcessEvent; it acts once.
void ApplyRequestedCultureOnce();
