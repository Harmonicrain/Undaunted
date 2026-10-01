/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Further modified in September 2026 for the Undaunted fork (Harmonicrain/Undaunted):
 * the backend address comes from the command line and requests go to the
 * Undaunted metagame over plain HTTP/WebSocket; the PlayerController
 * pre-channel guard reads ReplicateSingleActor's arguments in the executable's
 * order; the client skips the legendary-ability HUD's weapon update until a
 * weapon is equipped; the seasonal event feature flags the metagame lists are
 * forced on; world servers answer event schedule checks from the metagame's
 * seasonal event schedule; validated archive passes can be shown by the native
 * Hunt Pass selector. Not an official release of
 * Mystic Paradox or Undaunted.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "core/RuntimeHooks.h"
#include "client/Challenges.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "core/Transport.h"

static void PutDailyChallengesFirst(UChallengesLogPanel* Panel);
static void HideWeeklyDailyActivityBlock(UHUDChallengeObjectiveTracker* Tracker);

struct ChallengeSectionSlotStyle {
    enum class Kind { None, VerticalBox, ScrollBox } SlotKind = Kind::None;
    FSlateChildSize Size{};
    FMargin Padding{};
    EHorizontalAlignment Horizontal = EHorizontalAlignment::HAlign_Fill;
    EVerticalAlignment Vertical = EVerticalAlignment::VAlign_Fill;
};

using ChallengeSeasonWeeksFn = int32(__fastcall*)(UBountyComponent_Weekly*);

static UWidget* DirectChildBelow(UWidget* Descendant, UPanelWidget* Ancestor);
static UPanelWidget* LowestCommonPanel(UWidget* Left, UWidget* Right);
static int32 __fastcall ChallengeSeasonWeeksHook(UBountyComponent_Weekly* This);

static UWidget* DirectChildBelow(UWidget* Descendant, UPanelWidget* Ancestor) {
    UWidget* Current = Descendant;
    for (int Depth = 0; Current && Depth < 32; ++Depth) {
        auto* Parent = Current->GetParent();
        if (Parent == Ancestor) return Current;
        Current = Parent;
    }
    return nullptr;
}

static UPanelWidget* LowestCommonPanel(UWidget* Left, UWidget* Right) {
    std::vector<UPanelWidget*> RightParents;
    for (auto* Parent = Right ? Right->GetParent() : nullptr; Parent; Parent = Parent->GetParent())
        RightParents.push_back(Parent);
    for (auto* Parent = Left ? Left->GetParent() : nullptr; Parent; Parent = Parent->GetParent()) {
        if (std::find(RightParents.begin(), RightParents.end(), Parent) != RightParents.end()) return Parent;
    }
    return nullptr;
}

static void PutDailyChallengesFirst(UChallengesLogPanel* Panel) {
    if (!Panel || !IsReadablePointer(Panel, sizeof(UChallengesLogPanel))
        || !Panel->DailyBountyList || !Panel->WeeklyBountyList) return;
    auto* Common = LowestCommonPanel(Panel->DailyBountyList, Panel->WeeklyBountyList);
    if (!Common || !IsReadablePointer(Common, sizeof(UPanelWidget))) return;
    auto* DailySection = DirectChildBelow(Panel->DailyBountyList, Common);
    auto* WeeklySection = DirectChildBelow(Panel->WeeklyBountyList, Common);
    if (!DailySection || !WeeklySection || DailySection == WeeklySection) return;
    const int32 DailyIndex = Common->GetChildIndex(DailySection);
    const int32 WeeklyIndex = Common->GetChildIndex(WeeklySection);
    if (DailyIndex < 0 || WeeklyIndex < 0 || DailyIndex < WeeklyIndex) return;
    MpLog("[Challenges] reorder common=" + SafeObjectNameForDiagnostic(Common)
        + " daily=" + SafeObjectNameForDiagnostic(DailySection) + "@" + std::to_string(DailyIndex)
        + " weekly=" + SafeObjectNameForDiagnostic(WeeklySection) + "@" + std::to_string(WeeklyIndex));

    ChallengeSectionSlotStyle Style;
    auto* OldSlot = WeeklySection->Slot;
    if (OldSlot && IsReadablePointer(OldSlot, sizeof(UPanelSlot))) {
        if (OldSlot->IsA(UVerticalBoxSlot::StaticClass())) {
            auto* Slot = static_cast<UVerticalBoxSlot*>(OldSlot);
            Style.SlotKind = ChallengeSectionSlotStyle::Kind::VerticalBox;
            Style.Size = Slot->Size;
            Style.Padding = Slot->Padding;
            Style.Horizontal = Slot->HorizontalAlignment;
            Style.Vertical = Slot->VerticalAlignment;
        } else if (OldSlot->IsA(UScrollBoxSlot::StaticClass())) {
            auto* Slot = static_cast<UScrollBoxSlot*>(OldSlot);
            Style.SlotKind = ChallengeSectionSlotStyle::Kind::ScrollBox;
            Style.Padding = Slot->Padding;
            Style.Horizontal = Slot->HorizontalAlignment;
            Style.Vertical = Slot->VerticalAlignment;
        }
    }
    if (!Common->RemoveChild(WeeklySection)) return;
    auto* NewSlot = Common->AddChild(WeeklySection);
    if (!NewSlot) return;
    if (Style.SlotKind == ChallengeSectionSlotStyle::Kind::VerticalBox
        && NewSlot->IsA(UVerticalBoxSlot::StaticClass())) {
        auto* Slot = static_cast<UVerticalBoxSlot*>(NewSlot);
        Slot->SetSize(Style.Size);
        Slot->SetPadding(Style.Padding);
        Slot->SetHorizontalAlignment(Style.Horizontal);
        Slot->SetVerticalAlignment(Style.Vertical);
    } else if (Style.SlotKind == ChallengeSectionSlotStyle::Kind::ScrollBox
        && NewSlot->IsA(UScrollBoxSlot::StaticClass())) {
        auto* Slot = static_cast<UScrollBoxSlot*>(NewSlot);
        Slot->SetPadding(Style.Padding);
        Slot->SetHorizontalAlignment(Style.Horizontal);
        Slot->SetVerticalAlignment(Style.Vertical);
    }
    Common->InvalidateLayoutAndVolatility();
    Panel->ForceLayoutPrepass();
    for (UWidget* Parent = Common->GetParent(); Parent; Parent = Parent->GetParent()) {
        if (!Parent->IsA(UScrollBox::StaticClass())) continue;
        auto* Scroll = static_cast<UScrollBox*>(Parent);
        Scroll->ScrollWhenFocusChanges = EScrollWhenFocusChanges::NoScroll;
        Scroll->ScrollToStart();
        break;
    }
    MpLog("[Challenges] moved Daily section before Weekly");
}

static void HideWeeklyDailyActivityBlock(UHUDChallengeObjectiveTracker* Tracker) {
    if (!Tracker || !IsReadablePointer(Tracker, sizeof(UHUDChallengeObjectiveTracker))) return;
    for (UWidget* Widget : { static_cast<UWidget*>(Tracker->WeeklyChallengesObjetiveBox),
        static_cast<UWidget*>(Tracker->WeeklyRemainingTimeText),
        static_cast<UWidget*>(Tracker->weekly_challenge_header) }) {
        if (Widget && IsReadablePointer(Widget, sizeof(UWidget))) {
            if (Widget->GetParent()) {
                Widget->RemoveFromParent();
                MpLog("[Challenges] removed weekly Daily Activities widget " + Widget->GetName());
            }
            if (Widget->Visibility != ESlateVisibility::Collapsed)
                Widget->SetVisibility(ESlateVisibility::Collapsed);
        }
    }
}

static ChallengeSeasonWeeksFn OrigChallengeSeasonWeeks = nullptr;

static int32 __fastcall ChallengeSeasonWeeksHook(UBountyComponent_Weekly* This) {
    const int32 Weeks = OrigChallengeSeasonWeeks(This);
    uint32 Limit = 20; // CL392819 constructor default; also our defensive ceiling.
    if (This && IsReadablePointer(This, sizeof(UBountyComponent_Weekly))
        && This->MAX_SEASON_WEEKS > 0 && This->MAX_SEASON_WEEKS < Limit)
        Limit = This->MAX_SEASON_WEEKS;
    const int32 Bounded = Weeks < 0 ? 0 : (Weeks > static_cast<int32>(Limit)
        ? static_cast<int32>(Limit) : Weeks);
    static std::atomic<int> Reports{ 0 };
    if (Bounded != Weeks && Reports.fetch_add(1, std::memory_order_relaxed) < 8)
        MpLog("[Journal] bounded season weeks " + std::to_string(Weeks)
            + " -> " + std::to_string(Bounded));
    return Bounded;
}

void InstallJournalWeekLimitHook() {
    auto* Target = reinterpret_cast<unsigned char*>(Native112::At(Globals::BaseAddress, Native112::ChallengeSeasonWeeks));
    // Refuse a different executable rather than patching an unverified RVA.
    const unsigned char Expected[] = { 0x40, 0x53, 0x57, 0x48, 0x81, 0xEC, 0xB8, 0x01, 0x00, 0x00 };
    if (memcmp(Target, Expected, sizeof(Expected)) != 0) {
        MpLog("[InitClientHooks] JournalWeekLimit skipped: executable signature mismatch");
        return;
    }
    const MH_STATUS Create = RUNTIME_CREATE_HOOK(Target, ChallengeSeasonWeeksHook,
        reinterpret_cast<LPVOID*>(&OrigChallengeSeasonWeeks));
    const MH_STATUS Enable = Create == MH_OK ? RuntimeHooks::Enable(Target) : Create;
    MpLog(std::string("[InitClientHooks] JournalWeekLimit create=") + MH_StatusToString(Create)
        + " enable=" + MH_StatusToString(Enable));
}

void ChallengesAfterEvent(UObject* Object, const std::string& FunctionName) {
    if (Object && Object->IsA(UHUDChallengeObjectiveTracker::StaticClass()))
        HideWeeklyDailyActivityBlock(static_cast<UHUDChallengeObjectiveTracker*>(Object));
    if (Object && Object->IsA(UChallengesLogPanel::StaticClass())
        && (FunctionName.ends_with(".Construct") || FunctionName.ends_with(".OnUpdateViewModel")))
        PutDailyChallengesFirst(static_cast<UChallengesLogPanel*>(Object));
}
