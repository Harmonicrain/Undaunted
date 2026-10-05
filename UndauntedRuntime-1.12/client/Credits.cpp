/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#include "client/Credits.h"
#include "client/CreditsContent.h"
#include "client/CreditsInsert.h"
#include "core/Memory.h"
#include "core/Logging.h"
#include "SDK/bpw_Credits_classes.hpp"

namespace {
// Evidence: CL392819's bpw_Credits has a ScrollBox and an ArchonCreditsSection
// for Phoenix Labs. Its two columns are TextBlocks. Borrow their actual fonts
// and colours instead of relying on fonts or assets outside the installed game.
struct SectionState {
    UObject* Owner = nullptr;
    int32 SectionIndex = -1;
    unsigned Attempts = 0;
};
std::map<int32, SectionState> Sections;
thread_local bool Building = false;

template<class T> bool Live(T* Object) {
    return Object && IsReadablePointer(Object, sizeof(T))
        && IsRegisteredLiveObject(Object) && Object->IsA(T::StaticClass());
}

template<class T> T* NewWidget(UWidgetTree* Tree) {
    auto* Object = UGameplayStatics::SpawnObject(T::StaticClass(), Tree);
    return Live(Object) && Object->IsA(T::StaticClass()) ? static_cast<T*>(Object) : nullptr;
}

bool ValidChildren(UPanelWidget* Panel, int32 Limit = 128) {
    return Live(Panel) && Panel->Slots.Num() >= 0 && Panel->Slots.Num() <= Limit
        && (Panel->Slots.Num() == 0
            || IsReadablePointer(&Panel->Slots[0], sizeof(UPanelSlot*) * Panel->Slots.Num()));
}

UTextBlock* FindText(UWidget* Widget, unsigned Depth = 0) {
    if (!Live(Widget) || Depth > 6) return nullptr;
    if (Widget->IsA(UTextBlock::StaticClass())) return static_cast<UTextBlock*>(Widget);
    if (!Widget->IsA(UPanelWidget::StaticClass())) return nullptr;
    auto* Panel = static_cast<UPanelWidget*>(Widget);
    if (!ValidChildren(Panel, 16)) return nullptr;
    for (auto* Slot : Panel->Slots) {
        if (Live(Slot)) {
            if (auto* Text = FindText(Slot->Content, Depth + 1)) return Text;
        }
    }
    return nullptr;
}

UTextBlock* MakeText(UWidgetTree* Tree, const UTextBlock* Style,
                     const wchar_t* Text, ETextJustify Justify, bool Wrap = false,
                     int32 FontSize = 0) {
    auto* Block = NewWidget<UTextBlock>(Tree);
    if (!Block) return nullptr;
    auto Font = Style->Font;
    if (FontSize > 0) Font.Size = FontSize;
    Block->SetFont(Font);
    Block->SetColorAndOpacity(Style->ColorAndOpacity);
    Block->SetShadowOffset(Style->ShadowOffset);
    Block->SetShadowColorAndOpacity(Style->ShadowColorAndOpacity);
    Block->SetJustification(Justify);
    Block->SetAutoWrapText(Wrap);
    Block->SetText(UKismetTextLibrary::Conv_StringToText(FString(Text)));
    return Block;
}

bool AddLine(UVerticalBox* Box, UWidget* Child, float Top = 0, float Bottom = 0) {
    if (!Child) return false;
    auto* Slot = Box->AddChildToVerticalBox(Child);
    if (!Live(Slot)) return false;
    FMargin Padding{}; Padding.Top = Top; Padding.Bottom = Bottom;
    Slot->SetPadding(Padding);
    Slot->SetHorizontalAlignment(EHorizontalAlignment::HAlign_Fill);
    Slot->SetVerticalAlignment(EVerticalAlignment::VAlign_Top);
    return true;
}

UVerticalBox* BuildSection(Ubpw_Credits_C* Credits, UTextBlock* HeadingStyle,
                           UTextBlock* NameStyle, UTextBlock* RoleStyle) {
    auto* Tree = Credits->WidgetTree;
    auto* Box = NewWidget<UVerticalBox>(Tree);
    if (!Box) return nullptr;
    if (!AddLine(Box, MakeText(Tree, HeadingStyle, PrivateServerCredits::Heading,
                              ETextJustify::Center), 0, 12)
        || !AddLine(Box, MakeText(Tree, RoleStyle, PrivateServerCredits::Subheading,
                                 ETextJustify::Center), 0, 12)) return nullptr;
    for (const auto& Credit : PrivateServerCredits::Contributors) {
        auto* Row = NewWidget<UHorizontalBox>(Tree);
        auto* Name = MakeText(Tree, NameStyle, Credit.Name, ETextJustify::Right);
        auto* Role = MakeText(Tree, RoleStyle, Credit.Role, ETextJustify::Left);
        if (!Row || !Name || !Role) return nullptr;
        auto* NameSlot = Row->AddChildToHorizontalBox(Name);
        auto* RoleSlot = Row->AddChildToHorizontalBox(Role);
        if (!Live(NameSlot) || !Live(RoleSlot)) return nullptr;
        FSlateChildSize Fill{}; Fill.Value = 1; Fill.SizeRule = ESlateSizeRule::Fill;
        NameSlot->SetSize(Fill); RoleSlot->SetSize(Fill);
        NameSlot->SetHorizontalAlignment(EHorizontalAlignment::HAlign_Fill);
        RoleSlot->SetHorizontalAlignment(EHorizontalAlignment::HAlign_Fill);
        FMargin NamePadding{}, RolePadding{};
        NamePadding.Right = 12; RolePadding.Left = 12;
        NameSlot->SetPadding(NamePadding); RoleSlot->SetPadding(RolePadding);
        if (!AddLine(Box, Row)) return nullptr;
    }
    const int32 NoticeSize = std::clamp(RoleStyle->Font.Size * 2 / 3, 16, 24);
    if (!AddLine(Box, MakeText(Tree, RoleStyle, PrivateServerCredits::AiHeading,
                              ETextJustify::Center, true, NoticeSize), 20, 4)
        || !AddLine(Box, MakeText(Tree, RoleStyle, PrivateServerCredits::AiModels,
                                 ETextJustify::Center, true, NoticeSize))
        || !AddLine(Box, MakeText(Tree, RoleStyle, PrivateServerCredits::Attribution,
                              ETextJustify::Center, true, NoticeSize), 20, 8)
        || !AddLine(Box, MakeText(Tree, RoleStyle, PrivateServerCredits::ModificationNotice,
                                 ETextJustify::Center, true, NoticeSize))) return nullptr;
    return Box;
}

struct ScrollChild {
    UWidget* Content;
    FMargin Padding;
    EHorizontalAlignment Horizontal;
    EVerticalAlignment Vertical;
};

bool InsertSection(Ubpw_Credits_C* Credits, SectionState& State) {
    auto* Scroll = Credits->CreditsScrollBox;
    auto* Phoenix = Credits->credits_section_phoenix;
    if (!Live(Credits->WidgetTree) || !Live(Scroll) || !Live(Phoenix)
        || !Live(Phoenix->SectionTextBlock) || !ValidChildren(Scroll)
        || !ValidChildren(Phoenix->ColumnsBox, 16) || Phoenix->ColumnsBox->Slots.Num() != 2)
        return false;
    auto* NameSlot = Phoenix->ColumnsBox->Slots[0];
    auto* RoleSlot = Phoenix->ColumnsBox->Slots[1];
    if (!Live(NameSlot) || !Live(RoleSlot)) return false;
    auto* NameStyle = FindText(NameSlot->Content);
    auto* RoleStyle = FindText(RoleSlot->Content);
    if (!NameStyle || !RoleStyle || !Live(Phoenix->SectionTextBlock->Font.FontObject)) return false;

    std::vector<ScrollChild> Original;
    Original.reserve(Scroll->Slots.Num());
    for (auto* BaseSlot : Scroll->Slots) {
        if (!Live(BaseSlot) || !BaseSlot->IsA(UScrollBoxSlot::StaticClass())
            || !Live(BaseSlot->Content)) return false;
        auto* Slot = static_cast<UScrollBoxSlot*>(BaseSlot);
        Original.push_back({ Slot->Content, Slot->Padding, Slot->HorizontalAlignment, Slot->VerticalAlignment });
    }
    if (Original.empty()) return false;
    // The original roll starts with a full-screen spacer. Insert immediately
    // before Phoenix Labs, after that spacer, so our heading enters from below
    // rather than appearing at the top and leaving the entrance gap after it.
    UWidget* PhoenixRoot = Phoenix;
    for (unsigned Depth = 0; Depth < 8; ++Depth) {
        if (!Live(PhoenixRoot->Slot) || !Live(PhoenixRoot->Slot->Parent)) return false;
        if (PhoenixRoot->Slot->Parent == Scroll) break;
        PhoenixRoot = PhoenixRoot->Slot->Parent;
    }
    const auto Anchor = std::find_if(Original.begin(), Original.end(),
        [&](const ScrollChild& Child) { return Child.Content == PhoenixRoot; });
    if (Anchor == Original.end()) return false;
    auto* Section = BuildSection(Credits, Phoenix->SectionTextBlock, NameStyle, RoleStyle);
    if (!Section) return false; // Don't touch the original hierarchy until the section is complete.
    const float Offset = Scroll->GetScrollOffset();
    const ScrollChild First{ Section, FMargin{ 24, 0, 24, 48 },
        EHorizontalAlignment::HAlign_Fill, EVerticalAlignment::VAlign_Top };
    const auto Result = PrivateServerCredits::InsertBefore(Original, First, *Anchor,
        [&] { Scroll->ClearChildren(); },
        [&](const ScrollChild& Child) {
            auto* BaseSlot = Scroll->AddChild(Child.Content);
            if (!Live(BaseSlot) || !BaseSlot->IsA(UScrollBoxSlot::StaticClass())) return false;
            auto* Slot = static_cast<UScrollBoxSlot*>(BaseSlot);
            Slot->SetPadding(Child.Padding);
            Slot->SetHorizontalAlignment(Child.Horizontal);
            Slot->SetVerticalAlignment(Child.Vertical);
            return true;
        });
    Scroll->SetScrollOffset(Offset);
    if (Result != PrivateServerCredits::InsertResult::Inserted) {
        MpLog(Result == PrivateServerCredits::InsertResult::Restored
            ? "[Credits] Could not insert section; original credits restored."
            : "[Credits] Could not insert section; original credits could not be completely restored.");
        State.Attempts = 3; // A failed hierarchy transaction must never be retried every frame.
        return false;
    }
    State.SectionIndex = Section->Index;
    MpLog("[Credits] Inserted private server section before Phoenix Labs, after "
        + std::to_string(std::distance(Original.begin(), Anchor)) + " entrance entries; preserved "
        + std::to_string(Original.size()) + " original entries.");
    return true;
}
}

void CreditsAfterEvent(UObject* Object, const std::string& FunctionName) {
    if (Building || (FunctionName != "Function bpw_Credits.bpw_Credits_C.Construct"
        && FunctionName != "Function bpw_Credits.bpw_Credits_C.Tick")) return;
    if (!Live(Object) || Object->Class->GetName() != "bpw_Credits_C"
        || !IsReadablePointer(Object, sizeof(Ubpw_Credits_C))) return;
    auto* Credits = static_cast<Ubpw_Credits_C*>(Object);
    auto& State = Sections[Credits->Index];
    if (State.Owner != Object) State = { Object, -1, 0 };
    if (State.SectionIndex >= 0) {
        auto* Section = static_cast<UWidget*>(UObject::GObjects->GetByIndex(State.SectionIndex));
        if (Live(Section) && Live(Section->Slot) && Section->Slot->Parent == Credits->CreditsScrollBox) return;
        State.SectionIndex = -1; State.Attempts = 0;
    }
    if (State.Attempts >= 3) return;
    struct BuildGuard { BuildGuard() { Building = true; } ~BuildGuard() { Building = false; } } Guard;
    ++State.Attempts;
    if (!InsertSection(Credits, State) && State.Attempts >= 3)
        MpLog("[Credits] Section unavailable for this credits widget; no further insertion attempts.");
    // Do not keep identities belonging to discarded widgets indefinitely.
    if (Sections.size() > 32) {
        std::erase_if(Sections, [](const auto& Entry) { return !IsRegisteredLiveObject(Entry.second.Owner); });
    }
}
