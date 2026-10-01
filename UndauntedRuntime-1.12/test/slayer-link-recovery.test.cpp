/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
#include "../client/SlayerLinkRecoveryPolicy.h"
#include <cassert>

int main() {
    SlayerLinkRecoveryPolicy Recovery;
    assert(SlayerLinkRecoveryPolicy::PoolArrived(0, 12, -1));
    assert(!SlayerLinkRecoveryPolicy::PoolArrived(12, 12, -1));
    assert(!SlayerLinkRecoveryPolicy::PoolArrived(0, 0, -1));
    assert(!SlayerLinkRecoveryPolicy::PoolArrived(12, 0, -1));
    assert(!SlayerLinkRecoveryPolicy::PoolArrived(0, 12, 2)); // Preserve pending activation.
    assert(!SlayerLinkRecoveryPolicy::PoolArrived(-1, 12, -1));
    assert(Recovery.Request(1, 1, 100, 0, 0, 1000)); // Expired links still need their pool.
    assert(!Recovery.Request(1, 1, 100, 0, 0, 30999));
    assert(Recovery.Request(1, 1, 100, 0, 0, 31000));
    assert(!Recovery.Request(1, 2, 200, 0, 1, 31000)); // Preserve another native activation.
    assert(Recovery.Request(1, 2, 200, 0, -1, 31000));
    assert(!Recovery.Request(1, 2, 200, 0, 0, 31001));
    assert(!Recovery.Request(1, 3, 300, 12, 0, 31001)); // Never reroll stored prizes.
    assert(Recovery.Request(1, 1, 101, 0, 0, 31001)); // A new link bypasses old cooldown.
    assert(Recovery.Request(2, 1, 101, 0, 0, 31002)); // A new local owner resets state.
    assert(!Recovery.Request(0, 1, 101, 0, 0, 31003));
    assert(!Recovery.Request(2, 0, 101, 0, 0, 31003));
    assert(!Recovery.Request(2, 4, 101, 0, 0, 31003));
    assert(!Recovery.Request(2, 1, 0, 0, 0, 31003));
    assert(!Recovery.Request(2, 1, 101, -1, 0, 31003));

    assert(SlayerLinkUnlockPolicy::NeedsPool(7, 0));
    assert(SlayerLinkUnlockPolicy::NeedsPool(8, 0)); // Missing pools mimic zero earned rewards.
    assert(!SlayerLinkUnlockPolicy::NeedsPool(4, 0)); // Active links are untouched.
    assert(!SlayerLinkUnlockPolicy::NeedsPool(7, 12));
    SlayerLinkUnlockPolicy Unlock;
    assert(!Unlock.Begin(0, 100, 0));
    assert(!Unlock.Begin(1, 0, 0));
    assert(Unlock.Begin(1, 100, 0));
    assert(!Unlock.Begin(1, 100, 1000)); // Repeated clicks do not extend the timeout.
    assert(Unlock.Poll(1, 100, 0, 59999) == SlayerLinkUnlockPoll::Waiting);
    assert(Unlock.Poll(1, 100, 12, 59999) == SlayerLinkUnlockPoll::Resume);
    assert(!Unlock.Pending());
    assert(Unlock.Poll(1, 100, 12, 59999) == SlayerLinkUnlockPoll::Cancel); // Exactly one resume.
    assert(Unlock.Begin(1, 100, 100));
    assert(Unlock.Poll(1, 100, 12, 60100) == SlayerLinkUnlockPoll::Cancel);
    assert(Unlock.Begin(1, 100, 100));
    assert(Unlock.Poll(2, 100, 12, 101) == SlayerLinkUnlockPoll::Cancel);
    assert(Unlock.Begin(1, 100, 100));
    assert(Unlock.Poll(1, 101, 12, 101) == SlayerLinkUnlockPoll::Cancel); // Replacement link.
    assert(Unlock.Begin(1, 100, 100));
    assert(Unlock.Poll(1, 100, -1, 101) == SlayerLinkUnlockPoll::Cancel);
    assert(Unlock.Begin(1, 100, 100));
    Unlock.Cancel();
    assert(!Unlock.Pending());
    return 0;
}
