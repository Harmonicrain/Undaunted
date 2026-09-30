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
#include "diagnostics/RuntimeDiagnostics.h"

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
static BOOL CALLBACK LoadWeeklyChallengeRows(PINIT_ONCE, PVOID, PVOID*);
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

static INIT_ONCE g_WeeklyChallengeRowsOnce = INIT_ONCE_STATIC_INIT;

static std::set<std::string> g_WeeklyChallengeRows;

static SRWLOCK g_WeeklyChallengeTablesLock = SRWLOCK_INIT;

static std::set<UDataTable*> g_PatchedWeeklyChallengeTables;

static BOOL CALLBACK LoadWeeklyChallengeRows(PINIT_ONCE, PVOID, PVOID*) {
    const std::string Body = HttpGetFromMetagame(L"/game_tuning/bounty_game_data_weekly");
    const std::string Key = "\"bounty_id\":\"";
    for (size_t At = Body.find(Key); At != std::string::npos; At = Body.find(Key, At)) {
        At += Key.size();
        const size_t End = Body.find('"', At);
        if (End == std::string::npos) break;
        const std::string Id = Body.substr(At, End - At);
        if (Id.rfind("Challenge_Season_", 0) == 0 && Id.size() < 128
            && Id.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_") == std::string::npos)
            g_WeeklyChallengeRows.insert(Id);
        At = End + 1;
    }
    MpLog("[WeeklyChallenges] backend selected rows=" + std::to_string(g_WeeklyChallengeRows.size()));
    return TRUE;
}

void PatchWeeklyChallengeTable(UBountyComponent_Weekly* Component) {
    if (!Component || !IsReadablePointer(Component, sizeof(UBountyComponent_Weekly))) return;
    InitOnceExecuteOnce(&g_WeeklyChallengeRowsOnce, LoadWeeklyChallengeRows, nullptr, nullptr);
    if (g_WeeklyChallengeRows.empty()) return;
    auto* Table = Component->BountyTable;
    if (!Table || !IsReadablePointer(Table, sizeof(UDataTable))) return;

    AcquireSRWLockExclusive(&g_WeeklyChallengeTablesLock);
    if (g_PatchedWeeklyChallengeTables.count(Table) != 0) {
        ReleaseSRWLockExclusive(&g_WeeklyChallengeTablesLock);
        return;
    }

    FChallengeWeeklyData Template{};
    bool HasTemplate = false;
    for (auto& Pair : Table->RowMap) {
        const std::string Id = Pair.Key().GetRawString();
        if (Id.rfind("Challenge_Season_", 0) != 0) continue;
        auto* Row = reinterpret_cast<FBountyTableData*>(Pair.Value());
        if (!Row || !IsReadablePointer(Row, sizeof(FBountyTableData))) continue;
        for (const auto& Weekly : Row->HuntPassSeasonsData) {
            const std::string Season = Weekly.TargetHuntPassSeason.RowName.GetRawString();
            if (Weekly.WeekId == 0 && Season.find("19") != std::string::npos) {
                Template = Weekly;
                HasTemplate = true;
                break;
            }
        }
        if (HasTemplate) break;
    }
    if (!HasTemplate) {
        ReleaseSRWLockExclusive(&g_WeeklyChallengeTablesLock);
        MpLog("[WeeklyChallenges] table patch skipped: Season 19 week-zero template missing");
        return;
    }

    // SDK TArray::Add does not grow arrays. Prepare every replacement before
    // changing the table, using the engine allocator and independently owned tags.
    std::map<FBountyTableData*, TArray<FChallengeWeeklyData>> Replacements;
    auto CopyTags = [](const TArray<FGameplayTag>& Source) {
        if (Source.Num() == 0) return TArray<FGameplayTag>{};
        auto* Data = static_cast<FGameplayTag*>(EngineRealloc(nullptr, Source.Num() * sizeof(FGameplayTag)));
        if (!Data) return TArray<FGameplayTag>{};
        memcpy(Data, Source.GetDataPtr(), Source.Num() * sizeof(FGameplayTag));
        return TArray<FGameplayTag>(Data, Source.Num(), Source.Num());
    };
    for (auto& Pair : Table->RowMap) {
        if (g_WeeklyChallengeRows.count(Pair.Key().GetRawString()) == 0) continue;
        auto* Row = reinterpret_cast<FBountyTableData*>(Pair.Value());
        if (!Row || !IsReadablePointer(Row, sizeof(FBountyTableData))) continue;
        auto* Data = static_cast<FChallengeWeeklyData*>(EngineRealloc(nullptr, sizeof(FChallengeWeeklyData)));
        if (!Data) continue;
        *Data = Template;
        Data->Tags.GameplayTags = CopyTags(Template.Tags.GameplayTags);
        Data->Tags.ParentTags = CopyTags(Template.Tags.ParentTags);
        if (Data->Tags.GameplayTags.Num() != Template.Tags.GameplayTags.Num()
            || Data->Tags.ParentTags.Num() != Template.Tags.ParentTags.Num()) {
            EngineRealloc(const_cast<FGameplayTag*>(Data->Tags.GameplayTags.GetDataPtr()), 0);
            EngineRealloc(const_cast<FGameplayTag*>(Data->Tags.ParentTags.GetDataPtr()), 0);
            EngineRealloc(Data, 0);
            continue;
        }
        Replacements.emplace(Row, TArray<FChallengeWeeklyData>(Data, 1, 1));
    }
    if (Replacements.size() != 10 || g_WeeklyChallengeRows.size() != 10) {
        for (auto& Pair : Replacements) {
            auto& Data = Pair.second[0];
            EngineRealloc(const_cast<FGameplayTag*>(Data.Tags.GameplayTags.GetDataPtr()), 0);
            EngineRealloc(const_cast<FGameplayTag*>(Data.Tags.ParentTags.GetDataPtr()), 0);
            EngineRealloc(const_cast<FChallengeWeeklyData*>(Pair.second.GetDataPtr()), 0);
        }
        ReleaseSRWLockExclusive(&g_WeeklyChallengeTablesLock);
        MpLog("[WeeklyChallenges] refusing incomplete replacement; original table retained");
        return;
    }
    int Selected = 0, Cleared = 0;
    for (auto& Pair : Table->RowMap) {
        const std::string Id = Pair.Key().GetRawString();
        if (Id.rfind("Challenge_Season_", 0) != 0) continue;
        auto* Row = reinterpret_cast<FBountyTableData*>(Pair.Value());
        if (!Row || !IsReadablePointer(Row, sizeof(FBountyTableData))) continue;
        for (auto& Old : Row->HuntPassSeasonsData) {
            EngineRealloc(const_cast<FGameplayTag*>(Old.Tags.GameplayTags.GetDataPtr()), 0);
            EngineRealloc(const_cast<FGameplayTag*>(Old.Tags.ParentTags.GetDataPtr()), 0);
        }
        EngineRealloc(const_cast<FChallengeWeeklyData*>(Row->HuntPassSeasonsData.GetDataPtr()), 0);
        const auto Replacement = Replacements.find(Row);
        if (Replacement != Replacements.end()) {
            Row->HuntPassSeasonsData = Replacement->second;
            ++Selected;
        } else {
            Row->HuntPassSeasonsData = {};
            ++Cleared;
        }
    }
    g_PatchedWeeklyChallengeTables.insert(Table);
    ReleaseSRWLockExclusive(&g_WeeklyChallengeTablesLock);
    MpLog("[WeeklyChallenges] patched table selected=" + std::to_string(Selected)
        + " cleared=" + std::to_string(Cleared));
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
    auto* Target = reinterpret_cast<unsigned char*>(Native112::At(Globals::BaseAddress, Native112::Rva_01889100));
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
