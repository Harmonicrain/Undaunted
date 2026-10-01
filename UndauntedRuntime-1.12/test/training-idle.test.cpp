/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#include "../server/TrainingIdlePolicy.h"
#include <cassert>

int main() {
    TrainingIdlePolicy Idle;
    constexpr uint64_t Grace = 300000;
    assert(!Idle.EmptyLongEnough(0, 1000, Grace));
    assert(!Idle.EmptyLongEnough(0, 300999, Grace));
    assert(Idle.EmptyLongEnough(0, 301000, Grace));
    assert(!Idle.EmptyLongEnough(1, 301001, Grace));
    assert(!Idle.EmptyLongEnough(0, 301002, Grace));
    assert(!Idle.EmptyLongEnough(-1, 601002, Grace));
    assert(!Idle.EmptyLongEnough(0, 601003, Grace));
    assert(!Idle.EmptyLongEnough(0, 901002, Grace));
    assert(Idle.EmptyLongEnough(0, 901003, Grace));
    return 0;
}
