/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#include "../client/CreditsInsert.h"
#include <cassert>

struct Slot {
    int Content;
    float Padding;
    int Alignment;
    bool operator==(const Slot&) const = default;
};

int main() {
    using namespace PrivateServerCredits;
    // Entrance spacer, studio, collaborators, founders and copyright entries.
    const std::vector<Slot> Original{{0, 1080, 0}, {1, 240, 1}, {2, 48, 0}, {3, 12, 2}, {4, 0, 1}};
    const Slot NewSection{5, 48, 0};
    auto Children = Original;
    auto Clear = [&] { Children.clear(); };
    auto Append = [&](const Slot& Child) { Children.push_back(Child); return true; };
    assert(InsertBefore(Original, NewSection, Original[1], Clear, Append) == InsertResult::Inserted);
    assert(Children[0] == Original[0] && Children[1] == NewSection && Children[2] == Original[1]);
    auto Rest = Children; Rest.erase(Rest.begin() + 1);
    assert(Rest == Original); // Entrance spacing stays ahead of our heading, not after it.
    const auto Once = Children;
    assert(InsertBefore(Once, NewSection, Original[1], Clear, Append) == InsertResult::AlreadyPresent);
    assert(Children == Once); // Opening/reconstructing must not duplicate our section.

    for (int FailureAt = 0; FailureAt <= static_cast<int>(Original.size()); ++FailureAt) {
        Children = Original;
        int Calls = 0;
        auto FailingAppend = [&](const Slot& Child) {
            if (Calls++ == FailureAt) return false;
            Children.push_back(Child); return true;
        };
        assert(InsertBefore(Original, NewSection, Original[1], Clear, FailingAppend) == InsertResult::Restored);
        assert(Children == Original); // All names, order and layout survive each failed step.
    }
    Children = Original;
    auto PermanentFailure = [&](const Slot& Child) {
        if (Child.Content == 2) return false;
        Children.push_back(Child); return true;
    };
    assert(InsertBefore(Original, NewSection, Original[1], Clear, PermanentFailure) == InsertResult::RestoreFailed);
    assert(Children.back().Content == 4); // Recovery continues through copyright after a failure.
    Children = Original;
    const Slot Missing{99, 0, 0};
    assert(InsertBefore(Original, NewSection, Missing, Clear, Append) == InsertResult::AnchorMissing);
    assert(Children == Original);
}
