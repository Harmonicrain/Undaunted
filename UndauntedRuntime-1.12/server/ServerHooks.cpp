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

#include "server/ServerHooks.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "client/GameplayHUD.h"
#include "core/EngineTick.h"
#include "core/Features.h"
#include "core/RuntimeHooks.h"
#include "core/Logging.h"
#include "core/PlayerRoles.h"
#include "core/Transport.h"
#include "diagnostics/RuntimeDiagnostics.h"
#include "server/PlayerData.h"
#include "server/RenderData.h"
#include "server/FrameWait.h"
#include "server/TickFilter.h"
#include "server/ServerEvents.h"
#include "server/Replication.h"
#include "server/WorldLifecycle.h"

void InitServerHooks() {

    MH_Initialize();

    InstallApiHook(L"kernel32.dll", "ExitProcess", ExitProcessHook, reinterpret_cast<LPVOID*>(&OrigExitProcess), "kernel32!ExitProcess");
    InstallApiHook(L"ntdll.dll", "RtlExitUserProcess", RtlExitUserProcessHook, reinterpret_cast<LPVOID*>(&OrigRtlExitUserProcess), "ntdll!RtlExitUserProcess");
    InstallApiHook(L"kernelbase.dll", "TerminateProcess", TerminateProcessHook, reinterpret_cast<LPVOID*>(&OrigTerminateProcess), "kernelbase!TerminateProcess");
    InstallApiHook(L"kernelbase.dll", "RaiseException", RaiseExceptionHook, reinterpret_cast<LPVOID*>(&OrigRaiseException), "kernelbase!RaiseException");
    InstallApiHook(L"ucrtbase.dll", "exit", UcrtExitHook, reinterpret_cast<LPVOID*>(&OrigUcrtExit), "ucrtbase!exit");
    InstallApiHook(L"ucrtbase.dll", "_exit", UcrtUnderscoreExitHook, reinterpret_cast<LPVOID*>(&OrigUcrtUnderscoreExit), "ucrtbase!_exit");
    InstallApiHook(L"ucrtbase.dll", "abort", UcrtAbortHook, reinterpret_cast<LPVOID*>(&OrigUcrtAbort), "ucrtbase!abort");
    InstallApiHook(L"msvcrt.dll", "exit", MsvcrtExitHook, reinterpret_cast<LPVOID*>(&OrigMsvcrtExit), "msvcrt!exit");
    InstallApiHook(L"msvcrt.dll", "_exit", MsvcrtUnderscoreExitHook, reinterpret_cast<LPVOID*>(&OrigMsvcrtUnderscoreExit), "msvcrt!_exit");
    InstallApiHook(L"msvcrt.dll", "abort", MsvcrtAbortHook, reinterpret_cast<LPVOID*>(&OrigMsvcrtAbort), "msvcrt!abort");
    VectoredExceptionHandle = AddVectoredExceptionHandler(1, VectoredExceptionTrace);
    MpLog("[ExceptionTrace] AddVectoredExceptionHandler handle=" + MpPtr(VectoredExceptionHandle));

    MH_STATUS UnhandledCreate = RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_024A69F0)), UEUnhandledExceptionFilterHook, &OrigUnhandledExceptionFilter);
    MH_STATUS UnhandledEnable = RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_024A69F0)));
    MpLog(std::string("[ExitTrace] hook UEUnhandledExceptionFilter create=")
        + MH_StatusToString(UnhandledCreate)
        + " enable=" + MH_StatusToString(UnhandledEnable)
        + " target=+" + MpHex(0x024A69F0));

    RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::ProcessEvent)), ProcessEventHook, &OrigProcessEvent);
    RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::ProcessEvent)));

    InstallFeatureFlagHook("InitServerHooks");
    InstallScheduleHook("InitServerHooks");
    InstallServerWebBrowserSkip();
    InstallServerFrameWait();
    InstallServerTickFilter();

    RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_01B690F0)), OnPlayerDataLoadCompleteHook, &OrigOnPlayerDataLoadComplete);
    RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_01B690F0)));

    MH_STATUS KnockoutCreate = RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_01B8ACD0)), KnockoutHook, &OrigKnockout);
    MH_STATUS KnockoutEnable = RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_01B8ACD0)));
    MpLog(std::string("[InitServerHooks] Knockout diag hook create=")
        + MH_StatusToString(KnockoutCreate) + " enable=" + MH_StatusToString(KnockoutEnable)
        + " target=+" + MpHex(0x01B8ACD0));

    MH_STATUS SchedInitCreate = RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_01C412E0)), SchedulerInitializeHook, &OrigSchedulerInitialize);
    MH_STATUS SchedInitEnable = RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_01C412E0)));
    MpLog(std::string("[InitServerHooks] FGameplayScheduler::Initialize create=")
        + MH_StatusToString(SchedInitCreate) + " enable=" + MH_StatusToString(SchedInitEnable)
        + " target=+" + MpHex(0x01C412E0));

    MH_STATUS AprCreate = RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::ApplyPlayerRole)), ApplyPlayerRoleHook, &OrigApplyPlayerRole);
    MH_STATUS AprEnable = RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::ApplyPlayerRole)));
    MpLog(std::string("[InitServerHooks] ApplyPlayerRole hook create=")
        + MH_StatusToString(AprCreate) + " enable=" + MH_StatusToString(AprEnable)
        + " target=+" + MpHex(0x01A4B790));

    RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_02D2BD50)), GetGameDefaultMap, &OrigGetDefaultMap);
    RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_02D2BD50)));

    RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03BFDB50)), GameEngineTickHook, &OrigGameEngineTick);
    RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03BFDB50)));

    RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_01CDF5E0)), InteractionCalloutHideHoldTextHook, &OrigInteractionCalloutHideHoldText);
    RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_01CDF5E0)));

    MH_STATUS FadeCreate = RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::LoadingScreenFadeIn)), ArchonLoadingScreenFadeInHook, &OrigArchonLoadingScreenFadeIn);
    MH_STATUS FadeEnable = RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::LoadingScreenFadeIn)));
    MpLog(std::string("[InitServerHooks] ArchonLoadingScreenFadeIn create=")
        + MH_StatusToString(FadeCreate)
        + " enable=" + MH_StatusToString(FadeEnable)
        + " target=+" + MpHex(0x01CADE20));

    MH_STATUS NetDriverTickCreate = RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03D91AC0)), NetDriverTickDispatchInnerHook, &OrigNetDriverTickDispatchInner);
    MH_STATUS NetDriverTickEnable = RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03D91AC0)));
    MpLog(std::string("[InitServerHooks] NetDriverTickDispatchInner create=")
        + MH_StatusToString(NetDriverTickCreate)
        + " enable=" + MH_StatusToString(NetDriverTickEnable)
        + " target=+" + MpHex(0x03D91AC0));

    RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03102BD0)), ProcessRequest, &OrigProcessRequest);
    RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03102BD0)));

    InstallSetUrlRedirectHook("server");

    RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03D90740)), SetReplicationDriverHook, &OrigSetReplicationDriver);
    RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03D90740)));

    MH_STATUS SraCreate = RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03D75EF0)), ServerReplicateActorsHook, &OrigServerReplicateActors);
    MH_STATUS SraEnable = RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03D75EF0)));
    MpLog(std::string("[InitServerHooks] ServerReplicateActors create=") + MH_StatusToString(SraCreate)
        + " enable=" + MH_StatusToString(SraEnable) + " target=+" + MpHex(0x03D75EF0));

    MH_STATUS PcPreChannelCreate = RUNTIME_CREATE_HOOK(
        (void*)(Native112::At(Globals::BaseAddress, Native112::Rva_00ECEC50)),
        RepGraphReplicateSingleActorGuardHook,
        &OrigRepGraphReplicateSingleActor);
    MH_STATUS PcPreChannelEnable = RuntimeHooks::Enable(
        (void*)(Native112::At(Globals::BaseAddress, Native112::Rva_00ECEC50)));
    MpLog(std::string("[InitServerHooks] PlayerController pre-channel guard create=")
        + MH_StatusToString(PcPreChannelCreate)
        + " enable=" + MH_StatusToString(PcPreChannelEnable)
        + " target=+" + MpHex(0x00ECEC50));

    MH_STATUS PcChannelCreate = RUNTIME_CREATE_HOOK(
        (void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03B7B470)),
        ReplicateActorFreqHook,
        &OrigReplicateActorFreq);
    MH_STATUS PcChannelEnable = RuntimeHooks::Enable(
        (void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03B7B470)));
    MpLog(std::string("[InitServerHooks] PlayerController channel guard create=")
        + MH_StatusToString(PcChannelCreate)
        + " enable=" + MH_StatusToString(PcChannelEnable)
        + " target=+" + MpHex(0x03B7B470)
        + (RepGraphDiag() ? " (RepFreq diag also enabled)" : ""));

    g_RepDriverEnableFlag = reinterpret_cast<uint32_t*>(Native112::At(Globals::BaseAddress, Native112::Rva_06729DA8));

    g_RepGraphFeatureArrayData = reinterpret_cast<void**>(Native112::At(Globals::BaseAddress, Native112::Rva_06CE9588));
    g_RepGraphFeatureArrayNum  = reinterpret_cast<int*>(Native112::At(Globals::BaseAddress, Native112::Rva_06CE9588) + 8);
    RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03D72A80)), CreateRepDriverHook, &OrigCreateRepDriver);
    RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03D72A80)));

    RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03D56360)), IsLevelInitForActorHook, &OrigIsLevelInitForActor);
    RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03D56360)));

    RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_01811B40)), GetStartSpotHook, &OrigGetStartSpot);
    RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_01811B40)));

    RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_0409EC10)), NetModeHook, &OrigNetModeHook);
    RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_0409EC10)));

    RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03D77000)), NetModeHook, &OrigInternalNetModeHook);
    RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03D77000)));

    RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_0409EF00)), NetModeHook, &OrigWorldNetModeHook);
    RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_0409EF00)));

    RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03D7C820)), IsNetReadyHook, &OrigIsNetReady);
    RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03D7C820)));

    *reinterpret_cast<uint8_t*>(Native112::At(Globals::BaseAddress, Native112::Rva_069F6290)) = 5;

    MH_STATUS NotifyCreate = RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_00A59270)), NotifyClientDisconnectedHook, &OrigNotifyClientDisconnected);
    MH_STATUS NotifyEnable = RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_00A59270)));
    MpLog(std::string("[InitServerHooks] NotifyClientDisconnected hook create=") +
        MH_StatusToString(NotifyCreate) + " enable=" + MH_StatusToString(NotifyEnable));

    MpLog("[InitServerHooks] NetConnectionClose diagnostic disabled (unsafe +0x1318 UObject assumption)");

    RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::HasFinishedLoading)), HasFinishedLoadingHook, &OrigHasFinishedLoading);
    RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::HasFinishedLoading)));

    {
        MH_STATUS c = RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03795740)), ExecGetViewportSizeHook, &OrigGetViewportSize);
        MH_STATUS e = RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03795740)));
        MpLog(std::string("[InitServerHooks] GetViewportSize create=") + MH_StatusToString(c) + " enable=" + MH_StatusToString(e) + " target=+" + MpHex(0x03795740));
    }

    RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_024A8120)), ServerBootCrash, &OrigServerBootCrash);
    RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_024A8120)));

    MH_STATUS LoadFailedCreate = RUNTIME_CREATE_HOOK(
        (void*)(Native112::At(Globals::BaseAddress, Native112::Rva_01B65EB0)),
        ArchonLoadManagerLoadFailedHook,
        &OrigArchonLoadManagerLoadFailed);
    MH_STATUS LoadFailedEnable = RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_01B65EB0)));
    MpLog(std::string("[LoadFailed hook installed] create=")
        + MH_StatusToString(LoadFailedCreate)
        + " enable=" + MH_StatusToString(LoadFailedEnable)
        + " target=+" + MpHex(0x01B65EB0));

    RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_0243A310)), GetCommandLineHook, &OrigGetCommandLine);
    RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_0243A310)));

    {
        wchar_t ExeW[MAX_PATH];
        DWORD nw = GetModuleFileNameW(nullptr, ExeW, MAX_PATH);
        MpLog(std::string("[WARP] exe=") + ((nw > 0 && nw < MAX_PATH) ? MpNarrow(std::wstring(ExeW, nw)) : std::string("?"))
            + "  (put MP_FORCE_WARP.flag in that folder)  detected=" + (MpForceWarpEnabled() ? "YES" : "no"));
    }
    if (MpForceWarpEnabled()) {
        InstallWarpForceHooks();
        Globals::Move10Status += " [WARP force ENABLED (MP_FORCE_WARP.flag present)]";
    } else {
        Globals::Move10Status += " [WARP force off (no MP_FORCE_WARP.flag)]";
    }

    DWORD oldProtect;

    VirtualProtect((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_017BD9BC)), 0x7, PAGE_READWRITE, &oldProtect);
    *(uint8_t*)(Native112::At(Globals::BaseAddress, Native112::Rva_017BD9BC) + 0x0) = 0x33;
    *(uint8_t*)(Native112::At(Globals::BaseAddress, Native112::Rva_017BD9BC) + 0x1) = 0xF6;
    *(uint8_t*)(Native112::At(Globals::BaseAddress, Native112::Rva_017BD9BC) + 0x2) = 0x33;
    *(uint8_t*)(Native112::At(Globals::BaseAddress, Native112::Rva_017BD9BC) + 0x3) = 0xC0;
    *(uint8_t*)(Native112::At(Globals::BaseAddress, Native112::Rva_017BD9BC) + 0x4) = 0x90;
    *(uint8_t*)(Native112::At(Globals::BaseAddress, Native112::Rva_017BD9BC) + 0x5) = 0x90;
    *(uint8_t*)(Native112::At(Globals::BaseAddress, Native112::Rva_017BD9BC) + 0x6) = 0x90;
    VirtualProtect((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_017BD9BC)), 0x7, oldProtect, &oldProtect);

    {
        std::string s;
        Move10_PatchMovByteImm(0x009E934A, 0x06B53259, 0x01, 0x00, "0x934A GIsClient 1->0", s);
        Move10_PatchMovByteImm(0x009E94FB, 0x06B5325A, 0x00, 0x01, "0x94FB GIsServer 0->1", s);
        Move10_PatchMovRegToImm0(0x009E9507, 0x06B53259, "0x9507 GIsClient ->0", s);
        Move10_NopMovByteAlStore(0x009E4FD4, 0x06B53259, "0x4FD4 E37A0 GIsClient store", s);
        Move10_NopMovByteAlStore(0x009E4FE1, 0x06B5325A, "0x4FE1 E37A0 GIsServer store", s);
        Move10_PatchCallToMovAl1(0x04046888, 0x009D81A0, "0x4046888 InitListen-gate ->true", s);
        Globals::Move10Status = s;
    }

}
