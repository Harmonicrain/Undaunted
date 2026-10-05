/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#include "client/LoadingBackground.h"
#include "client/BackgroundArt.h"
#include "client/LoadingBackgroundChoice.h"
#include "core/RuntimeHooks.h"
#include "core/RuntimeState.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "native/Addresses112.h"

namespace {
void* OriginalFadeIn = nullptr;
std::size_t PreviousAsset = BackgroundArt::Paths.size();
thread_local bool Choosing = false;

template<class T> bool Live(T* Object) {
    return Object && IsReadablePointer(Object, sizeof(T))
        && IsRegisteredLiveObject(Object) && Object->IsA(T::StaticClass());
}

void ChooseBackground(UArchonLoadingScreen* Screen, uint8_t Mode) {
    // CL392819 ScreenFadeIn selects DefaultLoadingScreen for normal CITY and
    // ISLAND styles. FTUE uses its own tutorial art; QUICK/WHITE are transitions.
    if (Mode != static_cast<uint8_t>(ELoadScreenStyle::LOAD_SCREEN_CITY)
        && Mode != static_cast<uint8_t>(ELoadScreenStyle::LOAD_SCREEN_ISLAND)) return;
    if (!Live(Screen) || !Live(Screen->DefaultLoadingScreen)
        || !Live(Screen->WidgetSwitcherImage)) return;
    auto* Image = Screen->DefaultLoadingScreen;
    if (Screen->WidgetSwitcherImage->GetActiveWidget() != Image) return;
    const auto Bound = LoadingBackgroundChoice::DrawCount(BackgroundArt::Paths.size(), PreviousAsset);
    const auto Draw = UKismetMathLibrary::RandomInteger(static_cast<int32>(Bound));
    const auto Choice = LoadingBackgroundChoice::Select(BackgroundArt::Paths.size(), PreviousAsset,
        static_cast<std::size_t>(Draw));
    const auto Path = UKismetSystemLibrary::MakeSoftObjectPath(FString(BackgroundArt::Paths[Choice]));
    TSoftObjectPtr<UObject> Soft{};
    Soft.WeakPtr.ObjectIndex = -1;
    Soft.ObjectID.AssetPathName = Path.AssetPathName;
    Soft.ObjectID.SubPathString = Path.SubPathString;
    auto* Texture = UKismetSystemLibrary::LoadAsset_Blocking(Soft);
    if (!Live(Texture) || !Texture->IsA(UTexture2D::StaticClass())) {
        MpLog("[LoadingBackground] Installed background unavailable; retained current artwork.");
        return;
    }
    // The native setter invalidates the cached Slate handle. Preserve size,
    // tint, visibility and opacity, which belong to the original loading UI.
    Image->SetBrushFromTexture(static_cast<UTexture2D*>(Texture), false);
    PreviousAsset = Choice;
    MpLog("[LoadingBackground] Selected background " + std::to_string(Choice + 1)
        + " for loading mode " + std::to_string(Mode) + "; hints and indicator retained.");
}

void LoadingFadeInHook(UArchonLoadingScreen* Screen, uint8_t Mode) {
    if (!OriginalFadeIn) return;
    // Always preserve native loading logic and fades. Apply art after the game
    // has selected its active image, once per loading-screen presentation.
    if (Choosing) {
        reinterpret_cast<void(*)(UArchonLoadingScreen*, uint8_t)>(OriginalFadeIn)(Screen, Mode);
        return;
    }
    struct Guard { Guard() { Choosing = true; } ~Guard() { Choosing = false; } } Guard;
    reinterpret_cast<void(*)(UArchonLoadingScreen*, uint8_t)>(OriginalFadeIn)(Screen, Mode);
    ChooseBackground(Screen, Mode);
}
}

void InstallLoadingBackgroundHook() {
    auto* Target = reinterpret_cast<void*>(Native112::At(Globals::BaseAddress, Native112::LoadingScreenFadeIn));
    // Verified CL392819 prologue, the same function already guarded server-side.
    constexpr unsigned char Prologue[]{0x48, 0x89, 0x5C, 0x24, 0x10, 0x57, 0x48, 0x83, 0xEC, 0x70};
    if (!IsReadablePointer(Target, sizeof(Prologue)) || std::memcmp(Target, Prologue, sizeof(Prologue)) != 0) {
        MpLog("[LoadingBackground] Native signature mismatch; original loading artwork retained.");
        return;
    }
    RUNTIME_INSTALL_HOOK(Native112::LoadingScreenFadeIn, LoadingFadeInHook, &OriginalFadeIn);
}
