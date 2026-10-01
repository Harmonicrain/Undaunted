/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
#include "client/SlayerLinks.h"
#include "client/SlayerLinkRecoveryPolicy.h"
#include "core/RuntimeHooks.h"
#include "core/RuntimeState.h"
#include "core/Memory.h"
#include "core/Logging.h"
#include "native/Addresses112.h"
#include "native/Layouts112.h"

namespace {
using DataReceived = void(*)(void*, void*);
DataReceived Original = nullptr;
using TryAction = bool(*)(ULinkedSlayerScreen*);
TryAction OriginalAction = nullptr;

FUObjectItem* ObjectItem(int32_t Index) {
    auto* Objects = UObject::GObjects.operator->();
    if (!Objects || Index < 0 || Index >= Objects->Num()) return nullptr;
    return Objects->GetDecrytedObjPtr()[Index / 65536] + Index % 65536;
}

// The generated weak-pointer helper checks only the index. Check the serial
// too so a deferred click cannot act on an object occupying a recycled slot.
struct ObjectHandle {
    int32_t Index = -1;
    int32_t Serial = 0;
    bool Capture(UObject* Object) {
        __try {
            if (!IsReadablePointer(Object, sizeof(UObject))) return false;
            auto* Item = ObjectItem(Object->Index);
            if (!Item || Item->Object != Object) return false;
            Index = Object->Index;
            Serial = *reinterpret_cast<int32_t*>(reinterpret_cast<uint8_t*>(Item)
                + Native112::SlayerLinkLayout::ObjectItemSerial);
            if (!Serial) reinterpret_cast<void(*)(ObjectHandle*, UObject*)>(
                Native112::At(Globals::BaseAddress, Native112::MakeWeakObjectPtr))(this, Object);
            return Serial > 0;
        } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
    }
    UObject* Get() const {
        __try {
            auto* Item = ObjectItem(Index);
            if (!Item || Serial <= 0 || Serial != *reinterpret_cast<int32_t*>(
                reinterpret_cast<uint8_t*>(Item) + Native112::SlayerLinkLayout::ObjectItemSerial)) return nullptr;
            return Item->Object;
        } __except (EXCEPTION_EXECUTE_HANDLER) { return nullptr; }
    }
};

SlayerLinkUnlockPolicy PendingUnlock;
ObjectHandle PendingScreen, PendingModel, PendingOwner;

int64_t Expiration(const USlayerLinkViewModel* Model) {
    // FDateTime is an opaque eight-byte property in the generated SDK.
    static_assert(sizeof(FDateTime) == sizeof(int64_t));
    int64_t Ticks = 0;
    memcpy(&Ticks, &Model->ExpirationDate, sizeof(Ticks));
    return Ticks;
}

bool FindPool(UArchonLinkedSlayers* Owner, int32_t Slot, int64_t End, int32_t* PoolCount) {
    using namespace Native112::SlayerLinkLayout;
    __try {
        auto* Bytes = reinterpret_cast<const uint8_t*>(Owner);
        if (!IsReadablePointer(Bytes, Rows + 16)) return false;
        const auto* Data = *reinterpret_cast<const uint8_t* const*>(Bytes + Rows);
        const int32_t Num = *reinterpret_cast<const int32_t*>(Bytes + Rows + 8);
        const int32_t Max = *reinterpret_cast<const int32_t*>(Bytes + Rows + 12);
        if (Num < 1 || Num > 3 || Max < Num || !IsReadablePointer(Data, static_cast<size_t>(Num) * RowStride)) return false;
        for (int32_t Index = 0; Index < Num; ++Index) {
            const auto* Row = Data + static_cast<size_t>(Index) * RowStride;
            if (*reinterpret_cast<const int32_t*>(Row + RowSlot) != Slot
                || *reinterpret_cast<const int64_t*>(Row + RowExpiration) != End) continue;
            *PoolCount = *reinterpret_cast<const int32_t*>(Row + RowPoolCount);
            return *PoolCount >= 0;
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) { }
    return false;
}

void SetWaiting(ULinkedSlayerScreen* Screen, USlayerLinkViewModel* Model, bool Waiting) {
    if (!Screen || !Model || !IsReadablePointer(Screen, sizeof(*Screen))
        || !IsReadablePointer(Model, sizeof(*Model)) || Screen->SelectedLinkSlayerViewModel != Model) return;
    auto* Info = Screen->LinkInfoWidget;
    if (!IsReadablePointer(Info, sizeof(*Info))) return;
    auto* Button = Info->ActionButton;
    if (!IsReadablePointer(Button, sizeof(*Button))) return;
    if (Waiting) {
        Button->DisableButton();
        Button->SetButtonLabel(UKismetTextLibrary::Conv_StringToText(L"Preparing rewards..."));
    } else {
        Button->EnableButton();
        Button->SetButtonLabel(Model->ActionButtonLabelText);
    }
}

void CancelPendingUnlock() {
    PendingUnlock.Cancel();
    SetWaiting(static_cast<ULinkedSlayerScreen*>(PendingScreen.Get()),
        static_cast<USlayerLinkViewModel*>(PendingModel.Get()), false);
}

bool TryActionHook(ULinkedSlayerScreen* Screen) {
    if (!IsReadablePointer(Screen, sizeof(*Screen))) return OriginalAction(Screen);
    if (PendingUnlock.Pending()) {
        if (PendingScreen.Get() == Screen && PendingModel.Get() == Screen->SelectedLinkSlayerViewModel) return true;
        CancelPendingUnlock();
    }
    auto* Model = Screen->SelectedLinkSlayerViewModel;
    if (!IsReadablePointer(Model, sizeof(*Model))) return OriginalAction(Screen);
    ObjectHandle OwnerHandle{ Model->LinkedSlayers.ObjectIndex, Model->LinkedSlayers.ObjectSerialNumber };
    auto* Owner = static_cast<UArchonLinkedSlayers*>(OwnerHandle.Get());
    int32_t PoolCount = -1;
    if (!FindPool(Owner, Model->SlotNumber, Expiration(Model), &PoolCount)
        || !SlayerLinkUnlockPolicy::NeedsPool(static_cast<int32_t>(Model->Status), PoolCount)) return OriginalAction(Screen);
    if (!PendingScreen.Capture(Screen) || !PendingModel.Capture(Model) || !PendingOwner.Capture(Owner)
        || !PendingUnlock.Begin(Model->SlotNumber, Expiration(Model), GetTickCount64())) return OriginalAction(Screen);
    SetWaiting(Screen, Model, true);
    MpLog("[SlayerLink] waiting for prize pool before unlock, slot " + std::to_string(Model->SlotNumber));
    return true;
}

void ResumePendingUnlock(void* Owner) {
    if (!PendingUnlock.Pending()) return;
    if (!PendingOwner.Get()) { CancelPendingUnlock(); return; }
    if (PendingOwner.Get() != Owner) return;
    auto* Screen = static_cast<ULinkedSlayerScreen*>(PendingScreen.Get());
    if (!IsReadablePointer(Screen, sizeof(*Screen)) || Screen->bDestructCalled) { CancelPendingUnlock(); return; }
    // A refresh may replace the view model. Match the same link below rather
    // than requiring its old UI model to survive the refresh.
    auto* Model = Screen->SelectedLinkSlayerViewModel;
    int32_t PoolCount = -1;
    if (!IsReadablePointer(Model, sizeof(*Model))
        || Model->LinkedSlayers.ObjectIndex != PendingOwner.Index
        || Model->LinkedSlayers.ObjectSerialNumber != PendingOwner.Serial
        || (Model->Status != ELinkStatus::Finished && Model->Status != ELinkStatus::FinishedWithoutProgress)
        || !FindPool(static_cast<UArchonLinkedSlayers*>(Owner), Model->SlotNumber, Expiration(Model), &PoolCount)
        || !PendingModel.Capture(Model)) {
        CancelPendingUnlock();
        return;
    }
    // Wait for the UI model as well as the authoritative row: the native
    // action dispatch distinguishes zero progress using its updated status.
    const auto Decision = PendingUnlock.Poll(Model->SlotNumber, Expiration(Model),
        Model->PrizePool.Num() > 0 ? PoolCount : 0, GetTickCount64());
    if (Decision == SlayerLinkUnlockPoll::Waiting) { SetWaiting(Screen, Model, true); return; }
    SetWaiting(Screen, Model, false);
    if (Decision == SlayerLinkUnlockPoll::Resume) {
        MpLog("[SlayerLink] resuming queued native unlock, slot " + std::to_string(Model->SlotNumber));
        OriginalAction(Screen);
    } else MpLog("[SlayerLink] queued unlock canceled or timed out");
}

int RecoverMissingPool(uint8_t* Owner, const uint8_t* Rows) {
    using namespace Native112::SlayerLinkLayout;
    static SlayerLinkRecoveryPolicy Policy;
    __try {
        if (!IsReadablePointer(Owner, ActivationMarker + sizeof(int32_t)) || !IsReadablePointer(Rows, 16)) return 0;
        const auto* Data = *reinterpret_cast<const uint8_t* const*>(Rows);
        const int32_t Num = *reinterpret_cast<const int32_t*>(Rows + 8);
        const int32_t Max = *reinterpret_cast<const int32_t*>(Rows + 12);
        if (Num < 1 || Num > 3 || Max < Num || !IsReadablePointer(Data, static_cast<size_t>(Num) * RowStride)) return 0;
        const int32_t Marker = *reinterpret_cast<const int32_t*>(Owner + ActivationMarker);
        for (int32_t Index = 0; Index < Num; ++Index) {
            const uint8_t* Row = Data + static_cast<size_t>(Index) * RowStride;
            const int32_t Slot = *reinterpret_cast<const int32_t*>(Row + RowSlot);
            const int64_t End = *reinterpret_cast<const int64_t*>(Row + RowExpiration);
            const int32_t PoolCount = *reinterpret_cast<const int32_t*>(Row + RowPoolCount);
            if (!Policy.Request(reinterpret_cast<uintptr_t>(Owner), Slot, End, PoolCount, Marker, GetTickCount64())) continue;
            *reinterpret_cast<int32_t*>(Owner + ActivationMarker) = Slot;
            return Slot; // Remaining slots recover on subsequent native polls.
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) { }
    return 0;
}

bool PreparePoolArrivalRefresh(uint8_t* Owner, const uint8_t* Rows) {
    using namespace Native112::SlayerLinkLayout;
    __try {
        if (!IsReadablePointer(Owner, ActivationMarker + sizeof(int32_t)) || !IsReadablePointer(Rows, 16)) return false;
        const auto* Data = *reinterpret_cast<const uint8_t* const*>(Rows);
        const int32_t Num = *reinterpret_cast<const int32_t*>(Rows + 8);
        const int32_t Max = *reinterpret_cast<const int32_t*>(Rows + 12);
        if (Num < 1 || Num > 3 || Max < Num || !IsReadablePointer(Data, static_cast<size_t>(Num) * RowStride)) return false;
        const int32_t Marker = *reinterpret_cast<const int32_t*>(Owner + ActivationMarker);
        for (int32_t Index = 0; Index < Num; ++Index) {
            const auto* Row = Data + static_cast<size_t>(Index) * RowStride;
            int32_t ExistingCount = -1;
            if (!FindPool(reinterpret_cast<UArchonLinkedSlayers*>(Owner),
                *reinterpret_cast<const int32_t*>(Row + RowSlot),
                *reinterpret_cast<const int64_t*>(Row + RowExpiration), &ExistingCount)) continue;
            if (!SlayerLinkRecoveryPolicy::PoolArrived(ExistingCount,
                *reinterpret_cast<const int32_t*>(Row + RowPoolCount), Marker)) continue;
            // The native equality check at 0x01AF7CF0 omits the pool. Marker 0
            // bypasses that shortcut but matches no activation slot (1..3).
            *reinterpret_cast<int32_t*>(Owner + ActivationMarker) = 0;
            return true;
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) { }
    return false;
}

void FinishPoolArrivalRefresh(uint8_t* Owner) {
    __try {
        auto* Marker = reinterpret_cast<int32_t*>(Owner + Native112::SlayerLinkLayout::ActivationMarker);
        if (*Marker == 0) *Marker = -1;
    } __except (EXCEPTION_EXECUTE_HANDLER) { }
}

void DataReceivedHook(void* Owner, void* Rows) {
    const int Slot = RecoverMissingPool(static_cast<uint8_t*>(Owner), static_cast<const uint8_t*>(Rows));
    if (Slot) MpLog("[SlayerLink] recovering missing native prize pool for slot " + std::to_string(Slot));
    const bool PoolArrived = PreparePoolArrivalRefresh(static_cast<uint8_t*>(Owner), static_cast<const uint8_t*>(Rows));
    Original(Owner, Rows); // Native owns activation, generation, storage and UI.
    if (PoolArrived) {
        FinishPoolArrivalRefresh(static_cast<uint8_t*>(Owner));
        MpLog("[SlayerLink] refreshed native state after prize pool arrived");
    }
    ResumePendingUnlock(Owner);
}
}

void InstallSlayerLinkRecoveryHook() {
    const uint8_t WeakExpected[] = { 0x40, 0x53, 0x48, 0x83, 0xEC, 0x20, 0x48, 0x8B, 0xD9, 0x48, 0x85, 0xD2, 0x74, 0x1A };
    if (memcmp(reinterpret_cast<void*>(Native112::At(Globals::BaseAddress, Native112::MakeWeakObjectPtr)),
        WeakExpected, sizeof(WeakExpected)) != 0) {
        MpLog("[InitClientHooks] SlayerLinkRecovery skipped: weak-reference signature mismatch");
        return;
    }
    auto* Target = reinterpret_cast<uint8_t*>(Native112::At(Globals::BaseAddress, Native112::SlayerLinkDataReceived));
    const uint8_t Signature[] = {
        0x48, 0x89, 0x5C, 0x24, 0x18, 0x55, 0x56, 0x57, 0x41, 0x54, 0x41, 0x55, 0x41, 0x56, 0x41, 0x57,
        0x48, 0x8D, 0xAC, 0x24, 0xA0, 0xF9, 0xFF, 0xFF, 0x48, 0x81, 0xEC, 0x60, 0x07, 0x00, 0x00
    };
    if (memcmp(Target, Signature, sizeof(Signature)) != 0) {
        MpLog("[InitClientHooks] SlayerLinkRecovery skipped: executable signature mismatch");
        return;
    }
    const MH_STATUS Created = RUNTIME_CREATE_HOOK(Target, DataReceivedHook, reinterpret_cast<LPVOID*>(&Original));
    if (Created != MH_OK) return;
    const MH_STATUS Enabled = RuntimeHooks::Enable(Target);
    if (Enabled != MH_OK) { MH_RemoveHook(Target); Original = nullptr; }
    MpLog(std::string("[InitClientHooks] SlayerLinkRecovery enable=") + MH_StatusToString(Enabled));
    if (Enabled != MH_OK) return;

    auto* ActionTarget = reinterpret_cast<uint8_t*>(Native112::At(Globals::BaseAddress, Native112::SlayerLinkTryAction));
    const uint8_t ActionExpected[] = { 0x40, 0x53, 0x48, 0x81, 0xEC, 0x70, 0x01, 0x00, 0x00 };
    if (memcmp(ActionTarget, ActionExpected, sizeof(ActionExpected)) != 0) {
        MpLog("[InitClientHooks] SlayerLinkUnlock skipped: executable signature mismatch");
        return;
    }
    const MH_STATUS ActionCreated = RUNTIME_CREATE_HOOK(ActionTarget, TryActionHook, reinterpret_cast<LPVOID*>(&OriginalAction));
    if (ActionCreated != MH_OK) return;
    const MH_STATUS ActionEnabled = RuntimeHooks::Enable(ActionTarget);
    if (ActionEnabled != MH_OK) { MH_RemoveHook(ActionTarget); OriginalAction = nullptr; }
    MpLog(std::string("[InitClientHooks] SlayerLinkUnlock enable=") + MH_StatusToString(ActionEnabled));
}

void SlayerLinksBeforeEvent(UObject* Object, const std::string& FunctionName) {
    if (!PendingUnlock.Pending() || Object != PendingScreen.Get()) return;
    if (FunctionName.ends_with(".OnScreenHideBeginEvent") || FunctionName.ends_with(".ScreenHideEnd")
        || FunctionName.ends_with(".Destruct")) CancelPendingUnlock();
}
