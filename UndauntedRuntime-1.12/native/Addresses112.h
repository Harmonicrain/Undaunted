
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
    // MpLogHungGameThread
    inline constexpr uintptr_t Rva_00001000 = 0x00001000;
    // InitServerHooks
    inline constexpr uintptr_t Rva_00A59270 = 0x00A59270;
    // GameEngineTickHook, SafeManualTickDispatch
    inline constexpr uintptr_t Rva_00A6F220 = 0x00A6F220;
    // InitServerHooks
    inline constexpr uintptr_t Rva_00ECEC50 = 0x00ECEC50;
    // InitClientHooks
    inline constexpr uintptr_t Rva_0136FE40 = 0x0136FE40;
    // ServerTryActivateAbilityInternal
    inline constexpr uintptr_t Rva_015B9E20 = 0x015B9E20;
    // GetPlayerRoleAndSlot
    inline constexpr uintptr_t Rva_0173F670 = 0x0173F670;
    // InitServerHooks
    inline constexpr uintptr_t Rva_017BD9BC = 0x017BD9BC;
    // InitServerHooks
    inline constexpr uintptr_t Rva_01811B40 = 0x01811B40;
    // InstallJournalWeekLimitHook
    inline constexpr uintptr_t Rva_01889100 = 0x01889100;
    // ClientGetCurrentSpeedUpTokensHook
    inline constexpr uintptr_t InventoryGetItemQuantity = 0x01A03B60;
    // InitClientHooks, InitServerHooks
    inline constexpr uintptr_t ApplyPlayerRole = 0x01A4B790;
    // GetPlayerRoleAndSlot
    inline constexpr uintptr_t Rva_01A52080 = 0x01A52080;
    // InitClientHooks, InitServerHooks
    inline constexpr uintptr_t HasFinishedLoading = 0x01A60BC0;
    // RoutePlayerRoleToOwningConnectionRaw
    inline constexpr uintptr_t Rva_01A8F4C0 = 0x01A8F4C0;
    // GetPlayerRoleAndSlot
    inline constexpr uintptr_t Rva_01A95C60 = 0x01A95C60;
    // SafeCallGraphServerReplicate
    inline constexpr uintptr_t Rva_01AB43D0 = 0x01AB43D0;
    // InitServerHooks
    inline constexpr uintptr_t Rva_01B65EB0 = 0x01B65EB0;
    // InitServerHooks
    inline constexpr uintptr_t Rva_01B690F0 = 0x01B690F0;
    // InitServerHooks
    inline constexpr uintptr_t Rva_01B8ACD0 = 0x01B8ACD0;
    // InitServerHooks
    inline constexpr uintptr_t Rva_01C412E0 = 0x01C412E0;
    // InitServerHooks
    inline constexpr uintptr_t LoadingScreenFadeIn = 0x01CADE20;
    // InitServerHooks
    inline constexpr uintptr_t Rva_01CDF5E0 = 0x01CDF5E0;
    // InstallMiddlemanAetherdustHook
    inline constexpr uintptr_t Rva_01D56130 = 0x01D56130;
    // InstallHuntPassCoinIconsHook
    inline constexpr uintptr_t Rva_01DF5E80 = 0x01DF5E80;
    // InstallHuntPassMainTrackLayoutHook
    inline constexpr uintptr_t Rva_01DFD180 = 0x01DFD180;
    // InstallHuntPassMainTrackLayoutHook
    inline constexpr uintptr_t Rva_01DFDC10 = 0x01DFDC10;
    // InstallHuntPassLibraryHook
    inline constexpr uintptr_t Rva_01E1EB50 = 0x01E1EB50;
    // InstallHuntPassLibraryHook
    inline constexpr uintptr_t Rva_01E2F410 = 0x01E2F410;
    // InitClientHooks
    inline constexpr uintptr_t Rva_020DC460 = 0x020DC460;
    // InitServerHooks
    inline constexpr uintptr_t Rva_0243A310 = 0x0243A310;
    // InstallXmppConfigRedirectHook
    inline constexpr uintptr_t Rva_0243CAD0 = 0x0243CAD0;
    // InitServerHooks
    inline constexpr uintptr_t Rva_024A69F0 = 0x024A69F0;
    // InitServerHooks
    inline constexpr uintptr_t Rva_024A8120 = 0x024A8120;
    // VectoredExceptionTrace
    inline constexpr uintptr_t Rva_024AE5B0 = 0x024AE5B0;
    // CreateRepDriverHook
    inline constexpr uintptr_t Rva_02659120 = 0x02659120;
    // InitClientHooks, InitServerHooks
    inline constexpr uintptr_t ProcessEvent = 0x026A9890;
    // CreateRepDriverHook
    inline constexpr uintptr_t Rva_026CEC20 = 0x026CEC20;
    // InitServerHooks
    inline constexpr uintptr_t Rva_02D2BD50 = 0x02D2BD50;
    // InstallSetUrlRedirectHook
    inline constexpr uintptr_t Rva_03102740 = 0x03102740;
    // InitServerHooks
    inline constexpr uintptr_t Rva_03102BD0 = 0x03102BD0;
    // InstallWarpForceHooks
    inline constexpr uintptr_t Rva_032DAA1B = 0x032DAA1B;
    // InitServerHooks
    inline constexpr uintptr_t Rva_03795740 = 0x03795740;
    // InitServerHooks
    inline constexpr uintptr_t Rva_03B7B470 = 0x03B7B470;
    // InitServerHooks
    inline constexpr uintptr_t Rva_03BFDB50 = 0x03BFDB50;
    // InitServerHooks
    inline constexpr uintptr_t Rva_03D56360 = 0x03D56360;
    // SafeSetClientWorldPackageName
    inline constexpr uintptr_t Rva_03D64090 = 0x03D64090;
    // InitServerHooks
    inline constexpr uintptr_t Rva_03D72A80 = 0x03D72A80;
    // InitServerHooks
    inline constexpr uintptr_t Rva_03D75EF0 = 0x03D75EF0;
    // InitServerHooks
    inline constexpr uintptr_t Rva_03D77000 = 0x03D77000;
    // InitServerHooks
    inline constexpr uintptr_t Rva_03D7C820 = 0x03D7C820;
    // InitServerHooks
    inline constexpr uintptr_t Rva_03D90740 = 0x03D90740;
    // InitServerHooks
    inline constexpr uintptr_t Rva_03D91AC0 = 0x03D91AC0;
    // GameEngineTickHook, SafeManualTickFlush
    inline constexpr uintptr_t Rva_03D91DC0 = 0x03D91DC0;
    // RegisterNetDriverInLevelCollections
    inline constexpr uintptr_t Rva_0403A830 = 0x0403A830;
    // InitServerHooks
    inline constexpr uintptr_t Rva_0409EC10 = 0x0409EC10;
    // InitServerHooks
    inline constexpr uintptr_t Rva_0409EF00 = 0x0409EF00;
    // VectoredExceptionTrace
    inline constexpr uintptr_t Rva_04DF2E8C = 0x04DF2E8C;
    // MpLogHungGameThread
    inline constexpr uintptr_t Rva_04E00000 = 0x04E00000;
    // InitServerHooks
    inline constexpr uintptr_t Rva_06729DA8 = 0x06729DA8;
    // InitServerHooks
    inline constexpr uintptr_t Rva_069F6290 = 0x069F6290;
    // GameEngineTickHook, Init
    inline constexpr uintptr_t Rva_06B53259 = 0x06B53259;
    // GameEngineTickHook, Init
    inline constexpr uintptr_t Rva_06B5325A = 0x06B5325A;
    // ServerBootCrash
    inline constexpr uintptr_t Rva_06B53C44 = 0x06B53C44;
    // FindArchonReplicationGraphClass
    inline constexpr uintptr_t Rva_06B8BC00 = 0x06B8BC00;
    // InitServerHooks
    inline constexpr uintptr_t Rva_06CE9588 = 0x06CE9588;
    // RegisterNetDriverInLevelCollections
    inline constexpr uintptr_t Rva_06CFBF60 = 0x06CFBF60;
    // MainThread, SampleBleedoutGrace
    inline constexpr uintptr_t Rva_06D001B8 = 0x06D001B8;
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
    inline constexpr uintptr_t ActorPreReplication = 0x0394B400;
    inline constexpr uintptr_t CreateActorChannel = 0x03D47AC0;
    inline constexpr uintptr_t SetChannelActor = 0x03B80890;
    inline constexpr uintptr_t CreateNamedNetDriver = 0x04033D20;
    inline constexpr uintptr_t SendClientAdjustment = 0x03E9ABF0;
}
