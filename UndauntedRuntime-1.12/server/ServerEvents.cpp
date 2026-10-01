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
 * Hunt Pass selector. In October 2026 the hook was split into per-function
 * handlers chosen once per function, and one-off investigation logging was
 * removed. Not an official release of Mystic Paradox or Undaunted.
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
#include "core/Logging.h"
#include "core/Memory.h"
#include "core/Settings.h"
#include "diagnostics/EscalationTrace.h"
#include "diagnostics/HangTrace.h"
#include "diagnostics/ScriptProfile.h"
#include "server/Bleedout.h"
#include "server/Combat.h"
#include "server/WeeklyChallenges.h"
#include "server/WorldState.h"
#include <unordered_map>

// Every UObject::ProcessEvent call on a world server comes through here: the
// game's Blueprint and RPC calls, thousands a frame. What to do for a function
// is decided once from its full name and cached, so most calls cost a lookup.

void* OrigProcessEvent = nullptr;

namespace {
using ProcessEventFn = void(*)(UObject*, UFunction*, void*);

void CallOriginal(UObject* Object, UFunction* Function, void* Parms) {
    reinterpret_cast<ProcessEventFn>(OrigProcessEvent)(Object, Function, Parms);
}

enum class ServerEvent : uint8_t {
    None,
    PostLogin,                        // logged with the game mode's state
    VendorCamera,                     // absorbed (see HandleVendorCamera)
    ClientRestart,                    // the restarted pawn replicates to its owner
    PlayerCanRestart,                 // answered true after preparing the connection
    TryActivateAbility,               // activated through the runtime first
    TryActivateAbilityWithEventData,
};

// -UndauntedDiag=items: logs item grants and consumption.
enum class ItemEvent : uint8_t { None, GrantAndConsume, ServerConsume, InventoryConsume, Consume };

struct FunctionInfo {
    // The function's FName and outer when this was built, to notice freed
    // memory reused for another function.
    int32_t NameIndex = 0;
    uint32_t NameNumber = 0;
    void* Outer = nullptr;
    std::string Name;
    ServerEvent Event = ServerEvent::None;
    ItemEvent Item = ItemEvent::None;
    const char* Bleedout = nullptr;
    bool K2PostLogin = false;
};

void Classify(FunctionInfo& Info) {
    const std::string& Name = Info.Name;
    auto Has = [&](const char* Part) { return Name.find(Part) != std::string::npos; };
    Info.Event = ServerEvent::None;
    Info.Item = ItemEvent::None;
    Info.K2PostLogin = Has("K2_PostLogin");
    if (Has("PostLogin")) Info.Event = ServerEvent::PostLogin;
    else if (Has("vendor_interactive_bp_C.UpdateCameraForAspect")) Info.Event = ServerEvent::VendorCamera;
    else if (Name == "Function Engine.PlayerController.ClientRestart"
        || Name == "Function Engine.PlayerController.ClientRetryClientRestart") Info.Event = ServerEvent::ClientRestart;
    else if (Name == "Function Engine.GameModeBase.PlayerCanRestart") Info.Event = ServerEvent::PlayerCanRestart;
    else if (Name == "Function GameplayAbilities.AbilitySystemComponent.ServerTryActivateAbilityWithEventData")
        Info.Event = ServerEvent::TryActivateAbilityWithEventData;
    else if (Name == "Function GameplayAbilities.AbilitySystemComponent.ServerTryActivateAbility")
        Info.Event = ServerEvent::TryActivateAbility;
    if (Has("GrantAndConsumeItemsWithQuantity")) Info.Item = ItemEvent::GrantAndConsume;
    else if (Has("ServerConsumeItem")) Info.Item = ItemEvent::ServerConsume;
    else if (Has("InventoryConsumeItem")) Info.Item = ItemEvent::InventoryConsume;
    else if (Has("ConsumeItem")) Info.Item = ItemEvent::Consume;
    Info.Bleedout = BleedoutEventName(Name);
}

// GetFullName rebuilds the path from FName strings on every call (~9% of a
// two-player hunting ground's game thread, profile 2026-10-01), so each
// thread keeps what it has worked out per function.
const FunctionInfo& InfoFor(UFunction* Function) {
    static const FunctionInfo Null = [] { FunctionInfo Info; Info.Name = "null"; return Info; }();
    if (!Function) return Null;
    thread_local std::unordered_map<UFunction*, FunctionInfo> Cache;
    FunctionInfo& Info = Cache[Function];
    if (Info.Name.empty() || Info.NameIndex != Function->Name.ComparisonIndex
        || Info.NameNumber != Function->Name.Number || Info.Outer != Function->Outer) {
        Info.NameIndex = Function->Name.ComparisonIndex;
        Info.NameNumber = Function->Name.Number;
        Info.Outer = Function->Outer;
        Info.Name = Function->GetFullName();
        Classify(Info);
    }
    return Info;
}

// ClientRestart logs are limited per player login.
std::atomic<int> g_RestartLogsLeft{ 8 };

void HandlePostLogin(UObject* Object, const FunctionInfo& Info, void* Parms) {
    static std::atomic<int> Sequence{ 0 };
    const int Seq = Sequence.fetch_add(1, std::memory_order_relaxed);
    std::string Extra;
    if (Parms && Info.K2PostLogin) {
        void* NewPlayer = *reinterpret_cast<void**>(Parms);
        Extra = " newPlayer=" + MpPtr(NewPlayer) + "/" + SafeObjectNameForDiagnostic(NewPlayer);
        g_RestartLogsLeft.store(8, std::memory_order_relaxed);
    }
    MpLog("[PostLoginPE #" + std::to_string(Seq) + "] fn=" + Info.Name
        + " obj=" + MpPtr(Object) + "/" + SafeObjectNameForDiagnostic(Object) + Extra);
    LogArchonLifecycle(("PostLoginPE#" + std::to_string(Seq)).c_str());
}

// The vendor's camera Blueprint divides by the screen aspect ratio, which is
// 0/0 on a server without a screen.
void HandleVendorCamera() {
    static std::atomic<int> Count{ 0 };
    const int Slot = Count.fetch_add(1, std::memory_order_relaxed);
    if (Slot < 3 || (Slot % 60) == 0) {
        MpLog("[VendorFix] Absorbed UpdateCameraForAspect on server (slot=" + std::to_string(Slot)
            + ") - avoids GetCurrentScreenAspectRatio 0/0");
    }
}

// The restarted pawn replicates at least 60 times a second with priority 3,
// isn't dormant and is the owning client's autonomous proxy; the connection
// views it, so it is relevant to its own player.
void HandleClientRestart(UObject* Object, void* Parms) {
    if (!Parms || !IsReadablePointer(Parms, 0x8)) return;
    UObject* Pawn = *reinterpret_cast<UObject**>(Parms);
    if (Pawn && IsReadablePointer(Pawn, 0x120)) {
        const uintptr_t P = reinterpret_cast<uintptr_t>(Pawn);
        *reinterpret_cast<uint8_t*>(P + 0xF1) = 0;                       // NetDormancy: awake
        float* Frequency = reinterpret_cast<float*>(P + 0x108);          // NetUpdateFrequency
        float* Priority = reinterpret_cast<float*>(P + 0x110);           // NetPriority
        if (*Frequency < 60.0f) *Frequency = 60.0f;
        if (*Priority < 3.0f) *Priority = 3.0f;
        *reinterpret_cast<uint8_t*>(P + 0x5F) = 2;                       // RemoteRole: autonomous proxy
    }
    if (Pawn && Object && IsReadablePointer(Object, 0x420)) {
        void* Connection = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Object) + 0x418);
        if (Connection && IsReadablePointer(Connection, 0x98)) {
            void** ViewTarget = reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Connection) + 0x90);
            if (*ViewTarget != Pawn) *ViewTarget = Pawn;
        }
    }
    if (g_RestartLogsLeft.fetch_sub(1, std::memory_order_relaxed) > 0) {
        MpLog("[ClientRestart] pc=" + MpPtr(Object) + "/" + SafeObjectNameForDiagnostic(Object)
            + " pawn=" + MpPtr(Pawn) + "/" + SafeObjectNameForDiagnostic(Pawn) + " replicates to its owner");
    }
}

bool SafeSetClientWorldPackageName(void* Connection, uint64_t PackageName) {
    using SetFn = void(__fastcall*)(void*, uint64_t);
    __try {
        reinterpret_cast<SetFn>(Native112::At(Globals::BaseAddress, Native112::SetClientWorldPackageName))(Connection, PackageName);
        return true;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

// A player may always restart. Before answering, the player's connection gets
// the world's package name (UNetConnection::SetClientWorldPackageName with the
// player's outermost outer) and views the player's pawn, or the player.
void HandlePlayerCanRestart(void* Parms) {
    UObject* Player = *reinterpret_cast<UObject**>(Parms);

    UObject* Connection = nullptr;
    if (Player && IsReadablePointer(Player, 0x420)) {
        UObject* NetConnection = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(Player) + 0x418);
        UObject* Other = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(Player) + 0x298);
        if (NetConnection) {
            Connection = NetConnection;
        } else if (Other && IsReadablePointer(Other, 0x20)) {
            UObject* Class = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(Other) + 0x10);
            const std::string ClassName = Class && IsReadablePointer(Class, 0x20) ? Class->GetName() : std::string();
            if (ClassName.find("Connection") != std::string::npos && ClassName.find("local_player") == std::string::npos) {
                Connection = Other;
            }
        }
    }

    uint64_t PackageName = 0;
    if (Player) {
        UObject* Top = Player;
        for (int Hops = 0; Hops < 8 && IsReadablePointer(Top, 0x28); ++Hops) {
            UObject* Next = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(Top) + 0x20);
            if (!Next) break;
            Top = Next;
        }
        if (Top && IsReadablePointer(Top, 0x20)) PackageName = *reinterpret_cast<uint64_t*>(reinterpret_cast<uintptr_t>(Top) + 0x18);
    }
    bool PackageSet = false;
    if (Connection && PackageName != 0 && IsReadablePointer(Connection, 0x1608)) {
        PackageSet = SafeSetClientWorldPackageName(Connection, PackageName);
    }

    // Until 2026-10-01 this ran only for a world's first five calls (it sat
    // inside a log budget); every hunt island and Ramsgate's first joins had it.
    if (Connection && IsReadablePointer(Connection, 0xA0)) {
        UObject* Owning = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(Connection) + 0x98);
        UObject* View = Owning;
        if (Owning && IsReadablePointer(Owning, 0x258)) {
            if (UObject* Pawn = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(Owning) + 0x250)) View = Pawn;
        }
        *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(Connection) + 0x90) = View;
    }

    const bool Before = *reinterpret_cast<bool*>(reinterpret_cast<uintptr_t>(Parms) + 0x8);
    *reinterpret_cast<bool*>(reinterpret_cast<uintptr_t>(Parms) + 0x8) = true;

    static std::atomic<int> Logged{ 0 };
    if (Logged.fetch_add(1, std::memory_order_relaxed) < 5) {
        MpLog("[PlayerCanRestart] player=" + MpPtr(Player) + " connection=" + MpPtr(Connection)
            + " worldPackageSet=" + std::to_string(PackageSet ? 1 : 0)
            + " answer " + std::to_string(Before ? 1 : 0) + " -> 1");
    }
}

std::string QuantityArray(void* ArrayBase) {
    if (!IsReadablePointer(ArrayBase, 0x0C)) return "[?]";
    void* Data = *reinterpret_cast<void**>(ArrayBase);
    int32_t Num = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(ArrayBase) + 0x8);
    if (!Data || Num < 0 || Num > 256) return "[?]";
    std::string Out = "[";
    for (int i = 0; i < Num; ++i) {
        uintptr_t Elem = reinterpret_cast<uintptr_t>(Data) + static_cast<uintptr_t>(i) * 0x18;
        if (!IsReadablePointer(reinterpret_cast<void*>(Elem), 0x14)) { Out += (i ? ", ?" : "?"); continue; }
        if (i) Out += ", ";
        Out += CoreCapFString(reinterpret_cast<void*>(Elem)) + " x" + std::to_string(*reinterpret_cast<int32_t*>(Elem + 0x10));
    }
    return Out + "]";
}

int32_t ReadInt(void* Parms, uintptr_t Offset, int32_t Fallback) {
    void* At = reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Parms) + Offset);
    return IsReadablePointer(At, 4) ? *reinterpret_cast<int32_t*>(At) : Fallback;
}

void LogItemEvent(ItemEvent Item, UObject* Object, void* Parms) {
    static const bool Enabled = Settings::Diag(L"items");
    if (!Enabled || !Parms) return;
    const uintptr_t P = reinterpret_cast<uintptr_t>(Parms);
    switch (Item) {
    case ItemEvent::GrantAndConsume:
        MpLog("[CORE-CAP] GrantAndConsumeItemsWithQuantity obj=" + MpPtr(Object)
            + " grant=" + QuantityArray(Parms)
            + " consume=" + QuantityArray(reinterpret_cast<void*>(P + 0x10))
            + " source=" + CoreCapFString(reinterpret_cast<void*>(P + 0x20)));
        break;
    case ItemEvent::ServerConsume:
        MpLog("[CORE-CAP] ServerConsumeItem instanceId=" + CoreCapFString(Parms)
            + " amount=" + std::to_string(ReadInt(Parms, 0x10, 0))
            + " source=" + CoreCapFString(reinterpret_cast<void*>(P + 0x18)));
        break;
    case ItemEvent::InventoryConsume:
        MpLog("[CORE-CAP] InventoryConsumeItem itemIndex=" + std::to_string(ReadInt(Parms, 0, -1))
            + " amount=" + std::to_string(ReadInt(Parms, 0x04, 0)));
        break;
    case ItemEvent::Consume: {
        void* ItemObject = *reinterpret_cast<void**>(Parms);
        const std::string InstanceId = IsReadablePointer(ItemObject, 0x98)
            ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(ItemObject) + 0x88)) : std::string("?");
        MpLog("[CORE-CAP] ConsumeItem item=" + MpPtr(ItemObject) + " instanceId=" + InstanceId
            + " amount=" + std::to_string(ReadInt(Parms, 0x08, 0))
            + " source=" + CoreCapFString(reinterpret_cast<void*>(P + 0x10)));
        break;
    }
    case ItemEvent::None:
        break;
    }
}
}

void ProcessEventHook(UObject* Object, UFunction* Function, void* Parms) {
    // A Blueprint calling itself without end would overflow the stack; past 32
    // nested calls on a thread, a call is dropped (logged once per thread).
    thread_local int Depth = 0;
    struct DepthGuard { DepthGuard() { ++Depth; } ~DepthGuard() { --Depth; } } Guard;
    ScriptProfileEventScope ProfileScope(Function);
    if (Depth > 32) {
        thread_local bool Reported = false;
        if (!Reported) {
            Reported = true;
            MpLog("[ProcessEventHook] REENTRANCY-GUARD tripped (depth=" + std::to_string(Depth) + ") - ABSORBING call. fn="
                + (Function ? Function->GetFullName() : std::string("null"))
                + " obj=" + (Object ? Object->GetFullName() : std::string("null")));
        }
        return;
    }

    const FunctionInfo& Info = InfoFor(Function);
    NoteGameThreadEvent(Function, Object, Info.Name);
    if (Object && Object->IsA(UBountyComponent_Weekly::StaticClass()))
        PatchWeeklyChallengeTable(static_cast<UBountyComponent_Weekly*>(Object));
    if (Info.Bleedout) NoteBleedoutEvent(Info.Bleedout, Object);
    if (Info.Item != ItemEvent::None) LogItemEvent(Info.Item, Object, Parms);
    const int EscalationSeq = TraceEscalationFlowEnter("Server", Object, Info.Name, Parms);

    switch (Info.Event) {
    case ServerEvent::PostLogin:
        HandlePostLogin(Object, Info, Parms);
        break;
    case ServerEvent::VendorCamera:
        HandleVendorCamera();
        return;
    case ServerEvent::ClientRestart:
        HandleClientRestart(Object, Parms);
        break;
    case ServerEvent::PlayerCanRestart:
        if (Parms && IsReadablePointer(Parms, 0x10)) {
            HandlePlayerCanRestart(Parms);
            return;
        }
        break;
    case ServerEvent::TryActivateAbilityWithEventData: {
        auto* Params = static_cast<Params::AbilitySystemComponent_ServerTryActivateAbilityWithEventData*>(Parms);
        ServerTryActivateAbilityInternal(static_cast<UAbilitySystemComponent*>(Object), Params->AbilityToActivate,
            Params->InputPressed, Params->PredictionKey, &Params->TriggerEventData);
        break;
    }
    case ServerEvent::TryActivateAbility: {
        auto* Params = static_cast<Params::AbilitySystemComponent_ServerTryActivateAbility*>(Parms);
        ServerTryActivateAbilityInternal(static_cast<UAbilitySystemComponent*>(Object), Params->AbilityToActivate,
            Params->InputPressed, Params->PredictionKey, nullptr);
        break;
    }
    case ServerEvent::None:
        break;
    }

    CallOriginal(Object, Function, Parms);
    TraceEscalationFlowExit("Server", EscalationSeq, Object, Info.Name, Parms);
}
