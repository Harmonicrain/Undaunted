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
 * Hunt Pass selector. In October 2026 its client and world server parts moved to
 * client/PlayerRoleActivation.cpp and server/PlayerRoleRouting.cpp. Not an official release of
 * Mystic Paradox or Undaunted.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "core/PlayerRoles.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "diagnostics/PlayerRoleDiagnostics.h"

// Applying a loadout's player role to its pawn, on clients and world servers
// (UArchonLoadout's ApplyPlayerRole, hooked on both), and retrying while the
// role isn't on the pawn yet.

struct PendingPlayerRoleRetry {
    void* LoadoutPtr = nullptr;
    uint64_t FirstSeenInvalidMs = 0;
    uint64_t LastRetryMs = 0;
    int RetryCount = 0;
    bool InUse = false;
};

static void GetPlayerRoleAndSlot(void* LoadoutPtr, void** OutRole, void** OutSlot);
static bool IsPlayerRoleAppliedToPawn(void* LoadoutPtr, void** OutRole = nullptr, void** OutSlot = nullptr,
                                     void** OutPawn = nullptr, void** OutPawnRole = nullptr);
static void NotePlayerRoleValidity(void* LoadoutPtr, bool AppliedToPawn);

void* OrigApplyPlayerRole = nullptr;

static PlayerRoleAppliedFn g_PlayerRoleApplied = nullptr;

void SetPlayerRoleAppliedHandler(PlayerRoleAppliedFn Handler) {
    g_PlayerRoleApplied = Handler;
}

constexpr int kMaxPendingPlayerRoleRetries = 8;

constexpr uint64_t kPlayerRoleRetryIntervalMs = 1500;

static PendingPlayerRoleRetry s_pendingPlayerRoleRetries[kMaxPendingPlayerRoleRetries];

static void GetPlayerRoleAndSlot(void* LoadoutPtr, void** OutRole, void** OutSlot) {
    *OutRole = nullptr; *OutSlot = nullptr;
    if (!LoadoutPtr || !IsReadablePointer(LoadoutPtr, 0x40)) return;
    void* Inter = reinterpret_cast<void*(*)(void*)>(Native112::At(Globals::BaseAddress, Native112::LoadoutActiveSlotData))(LoadoutPtr);
    if (!Inter || !IsReadablePointer(Inter, 0x40)) return;
    *OutRole = reinterpret_cast<void*(*)(void*)>(Native112::At(Globals::BaseAddress, Native112::SlotDataPlayerRole))(Inter);
    *OutSlot = reinterpret_cast<void*(*)(void*)>(Native112::At(Globals::BaseAddress, Native112::SlotDataPlayerRoleItemSlot))(Inter);
}

static bool IsPlayerRoleAppliedToPawn(void* LoadoutPtr, void** OutRole , void** OutSlot ,
                                     void** OutPawn , void** OutPawnRole ) {
    void* Role = nullptr; void* Slot = nullptr;
    GetPlayerRoleAndSlot(LoadoutPtr, &Role, &Slot);

    void* PC = (LoadoutPtr && IsReadablePointer(LoadoutPtr, 0x638))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(LoadoutPtr) + 0x630) : nullptr;
    void* Pawn = (PC && IsReadablePointer(PC, 0x258))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(PC) + 0x250) : nullptr;
    void* PawnRole = (Pawn && IsReadablePointer(Pawn, 0x740))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Pawn) + 0x738) : nullptr;

    if (OutRole) *OutRole = Role;
    if (OutSlot) *OutSlot = Slot;
    if (OutPawn) *OutPawn = Pawn;
    if (OutPawnRole) *OutPawnRole = PawnRole;

    if (!Role || !Slot || !Pawn || !PawnRole) return false;
    const std::string InputId = CoreCapFString(
        reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Role) + 0x70));
    const std::string PawnId = CoreCapFString(
        reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(PawnRole) + 0x240));
    return !InputId.empty() && InputId == PawnId;
}

static void NotePlayerRoleValidity(void* LoadoutPtr, bool AppliedToPawn) {
    int FreeSlot = -1;
    for (int i = 0; i < kMaxPendingPlayerRoleRetries; ++i) {
        if (s_pendingPlayerRoleRetries[i].InUse && s_pendingPlayerRoleRetries[i].LoadoutPtr == LoadoutPtr) {
            if (AppliedToPawn) s_pendingPlayerRoleRetries[i] = PendingPlayerRoleRetry{};
            return;
        }
        if (FreeSlot < 0 && !s_pendingPlayerRoleRetries[i].InUse) FreeSlot = i;
    }
    if (AppliedToPawn || FreeSlot < 0) return;
    s_pendingPlayerRoleRetries[FreeSlot] = PendingPlayerRoleRetry{ LoadoutPtr, GetTickCount64(), 0, 0, true };
}

bool TryApplyPlayerRoleRetryGuarded(
    void* LoadoutPtr, void** OutRole, void** OutSlot, void** OutPawn, void** OutPawnRole,
    bool* OutAppliedBefore, bool* OutAppliedAfter)
{
    __try {
        *OutAppliedBefore = IsPlayerRoleAppliedToPawn(LoadoutPtr, OutRole, OutSlot, OutPawn, OutPawnRole);
        if (!*OutAppliedBefore && OrigApplyPlayerRole) {
            reinterpret_cast<void(*)(void*)>(OrigApplyPlayerRole)(LoadoutPtr);
        }
        *OutAppliedAfter = IsPlayerRoleAppliedToPawn(LoadoutPtr);
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

void TickPlayerRoleRetries() {
    uint64_t Now = GetTickCount64();
    for (int i = 0; i < kMaxPendingPlayerRoleRetries; ++i) {
        PendingPlayerRoleRetry& Entry = s_pendingPlayerRoleRetries[i];
        if (!Entry.InUse) continue;

        if (!IsReadablePointer(Entry.LoadoutPtr, 0x40) || Entry.RetryCount >= kMaxPlayerRoleRetryAttempts) {
            Entry = PendingPlayerRoleRetry{};
            continue;
        }
        if (Now - Entry.LastRetryMs < kPlayerRoleRetryIntervalMs) continue;

        if (!IsRegisteredLiveObject(Entry.LoadoutPtr)) {
            MpLog("[ApplyPlayerRole][RetryTimeout] loadout=" + MpPtr(Entry.LoadoutPtr)
                + " no longer a live registered object (owning world torn down, e.g. Ramsgate->Training"
                " travel) - discarding retry entry WITHOUT calling native code");
            Entry = PendingPlayerRoleRetry{};
            continue;
        }

        void* RoleBefore = nullptr; void* SlotBefore = nullptr;
        void* PawnBefore = nullptr; void* PawnRoleBefore = nullptr;
        bool AppliedBefore = false; bool AppliedAfter = false;
        const bool Survived = TryApplyPlayerRoleRetryGuarded(
            Entry.LoadoutPtr, &RoleBefore, &SlotBefore, &PawnBefore, &PawnRoleBefore,
            &AppliedBefore, &AppliedAfter);

        if (!Survived) {
            MpLog("[ApplyPlayerRole][RetryTimeout] loadout=" + MpPtr(Entry.LoadoutPtr)
                + " FAULTED re-running native apply (stale pointer, likely a level travel tore down"
                " the owning pawn/loadout) - caught, discarding retry entry instead of crashing");
            Entry = PendingPlayerRoleRetry{};
            continue;
        }

        if (AppliedBefore) {
            Entry = PendingPlayerRoleRetry{};
            continue;
        }

        Entry.LastRetryMs = Now;
        Entry.RetryCount++;
        MpLog("[ApplyPlayerRole][RetryTimeout] attempt=" + std::to_string(Entry.RetryCount)
            + " loadout=" + MpPtr(Entry.LoadoutPtr) + " elapsedMs=" + std::to_string(Now - Entry.FirstSeenInvalidMs)
            + " role=" + MpPtr(RoleBefore) + " slot=" + MpPtr(SlotBefore)
            + " pawn=" + MpPtr(PawnBefore) + " pawnRole=" + MpPtr(PawnRoleBefore)
            + " - re-running native apply");

        if (AppliedAfter) {
            MpLog("[ApplyPlayerRole][RetryTimeout] resolved after " + std::to_string(Entry.RetryCount)
                + " attempt(s), matching role is now installed on pawn loadout=" + MpPtr(Entry.LoadoutPtr));
            Entry = PendingPlayerRoleRetry{};
        }
    }
}

#pragma intrinsic(_ReturnAddress)
void ApplyPlayerRoleHook(void* a1) {

    uintptr_t Ret = reinterpret_cast<uintptr_t>(_ReturnAddress());
    uintptr_t RetRva = (Ret >= Globals::BaseAddress) ? (Ret - Globals::BaseAddress) : Ret;
    const char* Caller =
        (RetRva >= 0x01A664A0 && RetRva < 0x01A66900) ? "possession(0x01A664A0)" :
        (RetRva >= 0x01A4B6C0 && RetRva < 0x01A4B720) ? "apply-all(0x01A4B6C0)" :
        (RetRva >= 0x01A4B720 && RetRva < 0x01A4B790) ? "repfield-case8(0x01A4B720)" :
        (RetRva >= 0x01A72900 && RetRva < 0x01A72A80) ? "caller4(~0x01A729C3)" : "other";

    static std::atomic<int> s_aprSeq{ 0 };
    int Seq = s_aprSeq.fetch_add(1, std::memory_order_relaxed);

    void* Role = nullptr; void* Slot = nullptr;
    GetPlayerRoleAndSlot(a1, &Role, &Slot);
    std::string Name = (a1 && IsReadablePointer(a1, 0x40)) ? reinterpret_cast<UObject*>(a1)->GetName() : std::string("?");

    MpLog("[ApplyPlayerRole #" + std::to_string(Seq) + "] ENTER this=" + MpPtr(a1) + "/" + Name
        + " caller=" + Caller + " retRva=+" + MpHex(RetRva)
        + " PlayerRole=" + (Role ? "Valid" : "INVALID") + "(" + MpPtr(Role) + ")"
        + " Slot=" + (Slot ? "Valid" : "INVALID") + "(" + MpPtr(Slot) + ")");

    reinterpret_cast<void(*)(void*)>(OrigApplyPlayerRole)(a1);

    std::string InputRoleId = CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Role) + 0x70));
    std::string InputRoleInstance = CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Role) + 0x88));
    void* SlotCachedItem = (Slot && IsReadablePointer(Slot, 0xC0))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Slot) + 0xB8) : nullptr;
    std::string SlotCachedId = SlotCachedItem
        ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(SlotCachedItem) + 0x70)) : std::string();

    void* PC = (a1 && IsReadablePointer(a1, 0x638))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(a1) + 0x630) : nullptr;
    void* Pawn = (PC && IsReadablePointer(PC, 0x258))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(PC) + 0x250) : nullptr;
    void* PawnRole = (Pawn && IsReadablePointer(Pawn, 0x740))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Pawn) + 0x738) : nullptr;
    void* PlayerState = (Pawn && IsReadablePointer(Pawn, 0x248))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Pawn) + 0x240) : nullptr;
    std::string PlayerStateRoleId = (PlayerState && IsReadablePointer(PlayerState, 0x648))
        ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(PlayerState) + 0x638))
        : std::string();
    std::string PawnRoleId = PawnRole
        ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(PawnRole) + 0x240)) : std::string();
    std::string PawnRoleInstance = PawnRole
        ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(PawnRole) + 0x250)) : std::string();
    int Equipped = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x2F4) : -1;
    int EquippedGameplay = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x2F5) : -1;
    int ActiveGameplay = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x2F6) : -1;
    int BpEquipCalled = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x2F7) : -1;
    int RoleActorFlags58 = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x58) : -1;
    int RoleActorFlags59 = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x59) : -1;
    int RoleActorFlags5B = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x5B) : -1;
    int RoleActorRole = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0xF0) : -1;
    int RoleActorRemoteRole = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x5F) : -1;
    void* RoleActorOwner = (PawnRole && IsReadablePointer(PawnRole, 0xE8))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(PawnRole) + 0xE0) : nullptr;
    const bool AppliedToPawn = Role && Slot && Pawn && PawnRole
        && !InputRoleId.empty() && InputRoleId == PawnRoleId;
    NotePlayerRoleValidity(a1, AppliedToPawn);
    if (AppliedToPawn) {
        if (g_PlayerRoleApplied) g_PlayerRoleApplied(PawnRole);
    }
    const std::string RoleCharge = PlayerRoleChargeSummary(PawnRole);
    MpLog("[PlayerRoleState #" + std::to_string(Seq) + "] inputId=" + InputRoleId
        + " inputInstance=" + InputRoleInstance + " slotCached=" + MpPtr(SlotCachedItem)
        + "/" + SlotCachedId + " pc=" + MpPtr(PC) + " pawn=" + MpPtr(Pawn)
        + " playerState=" + MpPtr(PlayerState) + " playerStateRoleId=" + PlayerStateRoleId
        + " pawnRole=" + MpPtr(PawnRole) + " pawnRoleId=" + PawnRoleId
        + " pawnRoleInstance=" + PawnRoleInstance + " equipped=" + std::to_string(Equipped)
        + " gameplayEquipped=" + std::to_string(EquippedGameplay)
        + " activeGameplay=" + std::to_string(ActiveGameplay)
        + " bpEquipCalled=" + std::to_string(BpEquipCalled)
        + " roleActorOwner=" + MpPtr(RoleActorOwner)
        + " netFlags58=" + std::to_string(RoleActorFlags58)
        + " netFlags59=" + std::to_string(RoleActorFlags59)
        + " netFlags5B=" + std::to_string(RoleActorFlags5B)
        + " role=" + std::to_string(RoleActorRole)
        + " remoteRole=" + std::to_string(RoleActorRemoteRole)
        + " charge={" + RoleCharge + "}"
        + " modifiers={" + PlayerRoleModifierSummary(PawnRole) + "}"
        + " appliedToPawn=" + std::to_string(AppliedToPawn ? 1 : 0));

    MpLog("[ApplyPlayerRole #" + std::to_string(Seq) + "] EXIT  this=" + MpPtr(a1) + "/" + Name + " caller=" + Caller);
}
