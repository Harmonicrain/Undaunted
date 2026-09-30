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

#pragma once
#include "core/Runtime.h"

namespace Globals {
    extern bool AmServer;
    extern uintptr_t BaseAddress;
    extern bool Listening;
    extern bool DoListen;
    extern const wchar_t* ServerAPIKey;
    extern const wchar_t* MapPath;
    extern const wchar_t* BehemothPath;
    extern const wchar_t* MatchmakerHuntId;
    extern const wchar_t* ExpectedPlayerString;
    extern int Port;
    extern const wchar_t* MyIpAndPort;
    extern std::wstring MetagameAddress;
    extern bool EnableLogging;
    extern std::string Move10Status;
    extern std::wstring ServerAPIKeyStorage;
    extern std::wstring MapPathStorage;
    extern std::wstring BehemothPathStorage;
    extern std::wstring MatchmakerHuntIdStorage;
    extern std::wstring ExpectedPlayerStringStorage;
    extern std::wstring MyIpAndPortStorage;
}
