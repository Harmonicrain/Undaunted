/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#pragma once
#include <cstdint>

// The object's array length includes empty slots left after destruction.
struct ObjectSlotCounts { int32_t Slots = 0; int32_t Registered = 0; };

template<typename ReadSlot>
ObjectSlotCounts CountObjectSlots(int32_t Slots, ReadSlot Read) {
    ObjectSlotCounts Counts{ Slots > 0 ? Slots : 0, 0 };
    for (int32_t Index = 0; Index < Counts.Slots; ++Index) {
        if (Read(Index)) ++Counts.Registered;
    }
    return Counts;
}
