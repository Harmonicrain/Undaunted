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
#include "client/LootSummary.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "core/Logging.h"

using MatchLootDisplaySummaryFn = void(__fastcall*)(UMatchLootPanelWidget*);

using MatchLootOnHideEndFn = void(__fastcall*)(UMatchLootPanelWidget*);

static void __fastcall MatchLootDisplaySummaryHook(UMatchLootPanelWidget* Panel);
static void __fastcall MatchLootOnHideEndHook(UMatchLootPanelWidget* Panel);

static MatchLootDisplaySummaryFn OrigMatchLootDisplaySummary = nullptr;

static MatchLootOnHideEndFn OrigMatchLootOnHideEnd = nullptr;

static SRWLOCK g_MatchLootSummaryGuardLock = SRWLOCK_INIT;

static std::set<UMatchLootPanelWidget*> g_MatchLootSummaryOpeningPanels;

static void __fastcall MatchLootDisplaySummaryHook(UMatchLootPanelWidget* Panel) {
    if (!Panel) return;

    AcquireSRWLockExclusive(&g_MatchLootSummaryGuardLock);
    const bool FirstRequest = g_MatchLootSummaryOpeningPanels.insert(Panel).second;
    ReleaseSRWLockExclusive(&g_MatchLootSummaryGuardLock);

    if (!FirstRequest) {
        static volatile LONG DuplicateCount = 0;
        if (InterlockedIncrement(&DuplicateCount) <= 32)
            MpLog("[MatchLootSummary] blocked duplicate expanded-screen request");
        return;
    }

    OrigMatchLootDisplaySummary(Panel);
}

static void __fastcall MatchLootOnHideEndHook(UMatchLootPanelWidget* Panel) {
    OrigMatchLootOnHideEnd(Panel);
    AcquireSRWLockExclusive(&g_MatchLootSummaryGuardLock);
    g_MatchLootSummaryOpeningPanels.erase(Panel);
    ReleaseSRWLockExclusive(&g_MatchLootSummaryGuardLock);
}

void InstallMatchLootSummaryGuardHook() {
    constexpr uintptr_t DisplayRva = Native112::LootDisplaySummary;
    constexpr uintptr_t HideEndRva = Native112::LootHideEnd;
    auto* DisplayTarget = reinterpret_cast<unsigned char*>(Globals::BaseAddress + DisplayRva);
    auto* HideEndTarget = reinterpret_cast<unsigned char*>(Globals::BaseAddress + HideEndRva);
    const unsigned char DisplaySignature[] = {
        0x48, 0x89, 0x5C, 0x24, 0x10, 0x48, 0x89, 0x74, 0x24, 0x18,
        0x57, 0x48, 0x81, 0xEC, 0xA0, 0x01, 0x00, 0x00
    };
    const unsigned char HideEndSignature[] = {
        0x48, 0x89, 0x5C, 0x24, 0x10, 0x48, 0x89, 0x74, 0x24, 0x18,
        0x57, 0x48, 0x81, 0xEC, 0x60, 0x01, 0x00, 0x00
    };
    if (memcmp(DisplayTarget, DisplaySignature, sizeof(DisplaySignature)) != 0
        || memcmp(HideEndTarget, HideEndSignature, sizeof(HideEndSignature)) != 0) {
        MpLog("[InitClientHooks] MatchLootSummaryGuard skipped: executable signature mismatch");
        return;
    }

    const MH_STATUS DisplayCreate = RUNTIME_CREATE_HOOK(DisplayTarget, MatchLootDisplaySummaryHook,
        reinterpret_cast<LPVOID*>(&OrigMatchLootDisplaySummary));
    const MH_STATUS HideEndCreate = RUNTIME_CREATE_HOOK(HideEndTarget, MatchLootOnHideEndHook,
        reinterpret_cast<LPVOID*>(&OrigMatchLootOnHideEnd));
    if (DisplayCreate != MH_OK || HideEndCreate != MH_OK) {
        if (DisplayCreate == MH_OK) MH_RemoveHook(DisplayTarget);
        if (HideEndCreate == MH_OK) MH_RemoveHook(HideEndTarget);
        MpLog(std::string("[InitClientHooks] MatchLootSummaryGuard create failed display=")
            + MH_StatusToString(DisplayCreate) + " hideEnd=" + MH_StatusToString(HideEndCreate));
        return;
    }

    const MH_STATUS DisplayEnable = RuntimeHooks::Enable(DisplayTarget);
    const MH_STATUS HideEndEnable = RuntimeHooks::Enable(HideEndTarget);
    if (DisplayEnable != MH_OK || HideEndEnable != MH_OK) {
        if (DisplayEnable == MH_OK) MH_DisableHook(DisplayTarget);
        if (HideEndEnable == MH_OK) MH_DisableHook(HideEndTarget);
        MH_RemoveHook(DisplayTarget);
        MH_RemoveHook(HideEndTarget);
        OrigMatchLootDisplaySummary = nullptr;
        OrigMatchLootOnHideEnd = nullptr;
        MpLog(std::string("[InitClientHooks] MatchLootSummaryGuard enable failed display=")
            + MH_StatusToString(DisplayEnable) + " hideEnd=" + MH_StatusToString(HideEndEnable));
        return;
    }
    MpLog(std::string("[InitClientHooks] MatchLootSummaryGuard display=")
        + MH_StatusToString(DisplayEnable) + " hideEnd=" + MH_StatusToString(HideEndEnable));
}
