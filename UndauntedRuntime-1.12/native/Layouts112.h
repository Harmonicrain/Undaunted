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
#include <cstddef>

// Reflected/native fields verified for the 1.12 CL392819 executable.
// Keep these separate from executable RVAs and generated SDK definitions.
namespace Native112::MiddlemanLayout {
    inline constexpr size_t PriceOfferSize = 0xB0;
    inline constexpr size_t EffectivePrice = 0x98;
    inline constexpr size_t PriceCurrencyId = 0xA0;
    inline constexpr size_t EnumPriceMap = 0x190;
    inline constexpr size_t NamedPriceMap = 0x1E0;
    inline constexpr size_t PopupSize = 0x5A8;
    inline constexpr size_t PopupPlatinumButton = 0x438;
    inline constexpr size_t PopupPlatinumCost = 0x4B0;
    // 0x4C0 is the Added to Inventory message, not the "or" separator.
    inline constexpr size_t PopupOrSeparator = 0x500;
    inline constexpr size_t PopupSku = 0x538;
    inline constexpr size_t PopupSelectedCurrency = 0x580;
    inline constexpr size_t TooltipSize = 0x468;
    inline constexpr size_t TooltipCosts = 0x458;
}
