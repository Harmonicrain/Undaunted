/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#include "../client/TitleBackgroundTiming.h"
#include <cassert>
#include <limits>

int main() {
    using namespace TitleBackgroundTiming;
    for (std::size_t Count : {0u, 1u}) {
        const auto Frame = Sample(99, Count);
        assert(Frame.Current == 0 && Frame.CurrentOpacity == 1 && Frame.NextOpacity == 0);
    }
    assert(Sample(std::numeric_limits<double>::quiet_NaN(), 6).Current == 0);
    assert(Sample(std::numeric_limits<double>::infinity(), 6).Current == 0);
    assert(Sample(-1, 6).Current == 0);
    const auto Held = Sample(9, 6);
    assert(Held.Current == 0 && Held.Next == 1 && Held.NextOpacity == 0);
    const auto Half = Sample(11, 6);
    assert(Half.CurrentOpacity == 1 && Half.NextOpacity == 0.5f);
    const auto End = Sample(12, 6);
    assert(End.Current == 1 && End.Next == 2 && End.CurrentScale == End.NextScale);
    const auto Wrap = Sample(71, 6);
    assert(Wrap.Current == 5 && Wrap.Next == 0 && Wrap.CurrentOpacity == 0.5f && Wrap.NextOpacity == 1);
    assert(Sample(72, 6).Current == 0);
    for (unsigned Step = 0; Step < 7200; ++Step) {
        const auto Frame = Sample(Step / 100.0, 6);
        assert(Frame.Current < 6 && Frame.Next < 6 && Frame.Current != Frame.Next);
        assert(Frame.CurrentOpacity >= 0 && Frame.CurrentOpacity <= 1);
        assert(Frame.NextOpacity >= 0 && Frame.NextOpacity <= 1);
        assert(Frame.CurrentScale >= 1.01f && Frame.CurrentScale < 1.041f);
        // Compositing over black never darkens the artwork, even when wrapping.
        const auto Coverage = Frame.CurrentOpacity + Frame.NextOpacity * (1 - Frame.CurrentOpacity);
        assert(Coverage == 1);
    }
}
