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

// Lets a world server's frame limiter sleep out the end of each frame instead
// of spinning. Call after MH_Initialize.
void InstallServerFrameWait();

// Logs and resets the frame wait statistics. Call on the game thread.
void LogServerFrameWaitStats();
