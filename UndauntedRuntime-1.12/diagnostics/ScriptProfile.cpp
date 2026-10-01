/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

#include "diagnostics/ScriptProfile.h"
#include "diagnostics/ObjectCensus.h"
#include "core/RuntimeState.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "core/Settings.h"
#include <unordered_map>

namespace {
struct EventStat { uint64_t Calls = 0; int64_t Inclusive = 0; int64_t Exclusive = 0; };
struct RepStat { uint64_t Calls = 0; uint64_t Sent = 0; int64_t Ticks = 0; };
struct Frame { void* Function; int64_t Start; int64_t Children; };
struct TickStat { uint64_t Calls = 0; int64_t Ticks = 0; };
TickStat TickPhases[static_cast<size_t>(ScriptTickPhase::Count)]{};

// Game thread only: no locks.
std::unordered_map<void*, EventStat> Events;
std::unordered_map<void*, RepStat> Reps;
Frame Stack[256];
int Depth = 0;
int64_t WindowStart = 0;
double TicksPerMs = 0.0;

int WindowSeconds() {
    static const int Seconds = [] {
        if (!Globals::AmServer) return 0;
        return Settings::Int(L"ScriptProfile", 0, 5, 3600, 0);
    }();
    return Seconds;
}

bool OnGameThread() {
    return GameTickThreadId != 0 && GetCurrentThreadId() == GameTickThreadId;
}

int64_t Now() {
    LARGE_INTEGER Value;
    QueryPerformanceCounter(&Value);
    return Value.QuadPart;
}

// Names are read only when logging, from objects that are still registered.
std::string NameOf(void* Object, bool Full) {
    if (!Object || !IsRegisteredLiveObject(Object)) return "(gone)";
    return Full ? reinterpret_cast<UObject*>(Object)->GetFullName() : reinterpret_cast<UObject*>(Object)->GetName();
}

void ReportObjects() {
    if (!UObject::GObjects) return;
    std::unordered_map<void*, uint64_t> Classes;
    const ObjectSlotCounts Counts = CountObjectSlots(UObject::GObjects->Num(), [&](int32_t Index) {
        UObject* Object = UObject::GObjects->GetByIndex(Index);
        if (!Object || !IsRegisteredLiveObject(Object)) return false;
        ++Classes[Object->Class];
        return true;
    });
    char Line[256];
    sprintf_s(Line, "[ObjectProfile] %d slots, %d registered objects in %zu classes (includes defaults and pending GC)",
        Counts.Slots, Counts.Registered, Classes.size());
    MpLog(Line);
    std::vector<std::pair<void*, uint64_t>> Sorted(Classes.begin(), Classes.end());
    std::sort(Sorted.begin(), Sorted.end(), [](const auto& A, const auto& B) { return A.second > B.second; });
    for (size_t Index = 0; Index < Sorted.size(); ++Index) {
        const auto& Entry = Sorted[Index];
        const std::string Name = NameOf(Entry.first, false);
        const bool LifecycleClass = Name.find("Quest") != std::string::npos
            || Name.find("PlayerController") != std::string::npos || Name.find("NetConnection") != std::string::npos
            || Name.find("ReplicationGraph") != std::string::npos || Name == "BP_PlayerCharacter_C";
        if (Index >= 15 && !LifecycleClass) continue;
        sprintf_s(Line, "[ObjectProfile] %7llu registered  ", static_cast<unsigned long long>(Entry.second));
        MpLog(Line + Name);
    }
}

void Report(double Seconds) {
    char Line[512];
    const char* PhaseNames[] = { "engine", "dispatch", "flush", "player upkeep", "world maintenance" };
    for (size_t Index = 0; Index < static_cast<size_t>(ScriptTickPhase::Count); ++Index) {
        const TickStat& Stat = TickPhases[Index];
        sprintf_s(Line, "[TickProfile] %s: %.2f ms/s elapsed, %.3f ms/call, %.0f calls/s",
            PhaseNames[Index], Stat.Ticks / TicksPerMs / Seconds,
            Stat.Calls ? Stat.Ticks / TicksPerMs / Stat.Calls : 0.0, Stat.Calls / Seconds);
        MpLog(Line);
    }
    std::vector<std::pair<void*, EventStat>> SortedEvents(Events.begin(), Events.end());
    std::sort(SortedEvents.begin(), SortedEvents.end(),
        [](const auto& A, const auto& B) { return A.second.Exclusive > B.second.Exclusive; });
    int64_t EventTotal = 0;
    uint64_t CallTotal = 0;
    for (const auto& Entry : SortedEvents) { EventTotal += Entry.second.Exclusive; CallTotal += Entry.second.Calls; }
    sprintf_s(Line, "[ScriptProfile] %.0fs: %llu ProcessEvent calls (%.0f/s), %.2f ms/s exclusive in %zu functions",
        Seconds, static_cast<unsigned long long>(CallTotal), CallTotal / Seconds,
        EventTotal / TicksPerMs / Seconds, SortedEvents.size());
    MpLog(Line);
    for (size_t Index = 0; Index < SortedEvents.size() && Index < 30; ++Index) {
        const auto& Stat = SortedEvents[Index].second;
        sprintf_s(Line, "[ScriptProfile] %6.2f ms/s excl %6.2f incl %7.0f calls/s  ",
            Stat.Exclusive / TicksPerMs / Seconds, Stat.Inclusive / TicksPerMs / Seconds, Stat.Calls / Seconds);
        MpLog(Line + NameOf(SortedEvents[Index].first, true));
    }

    std::vector<std::pair<void*, RepStat>> SortedReps(Reps.begin(), Reps.end());
    std::sort(SortedReps.begin(), SortedReps.end(),
        [](const auto& A, const auto& B) { return A.second.Ticks > B.second.Ticks; });
    int64_t RepTotal = 0;
    uint64_t RepCalls = 0, RepSent = 0;
    for (const auto& Entry : SortedReps) { RepTotal += Entry.second.Ticks; RepCalls += Entry.second.Calls; RepSent += Entry.second.Sent; }
    sprintf_s(Line, "[RepProfile] %.0fs: %llu ReplicateActor calls (%.0f/s, %.0f/s sent data), %.2f ms/s in %zu classes",
        Seconds, static_cast<unsigned long long>(RepCalls), RepCalls / Seconds, RepSent / Seconds,
        RepTotal / TicksPerMs / Seconds, SortedReps.size());
    MpLog(Line);
    for (size_t Index = 0; Index < SortedReps.size() && Index < 30; ++Index) {
        const auto& Stat = SortedReps[Index].second;
        sprintf_s(Line, "[RepProfile] %6.2f ms/s %7.0f calls/s %7.0f sent/s %6.1f us/call  ",
            Stat.Ticks / TicksPerMs / Seconds, Stat.Calls / Seconds, Stat.Sent / Seconds,
            Stat.Calls ? Stat.Ticks / TicksPerMs * 1000.0 / Stat.Calls : 0.0);
        MpLog(Line + NameOf(SortedReps[Index].first, false));
    }
    ReportObjects();
}
}

bool ScriptProfileEnabled() {
    return WindowSeconds() > 0;
}

void ScriptProfileEngineTick(int64_t Ticks) {
    if (!ScriptProfileEnabled() || !OnGameThread()) return;
    TickStat& Stat = TickPhases[static_cast<size_t>(ScriptTickPhase::Engine)];
    ++Stat.Calls;
    Stat.Ticks += Ticks;
}

ScriptProfileTickScope::ScriptProfileTickScope(ScriptTickPhase InPhase) : Phase(InPhase) {
    if (ScriptProfileEnabled() && OnGameThread()) Start = Now();
}

ScriptProfileTickScope::~ScriptProfileTickScope() {
    if (!Start) return;
    TickStat& Stat = TickPhases[static_cast<size_t>(Phase)];
    ++Stat.Calls;
    Stat.Ticks += Now() - Start;
}

ScriptProfileEventScope::ScriptProfileEventScope(void* Function) {
    if (!ScriptProfileEnabled() || !Function || !OnGameThread() || Depth >= 256) return;
    Stack[Depth++] = { Function, Now(), 0 };
    Active = true;
}

ScriptProfileEventScope::~ScriptProfileEventScope() {
    if (!Active || Depth <= 0) return;
    const Frame Done = Stack[--Depth];
    const int64_t Elapsed = Now() - Done.Start;
    EventStat& Stat = Events[Done.Function];
    ++Stat.Calls;
    Stat.Inclusive += Elapsed;
    Stat.Exclusive += Elapsed - Done.Children;
    if (Depth > 0) Stack[Depth - 1].Children += Elapsed;
}

void ScriptProfileReplicated(void* ActorClass, int64_t Ticks, uint64_t Result) {
    if (!ScriptProfileEnabled() || !OnGameThread()) return;
    RepStat& Stat = Reps[ActorClass];
    ++Stat.Calls;
    if (Result) ++Stat.Sent;
    Stat.Ticks += Ticks;
    // Count it as a child of any event on the stack, so that event's
    // exclusive time stays its own.
    if (Depth > 0) Stack[Depth - 1].Children += Ticks;
}

void ScriptProfileTick() {
    if (!ScriptProfileEnabled() || !OnGameThread() || Depth != 0) return;
    if (TicksPerMs == 0.0) {
        LARGE_INTEGER Frequency;
        QueryPerformanceFrequency(&Frequency);
        TicksPerMs = Frequency.QuadPart / 1000.0;
        WindowStart = Now();
        MpLog("[ScriptProfile] profiling ProcessEvent and actor replication every "
            + std::to_string(WindowSeconds()) + " s");
        return;
    }
    const double Seconds = (Now() - WindowStart) / TicksPerMs / 1000.0;
    if (Seconds < WindowSeconds()) return;
    Report(Seconds);
    Events.clear();
    Reps.clear();
    for (auto& Stat : TickPhases) Stat = {};
    WindowStart = Now();
}
