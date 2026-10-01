/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#include "../server/TickFilterPolicy.h"
#include <cassert>

int main() {
    // Server work runs where the island/city test passes.
    assert(ServerTickFilterAnswer(3, true) == 1);   // ServerOnly: TickStamina, TickBleedout
    assert(ServerTickFilterAnswer(4, true) == 1);   // LocalOrServer: edge recovery timer
    assert(ServerTickFilterAnswer(5, true) == 1);   // All
    assert(ServerTickFilterAnswer(3, false) == 0);  // ServerOnly but island-only in town
    assert(ServerTickFilterAnswer(5, false) == 0);
    // Work for the owning client or other clients' copies does not run on a server.
    assert(ServerTickFilterAnswer(0, true) == 0);   // LocalOnly: audio, camera
    assert(ServerTickFilterAnswer(1, true) == 0);   // RemoteOnly: simulated-proxy branch
    assert(ServerTickFilterAnswer(2, true) == 0);   // LocalOrRemote: client pose calculations
    // Unknown values keep the game's own answer.
    assert(ServerTickFilterAnswer(6, true) == -1);
    assert(ServerTickFilterAnswer(255, false) == -1);
    return 0;
}
