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
 * Hunt Pass selector. In October 2026 this hook moved here from
 * server/Replication.cpp, as clients install it too. Not an official release
 * of Mystic Paradox or Undaunted.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "core/LoadingGate.h"
#include "core/Logging.h"
#include "core/Memory.h"

void* OrigHasFinishedLoading = nullptr;

// Answers finished for everything except the player's inventory, whose real
// answer keeps its loadout pending until the inventory has loaded. Clients and
// world servers both install it.
bool HasFinishedLoadingHook(UObject* a1) {
    if (reinterpret_cast<bool(*)(UObject*)>(OrigHasFinishedLoading)(a1)) return true;
    UObject* cls = a1 ? *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(a1) + 0x10) : nullptr;
    std::string cn = (cls && IsReadablePointer(cls, 0x20)) ? cls->GetName() : std::string();
    if (cn == "bp_archon_inventory_C" || cn.find("ArchonInventory") != std::string::npos) {
        static std::atomic<int> s_invReal{ 0 };
        if (s_invReal.fetch_add(1, std::memory_order_relaxed) < 10)
            MpLog(std::string("[ScopedBypass] inventory NOT forced (real result -> loadout stays pending) obj=") + a1->GetFullName());
        return false;
    }
    return true;
}
