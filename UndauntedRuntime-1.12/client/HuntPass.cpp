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
#include "client/HuntPass.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "core/Transport.h"

static void HideHuntPassRankSkip(UHuntingPassScreen* Screen);
static void PrepareLibraryPassSelection(UObject* Object);

struct HuntPassRankSkipWidgets {
    UWidget* LevelButton = nullptr;
    UWidget* CaptionContainer = nullptr;
};

using HuntPassQueryOffersFn = void(__fastcall*)(UHuntPassSelectionViewModel*);

using HuntPassSelectionUpdateFn = void(__fastcall*)(UHuntPassSelectionScreen*);

using InitializeHuntingPassViewModelFn = bool(__fastcall*)(UHuntingPassViewModel*, const void*);

using GetSeasonalCoinIconsFn = void(__fastcall*)(UHuntingPassViewModel*,
    TSoftObjectPtr<UTexture2D>*, TSoftObjectPtr<UTexture2D>*);

using InitializeHuntingPassLevelItemFn = void(__fastcall*)(UHuntingPassLevelItemWidget*,
    FHuntingPassLevelViewModel*, int32, bool);

static void FindHuntPassRankSkipWidgets(UWidget* Widget, HuntPassRankSkipWidgets& Found, int Depth = 0);
static void ReadJsonStringArray(const std::string& Body, const char* KeyName, std::set<std::string>& Out,
    const char* RequiredPrefix);
static BOOL CALLBACK LoadLibraryHuntPassRows(PINIT_ONCE, PVOID, PVOID*);
static void PrepareLibraryPassItem(UHuntPassItemViewModel* Item);
static void __fastcall HuntPassSelectionUpdateHook(UHuntPassSelectionScreen* This);
static void __fastcall HuntPassQueryOffersHook(UHuntPassSelectionViewModel* This);
static bool IsElementalReward(const FHuntingPassRewardViewModel& Reward);
static void SetElementalRewardIcon(TSoftObjectPtr<UTexture2D>& Target, bool Elite);
static void FixElementalRewardIcons(FHuntingPassLevelViewModel& Level);
static void __fastcall GetSeasonalCoinIconsHook(UHuntingPassViewModel* This,
    TSoftObjectPtr<UTexture2D>* Coin, TSoftObjectPtr<UTexture2D>* Stack);
static bool __fastcall InitializeHuntingPassViewModelHook(UHuntingPassViewModel* This, const void* Progress);
static void __fastcall InitializeHuntingPassLevelItemHook(UHuntingPassLevelItemWidget* This,
    FHuntingPassLevelViewModel* Level, int32 CurrentCurrency, bool bLastItemOnPage);

static void FindHuntPassRankSkipWidgets(UWidget* Widget, HuntPassRankSkipWidgets& Found, int Depth ) {
    if (!Widget || Depth > 32 || !IsReadablePointer(Widget, sizeof(UWidget))) return;
    const std::string Name = Widget->GetName();
    if (Name == "LevelButton") Found.LevelButton = Widget;
    else if (Name == "NextLevelPanel" && Widget->Slot
        && IsReadablePointer(Widget->Slot, sizeof(UPanelSlot))) {
        // The caption lives inside a SizeBox; collapse that parent to reclaim
        // its layout space without touching the adjacent Elite button.
        auto* Parent = Widget->Slot->Parent;
        if (Parent && IsReadablePointer(Parent, sizeof(UWidget))
            && Parent->IsA(USizeBox::StaticClass())) Found.CaptionContainer = Parent;
    }
    if (!Widget->IsA(UPanelWidget::StaticClass())) return;
    auto* Panel = static_cast<UPanelWidget*>(Widget);
    if (Panel->Slots.Num() < 0 || Panel->Slots.Num() > 256) return;
    for (auto* Slot : Panel->Slots) {
        if (Slot && IsReadablePointer(Slot, sizeof(UPanelSlot)))
            FindHuntPassRankSkipWidgets(Slot->Content, Found, Depth + 1);
    }
}

static void HideHuntPassRankSkip(UHuntingPassScreen* Screen) {
    if (!Screen || !IsReadablePointer(Screen, sizeof(UHuntingPassScreen))) return;
    auto* Tree = Screen->WidgetTree;
    if (!Tree || !IsReadablePointer(Tree, sizeof(UWidgetTree))) return;
    HuntPassRankSkipWidgets Found;
    FindHuntPassRankSkipWidgets(Tree->RootWidget, Found);
    static UFunction* SetVisibilityFn = UWidget::StaticClass()->GetFunction("Widget", "SetVisibility");
    if (!SetVisibilityFn) return;
    bool Changed = false;
    for (auto* Widget : { Found.LevelButton, Found.CaptionContainer }) {
        if (!Widget || Widget->Visibility == ESlateVisibility::Collapsed) continue;
        auto Visibility = ESlateVisibility::Collapsed;
        const auto Flags = SetVisibilityFn->FunctionFlags;
        SetVisibilityFn->FunctionFlags |= 0x400;
        Widget->ProcessEvent(SetVisibilityFn, &Visibility);
        SetVisibilityFn->FunctionFlags = Flags;
        Changed = true;
    }
    if (Changed) MpLog("[HuntPassRankSkip] collapsed button and caption");
}

// UHuntPassSelectionViewModel::QueryOffers, verified in CL392819 at
// +0x01E1EB50 (queries "huntpass_store"). Some archived rows have their
// bAvailableInCurrentBuild bit cleared despite retaining rewards and assets.
// Enable only the rows explicitly approved by the backend catalogue. Do not
// enable season feature flags: that would change the world's current season.
static std::set<std::string> g_LibraryHuntPassRows;

static std::set<std::string> g_HiddenVaultRows;

static std::set<std::string> g_MainStyleHuntPassTracks;

static std::set<std::string> g_SelectableLibraryHuntPassTracks;

static INIT_ONCE g_LibraryHuntPassRowsOnce = INIT_ONCE_STATIC_INIT;

static void ReadJsonStringArray(const std::string& Body, const char* KeyName, std::set<std::string>& Out,
    const char* RequiredPrefix) {
    const std::string KeyText = std::string("\"") + KeyName + "\"";
    const size_t Key = Body.find(KeyText);
    const size_t Open = Key == std::string::npos ? std::string::npos : Body.find('[', Key);
    const size_t Close = Open == std::string::npos ? std::string::npos : Body.find(']', Open);
    if (Close == std::string::npos) return;
    for (size_t At = Body.find('"', Open); At != std::string::npos && At < Close; ) {
        const size_t End = Body.find('"', At + 1);
        if (End == std::string::npos || End > Close) break;
        const std::string Value = Body.substr(At + 1, End - At - 1);
        if (Value.rfind(RequiredPrefix, 0) == 0 && Value.size() < 80
            && Value.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_") == std::string::npos)
            Out.insert(Value);
        At = Body.find('"', End + 1);
    }
}

static BOOL CALLBACK LoadLibraryHuntPassRows(PINIT_ONCE, PVOID, PVOID*) {
    const std::string Body = HttpGetFromMetagame(L"/undaunted/huntpass_library");
    ReadJsonStringArray(Body, "rows", g_LibraryHuntPassRows, "HuntPass_Season");
    ReadJsonStringArray(Body, "hidden_rows", g_HiddenVaultRows, "HuntPass_Season");
    ReadJsonStringArray(Body, "main_style_tracks", g_MainStyleHuntPassTracks, "season");
    ReadJsonStringArray(Body, "selectable_tracks", g_SelectableLibraryHuntPassTracks, "season");
    MpLog("[HuntPassLibrary] configured rows=" + std::to_string(g_LibraryHuntPassRows.size())
        + " main-style tracks=" + std::to_string(g_MainStyleHuntPassTracks.size()));
    return TRUE;
}

static void PrepareLibraryPassItem(UHuntPassItemViewModel* Item) {
    if (!Item || !IsReadablePointer(Item, sizeof(UHuntPassItemViewModel))) return;
    const auto Track = Item->HuntPassTrackID.ToString();
    if (g_SelectableLibraryHuntPassTracks.count(Track) == 0) return;
    // Archived regular passes have a public lane just like the current pass.
    // The stock selector otherwise mistakes their Elite offer for an access gate.
    Item->bIsLocked = false;
    if (g_MainStyleHuntPassTracks.count(Track) != 0) Item->bIsMainHuntPass = true;
}

static void PrepareLibraryPassSelection(UObject* Object) {
    // The query hook loads the allowlist before any selector items are built.
    if (g_SelectableLibraryHuntPassTracks.empty()) return;
    if (Object->IsA(UHuntPassSelectionScreen::StaticClass())) {
        auto* Model = static_cast<UHuntPassSelectionScreen*>(Object)->HuntPassSelectionViewModel;
        if (Model && IsReadablePointer(Model, sizeof(UHuntPassSelectionViewModel)))
            for (auto* Item : Model->HuntPassesViewModels) PrepareLibraryPassItem(Item);
    } else if (Object->IsA(UHuntPassItemWidget::StaticClass())) {
        PrepareLibraryPassItem(static_cast<UHuntPassItemWidget*>(Object)->HuntPassItemViewModel);
    } else if (Object->IsA(UHuntingPassScreen::StaticClass())) {
        PrepareLibraryPassItem(static_cast<UHuntingPassScreen*>(Object)->PreviewViewModel);
    }
}

static HuntPassQueryOffersFn OrigHuntPassQueryOffers = nullptr;

static HuntPassSelectionUpdateFn OrigHuntPassSelectionUpdate = nullptr;

static void __fastcall HuntPassSelectionUpdateHook(UHuntPassSelectionScreen* This) {
    if (This && IsReadablePointer(This, sizeof(UHuntPassSelectionScreen)))
        PrepareLibraryPassSelection(This);
    OrigHuntPassSelectionUpdate(This);
}

static void __fastcall HuntPassQueryOffersHook(UHuntPassSelectionViewModel* This) {
    InitOnceExecuteOnce(&g_LibraryHuntPassRowsOnce, LoadLibraryHuntPassRows, nullptr, nullptr);
    if (This && IsReadablePointer(This, sizeof(UHuntPassSelectionViewModel))) {
        UDataTable* Table = This->HuntPassSeasonTable;
        if (Table && IsReadablePointer(Table, sizeof(UDataTable))) {
            for (auto& Pair : Table->RowMap) {
                if (g_HiddenVaultRows.count(Pair.Key().GetRawString()) != 0) {
                    auto* Hidden = reinterpret_cast<FHuntPassSeasonDataTable*>(Pair.Value());
                    if (Hidden && IsReadablePointer(Hidden, sizeof(FHuntPassSeasonDataTable)))
                        Hidden->bAvailableInCurrentBuild = false;
                    continue;
                }
                if (g_LibraryHuntPassRows.count(Pair.Key().GetRawString()) == 0) continue;
                auto* Row = reinterpret_cast<FHuntPassSeasonDataTable*>(Pair.Value());
                if (Row && IsReadablePointer(Row, sizeof(FHuntPassSeasonDataTable)) && Row->Assets
                    && !Row->bAvailableInCurrentBuild) {
                    Row->bAvailableInCurrentBuild = true;
                    MpLog("[HuntPassLibrary] enabled archive row " + Pair.Key().GetRawString());
                }
            }
        }
    }
    OrigHuntPassQueryOffers(This);
}

void InstallHuntPassLibraryHook() {
    void* Target = reinterpret_cast<void*>(Native112::At(Globals::BaseAddress, Native112::Rva_01E1EB50));
    const MH_STATUS Create = RUNTIME_CREATE_HOOK(Target, HuntPassQueryOffersHook,
        reinterpret_cast<LPVOID*>(&OrigHuntPassQueryOffers));
    const MH_STATUS Enable = Create == MH_OK ? RuntimeHooks::Enable(Target) : Create;
    MpLog(std::string("[InitClientHooks] HuntPassLibrary create=") + MH_StatusToString(Create)
        + " enable=" + MH_StatusToString(Enable));
    // UHuntPassSelectionScreen::UpdateView is also called directly by native
    // focus/store callbacks, bypassing ProcessEvent. Its main-pass check at
    // +0x1E2F719 selects Activate rather than the premium-offer purchase action.
    auto* UpdateTarget = reinterpret_cast<unsigned char*>(Native112::At(Globals::BaseAddress, Native112::Rva_01E2F410));
    const unsigned char Expected[] = { 0x40, 0x55, 0x53, 0x41, 0x57, 0x48, 0x8D, 0xAC,
        0x24, 0x10, 0xFF, 0xFF, 0xFF, 0x48, 0x81, 0xEC, 0xF0, 0x01 };
    if (memcmp(UpdateTarget, Expected, sizeof(Expected)) != 0) {
        MpLog("[InitClientHooks] HuntPassSelectionUpdate skipped: executable signature mismatch");
        return;
    }
    const MH_STATUS UpdateCreate = RUNTIME_CREATE_HOOK(UpdateTarget, HuntPassSelectionUpdateHook,
        reinterpret_cast<LPVOID*>(&OrigHuntPassSelectionUpdate));
    const MH_STATUS UpdateEnable = UpdateCreate == MH_OK ? RuntimeHooks::Enable(UpdateTarget) : UpdateCreate;
    MpLog(std::string("[InitClientHooks] HuntPassSelectionUpdate create=") + MH_StatusToString(UpdateCreate)
        + " enable=" + MH_StatusToString(UpdateEnable));
}

static InitializeHuntingPassViewModelFn OrigInitializeHuntingPassViewModel = nullptr;

static thread_local bool g_MainStyleLevelWidgets = false;

static bool IsElementalReward(const FHuntingPassRewardViewModel& Reward) {
    return Reward.RewardCatalogItem.ItemId.ToString() == "CURRENCY_S19_COIN"
        || Reward.PreviewItemId.ToString() == "CURRENCY_S19_COIN";
}

// Both textures are shipped in Archon_UI_0-WindowsClient.pak. The elite
// reward uses the coin stack; the basic reward uses the single coin.
static void SetElementalRewardIcon(TSoftObjectPtr<UTexture2D>& Target, bool Elite) {
    static const FName Coin = UKismetStringLibrary::Conv_StringToName(
        L"/Game/UI/Textures/HuntingGrounds/season_icons/ui_event_molten_coin_currency_icon.ui_event_molten_coin_currency_icon");
    static const FName Stack = UKismetStringLibrary::Conv_StringToName(
        L"/Game/UI/Textures/HuntingGrounds/season_icons/ui_event_molten_coin_currency_store_icon.ui_event_molten_coin_currency_store_icon");
    // These texture references have no subobjects. Preserve FString ownership
    // rather than shallow-copying engine-owned soft object pointers.
    if (!Target.ObjectID.SubPathString.ToString().empty()) return;
    Target.ObjectID.AssetPathName = Elite ? Stack : Coin;
    Target.WeakPtr = {};
    Target.TagAtLastTest = 0;
}

// Reward cards and the subsequent screen-level seasonal override must agree.
static void FixElementalRewardIcons(FHuntingPassLevelViewModel& Level) {
    auto Fix = [](TArray<FHuntingPassRewardViewModel>& Rewards, bool Elite) {
        for (auto& Reward : Rewards) {
            if (!IsElementalReward(Reward)) continue;
            SetElementalRewardIcon(Reward.CustomIcon, Elite);
            SetElementalRewardIcon(Reward.CustomIconBottom, Elite);
        }
    };
    Fix(Level.BasicRewards, false);
    Fix(Level.EliteRewards, true);
}

static GetSeasonalCoinIconsFn OrigGetSeasonalCoinIcons = nullptr;

static void __fastcall GetSeasonalCoinIconsHook(UHuntingPassViewModel* This,
    TSoftObjectPtr<UTexture2D>* Coin, TSoftObjectPtr<UTexture2D>* Stack) {
    OrigGetSeasonalCoinIcons(This, Coin, Stack);
    if (!This || !IsReadablePointer(This, sizeof(UHuntingPassViewModel))) return;
    auto HasElemental = [](const TArray<FHuntingPassRewardViewModel>& Rewards) {
        for (const auto& Reward : Rewards)
            if (IsElementalReward(Reward)) return true;
        return false;
    };
    // UHuntingPassScreen calls this AFTER initializing the prestige tile, then
    // SetRewardsIcons replaces its card images. Archived season row handles
    // still name their old currency even though the server remaps the reward.
    // Scope the replacement to the actual bonus reward in each lane.
    const bool Basic = HasElemental(This->PrestigeViewModel.BasicRewards)
        || HasElemental(This->PrestigeLevel.BasicRewards);
    const bool Elite = HasElemental(This->PrestigeViewModel.EliteRewards)
        || HasElemental(This->PrestigeLevel.EliteRewards);
    if (Basic && Coin) SetElementalRewardIcon(*Coin, false);
    if (Elite && Stack) SetElementalRewardIcon(*Stack, true);
    static std::set<std::string> Reported;
    if ((Basic || Elite) && Reported.insert(This->ProgressionTrack.ToString()).second)
        MpLog("[HuntPassLibrary] Elemental bonus icons for " + This->ProgressionTrack.ToString());
}

void InstallHuntPassCoinIconsHook() {
    auto* Target = reinterpret_cast<unsigned char*>(Native112::At(Globals::BaseAddress, Native112::Rva_01DF5E80));
    const unsigned char Expected[] = { 0x48, 0x89, 0x5C, 0x24, 0x10,
        0x48, 0x89, 0x74, 0x24, 0x18, 0x48, 0x89, 0x7C, 0x24, 0x20 };
    if (memcmp(Target, Expected, sizeof(Expected)) != 0) {
        MpLog("[InitClientHooks] HuntPassCoinIcons skipped: executable signature mismatch");
        return;
    }
    const MH_STATUS Create = RUNTIME_CREATE_HOOK(Target, GetSeasonalCoinIconsHook,
        reinterpret_cast<LPVOID*>(&OrigGetSeasonalCoinIcons));
    const MH_STATUS Enable = Create == MH_OK ? RuntimeHooks::Enable(Target) : Create;
    MpLog(std::string("[InitClientHooks] HuntPassCoinIcons create=") + MH_StatusToString(Create)
        + " enable=" + MH_StatusToString(Enable));
}

static bool __fastcall InitializeHuntingPassViewModelHook(UHuntingPassViewModel* This, const void* Progress) {
    const bool Initialized = OrigInitializeHuntingPassViewModel(This, Progress);
    InitOnceExecuteOnce(&g_LibraryHuntPassRowsOnce, LoadLibraryHuntPassRows, nullptr, nullptr);
    g_MainStyleLevelWidgets = false;
    if (!Initialized || !This || !IsReadablePointer(This, sizeof(UHuntingPassViewModel))) return Initialized;
    FixElementalRewardIcons(This->PrestigeLevel);
    FixElementalRewardIcons(This->PrestigeViewModel);
    const std::string Track = This->ProgressionTrack.ToString();
    if (g_SelectableLibraryHuntPassTracks.count(Track) != 0) This->bIsLocked = false;
    if (g_MainStyleHuntPassTracks.count(Track) != 0) {
        g_MainStyleLevelWidgets = true;
        This->bIsMainHuntPass = true;
        This->bIsLocked = false;
        int32 BasicRewards = 0;
        for (auto& Level : This->Levels) {
            Level.bShowBasicReward = true;
            BasicRewards += Level.BasicRewards.Num();
        }
        This->PrestigeLevel.bShowBasicReward = true;
        This->PrestigeViewModel.bShowBasicReward = true;
        static std::set<std::string> Reported;
        if (Reported.insert(Track).second)
            MpLog("[HuntPassLibrary] main-track layout enabled for " + Track
                + " levels=" + std::to_string(This->Levels.Num())
                + " public rewards=" + std::to_string(BasicRewards));
    }
    return Initialized;
}

static InitializeHuntingPassLevelItemFn OrigInitializeHuntingPassLevelItem = nullptr;

static void __fastcall InitializeHuntingPassLevelItemHook(UHuntingPassLevelItemWidget* This,
    FHuntingPassLevelViewModel* Level, int32 CurrentCurrency, bool bLastItemOnPage) {
    if (g_MainStyleLevelWidgets && Level && IsReadablePointer(Level, sizeof(FHuntingPassLevelViewModel)))
        Level->bShowBasicReward = true;
    if (Level && IsReadablePointer(Level, sizeof(FHuntingPassLevelViewModel)))
        FixElementalRewardIcons(*Level);
    OrigInitializeHuntingPassLevelItem(This, Level, CurrentCurrency, bLastItemOnPage);
}

void InstallHuntPassMainTrackLayoutHook() {
    auto* Target = reinterpret_cast<unsigned char*>(Native112::At(Globals::BaseAddress, Native112::Rva_01DFDC10));
    const unsigned char Expected[] = { 0x48, 0x89, 0x5C, 0x24, 0x18, 0x55, 0x56, 0x57,
        0x41, 0x54, 0x41, 0x55, 0x41, 0x56, 0x41, 0x57 };
    if (memcmp(Target, Expected, sizeof(Expected)) != 0) {
        MpLog("[InitClientHooks] HuntPassMainTrackLayout skipped: executable signature mismatch");
        return;
    }
    const MH_STATUS Create = RUNTIME_CREATE_HOOK(Target, InitializeHuntingPassViewModelHook,
        reinterpret_cast<LPVOID*>(&OrigInitializeHuntingPassViewModel));
    const MH_STATUS Enable = Create == MH_OK ? RuntimeHooks::Enable(Target) : Create;
    MpLog(std::string("[InitClientHooks] HuntPassMainTrackLayout create=") + MH_StatusToString(Create)
        + " enable=" + MH_StatusToString(Enable));

    auto* LevelTarget = reinterpret_cast<unsigned char*>(Native112::At(Globals::BaseAddress, Native112::Rva_01DFD180));
    const unsigned char LevelExpected[] = { 0x48, 0x89, 0x5C, 0x24, 0x10, 0x48, 0x89, 0x6C,
        0x24, 0x18, 0x48, 0x89, 0x74, 0x24, 0x20, 0x57 };
    if (memcmp(LevelTarget, LevelExpected, sizeof(LevelExpected)) != 0) {
        MpLog("[InitClientHooks] HuntPassLevelItemLayout skipped: executable signature mismatch");
        return;
    }
    const MH_STATUS LevelCreate = RUNTIME_CREATE_HOOK(LevelTarget, InitializeHuntingPassLevelItemHook,
        reinterpret_cast<LPVOID*>(&OrigInitializeHuntingPassLevelItem));
    const MH_STATUS LevelEnable = LevelCreate == MH_OK ? RuntimeHooks::Enable(LevelTarget) : LevelCreate;
    MpLog(std::string("[InitClientHooks] HuntPassLevelItemLayout create=") + MH_StatusToString(LevelCreate)
        + " enable=" + MH_StatusToString(LevelEnable));
}

bool HuntPassBeforeEvent(UObject* Object, const std::string& FunctionName) {
    // This affects pass access only; bOwnsElite remains entitlement-driven.
    if (Object && (FunctionName.ends_with(".UpdateView")
        || FunctionName.ends_with(".OnUpdateViewModel")
        || FunctionName.ends_with(".OnHuntPassFocused")
        || FunctionName.ends_with(".OnActivateClicked")
        || FunctionName.ends_with(".OnPreviewClicked")
        || FunctionName.ends_with(".OnRefreshData")))
        PrepareLibraryPassSelection(Object);
    // The 1.12 rank-skip offers are not implemented by the metagame. Keep the
    // action inaccessible through controller/keyboard routes as well as UI.
    const bool RankSkipAction = FunctionName.ends_with(".TriggerBuyLevel")
        || FunctionName.ends_with(".OnBuyLevel")
        || FunctionName.find("BndEvt__BuyLevelButton_") != std::string::npos;
    if (RankSkipAction && Object && Object->IsA(UHuntingPassScreen::StaticClass())) return false;
    return true;
}

void HuntPassAfterEvent(UObject* Object, const std::string& FunctionName) {
    const bool HuntPassUiUpdate = FunctionName.find(".Construct") != std::string::npos
        || FunctionName.find(".OnRefreshData") != std::string::npos
        || FunctionName.find(".OnLevelOffersCompleted") != std::string::npos
        || FunctionName.find(".OnProgressionUpdated") != std::string::npos
        || FunctionName.find(".OnHuntPassUpdated") != std::string::npos
        || FunctionName.find(".OnBackFromSelectionScreen") != std::string::npos;
    if (HuntPassUiUpdate && Object && Object->IsA(UHuntingPassScreen::StaticClass()))
        HideHuntPassRankSkip(static_cast<UHuntingPassScreen*>(Object));
}
