/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

#pragma once
#include "core/Runtime.h"

// Applies -UndauntedAfkTimeoutSeconds to the world's game mode and game state.
// Call on the game thread every frame on world servers; it checks once a second.
void TickServerAfkTimeout();
