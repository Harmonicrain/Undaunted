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
 * Hunt Pass selector. In October 2026 this file was split out of
 * diagnostics/RuntimeDiagnostics.cpp. Not an official release of
 * Mystic Paradox or Undaunted.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "server/Bleedout.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "core/Settings.h"

struct BleedoutWatchEntry {
    void*    Comp;
    uint64_t EnteredMs;
    float    DurationAtEntry;
    bool     Warned;
};

static std::string BleedoutSnapshot(void* Comp);
static void BleedoutWatchEnter(void* Comp, float Duration);
static void BleedoutWatchExit(void* Comp);

// An island game mode with no bleed-out duration (<= 0) makes SetTimer fail and
// leaves a downed player downed forever; such a mode gets 30 s.
void EnsureBleedoutDuration(SDK::UObject* GameMode) {
    static bool s_done = false;
    if (s_done || !GameMode) return;
    if (!IsReadablePointer(GameMode, 0x548)) return;

    if (!GameMode->IsA(SDK::AArchonGameMode_Island::StaticClass())) { s_done = true; return; }

    float* Duration = reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(GameMode) + 0x540);
    const float Original = *Duration;

    if (Original > 0.0f) {
        MpLog("[Bleedout] GameMode BleedoutDuration=" + std::to_string(Original)
            + "s (valid; no patch needed)");
        s_done = true;
        return;
    }

    *Duration = 30.0f;
    MpLog("[Bleedout] GameMode BleedoutDuration was " + std::to_string(Original)
        + " (<=0) — SetTimer would fail and the player would be stuck downed forever. Patched to "
        + std::to_string(*Duration) + "s.");
    s_done = true;
}

static std::string BleedoutSnapshot(void* Comp) {
    if (!Comp || !IsReadablePointer(Comp, 0x178)) return "comp=unreadable";
    const uintptr_t C = reinterpret_cast<uintptr_t>(Comp);

    const uint8_t  State     = *reinterpret_cast<uint8_t*>(C + 0x0B0);
    const uint8_t  PrevState = *reinterpret_cast<uint8_t*>(C + 0x0B1);
    const float    Duration  = *reinterpret_cast<float*>(C + 0x0B4);
    const uint8_t  Finishing = *reinterpret_cast<uint8_t*>(C + 0x130);
    const int32_t  RepNum    = *reinterpret_cast<int32_t*>(C + 0x150);
    const int32_t  NoHealth  = *reinterpret_cast<int32_t*>(C + 0x160);
    const uint8_t  Ready     = *reinterpret_cast<uint8_t*>(C + 0x170);

    return "comp=" + MpPtr(Comp)
        + " state=" + std::to_string(State) + (State == 1 ? "(Bleedout)" : "(None)")
        + " prev=" + std::to_string(PrevState)
        + " duration=" + std::to_string(Duration) + (Duration <= 0.0f ? "  <== ZERO/NEG: SetTimer WILL FAIL" : "")
        + " replacementEffects=" + std::to_string(RepNum) + (RepNum > 0 ? "  <== REPLACEMENT PATH" : "")
        + " finishingHit=" + std::to_string(Finishing)
        + " noHealthEffectHandle=" + std::to_string(NoHealth)
        + " readyForEvents=" + std::to_string(Ready);
}

static BleedoutWatchEntry g_BleedWatch[8]{};

static void BleedoutWatchEnter(void* Comp, float Duration) {
    uint64_t Now = GetTickCount64();
    for (auto& E : g_BleedWatch) if (E.Comp == Comp) { E.EnteredMs = Now; E.DurationAtEntry = Duration; E.Warned = false; return; }
    for (auto& E : g_BleedWatch) if (E.Comp == nullptr) { E = { Comp, Now, Duration, false }; return; }

    BleedoutWatchEntry* Oldest = &g_BleedWatch[0];
    for (auto& E : g_BleedWatch) if (E.EnteredMs < Oldest->EnteredMs) Oldest = &E;
    *Oldest = { Comp, Now, Duration, false };
}

static void BleedoutWatchExit(void* Comp) {
    for (auto& E : g_BleedWatch) if (E.Comp == Comp) { E = {}; return; }
}

void TickBleedoutWatch() {
    const uint64_t Now = GetTickCount64();

    for (auto& E : g_BleedWatch) {
        if (E.Comp == nullptr || E.Warned) continue;

        const uint64_t HeldMs = Now - E.EnteredMs;

        if (HeldMs < 120000) continue;

        if (!IsReadablePointer(E.Comp, 0x178)) { E = {}; continue; }
        if (*reinterpret_cast<uint8_t*>(reinterpret_cast<uintptr_t>(E.Comp) + 0x0B0) != 1) { E = {}; continue; }

        MpLog("[BleedoutStuck] STILL in bleedout after " + std::to_string(HeldMs / 1000)
            + "s (durationAtEntry=" + std::to_string(E.DurationAtEntry)
            + ") — player is likely stuck downed/invincible. " + BleedoutSnapshot(E.Comp));
        E.Warned = true;
    }
}

const char* BleedoutEventName(const std::string& FunctionName) {
    if (FunctionName.find("Bleedout") == std::string::npos
        && FunctionName.find("FinishingHit") == std::string::npos
        && FunctionName.find("NoHealth") == std::string::npos) {
        return nullptr;
    }

    static const char* kNames[] = {
        "ServerTryStartBleedout", "TryStartBleedout", "AuthSetBleedoutState",
        "AuthOnBleedoutReplaced", "OnRep_CurrentBleedoutState",
        "ReceiveOnEnteredBleedoutState", "ReceiveOnExitedBleedoutState",
        "BroadcastPlayerStartedBleedoutDelegate", "ApplyNoHealthGameplayEffectToSelf",
        "DoFinishingHit", "FailsafeDoFinishingHit", "ClientEndFinishingHit",
        "RegisterBleedoutReplacementEffect", "UnregisterBleedoutReplacementEffect",
        "CanReplaceBleedout", "ReplaceBleedout", "OnPlayerEnterBleedout"
    };

    for (const char* N : kNames) {
        if (FunctionName.find(N) != std::string::npos) return N;
    }
    return nullptr;
}

void NoteBleedoutEvent(const char* Hit, void* Obj) {

    const bool IsComponent = Obj != nullptr
        && reinterpret_cast<UObject*>(Obj)->IsA(SDK::UArchonBleedoutComponent::StaticClass());

    const std::string Snap = IsComponent
        ? BleedoutSnapshot(Obj)
        : ("obj=" + MpPtr(Obj) + " (not the bleedout component — fields not read)");
    MpLog(std::string("[Bleedout] ") + Hit + " | " + Snap);

    if (IsComponent && IsReadablePointer(Obj, 0x178)) {
        const uintptr_t C = reinterpret_cast<uintptr_t>(Obj);
        const uint8_t State = *reinterpret_cast<uint8_t*>(C + 0x0B0);
        const float Duration = *reinterpret_cast<float*>(C + 0x0B4);

        if (State == 1) BleedoutWatchEnter(Obj, Duration);
        else            BleedoutWatchExit(Obj);

        if (State == 1 && Duration <= 0.0f) {
            MpLog("[BleedoutBUG] entered bleedout with duration=" + std::to_string(Duration)
                + " — BleedOutElasped SetTimer will fail and the player will be stuck downed. " + Snap);
        }
    }
}

static void SampleBleedoutGrace() {
    UWorld* w = *reinterpret_cast<UWorld**>(Native112::At(Globals::BaseAddress, Native112::GWorld));
    if (!w || !IsReadablePointer(w, 0x128)) return;
    void* gs = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(w) + 0x120);
    if (!gs || !IsReadablePointer(gs, 0x248)) return;
    void** psData = *reinterpret_cast<void***>(reinterpret_cast<uintptr_t>(gs) + 0x238);
    int psNum = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(gs) + 0x240);
    if (!psData || psNum <= 0 || psNum > 64 || !IsReadablePointer(psData, 8)) return;
    for (int i = 0; i < psNum; ++i) {
        void* ps = psData[i];
        if (!ps || !IsReadablePointer(ps, 0x3B8)) continue;
        int32_t state = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(ps) + 0x3AC);
        if (state == 0) continue;
        float len = *reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(ps) + 0x3B0);
        float rem = *reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(ps) + 0x3B4);
        MpLog("[GraceDiag] ps=" + reinterpret_cast<UObject*>(ps)->GetName()
            + " BleedoutState=" + std::to_string(state)
            + " timerLen=" + std::to_string(len)
            + " timeRemaining=" + std::to_string(rem));
    }
}

static void SampleBleedoutGraceGuarded() {
    __try { SampleBleedoutGrace(); } __except (EXCEPTION_EXECUTE_HANDLER) {}
}

void* OrigKnockout = nullptr;

static void LogKnockout(void* self) {
    std::string nm = (self && IsReadablePointer(self, 0x40)) ? reinterpret_cast<UObject*>(self)->GetName() : std::string("?");
    MpLog("[GraceDiag] KNOCKOUT actor=" + nm);
}

// Installed only with -UndauntedDiag=bleedout.
void KnockoutHook(void* self) {
    reinterpret_cast<void(*)(void*)>(OrigKnockout)(self);
    __try { LogKnockout(self); } __except (EXCEPTION_EXECUTE_HANDLER) {}
}

void TickBleedoutDiagnostic() {
    static const bool Enabled = Settings::Diag(L"bleedout");
    static uint32_t Tick = 0;
    if (Enabled && (++Tick & 7) == 0) SampleBleedoutGraceGuarded();
}
