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

// Diagnostic, off unless -UndauntedScriptProfile=<seconds> is on a world
// server's command line. On the game thread it times every ProcessEvent by
// function (exclusive of the events it calls) and every actor replication
// (UActorChannel::ReplicateActor) by actor class, and logs the largest every
// <seconds> as [ScriptProfile] and [RepProfile] lines.
bool ScriptProfileEnabled();

// Times one ProcessEvent call. Construct at the top of the hook.
class ScriptProfileEventScope {
    bool Active = false;
public:
    explicit ScriptProfileEventScope(void* Function);
    ~ScriptProfileEventScope();
    ScriptProfileEventScope(const ScriptProfileEventScope&) = delete;
    ScriptProfileEventScope& operator=(const ScriptProfileEventScope&) = delete;
};

// One UActorChannel::ReplicateActor call: the actor's class, its duration in
// QueryPerformanceCounter ticks and its result (non-zero when it sent data).
void ScriptProfileReplicated(void* ActorClass, int64_t Ticks, uint64_t Result);

// These elapsed timings include native work inside the runtime-driven calls.
// They overlap event/replication profiles and must not be added to them.
enum class ScriptTickPhase { Engine, Dispatch, Flush, PlayerUpkeep, Maintenance, Count };
void ScriptProfileEngineTick(int64_t Ticks);
class ScriptProfileTickScope {
    ScriptTickPhase Phase;
    int64_t Start = 0;
public:
    explicit ScriptProfileTickScope(ScriptTickPhase InPhase);
    ~ScriptProfileTickScope();
    ScriptProfileTickScope(const ScriptProfileTickScope&) = delete;
    ScriptProfileTickScope& operator=(const ScriptProfileTickScope&) = delete;
};

// Call once per frame on the game thread; logs when a window is complete.
void ScriptProfileTick();
