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
#include "client/Middleman.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "native/Layouts112.h"

namespace MM = Native112::MiddlemanLayout;
#include "core/Logging.h"
#include "core/Memory.h"

static void ShowMiddlemanDustOnly(UWidget* Widget, int Depth = 0);
static bool IsMiddlemanPurchasePopup(UObject* Object);
static void ShowMiddlemanDustOnlyPopup(UObject* Object);
static void ShowMiddlemanDustOnlyTooltip(UWidget* Widget, int Depth = 0);
static bool IsDustOnlyCellTooltip(UObject* Object);

using ClientGetCurrentSpeedUpTokensFn = int32(__fastcall*)(AArchonInventory*);

struct MiddlemanPriceReference { void* Offer; void* ReferenceController; };

using CellOfferConvertFn = SDK::FCellOfferViewModel*(__fastcall*)(
    SDK::FCellOfferViewModel*, const SDK::FOnlineStorePhoenixOffer*);

static int32 __fastcall ClientGetCurrentSpeedUpTokensHook(AArchonInventory* Inventory);
static SDK::FCellOfferViewModel* __fastcall CellOfferConvertHook(
    SDK::FCellOfferViewModel* Out, const SDK::FOnlineStorePhoenixOffer* In);
static void CentreMiddlemanPriceRow(UPanelWidget* Panel);

static ClientGetCurrentSpeedUpTokensFn OrigClientGetCurrentSpeedUpTokens = nullptr;

static int32 __fastcall ClientGetCurrentSpeedUpTokensHook(AArchonInventory* Inventory) {
    using QuantityFn = int32(__fastcall*)(AArchonInventory*, const FString*, bool);
    static const FString DustId(L"CURRENCY_CELLDUST");
    const auto Quantity = reinterpret_cast<QuantityFn>(Native112::At(Globals::BaseAddress, Native112::InventoryGetItemQuantity));
    const int32 Dust = Quantity(Inventory, &DustId, true);
    MpLog("[Middleman] speed-up inventory Aetherdust=" + std::to_string(Dust));
    return Dust;
}

static CellOfferConvertFn OrigCellOfferConvert = nullptr;

template<typename Key>
static bool ReadMiddlemanDustPrice(const void* Address, int32& Price) {
    using PriceMap = TMap<Key, MiddlemanPriceReference>;
    static_assert(sizeof(PriceMap) == 0x50);
    const auto& Map = *static_cast<const PriceMap*>(Address);
    if (!Map.IsValid() || Map.NumAllocated() < 0 || Map.NumAllocated() > 32) return false;
    for (const auto& Entry : Map) {
        const auto* Offer = static_cast<const unsigned char*>(Entry.Value().Offer);
        if (!Offer || !IsReadablePointer(Offer, MM::PriceOfferSize)) continue;
        const std::string Id = CoreCapFString(const_cast<unsigned char*>(Offer + MM::PriceCurrencyId));
        if (Id != "CURRENCY_CELLDUST" && Id != "id_currency_celldust") continue;
        const int32 EffectivePrice = *reinterpret_cast<const int32*>(Offer + MM::EffectivePrice);
        if (EffectivePrice < 0) return false;
        Price = EffectivePrice;
        return true;
    }
    return false;
}

static SDK::FCellOfferViewModel* __fastcall CellOfferConvertHook(
    SDK::FCellOfferViewModel* Out, const SDK::FOnlineStorePhoenixOffer* In) {
    auto* Result = OrigCellOfferConvert(Out, In);
    if (!In || !Out || !IsReadablePointer(In, sizeof(*In))) return Result;
    int32 DustPrice = -1;
    const auto* Bytes = reinterpret_cast<const unsigned char*>(In);
    if (ReadMiddlemanDustPrice<uint8>(Bytes + MM::EnumPriceMap, DustPrice)
        || ReadMiddlemanDustPrice<FName>(Bytes + MM::NamedPriceMap, DustPrice)) {
        Out->DustPrice = DustPrice;
        Out->DustCurrencyId = UKismetStringLibrary::Conv_StringToName(L"CURRENCY_CELLDUST");
        MpLog("[Middleman] offer " + CoreCapFString(&Out->SkuId)
            + " Aetherdust=" + std::to_string(DustPrice));
    }
    return Result;
}

static void CentreMiddlemanPriceRow(UPanelWidget* Panel) {
    if (!Panel || !IsReadablePointer(Panel, sizeof(UPanelWidget))) return;
    if (Panel->Slot && Panel->Slot->IsA(UVerticalBoxSlot::StaticClass()))
        static_cast<UVerticalBoxSlot*>(Panel->Slot)->SetHorizontalAlignment(EHorizontalAlignment::HAlign_Center);
    // A fill-sized amount reserves space beyond the icon/number pair. Once
    // Platinum is removed, centre the pair's natural width under the cell.
    FSlateChildSize AutoSize{};
    AutoSize.Value = 1.f;
    AutoSize.SizeRule = ESlateSizeRule::Automatic;
    if (Panel->Slots.Num() < 0 || Panel->Slots.Num() > 16) return;
    for (auto* Slot : Panel->Slots) {
        if (!Slot || !IsReadablePointer(Slot, sizeof(UPanelSlot))) continue;
        if (Slot->IsA(UHorizontalBoxSlot::StaticClass()))
            static_cast<UHorizontalBoxSlot*>(Slot)->SetSize(AutoSize);
        if (Slot->Content && Slot->Content->IsA(UHorizontalBox::StaticClass()))
            CentreMiddlemanPriceRow(static_cast<UPanelWidget*>(Slot->Content));
    }
}

static void ShowMiddlemanDustOnly(UWidget* Widget, int Depth ) {
    if (!Widget || Depth > 32 || !IsReadablePointer(Widget, sizeof(UWidget))) return;
    const std::string Name = Widget->GetName();
    if (Name == "ListHeader" && Widget->IsA(UTextBlock::StaticClass())) {
        static_cast<UTextBlock*>(Widget)->SetText(
            UKismetTextLibrary::Conv_StringToText(L"Purchase Cells with Aetherdust"));
    }
    // These are the actual widgets used by the 1.12 Middleman grid. Its
    // generic catalog tiles always create Platinum first, even when absent.
    if (Name == "PricesBox" && Widget->IsA(UPanelWidget::StaticClass())) {
        auto* Panel = static_cast<UPanelWidget*>(Widget);
        if (Panel->Slots.Num() == 2 && Panel->Slots[0]
            && IsReadablePointer(Panel->Slots[0], sizeof(UPanelSlot))
            && Panel->Slots[0]->Content) {
            Panel->Slots[0]->Content->SetVisibility(ESlateVisibility::Collapsed);
            Panel->Slots[0]->Content->SetIsEnabled(false);
        }
        CentreMiddlemanPriceRow(Panel);
    }
    if (Name == "PlatinumIcon" && Widget->Slot
        && IsReadablePointer(Widget->Slot, sizeof(UPanelSlot)) && Widget->Slot->Parent) {
        Widget->Slot->Parent->SetVisibility(ESlateVisibility::Collapsed);
    }
    if (Widget->IsA(UUserWidget::StaticClass())) {
        auto* Tree = static_cast<UUserWidget*>(Widget)->WidgetTree;
        if (Tree && IsReadablePointer(Tree, sizeof(UWidgetTree)))
            ShowMiddlemanDustOnly(Tree->RootWidget, Depth + 1);
    }
    if (!Widget->IsA(UPanelWidget::StaticClass())) return;
    auto* Panel = static_cast<UPanelWidget*>(Widget);
    if (Panel->Slots.Num() < 0 || Panel->Slots.Num() > 256) return;
    for (auto* Slot : Panel->Slots) {
        if (Slot && IsReadablePointer(Slot, sizeof(UPanelSlot)))
            ShowMiddlemanDustOnly(Slot->Content, Depth + 1);
    }
}

static bool IsMiddlemanPurchasePopup(UObject* Object) {
    if (!Object || !IsReadablePointer(Object, MM::PopupSize)
        || Object->Class->GetName() != "w_popup_purchase_confirm_C") return false;
    // Restrict this to the Middleman SKUs; other store popups retain their
    // own payment options. These reflected property offsets are from 1.12.
    const std::string Sku = CoreCapFString(reinterpret_cast<unsigned char*>(Object) + MM::PopupSku);
    return Sku.starts_with("middleman_");
}

static void ShowMiddlemanDustOnlyPopup(UObject* Object) {
    if (!IsMiddlemanPurchasePopup(Object)) return;
    auto* Bytes = reinterpret_cast<unsigned char*>(Object);
    for (size_t Offset : {size_t(MM::PopupPlatinumButton), size_t(MM::PopupPlatinumCost), size_t(MM::PopupOrSeparator)}) {
        auto* Widget = *reinterpret_cast<UWidget**>(Bytes + Offset);
        if (!Widget || !IsReadablePointer(Widget, sizeof(UWidget))) continue;
        Widget->SetVisibility(ESlateVisibility::Collapsed);
        Widget->SetIsEnabled(false);
    }
    // In the live 1.12 popup, "or" is txt_SecondaryButtonActive (0x500).
    // TextBlock (0x4C0) is the separate "Added to Inventory!" message.
    // Collapsing the separator removes its horizontal slot too; the equal
    // fill spacers either side of Cost then centre the remaining dust button.
    auto* Separator = *reinterpret_cast<UTextBlock**>(Bytes + MM::PopupOrSeparator);
    if (Separator && IsReadablePointer(Separator, sizeof(UTextBlock))
        && Separator->IsA(UTextBlock::StaticClass()))
        Separator->SetText(UKismetTextLibrary::Conv_StringToText(L""));
    // Keep confirm/gamepad input on the sole remaining payment option.
    *reinterpret_cast<int32*>(Bytes + MM::PopupSelectedCurrency) = 1;
}

static void ShowMiddlemanDustOnlyTooltip(UWidget* Widget, int Depth ) {
    if (!Widget || Depth > 32 || !IsReadablePointer(Widget, sizeof(UWidget))) return;
    if (Widget->GetName() == "CurrencyBox" && Widget->IsA(UPanelWidget::StaticClass())) {
        auto* Panel = static_cast<UPanelWidget*>(Widget);
        // 1.12 tooltip order: Platinum icon, Platinum amount, separator,
        // Aetherdust icon, Aetherdust amount.
        if (Panel->Slots.Num() == 5) {
            for (int Index = 0; Index < 3; ++Index) {
                auto* Slot = Panel->Slots[Index];
                if (Slot && IsReadablePointer(Slot, sizeof(UPanelSlot)) && Slot->Content)
                    Slot->Content->SetVisibility(ESlateVisibility::Collapsed);
            }
            CentreMiddlemanPriceRow(Panel);
        }
    }
    if (Widget->IsA(UUserWidget::StaticClass())) {
        auto* Tree = static_cast<UUserWidget*>(Widget)->WidgetTree;
        if (Tree && IsReadablePointer(Tree, sizeof(UWidgetTree)))
            ShowMiddlemanDustOnlyTooltip(Tree->RootWidget, Depth + 1);
    }
    if (!Widget->IsA(UPanelWidget::StaticClass())) return;
    auto* Panel = static_cast<UPanelWidget*>(Widget);
    if (Panel->Slots.Num() < 0 || Panel->Slots.Num() > 256) return;
    for (auto* Slot : Panel->Slots)
        if (Slot && IsReadablePointer(Slot, sizeof(UPanelSlot)))
            ShowMiddlemanDustOnlyTooltip(Slot->Content, Depth + 1);
}

static bool IsDustOnlyCellTooltip(UObject* Object) {
    if (!Object || !IsReadablePointer(Object, MM::TooltipSize)
        || Object->Class->GetName() != "w_CellItem_tooltip_bpw_C") return false;
    const auto& Costs = *reinterpret_cast<TArray<int32>*>(reinterpret_cast<unsigned char*>(Object) + MM::TooltipCosts);
    // Do not alter ordinary inventory tooltips or offers with a valid
    // Platinum price. These are the two costs passed by the Middleman tiles.
    const auto* CostData = *reinterpret_cast<int32* const*>(&Costs);
    return Costs.Num() == 2 && IsReadablePointer(CostData, sizeof(int32) * 2)
        && Costs[0] < 0 && Costs[1] >= 0;
}

void InstallMiddlemanAetherdustHook() {
    constexpr uintptr_t TargetRva = Native112::MiddlemanSpeedUpBalance;
    auto* Target = reinterpret_cast<unsigned char*>(Globals::BaseAddress + TargetRva);
    const unsigned char Expected[] = { 0x48, 0x89, 0x5C, 0x24, 0x08, 0x57, 0x48, 0x83,
        0xEC, 0x40, 0x48, 0x8B, 0xF9 };
    if (memcmp(Target, Expected, sizeof(Expected)) != 0) {
        MpLog("[InitClientHooks] MiddlemanAetherdust skipped: executable signature mismatch");
        return;
    }
    const MH_STATUS Create = RUNTIME_CREATE_HOOK(Target, ClientGetCurrentSpeedUpTokensHook,
        reinterpret_cast<LPVOID*>(&OrigClientGetCurrentSpeedUpTokens));
    const MH_STATUS Enable = Create == MH_OK ? RuntimeHooks::Enable(Target) : Create;
    MpLog(std::string("[InitClientHooks] MiddlemanAetherdust create=") + MH_StatusToString(Create)
        + " enable=" + MH_StatusToString(Enable));
    auto* Converter = reinterpret_cast<unsigned char*>(Native112::At(Globals::BaseAddress, Native112::Rva_01D56130));
    const unsigned char ConverterExpected[] = {0x48, 0x89, 0x5C, 0x24, 0x18, 0x55, 0x56, 0x57};
    if (memcmp(Converter, ConverterExpected, sizeof(ConverterExpected)) != 0) {
        MpLog("[InitClientHooks] MiddlemanOfferPrices skipped: executable signature mismatch");
        return;
    }
    const MH_STATUS PriceCreate = RUNTIME_CREATE_HOOK(Converter, CellOfferConvertHook,
        reinterpret_cast<LPVOID*>(&OrigCellOfferConvert));
    const MH_STATUS PriceEnable = PriceCreate == MH_OK ? RuntimeHooks::Enable(Converter) : PriceCreate;
    MpLog(std::string("[InitClientHooks] MiddlemanOfferPrices create=") + MH_StatusToString(PriceCreate)
        + " enable=" + MH_StatusToString(PriceEnable));

}

bool MiddlemanBeforeEvent(UObject* Object, const std::string& FunctionName) {
    // Run before native/Blueprint view and activation handlers read the lock.
    if (FunctionName.find("w_popup_purchase_confirm_C.") != std::string::npos
        && IsMiddlemanPurchasePopup(Object)
        && (FunctionName.ends_with(".PressedPlatinumButton") || FunctionName.ends_with(".InputSwap")))
        return false;
    return true;
}

void MiddlemanAfterEvent(UObject* Object, const std::string& FunctionName) {
    if (Object && FunctionName.find("w_exchange_offering_Grid_C.") != std::string::npos
        && (FunctionName.ends_with(".Construct") || FunctionName.ends_with(".RefreshItems")
            || FunctionName.ends_with(".SetupWeeklyOffers") || FunctionName.ends_with(".OnStoreOffersReceived")))
        ShowMiddlemanDustOnly(static_cast<UUserWidget*>(Object));
    if (FunctionName.find("w_popup_purchase_confirm_C.") != std::string::npos
        && (FunctionName.ends_with(".Refresh") || FunctionName.ends_with(".Construct")
            || FunctionName.ends_with(".Show Buttons") || FunctionName.ends_with(".UpdateCurrencyText")
            || FunctionName.ends_with(".SwapButtonStyles") || FunctionName.ends_with(".UpdateTextAndImages")
            || FunctionName.ends_with(".OnAnimationFinished")))
        ShowMiddlemanDustOnlyPopup(Object);
    if (FunctionName.find("w_CellItem_tooltip_bpw_C.") != std::string::npos
        && (FunctionName.ends_with(".Construct") || FunctionName.ends_with(".UpdateTooltip"))
        && IsDustOnlyCellTooltip(Object))
        ShowMiddlemanDustOnlyTooltip(static_cast<UUserWidget*>(Object));
}
