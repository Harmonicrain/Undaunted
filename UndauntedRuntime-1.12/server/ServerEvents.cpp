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

#include "server/ServerEvents.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "client/Challenges.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "diagnostics/RuntimeDiagnostics.h"
#include "server/Combat.h"
#include "server/Replication.h"
#include "server/WorldLifecycle.h"
#include <unordered_map>

static bool SafeSetClientWorldPackageName(void* NetConn, uint64_t FNameValue);

void* OrigProcessEvent = nullptr;

static bool SafeSetClientWorldPackageName(void* NetConn, uint64_t FNameValue) {
    using SetCWPNFn = void(__fastcall*)(void*, uint64_t);
    auto SetCWPN = reinterpret_cast<SetCWPNFn>(Native112::At(Globals::BaseAddress, Native112::Rva_03D64090));
    __try {
        SetCWPN(NetConn, FNameValue);
        return true;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

// GetFullName rebuilds the path from FName strings on every call: ~9% of a
// two-player hunting ground's game thread (profile 2026-10-01). A function's
// path doesn't change, so each thread keeps the names it has built, checked
// against the function's FName and outer in case freed memory is reused.
static const std::string& CachedFunctionName(UFunction* Function) {
    static const std::string Null = "null";
    if (!Function) return Null;
    struct Entry { int32_t NameIndex = 0; uint32_t NameNumber = 0; void* Outer = nullptr; std::string Name; };
    thread_local std::unordered_map<UFunction*, Entry> Cache;
    Entry& Cached = Cache[Function];
    if (Cached.Name.empty() || Cached.NameIndex != Function->Name.ComparisonIndex
        || Cached.NameNumber != Function->Name.Number || Cached.Outer != Function->Outer) {
        Cached.NameIndex = Function->Name.ComparisonIndex;
        Cached.NameNumber = Function->Name.Number;
        Cached.Outer = Function->Outer;
        Cached.Name = Function->GetFullName();
    }
    return Cached.Name;
}

void ProcessEventHook(UObject* Object, UFunction* Function, void* Parms) {

    static thread_local int s_processEventDepth = 0;
    static thread_local UFunction* s_peStack[64] = {};
    struct DepthGuard {
        DepthGuard(UFunction* f)  { if (s_processEventDepth >= 0 && s_processEventDepth < 64) s_peStack[s_processEventDepth] = f; ++s_processEventDepth; }
        ~DepthGuard() { --s_processEventDepth; }
    } g_depthGuard(Function);

    if (s_processEventDepth > 32) {
        static thread_local bool s_reportedRecursion = false;
        if (!s_reportedRecursion) {
            s_reportedRecursion = true;
            std::string FunctionName = Function ? Function->GetFullName() : "null";
            std::string ObjectName = Object ? Object->GetFullName() : "null";
            MpLog("[ProcessEventHook] REENTRANCY-GUARD tripped (depth="
                + std::to_string(s_processEventDepth) + ") — ABSORBING call. "
                + "fn=" + FunctionName + " obj=" + ObjectName);
        }
        return;
    }

    static UFunction* ServerTryActivateAbilityWithEventData = nullptr;
    static UFunction* ServerTryActivateAbility = nullptr;
    static UFunction* OnAirshipUpdated = nullptr;
    static UFunction* OnPostMitDealtAnyDamage = nullptr;

    const std::string& FunctionName = CachedFunctionName(Function);
    if (Globals::AmServer && Object && Object->IsA(UBountyComponent_Weekly::StaticClass()))
        PatchWeeklyChallengeTable(static_cast<UBountyComponent_Weekly*>(Object));
    const int EscalationFlowServerSeq = TraceEscalationFlowEnter(
        "Server", Object, FunctionName, Parms);

    int WeaponXpServerGrantSeq = -1;
    Params::PlayerExperienceComponent_GrantWeaponExperience* WeaponXpServerGrant = nullptr;
    if (Function && Parms
        && FunctionName.find("PlayerExperienceComponent.HandleBehemothKilled") != std::string::npos
        && IsReadablePointer(Parms, sizeof(Params::PlayerExperienceComponent_HandleBehemothKilled))) {
        static std::atomic<int> s_weaponXpServerKillCount{ 0 };
        int Seq = s_weaponXpServerKillCount.fetch_add(1, std::memory_order_relaxed);
        if (Seq < 128) {
            auto* KillParms = reinterpret_cast<Params::PlayerExperienceComponent_HandleBehemothKilled*>(Parms);
            void* Behemoth = KillParms->Behemoth;
            void* ThreatComponent = (Behemoth && IsReadablePointer(Behemoth, 0x67C))
                ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Behemoth) + 0x5E8) : nullptr;
            int32_t ContentLevel = (ThreatComponent && IsReadablePointer(ThreatComponent, 0x10C))
                ? *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(ThreatComponent) + 0x108) : -1;
            float GlobalPower = (Behemoth && IsReadablePointer(Behemoth, 0x67C))
                ? *reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(Behemoth) + 0x678) : -1.0f;
            MpLog("[WeaponXP][ServerKill] seq=" + std::to_string(Seq)
                + " component=" + MpPtr(Object) + "/" + SafeObjectNameForDiagnostic(Object)
                + " behemoth=" + MpPtr(Behemoth) + "/" + SafeObjectNameForDiagnostic(Behemoth)
                + " threat=" + MpPtr(ThreatComponent)
                + " contentLevel=" + std::to_string(ContentLevel)
                + " globalPower=" + std::to_string(GlobalPower));
        }
    }

    if (Function && Parms
        && FunctionName.find("PlayerExperienceComponent.GrantWeaponExperience") != std::string::npos
        && IsReadablePointer(Parms, sizeof(Params::PlayerExperienceComponent_GrantWeaponExperience))) {
        static std::atomic<int> s_weaponXpServerGrantCount{ 0 };
        WeaponXpServerGrantSeq = s_weaponXpServerGrantCount.fetch_add(1, std::memory_order_relaxed);
        if (WeaponXpServerGrantSeq < 256) {
            WeaponXpServerGrant = reinterpret_cast<Params::PlayerExperienceComponent_GrantWeaponExperience*>(Parms);
            MpLog("[WeaponXP][ServerGrant] ENTER seq=" + std::to_string(WeaponXpServerGrantSeq)
                + " component=" + MpPtr(Object) + "/" + SafeObjectNameForDiagnostic(Object)
                + " type=" + std::to_string(static_cast<int>(WeaponXpServerGrant->WeaponXPType))
                + " base=" + std::to_string(WeaponXpServerGrant->BaseAmount)
                + " bonus=" + std::to_string(WeaponXpServerGrant->BonusAmount));
        }
    }

    if (Function && Parms
        && FunctionName.find("PlayerExperienceComponent.GrantPlayerExperience") != std::string::npos
        && IsReadablePointer(Parms, sizeof(Params::PlayerExperienceComponent_GrantPlayerExperience))) {
        static std::atomic<int> s_playerXpServerGrantCount{ 0 };
        int Seq = s_playerXpServerGrantCount.fetch_add(1, std::memory_order_relaxed);
        if (Seq < 256) {
            auto* PlayerGrant = reinterpret_cast<Params::PlayerExperienceComponent_GrantPlayerExperience*>(Parms);
            MpLog("[WeaponXP][ServerPlayerGrant] ENTER seq=" + std::to_string(Seq)
                + " component=" + MpPtr(Object) + "/" + SafeObjectNameForDiagnostic(Object)
                + " amount=" + std::to_string(PlayerGrant->Amount));
        }
    }

    int TempestPerfectDodgeServerSeq = -1;
    if (Function && FunctionName.find("PerfectDodge") != std::string::npos) {
        static std::atomic<int> s_tempestPerfectDodgeServerCount{ 0 };
        TempestPerfectDodgeServerSeq = s_tempestPerfectDodgeServerCount.fetch_add(1, std::memory_order_relaxed);
        if (TempestPerfectDodgeServerSeq < 64) {
            MpLog("[TempestPerfectDodge][Server] ENTER seq=" + std::to_string(TempestPerfectDodgeServerSeq)
                + " fn=" + FunctionName + " obj=" + MpPtr(Object) + "/"
                + SafeObjectNameForDiagnostic(Object));
        }
    }

    BleedoutNoteEvent(FunctionName, Object);

    {
        uint32_t gt = g_wdGameThreadId.load(std::memory_order_relaxed);
        if (gt == 0 || GetCurrentThreadId() == gt) {
            g_gtPeCurFunc.store(Function, std::memory_order_relaxed);
            g_gtPeCurObj.store(Object, std::memory_order_relaxed);
            if (VerboseDiag()) {
                uint32_t p = g_gtPeRingPos.fetch_add(1, std::memory_order_relaxed) % kPeRing;
                strncpy_s(g_gtPeNameRing[p], sizeof(g_gtPeNameRing[p]), FunctionName.c_str(), _TRUNCATE);
            }
        }
    }

    if (Function && Parms && CoreCaptureEnabled()) {
        auto DumpQtyArray = [](void* arrBase) -> std::string {

            if (!IsReadablePointer(arrBase, 0x0C)) return "[?]";
            void* Data = *reinterpret_cast<void**>(arrBase);
            int32_t Num = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(arrBase) + 0x8);
            if (!Data || Num < 0 || Num > 256) return "[?]";
            std::string Out = "[";
            for (int i = 0; i < Num; ++i) {
                uintptr_t Elem = reinterpret_cast<uintptr_t>(Data) + static_cast<uintptr_t>(i) * 0x18;
                if (!IsReadablePointer(reinterpret_cast<void*>(Elem), 0x14)) { Out += (i ? ", ?" : "?"); continue; }
                std::string Item = CoreCapFString(reinterpret_cast<void*>(Elem));
                int32_t Amt = *reinterpret_cast<int32_t*>(Elem + 0x10);
                if (i) Out += ", ";
                Out += Item + " x" + std::to_string(Amt);
            }
            return Out + "]";
        };

        if (FunctionName.find("GrantAndConsumeItemsWithQuantity") != std::string::npos) {

            MpLog("[CORE-CAP] GrantAndConsumeItemsWithQuantity obj=" + MpPtr(Object)
                + " grant=" + DumpQtyArray(Parms)
                + " consume=" + DumpQtyArray(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Parms) + 0x10))
                + " source=" + CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Parms) + 0x20)));
        }
        else if (FunctionName.find("ServerConsumeItem") != std::string::npos) {

            int32_t Amt = IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Parms) + 0x10), 4) ? *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(Parms) + 0x10) : 0;
            MpLog("[CORE-CAP] ServerConsumeItem instanceId=" + CoreCapFString(Parms)
                + " amount=" + std::to_string(Amt)
                + " source=" + CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Parms) + 0x18)));
        }
        else if (FunctionName.find("InventoryConsumeItem") != std::string::npos) {

            int32_t Idx = IsReadablePointer(Parms, 4) ? *reinterpret_cast<int32_t*>(Parms) : -1;
            int32_t Amt = IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Parms) + 0x04), 4) ? *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(Parms) + 0x04) : 0;
            MpLog("[CORE-CAP] InventoryConsumeItem itemIndex=" + std::to_string(Idx) + " amount=" + std::to_string(Amt));
        }
        else if (FunctionName.find("ConsumeItem") != std::string::npos) {

            void* Item = *reinterpret_cast<void**>(Parms);
            int32_t Amt = IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Parms) + 0x08), 4) ? *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(Parms) + 0x08) : 0;
            std::string InstId = IsReadablePointer(Item, 0x98) ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Item) + 0x88)) : std::string("?");
            MpLog("[CORE-CAP] ConsumeItem item=" + MpPtr(Item) + " instanceId=" + InstId
                + " amount=" + std::to_string(Amt)
                + " source=" + CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Parms) + 0x10)));
        }
    }

    {
        static std::atomic<bool> s_postLoginAnchor{ false };
        if (Function && FunctionName.find("K2_PostLogin") != std::string::npos) {
            bool expected = false;
            if (s_postLoginAnchor.compare_exchange_strong(expected, true)) {
                g_postLoginTimeMs.store(GetTickCount64(), std::memory_order_relaxed);
            }
        }
    }

    if (Function && FunctionName.find("PostLogin") != std::string::npos) {
        static std::atomic<int> s_plSeq{ 0 };
        int Seq = s_plSeq.fetch_add(1, std::memory_order_relaxed);
        std::string ObjName = (Object && IsReadablePointer(Object, 0x40)) ? Object->GetName() : std::string("?");
        std::string Extra;
        if (Parms && FunctionName.find("K2_PostLogin") != std::string::npos) {
            void* NewPlayer = *reinterpret_cast<void**>(Parms);
            std::string PcName = (NewPlayer && IsReadablePointer(NewPlayer, 0x40)) ? reinterpret_cast<UObject*>(NewPlayer)->GetName() : std::string("?");
            Extra = " newPlayer=" + MpPtr(NewPlayer) + "/" + PcName;

            g_pawnDiagCount.store(0, std::memory_order_relaxed);
        }
        MpLog("[PostLoginPE #" + std::to_string(Seq) + "] fn=" + FunctionName
            + " obj=" + MpPtr(Object) + "/" + ObjName + Extra);
        LogArchonLifecycle(("PostLoginPE#" + std::to_string(Seq)).c_str());
    }

    void* AckCapturePc = nullptr;
    void* AckPawnBefore = nullptr;
    if (Function &&
        (FunctionName.find("AcknowledgePossession") != std::string::npos
            || FunctionName.find("CheckClientPossession") != std::string::npos
            || FunctionName.find("AcknowledgePawn") != std::string::npos)) {
        std::string PossObjName = (Object && IsReadablePointer(Object, 0x420)) ? Object->GetName() : std::string("?");
        void* pawnParam = (Parms && FunctionName.find("AcknowledgePossession") != std::string::npos) ? *reinterpret_cast<void**>(Parms) : nullptr;
        void* pcPawn = nullptr; void* ackPawn = nullptr; void* netConn = nullptr;
        if (Object && IsReadablePointer(Object, 0x420)) {
            uintptr_t Pc = reinterpret_cast<uintptr_t>(Object);
            pcPawn  = *reinterpret_cast<void**>(Pc + 0x250);
            ackPawn = *reinterpret_cast<void**>(Pc + 0x2A0);
            netConn = *reinterpret_cast<void**>(Pc + 0x418);
            if (FunctionName.find("AcknowledgePossession") != std::string::npos) { AckCapturePc = Object; AckPawnBefore = ackPawn; }
        }
        MpLog("[PossessionRPC] fn=" + FunctionName + " pc=" + MpPtr(Object) + "/" + PossObjName
            + " netConn=" + MpPtr(netConn)
            + " pawnParam=" + MpPtr(pawnParam)
            + " PC.Pawn=" + MpPtr(pcPawn)
            + " AcknowledgedPawn(before)=" + MpPtr(ackPawn));
    }

    if (Function && FunctionName.find("vendor_interactive_bp_C.UpdateCameraForAspect")
        != std::string::npos)
    {
        static std::atomic<int> s_vendorAbsorbCount{0};
        int slot = s_vendorAbsorbCount.fetch_add(1, std::memory_order_relaxed);
        if (slot < 3 || (slot % 60) == 0) {
            MpLog("[VendorFix] Absorbed UpdateCameraForAspect on server (slot="
                + std::to_string(slot) + ") — avoids GetCurrentScreenAspectRatio 0/0");
        }
        return;
    }

    if (Function && (FunctionName == "Function Engine.PlayerController.ClientRestart"
                     || FunctionName == "Function Engine.PlayerController.ClientRetryClientRestart")) {
        const int PAWN_DIAG_BUDGET = 8;
        int slot = g_pawnDiagCount.fetch_add(1, std::memory_order_relaxed);
        if (Parms && IsReadablePointer(Parms, 0x8)) {
            UObject* PawnObj = *reinterpret_cast<UObject**>(Parms);

            bool     patchApplied = false;
            uint8_t  before_58 = 0, after_58 = 0;
            uint8_t  before_dorm = 0xFF, after_dorm = 0xFF;
            float    before_freq = 0.0f, after_freq = 0.0f;
            float    before_prio = 0.0f, after_prio = 0.0f;
            uint8_t  before_remoteRole = 0xFF, after_remoteRole = 0xFF;
            if (PawnObj && IsReadablePointer(PawnObj, 0x120)) {
                uint8_t* byte58 = reinterpret_cast<uint8_t*>(reinterpret_cast<uintptr_t>(PawnObj) + 0x58);
                uint8_t* byteDorm = reinterpret_cast<uint8_t*>(reinterpret_cast<uintptr_t>(PawnObj) + 0xF1);
                float*   fFreq   = reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(PawnObj) + 0x108);
                float*   fPrio   = reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(PawnObj) + 0x110);

                uint8_t* byteRemoteRole = reinterpret_cast<uint8_t*>(reinterpret_cast<uintptr_t>(PawnObj) + 0x5F);
                before_58 = *byte58;
                before_dorm = *byteDorm;
                before_freq = *fFreq;
                before_prio = *fPrio;
                before_remoteRole = *byteRemoteRole;

                if (!OwnerPawnRelevancyFix()) {
                    *byte58 = *byte58 | 0x08;
                }
                *byteDorm = 0;
                if (*fFreq < 60.0f) *fFreq = 60.0f;
                if (*fPrio < 3.0f)  *fPrio = 3.0f;
                *byteRemoteRole = 2;
                after_58 = *byte58;
                after_dorm = *byteDorm;
                after_freq = *fFreq;
                after_prio = *fPrio;
                after_remoteRole = *byteRemoteRole;
                patchApplied = true;
            }

            if (OwnerPawnRelevancyFix() && PawnObj && Object && IsReadablePointer(Object, 0x420)) {
                void* netConn = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Object) + 0x418);
                if (netConn && IsReadablePointer(netConn, 0x98)) {
                    void** connViewTarget = reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(netConn) + 0x90);
                    if (*connViewTarget != reinterpret_cast<void*>(PawnObj)) {
                        static std::atomic<int> s_vtLog{ 0 };
                        if (s_vtLog.fetch_add(1, std::memory_order_relaxed) < 8)
                            MpLog("[OwnerPawnRelevancy] conn=" + MpPtr(netConn) + " ViewTarget "
                                + MpPtr(*connViewTarget) + " -> pawn " + MpPtr(PawnObj) + " (per-connection relevancy)");
                        *connViewTarget = reinterpret_cast<void*>(PawnObj);
                    }
                }
            }

            if (slot < PAWN_DIAG_BUDGET) {
                std::string pClass = "(null-pawn)";
                std::string pFullName = "(null-pawn)";
                uint8_t     pReplicatesByte = 0;
                uint8_t     pRemoteRole = 0xFF;
                uint8_t     pRole = 0xFF;
                UObject*    pOwner = nullptr;
                std::string pOwnerClass = "(none)";
                std::string pOwnerName = "(none)";

                if (PawnObj && IsReadablePointer(PawnObj, 0x110)) {
                    pFullName = PawnObj->GetFullName();
                    UObject* Cls = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(PawnObj) + 0x10);
                    if (Cls && IsReadablePointer(Cls, 0x20)) pClass = Cls->GetName();
                    pReplicatesByte = *reinterpret_cast<uint8_t*>(reinterpret_cast<uintptr_t>(PawnObj) + 0x5B);
                    pRemoteRole = *reinterpret_cast<uint8_t*>(reinterpret_cast<uintptr_t>(PawnObj) + 0x5F);
                    pRole = *reinterpret_cast<uint8_t*>(reinterpret_cast<uintptr_t>(PawnObj) + 0xF0);
                    pOwner = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(PawnObj) + 0xE0);
                    if (pOwner && IsReadablePointer(pOwner, 0x20)) {
                        pOwnerName = pOwner->GetFullName();
                        UObject* OwnerCls = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(pOwner) + 0x10);
                        if (OwnerCls && IsReadablePointer(OwnerCls, 0x20)) pOwnerClass = OwnerCls->GetName();
                    }
                }

                void* pcPawn = nullptr;
                if (Object && IsReadablePointer(Object, 0x258)) {
                    pcPawn = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Object) + 0x250);
                }

                bool bReplicates = (pReplicatesByte & 0x01) != 0;
                const char* remoteRoleName =
                    pRemoteRole == 0 ? "None" : pRemoteRole == 1 ? "SimulatedProxy" :
                    pRemoteRole == 2 ? "AutonomousProxy" : pRemoteRole == 3 ? "Authority" : "?";
                const char* roleName =
                    pRole == 0 ? "None" : pRole == 1 ? "SimulatedProxy" :
                    pRole == 2 ? "AutonomousProxy" : pRole == 3 ? "Authority" : "?";

                MpLog("[PAWN #" + std::to_string(slot) + "] fn=" + FunctionName
                    + " pawn=" + MpPtr(PawnObj) + "/" + pClass
                    + " pcPawn(+0x250)=" + MpPtr(pcPawn)
                    + " match=" + std::to_string(pcPawn == PawnObj ? 1 : 0));
                MpLog("[PAWN #" + std::to_string(slot) + "] pawnFullName=" + pFullName);
                MpLog("[PAWN #" + std::to_string(slot) + "] bReplicates=" + std::to_string(bReplicates ? 1 : 0)
                    + " Role=" + std::string(roleName) + "(" + std::to_string(pRole) + ")"
                    + " RemoteRole=" + std::string(remoteRoleName) + "(" + std::to_string(pRemoteRole) + ")");
                MpLog("[PAWN #" + std::to_string(slot) + "] owner=" + MpPtr(pOwner) + "/" + pOwnerClass
                    + " ownerName=" + pOwnerName);
                MpLog("[PAWN #" + std::to_string(slot) + "] FORCE-REP patch applied=" + std::to_string(patchApplied ? 1 : 0)
                    + "  +0x58 before=0x" + std::to_string(before_58) + " after=0x" + std::to_string(after_58)
                    + " (bAlwaysRelevant bit3 mask 0x08)"
                    + "  NetDormancy before=" + std::to_string(before_dorm) + " after=" + std::to_string(after_dorm)
                    + "  NetUpdateFreq before=" + std::to_string(before_freq) + " after=" + std::to_string(after_freq)
                    + "  NetPriority before=" + std::to_string(before_prio) + " after=" + std::to_string(after_prio)
                    + "  RemoteRole before=" + std::to_string(before_remoteRole) + " after=" + std::to_string(after_remoteRole)
                    + " (2=AutonomousProxy)");
            }
        }
    }

    static UFunction* CachedMustSpectate = nullptr;
    if ((CachedMustSpectate && Function == CachedMustSpectate) ||
        (!CachedMustSpectate && Function && FunctionName == "Function Engine.GameModeBase.MustSpectate")) {
        CachedMustSpectate = Function;
        if (Parms && IsReadablePointer(Parms, 0x10)) {
            UObject* PlayerObj = *reinterpret_cast<UObject**>(Parms);
            bool Ret = *reinterpret_cast<bool*>(reinterpret_cast<uintptr_t>(Parms) + 0x8);
            static std::atomic<int> s_msLog{0};
            if (s_msLog.fetch_add(1, std::memory_order_relaxed) < 20)
                MpLog("[MustSpectate] ret=" + std::to_string(Ret ? 1 : 0)
                    + " player=" + (PlayerObj ? PlayerObj->GetFullName() : "null"));
        }
    }

    static UFunction* CachedPlayerCanRestart = nullptr;
    if ((CachedPlayerCanRestart && Function == CachedPlayerCanRestart) ||
        (!CachedPlayerCanRestart && Function && FunctionName == "Function Engine.GameModeBase.PlayerCanRestart")) {
        CachedPlayerCanRestart = Function;

        if (Parms && IsReadablePointer(Parms, 0x10)) {
            UObject* PlayerObj = *reinterpret_cast<UObject**>(Parms);
            bool     PriorRet  = *reinterpret_cast<bool*>(reinterpret_cast<uintptr_t>(Parms) + 0x8);

            static std::atomic<int> s_diagLogCount{0};
            const int LOG_BUDGET = 5;

            UObject* ConnFrom298 = nullptr;
            UObject* ConnFrom418 = nullptr;
            std::string Class298 = "(none)";
            std::string Class418 = "(none)";

            if (PlayerObj && IsReadablePointer(PlayerObj, 0x420)) {
                ConnFrom298 = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(PlayerObj) + 0x298);
                ConnFrom418 = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(PlayerObj) + 0x418);

                if (ConnFrom298 && IsReadablePointer(ConnFrom298, 0x20)) {
                    UObject* ClsObj = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(ConnFrom298) + 0x10);
                    if (ClsObj && IsReadablePointer(ClsObj, 0x20)) Class298 = ClsObj->GetName();
                }
                if (ConnFrom418 && IsReadablePointer(ConnFrom418, 0x20)) {
                    UObject* ClsObj = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(ConnFrom418) + 0x10);
                    if (ClsObj && IsReadablePointer(ClsObj, 0x20)) Class418 = ClsObj->GetName();
                }
            }

            UObject* NetConnObj = nullptr;
            std::string NetConnClass = "(none)";
            std::string ConnSource = "none";
            if (ConnFrom418) {

                NetConnObj = ConnFrom418;
                NetConnClass = Class418;
                ConnSource = "+0x418";
            }
            else if (ConnFrom298
                     && Class298.find("Connection") != std::string::npos
                     && Class298.find("local_player") == std::string::npos) {

                NetConnObj = ConnFrom298;
                NetConnClass = Class298;
                ConnSource = "+0x298";
            }

            std::string OuterChain;
            uint64_t WorldOutermostFName = 0;
            UObject* TopOuter = nullptr;
            if (PlayerObj) {
                UObject* Cur = PlayerObj;
                TopOuter = Cur;
                for (int hops = 0; hops < 8; ++hops) {
                    if (!IsReadablePointer(Cur, 0x28)) break;
                    if (!OuterChain.empty()) OuterChain += " -> ";
                    OuterChain += Cur->GetFullName();
                    UObject* Nxt = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(Cur) + 0x20);
                    if (!Nxt) break;
                    TopOuter = Nxt;
                    Cur = Nxt;
                }
                if (TopOuter && IsReadablePointer(TopOuter, 0x20)) {
                    WorldOutermostFName = *reinterpret_cast<uint64_t*>(reinterpret_cast<uintptr_t>(TopOuter) + 0x18);
                }
            }

            uint64_t ConnBeforeFName = 0;
            uint64_t ConnAfterFName  = 0;
            bool     SetterInvoked   = false;
            if (NetConnObj && IsReadablePointer(NetConnObj, 0x1608)) {
                ConnBeforeFName = *reinterpret_cast<uint64_t*>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x1600);
                if (WorldOutermostFName != 0) {
                    SetterInvoked = SafeSetClientWorldPackageName(NetConnObj, WorldOutermostFName);
                    ConnAfterFName = *reinterpret_cast<uint64_t*>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x1600);
                }
            }

            int slot = s_diagLogCount.fetch_add(1, std::memory_order_relaxed);
            if (slot < LOG_BUDGET) {
                MpLog("[CWPN #" + std::to_string(slot) + "] object=" + (Object ? Object->GetFullName() : std::string("null"))
                    + " player=" + MpPtr(PlayerObj)
                    + " conn+0x298=" + MpPtr(ConnFrom298) + "/" + Class298
                    + " conn+0x418=" + MpPtr(ConnFrom418) + "/" + Class418
                    + " chosen=" + ConnSource + "/" + NetConnClass);
                MpLog("[CWPN #" + std::to_string(slot) + "] outerChain: " + OuterChain);
                MpLog("[CWPN #" + std::to_string(slot) + "] topFName=" + std::to_string(WorldOutermostFName)
                    + " conn+0x1600 before=" + std::to_string(ConnBeforeFName)
                    + " setterInvoked=" + std::to_string(SetterInvoked ? 1 : 0)
                    + " conn+0x1600 after=" + std::to_string(ConnAfterFName));

                if (NetConnObj && IsReadablePointer(NetConnObj, 0xA0)) {
                    UObject* connPC   = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x30);
                    UObject* connDrv  = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x58);
                    UObject* viewTgt  = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x90);
                    UObject* owning   = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x98);
                    int32_t  chNum    = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x78);
                    std::string connPCName  = (connPC  && IsReadablePointer(connPC,  0x20)) ? connPC->GetFullName()  : std::string("(null-or-unreadable)");
                    std::string viewTgtName = (viewTgt && IsReadablePointer(viewTgt, 0x20)) ? viewTgt->GetFullName() : std::string("(null-or-unreadable)");
                    std::string owningName  = (owning  && IsReadablePointer(owning,  0x20)) ? owning->GetFullName()  : std::string("(null-or-unreadable)");
                    MpLog("[CWPN #" + std::to_string(slot) + "] CONN STATE:"
                        + " PC(+0x30)=" + MpPtr(connPC) + "/" + connPCName);
                    MpLog("[CWPN #" + std::to_string(slot) + "] CONN STATE:"
                        + " OwningActor(+0x98)=" + MpPtr(owning) + "/" + owningName);
                    MpLog("[CWPN #" + std::to_string(slot) + "] CONN STATE:"
                        + " ViewTarget(+0x90)=" + MpPtr(viewTgt) + "/" + viewTgtName
                        + "  Driver(+0x58)=" + MpPtr(connDrv)
                        + "  OpenChannels.Num(+0x78)=" + std::to_string(chNum));

                    if (IsReadablePointer(NetConnObj, 0x1D8)) {
                        int32_t sockState = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x134);
                        double  lastRecv  = *reinterpret_cast<double*>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x1D0);
                        const char* stateName =
                            sockState == 0 ? "Invalid" :
                            sockState == 1 ? "Closed" :
                            sockState == 2 ? "Pending" :
                            sockState == 3 ? "Open" : "?";

                        float   drvTime   = 0.0f;
                        UObject* repDriver = nullptr;
                        std::string repDriverClass = "(none)";
                        UObject* repDriver6F0 = nullptr;
                        std::string repDriver6F0Class = "(none)";
                        if (connDrv && IsReadablePointer(connDrv, 0x6F8)) {
                            drvTime = *reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(connDrv) + 0x210);
                            repDriver = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(connDrv) + 0x6E8);
                            if (repDriver && IsReadablePointer(repDriver, 0x20)) {
                                UObject* rdCls = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(repDriver) + 0x10);
                                if (rdCls && IsReadablePointer(rdCls, 0x20)) repDriverClass = rdCls->GetName();
                            }

                            repDriver6F0 = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(connDrv) + 0x6F0);
                            repDriver6F0Class = "";
                        }
                        double delta = static_cast<double>(drvTime) - lastRecv;

                        std::string scanReport = "(disabled — see 1.12.0 fix note)";
                        MpLog("[CWPN #" + std::to_string(slot) + "] Driver-wider: " + scanReport);

                        MpLog("[CWPN #" + std::to_string(slot) + "] CONN STATE:"
                            + " State(+0x134)=" + std::string(stateName) + "(" + std::to_string(sockState) + ")"
                            + "  LastReceiveTime(+0x1D0)=" + std::to_string(lastRecv)
                            + "  Driver->Time(+0x210)=" + std::to_string(drvTime)
                            + "  delta=" + std::to_string(delta)
                            + "  freshOK=" + std::to_string(delta < 1.5 ? 1 : 0));
                        MpLog("[CWPN #" + std::to_string(slot) + "] CONN STATE:"
                            + " Driver->@+0x6E8=" + MpPtr(repDriver) + "/" + repDriverClass
                            + "  Driver->@+0x6F0=" + MpPtr(repDriver6F0) + "/" + repDriver6F0Class);
                    }

                    MpLog("[CWPN #" + std::to_string(slot) + "] pc_match_check: interceptPC=" + MpPtr(PlayerObj)
                        + "  connPC=" + MpPtr(connPC)
                        + "  same=" + std::to_string(PlayerObj == connPC ? 1 : 0));

                    if (connDrv && IsReadablePointer(connDrv, 0x10)) {
                        void** driverVtable = *reinterpret_cast<void***>(connDrv);
                        if (driverVtable && IsReadablePointer(driverVtable, 0x400)) {
                            auto rva = [](void* p) -> uint64_t {
                                if (!p) return 0;
                                uintptr_t rvaVal = reinterpret_cast<uintptr_t>(p) - Globals::BaseAddress;
                                return rvaVal;
                            };
                            void* slot2a8 = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(driverVtable) + 0x2A8);
                            void* slot320 = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(driverVtable) + 0x320);
                            void* slot328 = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(driverVtable) + 0x328);
                            void* slot330 = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(driverVtable) + 0x330);
                            void* slot378 = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(driverVtable) + 0x378);

                            char buf[512];
                            _snprintf_s(buf, _TRUNCATE,
                                "[CWPN #%d] VTABLE dump (Driver->vtable=%p): "
                                "+0x2a8=RVA_0x%llX  +0x320=RVA_0x%llX  +0x328=RVA_0x%llX  +0x330=RVA_0x%llX  +0x378=RVA_0x%llX",
                                slot, driverVtable, rva(slot2a8), rva(slot320), rva(slot328), rva(slot330), rva(slot378));
                            MpLog(buf);
                        }
                    }
                }

                if (NetConnObj && IsReadablePointer(NetConnObj, 0xA0)) {
                    UObject* owning = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x98);
                    UObject* preferView = owning;

                    if (owning && IsReadablePointer(owning, 0x258)) {
                        UObject* pcPawn = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(owning) + 0x250);
                        if (pcPawn) preferView = pcPawn;
                    }
                    UObject* viewBefore = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x90);
                    *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x90) = preferView;
                    UObject* viewAfter = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x90);
                    if (slot < LOG_BUDGET) {
                        MpLog("[CWPN #" + std::to_string(slot) + "] FORCE-VIEWTARGET write:"
                            + " viewBefore=" + MpPtr(viewBefore)
                            + " forced=" + MpPtr(preferView)
                            + " viewAfter=" + MpPtr(viewAfter)
                            + " (owning=" + MpPtr(owning) + ")");
                    }

                    void* dbgDriver = nullptr;
                    if (NetConnObj && IsReadablePointer(NetConnObj, 0x60)) {
                        dbgDriver = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x58);
                    }
                    if (slot < LOG_BUDGET && dbgDriver && IsReadablePointer(dbgDriver, 0x800)) {

                    }
                }
            }

            if (DiagNaturalMode()) {
                static std::atomic<int> s_pcrNat{ 0 };
                if (s_pcrNat.fetch_add(1, std::memory_order_relaxed) < 5)
                    MpLog("[Diag] PlayerCanRestart NOT forced (natural mode) priorRet=" + std::to_string(PriorRet ? 1 : 0));
                reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEvent)(Object, Function, Parms);
                return;
            }

            *reinterpret_cast<bool*>(reinterpret_cast<uintptr_t>(Parms) + 0x8) = true;

            static bool s_loggedPCR = false;
            if (!s_loggedPCR) {
                s_loggedPCR = true;
                MpLog("[PlayerCanRestart] first-intercept — player=" + MpPtr(PlayerObj)
                    + " priorRet=" + std::to_string(PriorRet ? 1 : 0)
                    + " forcedRet=1");
            }
            return;
        }
    }

    if (Function == ServerTryActivateAbilityWithEventData || (!ServerTryActivateAbilityWithEventData && FunctionName.contains("ServerTryActivateAbilityWithEventData"))) {
        ServerTryActivateAbilityWithEventData = Function;

        Params::AbilitySystemComponent_ServerTryActivateAbilityWithEventData* ActivateAbilityParams = (Params::AbilitySystemComponent_ServerTryActivateAbilityWithEventData*)Parms;

        ServerTryActivateAbilityInternal((UAbilitySystemComponent*)Object, ActivateAbilityParams->AbilityToActivate, ActivateAbilityParams->InputPressed, ActivateAbilityParams->PredictionKey, &ActivateAbilityParams->TriggerEventData);
    }
    else if (Function == ServerTryActivateAbility || (!ServerTryActivateAbility && FunctionName.contains("ServerTryActivateAbility"))) {
        ServerTryActivateAbility = Function;

        Params::AbilitySystemComponent_ServerTryActivateAbility* ActivateAbilityParams = (Params::AbilitySystemComponent_ServerTryActivateAbility*)Parms;

        ServerTryActivateAbilityInternal((UAbilitySystemComponent*)Object, ActivateAbilityParams->AbilityToActivate, ActivateAbilityParams->InputPressed, ActivateAbilityParams->PredictionKey, nullptr);
    }

    reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEvent)(Object, Function, Parms);

    if (WeaponXpServerGrant && WeaponXpServerGrantSeq >= 0 && WeaponXpServerGrantSeq < 256) {
        MpLog("[WeaponXP][ServerGrant] EXIT seq=" + std::to_string(WeaponXpServerGrantSeq)
            + " returned=" + std::to_string(WeaponXpServerGrant->ReturnValue ? 1 : 0)
            + " type=" + std::to_string(static_cast<int>(WeaponXpServerGrant->WeaponXPType))
            + " base=" + std::to_string(WeaponXpServerGrant->BaseAmount)
            + " bonus=" + std::to_string(WeaponXpServerGrant->BonusAmount));
    }

    TraceEscalationFlowExit("Server", EscalationFlowServerSeq, Object, FunctionName, Parms);

    if (TempestPerfectDodgeServerSeq >= 0 && TempestPerfectDodgeServerSeq < 64) {
        MpLog("[TempestPerfectDodge][Server] EXIT seq=" + std::to_string(TempestPerfectDodgeServerSeq)
            + " fn=" + FunctionName);
    }

    if (AckCapturePc && IsReadablePointer(AckCapturePc, 0x420)) {
        uintptr_t Pc = reinterpret_cast<uintptr_t>(AckCapturePc);
        void* ackAfter = *reinterpret_cast<void**>(Pc + 0x2A0);
        void* pcPawn   = *reinterpret_cast<void**>(Pc + 0x250);
        MpLog("[PossessionRPC] AFTER pc=" + MpPtr(AckCapturePc)
            + " AcknowledgedPawn=" + MpPtr(ackAfter) + " (before=" + MpPtr(AckPawnBefore) + ")"
            + " PC.Pawn=" + MpPtr(pcPawn)
            + " stuck=" + std::to_string((ackAfter != nullptr && ackAfter == pcPawn) ? 1 : 0));
    }
}
