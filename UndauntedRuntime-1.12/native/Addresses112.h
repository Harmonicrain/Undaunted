
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

#pragma once
#include <cstdint>

// Dauntless 1.12.0 CL392819 only. RVAs refer to the shipping executable.
namespace Native112 {
    inline uintptr_t At(uintptr_t Base, uintptr_t Rva) { return Base + Rva; }
    // UArchonLinkedSlayers link-row callback: verified by .pdata range,
    // 0x68-byte rows, activation marker +0x148 and native activation broadcast.
    inline constexpr uintptr_t SlayerLinkDataReceived = 0x01B413F0;
    // LinkedSlayerScreen.OnActionButtonClicked -> native status dispatch;
    // Finished calls grant, FinishedWithoutProgress deletes without a grant.
    inline constexpr uintptr_t SlayerLinkTryAction = 0x01FBFA20;
    // FWeakObjectPtr assignment: reads UObject.Index (+0xC), allocates its
    // FUObjectItem serial, writes {index, serial}. Verified at this RVA.
    inline constexpr uintptr_t MakeWeakObjectPtr = 0x026B90B0;
    // ClientGetCurrentSpeedUpTokensHook
    inline constexpr uintptr_t InventoryGetItemQuantity = 0x01A03B60;
    // InitClientHooks, InitServerHooks
    inline constexpr uintptr_t ApplyPlayerRole = 0x01A4B790;
    // InitClientHooks, InitServerHooks
    inline constexpr uintptr_t HasFinishedLoading = 0x01A60BC0;
    // Server widget guard / client random loading art. CL392819 native
    // ArchonLoadingScreen::ScreenFadeIn, verified switcher fields +0x3E0,
    // normal image +0x388; prologue 48 89 5C 24 10 57 48 83 EC 70.
    inline constexpr uintptr_t LoadingScreenFadeIn = 0x01CADE20;
    // InitClientHooks, InitServerHooks
    inline constexpr uintptr_t ProcessEvent = 0x026A9890;

    // Engine globals (data). World servers pin GIsClient/GIsServer to server
    // values; GErrorHist holds the fatal error text.
    inline constexpr uintptr_t GIsClient = 0x06B53259;
    inline constexpr uintptr_t GIsServer = 0x06B5325A;
    inline constexpr uintptr_t GErrorHist = 0x06B53C44;
    inline constexpr uintptr_t GEngine = 0x06CFBF60;
    inline constexpr uintptr_t GWorld = 0x06D001B8;
    // The range LogHungGameThread treats as the executable's code when it scans
    // a stack for return addresses.
    inline constexpr uintptr_t CodeStart = 0x00001000;
    inline constexpr uintptr_t CodeEnd = 0x04E00000;

    // Engine startup code that sets GIsClient and GIsServer for a client,
    // rewritten on world servers after checking each instruction (see
    // InstallServerRolePatches): mov byte [GIsClient], 1 and mov byte
    // [GIsServer], 0, then mov [GIsClient], r12b, and two mov [..], al stores
    // in another function; plus the call that decides whether a world may listen.
    inline constexpr uintptr_t GIsClientStoreOne = 0x009E934A;
    inline constexpr uintptr_t GIsServerStoreZero = 0x009E94FB;
    inline constexpr uintptr_t GIsClientStoreR12 = 0x009E9507;
    inline constexpr uintptr_t GIsClientStoreAl = 0x009E4FD4;
    inline constexpr uintptr_t GIsServerStoreAl = 0x009E4FE1;
    inline constexpr uintptr_t InitListenGateCall = 0x04046888;
    inline constexpr uintptr_t InitListenGate = 0x009D81A0;
    // In the function that sorts the loadout's player role slot entries
    // (UArchonLoadoutSlotData::PlayerRoleItemSlot, 0x28-byte entries from
    // +0x150) into ten lists at +0x9C0: "mov rsi, [rax]; movsxd rax, [rax+8]"
    // loads the array's data and count. World servers zero both, so the sort is
    // skipped (inherited from Mystic Paradox; the reason wasn't recorded).
    inline constexpr uintptr_t PlayerRoleSlotSortArray = 0x017BD9BC;

    // Networking and replication.
    inline constexpr uintptr_t GameEngineTick = 0x03BFDB50;               // UGameEngine::Tick
    inline constexpr uintptr_t NetDriverTickDispatch = 0x00A6F220;        // UNetDriver::TickDispatch
    inline constexpr uintptr_t NetDriverTickDispatchInner = 0x03D91AC0;
    inline constexpr uintptr_t NetDriverTickFlush = 0x03D91DC0;           // UNetDriver::TickFlush
    inline constexpr uintptr_t EngineFindNamedNetDriver = 0x0403A830;     // UEngine::FindNamedNetDriver(World, Name)
    inline constexpr uintptr_t NotifyClientDisconnected = 0x00A59270;
    inline constexpr uintptr_t IsNetReady = 0x03D7C820;
    // The three net-mode queries world servers answer as a dedicated server.
    inline constexpr uintptr_t GetNetMode = 0x0409EC10;
    inline constexpr uintptr_t InternalGetNetMode = 0x03D77000;
    inline constexpr uintptr_t WorldGetNetMode = 0x0409EF00;
    inline constexpr uintptr_t SetClientWorldPackageName = 0x03D64090;    // UNetConnection
    inline constexpr uintptr_t ServerReplicateActors = 0x03D75EF0;        // UNetDriver
    inline constexpr uintptr_t SetReplicationDriver = 0x03D90740;         // UNetDriver
    inline constexpr uintptr_t CreateReplicationDriver = 0x03D72A80;
    inline constexpr uintptr_t ActorChannelReplicateActor = 0x03B7B470;   // UActorChannel::ReplicateActor
    inline constexpr uintptr_t RepGraphReplicateSingleActor = 0x00ECEC50; // UReplicationGraph
    inline constexpr uintptr_t RepGraphServerReplicateActors = 0x01AB43D0;
    // (Graph, Connection): the graph's per-connection manager, from its list at +0x4A8.
    inline constexpr uintptr_t RepGraphFindConnectionManager = 0x01A8F4C0;
    // The replication driver enable flag CreateReplicationDriver checks, and the
    // registered replication graph feature array (data, then count at +8).
    inline constexpr uintptr_t RepDriverEnableFlag = 0x06729DA8;
    inline constexpr uintptr_t RepGraphFeatureArray = 0x06CE9588;
    inline constexpr uintptr_t GetTransientPackage = 0x02659120;
    inline constexpr uintptr_t StaticConstructObjectInternal = 0x026CEC20;

    // World lifecycle.
    inline constexpr uintptr_t GetGameDefaultMap = 0x02D2BD50;
    inline constexpr uintptr_t GetStartSpot = 0x01811B40;
    inline constexpr uintptr_t FCommandLineGet = 0x0243A310;
    inline constexpr uintptr_t OnPlayerDataLoadComplete = 0x01B690F0;
    inline constexpr uintptr_t ArchonLoadManagerLoadFailed = 0x01B65EB0;
    inline constexpr uintptr_t GameplaySchedulerInitialize = 0x01C412E0;  // FGameplayScheduler::Initialize
    // The engine's fatal error path (reads GErrorHist); world servers log and return.
    inline constexpr uintptr_t FatalErrorHandler = 0x024A8120;
    inline constexpr uintptr_t UnhandledExceptionFilter = 0x024A69F0;
    // An FName text read that faults on a bad entry; the exception handler
    // points it at an empty name string instead.
    inline constexpr uintptr_t FNameEntryTextRead = 0x024AE5B0;
    inline constexpr uintptr_t EmptyNameText = 0x04DF2E8C;
    inline constexpr uintptr_t Knockout = 0x01B8ACD0;
    inline constexpr uintptr_t InteractionCalloutHideHoldText = 0x01CDF5E0;

    // Gameplay abilities and player roles.
    // UAbilitySystemComponent::InternalTryActivateAbility(Handle, PredictionKey,
    // OutInstancedAbility, OnEnded, TriggerEventData).
    inline constexpr uintptr_t InternalTryActivateAbility = 0x015B9E20;
    // A loadout's active UArchonLoadoutSlotData (index +0x680 into +0x670), its
    // player role, and its PlayerRoleItemSlot (+0x348).
    inline constexpr uintptr_t LoadoutActiveSlotData = 0x01A52080;
    inline constexpr uintptr_t SlotDataPlayerRole = 0x01A95C60;
    inline constexpr uintptr_t SlotDataPlayerRoleItemSlot = 0x0173F670;
    // Player role ability charge queries (each takes the role).
    inline constexpr uintptr_t PlayerRoleCurrentCharge = 0x01B983E0;
    inline constexpr uintptr_t PlayerRoleChargePercent = 0x01B98410;
    inline constexpr uintptr_t PlayerRoleCurrentChargeRate = 0x01B98470;
    inline constexpr uintptr_t PlayerRoleMaxCharge = 0x01B99F30;
    inline constexpr uintptr_t PlayerRoleCanActivate = 0x01B8D8A0;

    // Backend traffic (client and world servers).
    inline constexpr uintptr_t HttpRequestSetURL = 0x03102740;
    inline constexpr uintptr_t HttpRequestProcessRequest = 0x03102BD0;
    inline constexpr uintptr_t ConfigGetString = 0x0243CAD0;              // GConfig string lookup (XMPP settings)

    // Client.
    inline constexpr uintptr_t EasyAntiCheatStartup = 0x0136FE40;
    inline constexpr uintptr_t EasyAntiCheatErrorProc = 0x020DC460;
    inline constexpr uintptr_t ChallengeSeasonWeeks = 0x01889100;         // UBountyComponent_Weekly
    inline constexpr uintptr_t MiddlemanCellOfferConvert = 0x01D56130;
    inline constexpr uintptr_t HuntPassSeasonalCoinIcons = 0x01DF5E80;
    inline constexpr uintptr_t HuntingPassLevelItemInitialize = 0x01DFD180;
    inline constexpr uintptr_t HuntingPassViewModelInitialize = 0x01DFDC10;
    inline constexpr uintptr_t HuntPassQueryOffers = 0x01E1EB50;
    inline constexpr uintptr_t HuntPassSelectionUpdateView = 0x01E2F410;
    inline constexpr uintptr_t EngineRealloc = 0x023BB590;
    inline constexpr uintptr_t MiddlemanSpeedUpBalance = 0x019F4B70;
    inline constexpr uintptr_t LootDisplaySummary = 0x01DA9AD0;
    inline constexpr uintptr_t LootHideEnd = 0x01DA7400;
    inline constexpr uintptr_t FeatureFlagIsEnabled = 0x00E57820;
    inline constexpr uintptr_t IsScheduledItemActive = 0x01C98C50;
    // CVarMaxFPS ("t.MaxFPS"): the TConsoleVariableData<float>* its static
    // initializer (0x0095B830) stores; [0] is the game thread's value, which
    // UEngine's frame limiter reads.
    inline constexpr uintptr_t CVarMaxFPSData = 0x06CFC2B0;
    // UEngine::UpdateTimeAndHandleMaxTickRate's frame limiter (0x04052540)
    // calls FPlatformProcess::SleepNoStats for all but the last 2 ms of a wait
    // over 5 ms (call at 0x0405293E), then in a loop until
    // FPlatformTime::Seconds() reaches the end time it keeps in xmm7 (set at
    // 0x04052912, compared at 0x04052963 and 0x04052999; the loop's call is
    // at 0x04052974). Seconds() is QueryPerformanceCounter times
    // GSecondsPerCycle plus 16777216. Found from SleepNoStats's callers and
    // the 0.002f slack constant.
    inline constexpr uintptr_t SleepNoStats = 0x024BE960;
    inline constexpr uintptr_t FrameLimiterEndTime = 0x04052912;
    inline constexpr uintptr_t FrameLimiterSlackSleepCall = 0x0405293E;
    inline constexpr uintptr_t FrameLimiterFirstCompare = 0x04052963;
    inline constexpr uintptr_t FrameLimiterSpinSleepCall = 0x04052974;
    inline constexpr uintptr_t FrameLimiterLoopCompare = 0x04052999;
    inline constexpr uintptr_t GSecondsPerCycle = 0x06B1CAF8;
    // UArchonGameplayStatics::TickFilterHelper(Actor, ECityExecFilter Where,
    // ERemoteExecFilter Whom): the Blueprint exec thunk and the native filter
    // it calls (its only caller). In this client build ServerOnly never passes
    // and LocalOrServer passes only for an autonomous proxy (Role at +0xF0 == 2).
    inline constexpr uintptr_t TickFilterHelperExec = 0x020FECE0;
    inline constexpr uintptr_t TickFilterHelper = 0x01823000;
    // CVarFreeSkeletalMeshBuffers ("r.FreeSkeletalMeshBuffers", int, default
    // 0): the TConsoleVariableData<int32>* its static initializer (0x00819010)
    // stores. FSkeletalMeshLODRenderData::ShouldForceKeepCPUResources
    // (0x03F8E660) reads [0] on the game thread and [1] elsewhere while a mesh
    // loads; 0 keeps a CPU copy of every skeletal mesh's buffers.
    inline constexpr uintptr_t CVarFreeSkeletalMeshBuffersData = 0x06B1BA10;
    // FWebBrowserWidgetModule::StartupModule (WebBrowserWidget plugin): makes
    // its UWebBrowserAssetManager, then IWebBrowserModule::Get().GetSingleton()
    // (vtable +0x48, FWebBrowserModule::GetSingleton 0x04376C80), which runs
    // CefInitialize and starts UnrealCEFSubProcess.exe whatever -nocef says.
    // Found by breaking on GetSingleton in a world server (first caller).
    inline constexpr uintptr_t WebBrowserWidgetStartupModule = 0x00EF8990;
    // FGenericPlatformMemory::BackupOOMMemoryPool: 32 MB committed at startup
    // (0x0237CE80) and only freed by the out-of-memory handler (0x02381310),
    // which skips it when null.
    inline constexpr uintptr_t BackupOOMMemoryPool = 0x06B1CAD8;
    // FDistanceFieldVolumeData's vtable, stored by FStaticMeshRenderData's
    // serializer (0x03FCC540) into each LOD's new distance field.
    inline constexpr uintptr_t DistanceFieldVolumeDataVTable = 0x05B04A30;
    // GMalloc (read by FMemory::Realloc, 0x023BB590) and the FMallocBinned2
    // methods in its vtable (0x0556A328): [2] Malloc, [4] Realloc, [6] Free.
    inline constexpr uintptr_t GMalloc = 0x06B532D0;
    inline constexpr uintptr_t MallocBinned2Malloc = 0x02391F60;
    inline constexpr uintptr_t MallocBinned2Realloc = 0x02392DA0;
    inline constexpr uintptr_t MallocBinned2Free = 0x023902B0;
    inline constexpr uintptr_t LegendaryWeaponEquipped = 0x01DF77C0;
    inline constexpr uintptr_t CreateActorChannel = 0x03D47AC0;
    inline constexpr uintptr_t SetChannelActor = 0x03B80890;
    inline constexpr uintptr_t CreateNamedNetDriver = 0x04033D20;
}
