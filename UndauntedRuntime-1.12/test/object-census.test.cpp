/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#include "../diagnostics/ObjectCensus.h"
#include <cassert>

int main() {
    bool Slots[] = { true, true, true, true, true };
    auto Read = [&](int32_t Index) { return Slots[Index]; };
    assert(CountObjectSlots(5, Read).Registered == 5);
    // Destruction leaves holes without decreasing the array's length.
    Slots[1] = Slots[3] = false;
    auto AfterLeave = CountObjectSlots(5, Read);
    assert(AfterLeave.Slots == 5 && AfterLeave.Registered == 3);
    // A later visit may reuse a freed slot, without adding another slot.
    Slots[1] = true;
    auto AfterReturn = CountObjectSlots(5, Read);
    assert(AfterReturn.Slots == 5 && AfterReturn.Registered == 4);
    auto Empty = CountObjectSlots(0, Read);
    assert(Empty.Slots == 0 && Empty.Registered == 0);
    assert(CountObjectSlots(-1, Read).Slots == 0);
}
