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
 * Hunt Pass selector. In October 2026 these hooks moved here from
 * core/EngineTick.cpp. Not an official release of
 * Mystic Paradox or Undaunted.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "server/WidgetGuards.h"
#include "core/Logging.h"
#include "core/Memory.h"

// Widget code that runs on world servers and reads members a server never
// sets: each call is skipped when those are missing.

void* OrigInteractionCalloutHideHoldText = nullptr;

void* OrigArchonLoadingScreenFadeIn = nullptr;

void InteractionCalloutHideHoldTextHook(void* Widget) {
    if (!IsReadablePointer(Widget, 0x3C8)) {
        MpLog("[InteractionCalloutHideHoldText] skipping unreadable widget=" + MpPtr(Widget));
        return;
    }

    void* HoldTextController = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Widget) + 0x3C0);
    if (!IsReadablePointer(HoldTextController, sizeof(void*))) {
        MpLog("[InteractionCalloutHideHoldText] skipping null/unreadable widget+0x3C0 widget="
            + MpPtr(Widget)
            + " member=" + MpPtr(HoldTextController));
        return;
    }

    reinterpret_cast<void(*)(void*)>(OrigInteractionCalloutHideHoldText)(Widget);
}

void ArchonLoadingScreenFadeInHook(void* LoadingScreen, uint8_t FadeMode) {
    void* PrimaryFadeWidget = nullptr;
    void* SecondaryFadeWidget = nullptr;

    if (IsReadablePointer(LoadingScreen, 0x3F0)) {
        PrimaryFadeWidget = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(LoadingScreen) + 0x3E8);
        SecondaryFadeWidget = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(LoadingScreen) + 0x3E0);
    }

    const bool WidgetsValid =
        LoadingScreen != nullptr &&
        PrimaryFadeWidget != nullptr &&
        SecondaryFadeWidget != nullptr &&
        IsReadablePointer(PrimaryFadeWidget, sizeof(void*)) &&
        IsReadablePointer(SecondaryFadeWidget, sizeof(void*));

    if (!WidgetsValid) {
        MpLog("[ArchonLoadingScreenFadeIn] suppressed (null-widget guard) loadingScreen="
            + MpPtr(LoadingScreen)
            + " primary(+0x3E8)=" + MpPtr(PrimaryFadeWidget)
            + " secondary(+0x3E0)=" + MpPtr(SecondaryFadeWidget)
            + " mode=" + std::to_string(FadeMode));
        return;
    }

    static bool s_loggedMode[256] = {};
    if (!s_loggedMode[FadeMode]) {
        s_loggedMode[FadeMode] = true;
        MpLog("[ArchonLoadingScreenFadeIn] pass-through (widgets valid) loadingScreen="
            + MpPtr(LoadingScreen)
            + " primary(+0x3E8)=" + MpPtr(PrimaryFadeWidget)
            + " secondary(+0x3E0)=" + MpPtr(SecondaryFadeWidget)
            + " mode=" + std::to_string(FadeMode)
            + " -> calling original");
    }

    reinterpret_cast<void(*)(void*, uint8_t)>(OrigArchonLoadingScreenFadeIn)(LoadingScreen, FadeMode);
}
