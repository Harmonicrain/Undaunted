/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
#pragma once
#include <cstdint>

// Native has one pending slot-activation marker. Preserve another slot's
// activation and bound recovery retries while its asynchronous pool is saved.
class SlayerLinkRecoveryPolicy {
    uintptr_t Owner = 0;
    uint64_t LastAttempt[3]{};
    int64_t LastEnd[3]{};
public:
    static bool PoolArrived(int32_t ExistingCount, int32_t IncomingCount, int32_t Marker) {
        return Marker == -1 && ExistingCount == 0 && IncomingCount > 0;
    }
    bool Request(uintptr_t CurrentOwner, int32_t Slot, int64_t End,
        int32_t PoolCount, int32_t Marker, uint64_t NowMs) {
        if (!CurrentOwner || Slot < 1 || Slot > 3 || End <= 0 || PoolCount != 0) return false;
        if (Marker >= 1 && Marker <= 3 && Marker != Slot) return false;
        if (Owner != CurrentOwner) {
            Owner = CurrentOwner;
            for (int Index = 0; Index < 3; ++Index) { LastAttempt[Index] = 0; LastEnd[Index] = 0; }
        }
        const int Index = Slot - 1;
        if (LastEnd[Index] == End && LastAttempt[Index] && NowMs - LastAttempt[Index] < 30000) return false;
        LastEnd[Index] = End;
        LastAttempt[Index] = NowMs;
        return true;
    }
};

// A click made during pool recovery waits for authoritative data, then runs
// once. Closing/changing the screen cancels it in the runtime adapter.
enum class SlayerLinkUnlockPoll { Waiting, Resume, Cancel };

class SlayerLinkUnlockPolicy {
    int32_t Slot = 0;
    int64_t End = 0;
    uint64_t StartedAt = 0;
public:
    bool Pending() const { return Slot != 0; }
    void Cancel() { Slot = 0; }
    static bool NeedsPool(int32_t Status, int32_t PoolCount) {
        return (Status == 7 || Status == 8) && PoolCount == 0;
    }
    bool Begin(int32_t NewSlot, int64_t NewEnd, uint64_t NowMs) {
        if (Pending() || NewSlot < 1 || NewSlot > 3 || NewEnd <= 0) return false;
        Slot = NewSlot; End = NewEnd; StartedAt = NowMs;
        return true;
    }
    SlayerLinkUnlockPoll Poll(int32_t CurrentSlot, int64_t CurrentEnd,
        int32_t PoolCount, uint64_t NowMs) {
        if (!Pending() || Slot != CurrentSlot || End != CurrentEnd
            || PoolCount < 0 || NowMs - StartedAt >= 60000) {
            Cancel();
            return SlayerLinkUnlockPoll::Cancel;
        }
        if (PoolCount > 0) {
            Cancel(); // Consume before invoking native: reentrant calls cannot replay it.
            return SlayerLinkUnlockPoll::Resume;
        }
        return SlayerLinkUnlockPoll::Waiting;
    }
};
