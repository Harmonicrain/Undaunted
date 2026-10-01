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

// Answers the Blueprints' TickFilterHelper as a dedicated server would
// (-UndauntedServerTickFilter) and/or counts its calls by call site
// (-UndauntedTickFilterCensus). World servers only. Call after MH_Initialize.
void InstallServerTickFilter();

// True when world servers answer TickFilterHelper as a dedicated server,
// which runs the player's own server-side stamina tick.
bool ServerTickFilterEnabled();

// Logs the census counts so far ([TickFilterCensus]). Call on the game thread.
void LogTickFilterCensus();
