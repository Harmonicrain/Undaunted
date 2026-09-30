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

// Hands a world server's untouched memory back to Windows after load, after a
// player joins and when the world empties (periodically too, if asked). Call
// on the game thread every frame
// once the world is listening; Connections < 0 means unknown.
void TickServerWorkingSetTrim(int32_t Connections);
