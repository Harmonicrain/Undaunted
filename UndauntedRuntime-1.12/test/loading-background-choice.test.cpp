/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#include "../client/LoadingBackgroundChoice.h"
#include <cassert>
#include <vector>

int main() {
    using namespace LoadingBackgroundChoice;
    assert(Select(0, 0, 99) == 0);
    assert(Select(1, 0, 99) == 0);
    for (std::size_t Count = 2; Count <= 10; ++Count) {
        for (std::size_t Previous = 0; Previous <= Count; ++Previous) {
            std::vector<unsigned> Visits(Count);
            const auto Bound = DrawCount(Count, Previous);
            assert(Bound == (Previous < Count ? Count - 1 : Count));
            for (std::size_t Draw = 0; Draw < Bound; ++Draw) {
                const auto Choice = Select(Count, Previous, Draw);
                assert(Choice < Count && Choice != Previous);
                ++Visits[Choice];
            }
            for (std::size_t Index = 0; Index < Count; ++Index)
                assert(Visits[Index] == (Index == Previous ? 0u : 1u));
        }
    }
}
