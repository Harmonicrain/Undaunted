/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

#include "server/AfkTimeout.h"
#include "core/RuntimeState.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "core/Settings.h"

// The AFK kick happens on the client: its local player controller counts idle
// time and, past the timeout, returns the player to the main menu ("You have
// been away from the keyboard for too long"). The timeout is the world's
// AArchonGameState::AFKTimeout (AFKTimeoutFriendly when the game state's byte at
// +0x410 is set), replicated from the server, which copies it from its game
// mode; 0 or less turns the kick off. The game modes default to 600 s. Read
// from AArchonPlayerController's AFK check (0x01B6EC40) on 2026-10-01.
// The values are set before players join and checked again once a second, so
// a game mode or game state created later gets them too.
//   -UndauntedAfkTimeoutSeconds=<n>  both timeouts, in seconds (0 = never)

namespace {
float ConfiguredSeconds(bool& Present) {
    static bool Found = false;
    static const float Seconds = [] {
        const int Value = Settings::Int(L"AfkTimeoutSeconds", -1, 0, 7 * 24 * 3600, -1);
        if (Value < 0) return 0.0f;
        Found = true;
        return static_cast<float>(Value);
    }();
    Present = Found;
    return Seconds;
}

bool SetTimeouts(float* Timeout, float* Friendly, float Seconds) {
    if (*Timeout == Seconds && *Friendly == Seconds) return false;
    *Timeout = Seconds;
    *Friendly = Seconds;
    return true;
}
}

void TickServerAfkTimeout() {
    if (!Globals::AmServer) return;
    bool Present = false;
    const float Seconds = ConfiguredSeconds(Present);
    if (!Present) return;
    static uint64_t NextCheckMs = 0;
    const uint64_t NowMs = GetTickCount64();
    if (NowMs < NextCheckMs) return;
    NextCheckMs = NowMs + 1000;

    SDK::UWorld* World = SDK::UWorld::GetWorld();
    if (!World || !IsReadablePointer(World, sizeof(SDK::UWorld))) return;
    SDK::AGameModeBase* Mode = World->AuthorityGameMode;
    if (Mode && IsRegisteredLiveObject(Mode) && Mode->IsA(SDK::AArchonGameMode::StaticClass())) {
        auto* ArchonMode = static_cast<SDK::AArchonGameMode*>(Mode);
        if (SetTimeouts(&ArchonMode->AFKTimeout, &ArchonMode->AFKTimeoutFriendly, Seconds)) {
            MpLog("[AfkTimeout] game mode AFK timeout set to " + std::to_string(static_cast<int>(Seconds)) + " s");
        }
    }
    SDK::AGameStateBase* State = World->GameState;
    if (State && IsRegisteredLiveObject(State) && State->IsA(SDK::AArchonGameState::StaticClass())) {
        auto* ArchonState = static_cast<SDK::AArchonGameState*>(State);
        if (SetTimeouts(&ArchonState->AFKTimeout, &ArchonState->AFKTimeoutFriendly, Seconds)) {
            MpLog("[AfkTimeout] game state AFK timeout set to " + std::to_string(static_cast<int>(Seconds)) + " s");
        }
    }
}
