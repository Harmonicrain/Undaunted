/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#pragma once
#include <vector>

namespace PrivateServerCredits {
enum class InsertResult { Inserted, AlreadyPresent, AnchorMissing, Restored, RestoreFailed };

// UMG exposes append rather than insertion. Preserve every original child and
// its layout; if any append fails, restore the original list before returning.
// The callbacks let the same transaction be exercised without a running game.
template<class Slot, class Clear, class Append>
InsertResult InsertBefore(const std::vector<Slot>& Original, const Slot& Section, const Slot& Before,
                     Clear ClearChildren, Append AppendChild) {
    bool FoundAnchor = false;
    for (const auto& Child : Original)
        if (Child.Content == Section.Content) return InsertResult::AlreadyPresent;
        else if (Child.Content == Before.Content) FoundAnchor = true;
    if (!FoundAnchor) return InsertResult::AnchorMissing;
    ClearChildren();
    bool Complete = true;
    for (const auto& Child : Original) {
        if (Child.Content == Before.Content && !AppendChild(Section)) { Complete = false; break; }
        if (!AppendChild(Child)) { Complete = false; break; }
    }
    if (Complete) return InsertResult::Inserted;
    ClearChildren();
    bool Restored = true;
    for (const auto& Child : Original)
        if (!AppendChild(Child)) Restored = false;
    return Restored ? InsertResult::Restored : InsertResult::RestoreFailed;
}
}
