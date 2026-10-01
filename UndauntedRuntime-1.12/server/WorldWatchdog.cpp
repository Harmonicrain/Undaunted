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
 * Hunt Pass selector. In October 2026 the world watchdog was split out of
 * diagnostics/RuntimeDiagnostics.cpp and its two empty-world shutdowns became
 * one. Not an official release of Mystic Paradox or Undaunted.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "server/WorldWatchdog.h"
#include "server/WorldState.h"
#include "diagnostics/HangTrace.h"
#include "core/Logging.h"
#include "core/Memory.h"

bool EnableWatchdog = true;

namespace {
// 1 for Ramsgate and the Training Grounds (never shut down for being empty),
// 0 for a hunt island, -1 until a game mode has been seen.
std::atomic<int> g_IsHub{ -1 };
std::atomic<uint64_t> g_LastTickMs{ 0 };
std::atomic<bool> g_SawPlayer{ false };
float g_EmptySeconds = 0.0f;
constexpr float EmptyShutdownSeconds = 50.0f;
}

void MpReapExit(const char* Reason, UINT ExitCode) {
    MpLog(std::string("[Watchdog] ") + Reason
        + " -> TerminateProcess(" + std::to_string(ExitCode) + ") (skipping UE static teardown)");

    Sleep(50);
    TerminateProcess(GetCurrentProcess(), ExitCode);

    exit(static_cast<int>(ExitCode));
}

void TickWorldWatchdog(float DeltaTime, bool HasConnection) {
    if (!EnableWatchdog) return;
    g_LastTickMs.store(GetTickCount64(), std::memory_order_relaxed);

    int EmptyState = -1;
    if (SDK::AArchonGameMode* GameMode = CurrentGameMode(); GameMode && IsReadablePointer(GameMode, 0x2E0)) {
        if (g_IsHub.load(std::memory_order_relaxed) < 0) {
            const std::string Name = GameMode->Class->GetName();
            g_IsHub.store((Name.find("City") != std::string::npos
                || Name.find("TrainingGrounds") != std::string::npos) ? 1 : 0, std::memory_order_relaxed);
        }
        const uintptr_t Gm = reinterpret_cast<uintptr_t>(GameMode);
        const int32_t NumPlayers = *reinterpret_cast<int32_t*>(Gm + 0x02D0);
        const int32_t NumTravelling = *reinterpret_cast<int32_t*>(Gm + 0x02DC);
        if (NumPlayers > 0) g_SawPlayer.store(true, std::memory_order_relaxed);
        EmptyState = (NumPlayers <= 0 && NumTravelling <= 0) ? 1 : 0;
    }

    const bool IsEmpty = EmptyState == 1 || (EmptyState == -1 && !HasConnection);
    if (!IsEmpty) {
        g_EmptySeconds = 0.0f;
        return;
    }
    g_EmptySeconds += DeltaTime;
    if (g_EmptySeconds >= EmptyShutdownSeconds && g_IsHub.load(std::memory_order_relaxed) == 0) {
        MpReapExit(("hunt island empty for 50 s (gmState=" + std::to_string(EmptyState) + ")").c_str());
    }
}

void StartWorldWatchdogThread() {
    static std::atomic<bool> Started{ false };
    bool Expected = false;
    if (!Started.compare_exchange_strong(Expected, true)) return;
    std::thread([] {
        constexpr uint64_t SampleAfterMs = 20000;
        constexpr uint64_t ShutdownAfterMs = 180000;
        bool Sampled = false;
        MpLog("[Watchdog] hang watch started (samples a hunt island's game thread after 20 s without a tick, shuts it down after 180 s)");
        for (;;) {
            Sleep(2000);
            if (!EnableWatchdog || g_IsHub.load(std::memory_order_relaxed) != 0
                || !g_SawPlayer.load(std::memory_order_relaxed)) continue;
            const uint64_t LastTick = g_LastTickMs.load(std::memory_order_relaxed);
            if (LastTick == 0) continue;
            const uint64_t SinceTick = GetTickCount64() - LastTick;
            if (SinceTick < 10000) Sampled = false;
            if (SinceTick >= SampleAfterMs && !Sampled) {
                Sampled = true;
                MpLog("[HangSuspect] game thread not ticked for " + std::to_string(SinceTick / 1000)
                    + " s - sampling (shutting down at 180 s)");
                LogHungGameThread();
            }
            if (SinceTick >= ShutdownAfterMs) {
                MpLog("[Watchdog] game thread not ticked for " + std::to_string(SinceTick / 1000)
                    + " s (hung game thread or ghost connection)");
                LogHungGameThread();
                MpReapExit("tick stale");
            }
        }
    }).detach();
}
