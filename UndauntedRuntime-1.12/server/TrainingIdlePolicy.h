/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#pragma once
#include <cstdint>

// Unknown connection counts restart the grace period; they never count as empty.
class TrainingIdlePolicy {
    uint64_t EmptySince = 0;
public:
    bool EmptyLongEnough(int32_t Connections, uint64_t NowMs, uint64_t GraceMs) {
        if (Connections != 0) { EmptySince = 0; return false; }
        if (EmptySince == 0) EmptySince = NowMs;
        return NowMs - EmptySince >= GraceMs;
    }
};
