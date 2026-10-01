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
 * Hunt Pass selector. Not an official release of
 * Mystic Paradox or Undaunted.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "core/RuntimeState.h"
#include "native/Addresses112.h"

namespace Globals {
    bool AmServer = false;
    uintptr_t BaseAddress = 0x0;
    bool Listening = false;
    bool DoListen = false;
    const wchar_t* ServerAPIKey = nullptr;
    const wchar_t* MapPath = nullptr;
    const wchar_t* BehemothPath = nullptr;
    const wchar_t* MatchmakerHuntId = nullptr;
    const wchar_t* ExpectedPlayerString = nullptr;
    int Port = 0;
    const wchar_t* MyIpAndPort = nullptr;
    // host:port of the Undaunted metagame. Gameservers get it as the
    // DeployServer's ninth argument, clients as -UndauntedMetagame=host:port.
    std::wstring MetagameAddress;

    bool EnableLogging = true;

    std::wstring ServerAPIKeyStorage;
    std::wstring MapPathStorage;
    std::wstring BehemothPathStorage;
    std::wstring MatchmakerHuntIdStorage;
    std::wstring ExpectedPlayerStringStorage;
    std::wstring MyIpAndPortStorage;
}

volatile DWORD GameTickThreadId = 0;
