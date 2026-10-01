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
 * Hunt Pass selector. In October 2026 every hook is installed through one
 * helper, and the hooks and patches that did nothing were removed. Not an
 * official release of Mystic Paradox or Undaunted.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "server/ServerHooks.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "native/CodePatch.h"
#include "core/Features.h"
#include "core/LoadingGate.h"
#include "core/RuntimeHooks.h"
#include "core/Logging.h"
#include "core/PlayerRoles.h"
#include "server/PlayerRoleRouting.h"
#include "core/Settings.h"
#include "core/Transport.h"
#include "diagnostics/ExitTrace.h"
#include "server/Bleedout.h"
#include "server/FrameWait.h"
#include "server/PlayerData.h"
#include "server/RenderData.h"
#include "server/Replication.h"
#include "server/ServerEvents.h"
#include "server/ServerTick.h"
#include "server/TickFilter.h"
#include "server/WidgetGuards.h"
#include "server/WorldLifecycle.h"

namespace {
// Engine startup sets GIsClient and GIsServer for a client and only lets a
// listen-capable world listen; these rewrite that code for a world server.
// The player role slot patch is described with its address.
void InstallServerRolePatches() {
    PatchStoreImmediate("GIsClient store 1 -> 0", Native112::GIsClientStoreOne, Native112::GIsClient, 0x01, 0x00);
    PatchStoreImmediate("GIsServer store 0 -> 1", Native112::GIsServerStoreZero, Native112::GIsServer, 0x00, 0x01);
    PatchStoreR12ToZero("GIsClient store r12b -> 0", Native112::GIsClientStoreR12, Native112::GIsClient);
    RemoveStoreAl("GIsClient store al removed", Native112::GIsClientStoreAl, Native112::GIsClient);
    RemoveStoreAl("GIsServer store al removed", Native112::GIsServerStoreAl, Native112::GIsServer);
    PatchCallToTrue("InitListen gate -> true", Native112::InitListenGateCall, Native112::InitListenGate);
    static const uint8_t SortArrayLoad[] = { 0x48, 0x8B, 0x30, 0x48, 0x63, 0x40, 0x08 };   // mov rsi, [rax]; movsxd rax, [rax+8]
    static const uint8_t EmptyArray[] = { 0x33, 0xF6, 0x33, 0xC0, 0x90, 0x90, 0x90 };      // xor esi, esi; xor eax, eax; nop x3
    PatchBytes("player role slot sort skipped", Native112::PlayerRoleSlotSortArray, SortArrayLoad, EmptyArray, sizeof(EmptyArray));
}
}

void InitServerHooks() {
    MH_Initialize();
    InstallExitTraceHooks();

    RUNTIME_INSTALL_HOOK(Native112::ProcessEvent, ProcessEventHook, &OrigProcessEvent);
    InstallFeatureFlagHook("InitServerHooks");
    InstallScheduleHook("InitServerHooks");
    InstallServerWebBrowserSkip();
    InstallServerFrameWait();
    InstallServerTickFilter();

    // World lifecycle and players.
    RUNTIME_INSTALL_HOOK(Native112::GameEngineTick, GameEngineTickHook, &OrigGameEngineTick);
    RUNTIME_INSTALL_HOOK(Native112::GetGameDefaultMap, GetGameDefaultMap, &OrigGetDefaultMap);
    RUNTIME_INSTALL_HOOK(Native112::FCommandLineGet, GetCommandLineHook, &OrigGetCommandLine);
    RUNTIME_INSTALL_HOOK(Native112::OnPlayerDataLoadComplete, OnPlayerDataLoadCompleteHook, &OrigOnPlayerDataLoadComplete);
    RUNTIME_INSTALL_HOOK(Native112::GameplaySchedulerInitialize, SchedulerInitializeHook, &OrigSchedulerInitialize);
    RUNTIME_INSTALL_HOOK(Native112::ApplyPlayerRole, ApplyPlayerRoleHook, &OrigApplyPlayerRole);
    SetPlayerRoleAppliedHandler(OnServerPlayerRoleApplied);
    RUNTIME_INSTALL_HOOK(Native112::HasFinishedLoading, HasFinishedLoadingHook, &OrigHasFinishedLoading);
    RUNTIME_INSTALL_HOOK(Native112::GetStartSpot, GetStartSpotHook, &OrigGetStartSpot);
    RUNTIME_INSTALL_HOOK(Native112::FatalErrorHandler, ServerBootCrash, &OrigServerBootCrash);
    RUNTIME_INSTALL_HOOK(Native112::ArchonLoadManagerLoadFailed, ArchonLoadManagerLoadFailedHook, &OrigArchonLoadManagerLoadFailed);
    RUNTIME_INSTALL_HOOK(Native112::InteractionCalloutHideHoldText, InteractionCalloutHideHoldTextHook, &OrigInteractionCalloutHideHoldText);
    RUNTIME_INSTALL_HOOK(Native112::LoadingScreenFadeIn, ArchonLoadingScreenFadeInHook, &OrigArchonLoadingScreenFadeIn);
    if (Settings::Diag(L"bleedout")) RUNTIME_INSTALL_HOOK(Native112::Knockout, KnockoutHook, &OrigKnockout);

    // Backend traffic.
    RUNTIME_INSTALL_HOOK(Native112::HttpRequestProcessRequest, ProcessRequest, &OrigProcessRequest);
    InstallSetUrlRedirectHook("server");

    // Networking: answered as a dedicated server, and replication.
    RUNTIME_INSTALL_HOOK(Native112::GetNetMode, NetModeHook, &OrigNetModeHook);
    RUNTIME_INSTALL_HOOK(Native112::InternalGetNetMode, NetModeHook, &OrigInternalNetModeHook);
    RUNTIME_INSTALL_HOOK(Native112::WorldGetNetMode, NetModeHook, &OrigWorldNetModeHook);
    RUNTIME_INSTALL_HOOK(Native112::IsNetReady, IsNetReadyHook, &OrigIsNetReady);
    RUNTIME_INSTALL_HOOK(Native112::NetDriverTickDispatchInner, NetDriverTickDispatchInnerHook, &OrigNetDriverTickDispatchInner);
    RUNTIME_INSTALL_HOOK(Native112::NotifyClientDisconnected, NotifyClientDisconnectedHook, &OrigNotifyClientDisconnected);
    RUNTIME_INSTALL_HOOK(Native112::SetReplicationDriver, SetReplicationDriverHook, &OrigSetReplicationDriver);
    RUNTIME_INSTALL_HOOK(Native112::ServerReplicateActors, ServerReplicateActorsHook, &OrigServerReplicateActors);
    RUNTIME_INSTALL_HOOK(Native112::RepGraphReplicateSingleActor, RepGraphReplicateSingleActorGuardHook, &OrigRepGraphReplicateSingleActor);
    RUNTIME_INSTALL_HOOK(Native112::ActorChannelReplicateActor, ReplicateActorFreqHook, &OrigReplicateActorFreq);
    g_RepDriverEnableFlag = reinterpret_cast<uint32_t*>(Native112::At(Globals::BaseAddress, Native112::RepDriverEnableFlag));
    g_RepGraphFeatureArrayData = reinterpret_cast<void**>(Native112::At(Globals::BaseAddress, Native112::RepGraphFeatureArray));
    g_RepGraphFeatureArrayNum = reinterpret_cast<int*>(Native112::At(Globals::BaseAddress, Native112::RepGraphFeatureArray) + 8);
    RUNTIME_INSTALL_HOOK(Native112::CreateReplicationDriver, CreateRepDriverHook, &OrigCreateRepDriver);

    InstallServerRolePatches();
}
