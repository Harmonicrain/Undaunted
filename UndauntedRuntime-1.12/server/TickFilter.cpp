/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

#include "server/TickFilter.h"
#include "server/TickFilterPolicy.h"
#include "core/RuntimeState.h"
#include "core/RuntimeHooks.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "native/Addresses112.h"
#include "core/Settings.h"
#include <map>
#include <tuple>

// The player's Blueprints gate their per-frame work with
// TickFilterHelper(Actor, Where, Whom). Where is IslandOnly, CityOnly or Both;
// Whom is LocalOnly, RemoteOnly, LocalOrRemote, ServerOnly, LocalOrServer or All.
// This client build has no server branch: ServerOnly never passes, and an
// authority actor counts as "remote", so a world server took the branch meant
// for other clients' copies of a player. Read from the Blueprints on
// 2026-10-01 (all 16 call sites are the player character's and its combat
// animation Blueprint's):
//   - ReceiveTick stopped at its RemoteOnly branch, so the server never ran
//     TickBleedout (the downed countdown other players see), TickStamina
//     (stamina regeneration; the runtime called it itself instead) or its other
//     server ticks;
//   - ReceiveBeginPlay never started the 0.5 s UpdateLastValidPlayerTransform
//     timer that edge recovery returns a fallen player to (players fell off an
//     island and got stuck in a loop);
//   - the animation Blueprint ran seven client-only pose calculations (hand IK,
//     leaning, strafing, speed curves) on the server every frame.
// With -UndauntedServerTickFilter, an actor this world has authority over gets
// a dedicated server's answer: ServerOnly, LocalOrServer and All pass (where
// the island/city test does), LocalOnly, RemoteOnly and LocalOrRemote don't.
// -UndauntedTickFilterCensus logs, per call site, how often each was asked and
// passed (before and after).

namespace {
using ExecFn = void(*)(void* Context, void* Stack, void* Result);
using FilterFn = bool(*)(void* Actor, uint8_t Where, uint8_t Whom);
ExecFn OrigExec = nullptr;
FilterFn OrigFilter = nullptr;
thread_local void* CurrentStack = nullptr;

struct Stat { uint64_t Calls = 0; uint64_t GamePassed = 0; uint64_t ServerPassed = 0; };
using Key = std::tuple<void*, int32_t, uint8_t, uint8_t>;  // function, call-site offset, Where, Whom
SRWLOCK Lock = SRWLOCK_INIT;
std::map<Key, Stat> Stats;
uint64_t OtherThreadCalls = 0;

bool CensusOn() {
    static const bool On = Globals::AmServer && Settings::Has(L"TickFilterCensus");
    return On;
}

bool FixOn() {
    static const bool On = Globals::AmServer && Settings::Has(L"ServerTickFilter");
    return On;
}

bool HasAuthority(void* Actor) {
    __try {
        return Actor && reinterpret_cast<const uint8_t*>(Actor)[0xF0] == 3;  // AActor::Role == ROLE_Authority
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

// FFrame: Node (the executing UFunction) +0x10, Code +0x20; UStruct::Script +0x60/+0x68.
void CallSite(void* Stack, void** Function, int32_t* Offset) {
    *Function = nullptr;
    *Offset = -1;
    if (!Stack) return;
    __try {
        void* Node = *reinterpret_cast<void**>(reinterpret_cast<uint8_t*>(Stack) + 0x10);
        const uint8_t* Code = *reinterpret_cast<const uint8_t**>(reinterpret_cast<uint8_t*>(Stack) + 0x20);
        const uint8_t* Script = Node ? *reinterpret_cast<const uint8_t**>(reinterpret_cast<uint8_t*>(Node) + 0x60) : nullptr;
        const int32_t Size = Node ? *reinterpret_cast<int32_t*>(reinterpret_cast<uint8_t*>(Node) + 0x68) : 0;
        *Function = Node;
        if (Script && Code >= Script && Code <= Script + Size) *Offset = static_cast<int32_t>(Code - Script);
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
    }
}

void __fastcall ExecHook(void* Context, void* Stack, void* Result) {
    void* const Previous = CurrentStack;
    CurrentStack = Stack;
    OrigExec(Context, Stack, Result);
    CurrentStack = Previous;
}

bool __fastcall FilterHook(void* Actor, uint8_t Where, uint8_t Whom) {
    // With Whom = All the game's answer is the island/city test alone.
    const int Server = HasAuthority(Actor)
        ? ServerTickFilterAnswer(Whom, OrigFilter(Actor, Where, static_cast<uint8_t>(TickWhom::All)))
        : -1;
    if (FixOn() && Server >= 0 && !CensusOn()) return Server == 1;
    const bool GameAnswer = OrigFilter(Actor, Where, Whom);
    const bool ServerAnswer = Server >= 0 ? Server == 1 : GameAnswer;
    const bool Result = FixOn() ? ServerAnswer : GameAnswer;
    if (!CensusOn()) return Result;
    if (GameTickThreadId == 0 || GetCurrentThreadId() != GameTickThreadId) {
        AcquireSRWLockExclusive(&Lock);
        ++OtherThreadCalls;
        ReleaseSRWLockExclusive(&Lock);
        return Result;
    }
    void* Function = nullptr;
    int32_t Offset = -1;
    CallSite(CurrentStack, &Function, &Offset);
    AcquireSRWLockExclusive(&Lock);
    Stat& Entry = Stats[Key(Function, Offset, Where, Whom)];
    ++Entry.Calls;
    if (GameAnswer) ++Entry.GamePassed;
    if (ServerAnswer) ++Entry.ServerPassed;
    ReleaseSRWLockExclusive(&Lock);
    return Result;
}

std::string FunctionName(void* Function) {
    if (!Function || !IsRegisteredLiveObject(Function)) return "(unknown)";
    return reinterpret_cast<UObject*>(Function)->GetFullName();
}
}

bool ServerTickFilterEnabled() {
    return FixOn() && OrigFilter != nullptr;
}

void InstallServerTickFilter() {
    if (!FixOn() && !CensusOn()) return;
    // push rbx; push rsi; push rdi; sub rsp, 20h; xor edi, edi; mov rsi, r8
    static const unsigned char ExecBytes[] = { 0x40, 0x53, 0x56, 0x57, 0x48, 0x83, 0xEC, 0x20, 0x33, 0xFF, 0x49, 0x8B, 0xF0 };
    // mov [rsp+8], rbx; mov [rsp+10h], rsi; push rdi; sub rsp, 20h; movzx ebx, r8b; movzx esi, dl
    static const unsigned char FilterBytes[] = { 0x48, 0x89, 0x5C, 0x24, 0x08, 0x48, 0x89, 0x74, 0x24, 0x10, 0x57,
        0x48, 0x83, 0xEC, 0x20, 0x41, 0x0F, 0xB6, 0xD8, 0x0F, 0xB6, 0xF2 };
    void* Exec = reinterpret_cast<void*>(Native112::At(Globals::BaseAddress, Native112::TickFilterHelperExec));
    void* Filter = reinterpret_cast<void*>(Native112::At(Globals::BaseAddress, Native112::TickFilterHelper));
    if (memcmp(Exec, ExecBytes, sizeof(ExecBytes)) != 0 || memcmp(Filter, FilterBytes, sizeof(FilterBytes)) != 0) {
        MpLog("[TickFilter] TickFilterHelper has unexpected bytes; left alone");
        return;
    }
    MH_STATUS ExecEnable = MH_OK;
    if (CensusOn()) {
        const MH_STATUS ExecCreate = RUNTIME_CREATE_HOOK(Exec, ExecHook, &OrigExec);
        ExecEnable = ExecCreate == MH_OK ? RuntimeHooks::Enable(Exec) : ExecCreate;
    }
    const MH_STATUS FilterCreate = RUNTIME_CREATE_HOOK(Filter, FilterHook, &OrigFilter);
    const MH_STATUS FilterEnable = FilterCreate == MH_OK ? RuntimeHooks::Enable(Filter) : FilterCreate;
    if (FilterEnable != MH_OK) OrigFilter = nullptr;
    MpLog(std::string("[TickFilter] ") + (FixOn() ? "answering as a dedicated server" : "game's own answers")
        + (CensusOn() ? ", counting call sites" : "") + "; filter " + MH_StatusToString(FilterEnable)
        + (CensusOn() ? std::string(", exec ") + MH_StatusToString(ExecEnable) : std::string()));
}

void LogTickFilterCensus() {
    if (!CensusOn()) return;
    std::vector<std::pair<Key, Stat>> Rows;
    uint64_t Others = 0;
    AcquireSRWLockShared(&Lock);
    Rows.assign(Stats.begin(), Stats.end());
    Others = OtherThreadCalls;
    ReleaseSRWLockShared(&Lock);
    std::sort(Rows.begin(), Rows.end(), [](const auto& A, const auto& B) { return A.second.Calls > B.second.Calls; });
    uint64_t Calls = 0, Changed = 0;
    for (const auto& Row : Rows) {
        Calls += Row.second.Calls;
        Changed += Row.second.GamePassed > Row.second.ServerPassed ? Row.second.GamePassed - Row.second.ServerPassed
                                                                   : Row.second.ServerPassed - Row.second.GamePassed;
    }
    MpLog("[TickFilterCensus] " + std::to_string(Rows.size()) + " call sites, " + std::to_string(Calls)
        + " calls, " + std::to_string(Changed) + " answered differently by a dedicated server ("
        + (FixOn() ? "server answers in use" : "game answers in use") + "); "
        + std::to_string(Others) + " calls off the game thread");
    char Line[176];
    for (const auto& Row : Rows) {
        const Stat& S = Row.second;
        sprintf_s(Line, "[TickFilterCensus] where %u whom %u: %llu calls, game passed %llu, server passed %llu  ",
            std::get<2>(Row.first), std::get<3>(Row.first), static_cast<unsigned long long>(S.Calls),
            static_cast<unsigned long long>(S.GamePassed), static_cast<unsigned long long>(S.ServerPassed));
        MpLog(Line + FunctionName(std::get<0>(Row.first)) + " @" + std::to_string(std::get<1>(Row.first)));
    }
}
