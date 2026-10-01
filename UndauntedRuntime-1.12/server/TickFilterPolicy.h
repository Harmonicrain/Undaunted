/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#pragma once
#include <cstdint>

// ERemoteExecFilter: who a Blueprint tick is for.
enum class TickWhom : uint8_t { LocalOnly = 0, RemoteOnly = 1, LocalOrRemote = 2, ServerOnly = 3, LocalOrServer = 4, All = 5 };

// What a dedicated server answers for an actor it has authority over, given
// whether the island/city test passes: server work runs, work meant for the
// owning client or for other clients' copies of the actor doesn't. -1 for an
// unknown value (keep the game's own answer).
inline int ServerTickFilterAnswer(uint8_t Whom, bool WherePasses) {
    switch (static_cast<TickWhom>(Whom)) {
    case TickWhom::ServerOnly:
    case TickWhom::LocalOrServer:
    case TickWhom::All:
        return WherePasses ? 1 : 0;
    case TickWhom::LocalOnly:
    case TickWhom::RemoteOnly:
    case TickWhom::LocalOrRemote:
        return 0;
    default:
        return -1;
    }
}
