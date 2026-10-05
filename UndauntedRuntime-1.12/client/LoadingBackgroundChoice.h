/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#pragma once
#include <cstddef>

namespace LoadingBackgroundChoice {
inline std::size_t DrawCount(std::size_t Count, std::size_t Previous) {
    return Count > 1 && Previous < Count ? Count - 1 : Count;
}
// A uniform draw over Count-1 candidates maps to every index except Previous.
// No retry loop or bias towards the original Malkarion background.
inline std::size_t Select(std::size_t Count, std::size_t Previous, std::size_t Draw) {
    if (Count < 2) return 0;
    const auto Candidate = Draw % DrawCount(Count, Previous);
    return Previous < Count && Candidate >= Previous ? Candidate + 1 : Candidate;
}
}
