/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#include "client/TitleBackground.h"
#include "client/TitleBackgroundTiming.h"
#include "client/BackgroundArt.h"
#include "core/Memory.h"
#include "core/Logging.h"
#include "SDK/LoginScreen_bps_classes.hpp"
#include "SDK/UMG_parameters.hpp"

namespace {

struct BackgroundState {
    UObject* Owner = nullptr;
    UOverlay* Overlay = nullptr;
    std::vector<UImage*> Layers;
    std::size_t NextAsset = 1; // The game's original Malkarion image is already attached.
    double Seconds = 0;
    bool Active = true, Failed = false, Ready = false, LoggedTick = false;
    std::size_t LastSlide = 0;
};
std::map<int32, BackgroundState> Backgrounds;
thread_local bool UpdatingBackground = false;

template<class T> bool Live(T* Object) {
    return Object && IsReadablePointer(Object, sizeof(T))
        && IsRegisteredLiveObject(Object) && Object->IsA(T::StaticClass());
}
template<class T> T* NewWidget(UWidgetTree* Tree) {
    auto* Object = UGameplayStatics::SpawnObject(T::StaticClass(), Tree);
    return Live(Object) && Object->IsA(T::StaticClass()) ? static_cast<T*>(Object) : nullptr;
}

bool AddLayer(UOverlay* Overlay, UImage* Image) {
    auto* Slot = Overlay->AddChildToOverlay(Image);
    if (!Live(Slot)) return false;
    Slot->SetHorizontalAlignment(EHorizontalAlignment::HAlign_Fill);
    Slot->SetVerticalAlignment(EVerticalAlignment::VAlign_Fill);
    Image->SetVisibility(ESlateVisibility::HitTestInvisible);
    Image->SetRenderTransformPivot(FVector2D{0.5f, 0.5f});
    return true;
}

bool SetUp(ULoginScreen_bps_C* Screen, BackgroundState& State) {
    // Read-only live inspection: SplashImage is a Texture2D in a SizeBox,
    // within the background ScaleBox. Wrap only this image; all other controls
    // and the parent's original sizing/padding stay in their existing hierarchy.
    auto* Image = Screen->SplashImage;
    if (!Live(Screen->WidgetTree) || !Live(Image) || !Live(Image->Brush.ResourceObject)
        || !Image->Brush.ResourceObject->IsA(UTexture2D::StaticClass())
        || !Live(Image->Slot) || !Image->Slot->IsA(USizeBoxSlot::StaticClass())
        || !Live(Image->Slot->Parent) || !Image->Slot->Parent->IsA(USizeBox::StaticClass())) return false;
    auto* Parent = static_cast<USizeBox*>(Image->Slot->Parent);
    auto* OldSlot = static_cast<USizeBoxSlot*>(Image->Slot);
    const auto Padding = OldSlot->Padding;
    const auto Horizontal = OldSlot->HorizontalAlignment;
    const auto Vertical = OldSlot->VerticalAlignment;
    auto* Overlay = NewWidget<UOverlay>(Screen->WidgetTree);
    if (!Overlay) return false;
    Overlay->SetVisibility(ESlateVisibility::HitTestInvisible);
    Overlay->SetClipping(EWidgetClipping::ClipToBounds);
    auto Attach = [&](UWidget* Child) {
        auto* Slot = Parent->SetContent(Child);
        if (!Live(Slot) || !Slot->IsA(USizeBoxSlot::StaticClass())) return false;
        auto* SizeSlot = static_cast<USizeBoxSlot*>(Slot);
        SizeSlot->SetPadding(Padding);
        SizeSlot->SetHorizontalAlignment(Horizontal);
        SizeSlot->SetVerticalAlignment(Vertical);
        return true;
    };
    if (!Attach(Overlay) || !AddLayer(Overlay, Image)) {
        Image->RemoveFromParent();
        Attach(Image); // Keep the original static background if wrapping fails.
        return false;
    }
    State.Overlay = Overlay;
    State.Layers.push_back(Image);
    MpLog("[TitleBackground] Wrapped original SplashImage; controls and logo retained.");
    return true;
}

void LoadNext(ULoginScreen_bps_C* Screen, BackgroundState& State) {
    // One asset per UI tick. Each loaded texture is immediately held by an
    // attached Image brush, so GC cannot collect a pending slide.
    if (State.NextAsset < BackgroundArt::Paths.size()) {
        const auto AssetIndex = State.NextAsset++;
        const auto Path = UKismetSystemLibrary::MakeSoftObjectPath(FString(BackgroundArt::Paths[AssetIndex]));
        TSoftObjectPtr<UObject> Soft{};
        Soft.WeakPtr.ObjectIndex = -1;
        Soft.ObjectID.AssetPathName = Path.AssetPathName;
        Soft.ObjectID.SubPathString = Path.SubPathString;
        auto* Texture = UKismetSystemLibrary::LoadAsset_Blocking(Soft);
        if (!Live(Texture) || !Texture->IsA(UTexture2D::StaticClass())) {
            MpLog("[TitleBackground] Skipped unavailable installed background " + std::to_string(AssetIndex + 1));
            return;
        }
        auto* Layer = NewWidget<UImage>(Screen->WidgetTree);
        if (!Layer) return;
        // Do not copy the source brush's opaque fields. Its Pad_70 contains
        // Slate's cached render resource, which can still point to Malkarion
        // even after ResourceObject changes. Let the native setter create a
        // distinct resource handle, then retain the original size/tint/layout.
        Layer->SetBrushFromTexture(static_cast<UTexture2D*>(Texture), false);
        Layer->SetBrushSize(State.Layers.front()->Brush.ImageSize);
        Layer->SetBrushTintColor(State.Layers.front()->Brush.TintColor);
        Layer->SetColorAndOpacity(State.Layers.front()->ColorAndOpacity);
        Layer->SetRenderOpacity(0);
        if (!AddLayer(State.Overlay, Layer)) return;
        State.Layers.push_back(Layer);
        MpLog("[TitleBackground] Loaded installed background " + std::to_string(AssetIndex + 1));
        return;
    }
    State.Ready = true;
    MpLog("[TitleBackground] Ready with " + std::to_string(State.Layers.size())
        + " backgrounds; 10s hold, 2s crossfade, gentle zoom.");
}

void Animate(BackgroundState& State, float Delta) {
    if (!std::isfinite(Delta) || Delta <= 0) return;
    // Resuming a hidden window must not skip through the entire slideshow.
    State.Seconds += (std::min)(Delta, 0.25f);
    const auto Frame = TitleBackgroundTiming::Sample(State.Seconds, State.Layers.size());
    for (std::size_t Index = 0; Index < State.Layers.size(); ++Index) {
        auto* Layer = State.Layers[Index];
        if (!Live(Layer)) { State.Failed = true; return; }
        float Opacity = 0, Scale = 1.01f;
        if (Index == Frame.Current) { Opacity = Frame.CurrentOpacity; Scale = Frame.CurrentScale; }
        else if (Index == Frame.Next) { Opacity = Frame.NextOpacity; Scale = Frame.NextScale; }
        Layer->SetRenderOpacity(Opacity);
        Layer->SetRenderScale(FVector2D{Scale, Scale});
    }
    if (Frame.Current != State.LastSlide) {
        State.LastSlide = Frame.Current;
        MpLog("[TitleBackground] Showing background " + std::to_string(Frame.Current + 1));
    }
}
}

void TitleBackgroundAfterEvent(UObject* Object, const std::string& FunctionName, void* Parms) {
    const bool Construct = FunctionName == "Function LoginScreen_bps.LoginScreen_bps_C.Construct";
    const bool Tick = FunctionName == "Function UMG.UserWidget.Tick";
    const bool Destruct = FunctionName == "Function UMG.UserWidget.Destruct";
    if (UpdatingBackground || (!Construct && !Tick && !Destruct)
        || !Live(Object) || Object->Class->GetName() != "LoginScreen_bps_C"
        || !IsReadablePointer(Object, sizeof(ULoginScreen_bps_C))) return;
    struct Guard { Guard() { UpdatingBackground = true; } ~Guard() { UpdatingBackground = false; } } Guard;
    auto* Screen = static_cast<ULoginScreen_bps_C*>(Object);
    auto& State = Backgrounds[Object->Index];
    if (State.Owner != Object) { State = {}; State.Owner = Object; }
    if (Destruct) { State.Active = false; return; }
    if (Construct) {
        State.Active = true;
        if (!State.Overlay && !State.Failed) State.Failed = !SetUp(Screen, State);
        if (State.Failed) MpLog("[TitleBackground] Original static background retained; slideshow unavailable.");
        else {
            // This Blueprint has no scripted Tick. NativeConstruct evaluates
            // these flags after Construct returns; enable the reflected base
            // UserWidget.Tick event so animation stays on the game/UI thread.
            Screen->bHasScriptImplementedTick = true;
            Screen->TickFrequency = EWidgetTickFrequency::Auto;
        }
        if (Backgrounds.size() > 16)
            std::erase_if(Backgrounds, [](const auto& Entry) { return !IsRegisteredLiveObject(Entry.second.Owner); });
        return;
    }
    if (!State.Active || State.Failed || !Live(State.Overlay) || !Screen->IsVisible()
        || State.Layers.empty() || !Live(State.Layers.front())
        || !Live(State.Layers.front()->Slot) || State.Layers.front()->Slot->Parent != State.Overlay) return;
    if (!State.LoggedTick) { State.LoggedTick = true; MpLog("[TitleBackground] UI-thread animation tick active."); }
    if (!State.Ready) { LoadNext(Screen, State); return; }
    if (State.Layers.size() < 2 || !IsReadablePointer(Parms, sizeof(Params::UserWidget_Tick))) return;
    Animate(State, static_cast<Params::UserWidget_Tick*>(Parms)->InDeltaTime);
}
