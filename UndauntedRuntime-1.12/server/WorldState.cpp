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
 * Hunt Pass selector. In October 2026 the game mode lookups were consolidated
 * here. Not an official release of Mystic Paradox or Undaunted.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "server/WorldState.h"
#include "core/Logging.h"
#include "core/Memory.h"

static SDK::UWorld* CurrentWorld() {
    SDK::UWorld* World = SDK::UWorld::GetWorld();
    return World && IsRegisteredLiveObject(World) ? World : nullptr;
}

SDK::AArchonGameMode* CurrentGameMode() {
    SDK::UWorld* World = CurrentWorld();
    SDK::AGameModeBase* Mode = World ? World->AuthorityGameMode : nullptr;
    if (!Mode || !IsRegisteredLiveObject(Mode) || !Mode->IsA(SDK::AArchonGameMode::StaticClass())) return nullptr;
    return static_cast<SDK::AArchonGameMode*>(Mode);
}

SDK::AArchonGameState* CurrentGameState() {
    SDK::UWorld* World = CurrentWorld();
    SDK::AGameStateBase* State = World ? World->GameState : nullptr;
    if (!State || !IsRegisteredLiveObject(State) || !State->IsA(SDK::AArchonGameState::StaticClass())) return nullptr;
    return static_cast<SDK::AArchonGameState*>(State);
}

void LogArchonLifecycle(const char* Tag) {
    SDK::UObject* GmObj = CurrentGameMode();
    SDK::UObject* GsObj = CurrentGameState();

    std::string Msg = std::string("[Lifecycle:") + Tag + "]";

    if (GmObj && IsReadablePointer(GmObj, 0x4A0)) {
        uintptr_t Gm = reinterpret_cast<uintptr_t>(GmObj);
        std::string MatchState = "?";
        if (IsReadablePointer(reinterpret_cast<void*>(Gm + 0x02C0), 8)) {
            MatchState = reinterpret_cast<SDK::FName*>(Gm + 0x02C0)->ToString();
        }
        void* GameSession = *reinterpret_cast<void**>(Gm + 0x0278);
        int32_t GsMax = -1;
        if (IsReadablePointer(GameSession, 0x228)) {
            GsMax = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(GameSession) + 0x0224);
        }
        Msg += " GM=" + MpPtr(GmObj) + " class=" + GmObj->Class->GetName()
            + " match=" + MatchState
            + " NumPlayers=" + std::to_string(*reinterpret_cast<int32_t*>(Gm + 0x02D0))
            + " NumSpectators=" + std::to_string(*reinterpret_cast<int32_t*>(Gm + 0x02CC))
            + " NumTravelling=" + std::to_string(*reinterpret_cast<int32_t*>(Gm + 0x02DC))
            + " ExpectedPlayerCount=" + std::to_string(*reinterpret_cast<int32_t*>(Gm + 0x0498))
            + " MaxPlayers=" + std::to_string(*reinterpret_cast<int32_t*>(Gm + 0x049C))
            + " GameSession=" + MpPtr(GameSession) + " GS.MaxPlayers=" + std::to_string(GsMax);
    } else {
        Msg += " GM=null";
    }

    if (GsObj && IsReadablePointer(GsObj, 0x278)) {
        uintptr_t Gs = reinterpret_cast<uintptr_t>(GsObj);
        std::string GsMatch = "?";
        if (IsReadablePointer(reinterpret_cast<void*>(Gs + 0x0270), 8)) {
            GsMatch = reinterpret_cast<SDK::FName*>(Gs + 0x0270)->ToString();
        }
        Msg += " | GState=" + MpPtr(GsObj) + " match=" + GsMatch;
    } else {
        Msg += " | GState=null";
    }

    MpLog(Msg);
}
