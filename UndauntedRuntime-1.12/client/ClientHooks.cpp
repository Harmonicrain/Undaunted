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

#include "core/RuntimeHooks.h"
#include "client/ClientHooks.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "client/Challenges.h"
#include "client/GameplayHUD.h"
#include "client/HuntPass.h"
#include "client/LootSummary.h"
#include "client/Middleman.h"
#include "client/ClientEvents.h"
#include "client/SlayerLinks.h"
#include "core/EngineTick.h"
#include "core/Features.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "core/PlayerRoles.h"
#include "core/Transport.h"
#include "server/Replication.h"

void EasyAntiCheatErrorProcHook(void* Context, void* Stack, void* Result);
void EasyAntiCheatStartupHook(void* Module);

void* OrigEasyAntiCheatErrorProc = nullptr;

void* OrigEasyAntiCheatStartup = nullptr;

bool SuppressEacPopupEnabled() {
    return true;
}

void EasyAntiCheatErrorProcHook(void* Context, void* Stack, void* Result) {
    (void)Context;
    (void)Stack;
    if (SuppressEacPopupEnabled()) {

        if (Result && IsReadablePointer(Result, 0x11)) {
            *reinterpret_cast<uint8_t*>(reinterpret_cast<uintptr_t>(Result) + 0x10) = 0;
        }
        static bool Logged = false;
        if (!Logged) {
            Logged = true;
            MpLog("[EACPopup] suppressed native EasyAntiCheatErrorProc");
        }
        return;
    }
    if (OrigEasyAntiCheatErrorProc) {
        reinterpret_cast<void(*)(void*, void*, void*)>(OrigEasyAntiCheatErrorProc)(Context, Stack, Result);
    }
}

void EasyAntiCheatStartupHook(void* Module) {
    if (SuppressEacPopupEnabled()) {
        (void)Module;
        static bool Logged = false;
        if (!Logged) {
            Logged = true;
            MpLog("[EACPopup] suppressed FEasyAntiCheatClient::StartupModule");
        }
        return;
    }
    if (OrigEasyAntiCheatStartup) {
        reinterpret_cast<void(*)(void*)>(OrigEasyAntiCheatStartup)(Module);
    }
}

void InitClientHooks() {
    MH_STATUS InitStatus = MH_Initialize();
    MpLog(std::string("[InitClientHooks] MH_Initialize=") + MH_StatusToString(InitStatus));

    {
        MH_STATUS HasFinishedCreate = RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::HasFinishedLoading)), HasFinishedLoadingHook, &OrigHasFinishedLoading);
        MH_STATUS HasFinishedEnable = RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::HasFinishedLoading)));
        MpLog(std::string("[InitClientHooks] HasFinishedLoading create=")
            + MH_StatusToString(HasFinishedCreate)
            + " enable=" + MH_StatusToString(HasFinishedEnable)
            + " target=+" + MpHex(0x01A60BC0));
    }

    {
        MH_STATUS ProcessEventCreate = RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::ProcessEvent)), ProcessEventClientHook, &OrigProcessEventClient);
        MH_STATUS ProcessEventEnable = RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::ProcessEvent)));
        MpLog(std::string("[InitClientHooks] ProcessEvent create=")
            + MH_StatusToString(ProcessEventCreate)
            + " enable=" + MH_StatusToString(ProcessEventEnable)
            + " target=+" + MpHex(0x026A9890));
    }

    {
        MH_STATUS AprCreate = RUNTIME_CREATE_HOOK(
            (void*)(Native112::At(Globals::BaseAddress, Native112::ApplyPlayerRole)),
            ApplyPlayerRoleHook,
            &OrigApplyPlayerRole);
        MH_STATUS AprEnable = RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::ApplyPlayerRole)));
        MpLog(std::string("[InitClientHooks] ApplyPlayerRole hook create=")
            + MH_StatusToString(AprCreate) + " enable=" + MH_StatusToString(AprEnable)
            + " target=+" + MpHex(0x01A4B790));
    }

    {
        MH_STATUS HudCreate = RUNTIME_CREATE_HOOK(
            (void*)(Globals::BaseAddress + kHudLegendaryHandleWeaponEquippedRva),
            HudLegendaryHandleWeaponEquippedHook,
            &OrigHudLegendaryHandleWeaponEquipped);
        MH_STATUS HudEnable = RuntimeHooks::Enable((void*)(Globals::BaseAddress + kHudLegendaryHandleWeaponEquippedRva));
        MpLog(std::string("[InitClientHooks] HudLegendaryHandleWeaponEquipped create=")
            + MH_StatusToString(HudCreate) + " enable=" + MH_StatusToString(HudEnable)
            + " target=+" + MpHex(kHudLegendaryHandleWeaponEquippedRva));
    }

    InstallFeatureFlagHook("InitClientHooks");
    InstallHuntPassLibraryHook();
    InstallHuntPassMainTrackLayoutHook();
    InstallHuntPassCoinIconsHook();
    InstallJournalWeekLimitHook();
    InstallMiddlemanAetherdustHook();
    InstallMatchLootSummaryGuardHook();
    InstallSlayerLinkRecoveryHook();

    {
        MH_STATUS EacCreate = RUNTIME_CREATE_HOOK(
            (void*)(Native112::At(Globals::BaseAddress, Native112::Rva_020DC460)),
            EasyAntiCheatErrorProcHook,
            &OrigEasyAntiCheatErrorProc);
        MH_STATUS EacEnable = RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_020DC460)));
        MpLog(std::string("[InitClientHooks] EasyAntiCheatErrorProc create=")
            + MH_StatusToString(EacCreate)
            + " enable=" + MH_StatusToString(EacEnable)
            + " target=+" + MpHex(0x020DC460));
    }

    {
        MH_STATUS EacStartupCreate = RUNTIME_CREATE_HOOK(
            (void*)(Native112::At(Globals::BaseAddress, Native112::Rva_0136FE40)),
            EasyAntiCheatStartupHook,
            &OrigEasyAntiCheatStartup);
        MH_STATUS EacStartupEnable = RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_0136FE40)));
        MpLog(std::string("[InitClientHooks] EasyAntiCheatStartup create=")
            + MH_StatusToString(EacStartupCreate)
            + " enable=" + MH_StatusToString(EacStartupEnable)
            + " target=+" + MpHex(0x0136FE40));
    }

    InstallSetUrlRedirectHook("client");

    InstallXmppConfigRedirectHook("client");
}
