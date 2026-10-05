/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#pragma once
#include <array>

namespace BackgroundArt {
// Full login/loading artwork verified in CL392819's UI_0/UI_1/UI_3 paks.
inline constexpr std::array<const wchar_t*, 6> Paths{{
    L"/Game/UI/LoadingScreen/Malkarion_SplashArt.Malkarion_SplashArt",
    L"/Game/UI/Textures/HuntpassRewards/2019_Season08a/ui_background_hp08a_loginscreen.ui_background_hp08a_loginscreen",
    L"/Game/UI/Textures/HuntpassRewards/2020_Season09b/ui_background_hp09b_commando_loginscreen.ui_background_hp09b_commando_loginscreen",
    L"/Game/UI/Textures/HuntpassRewards/2021_Season16a/ui_hp_login_marauder_16A.ui_hp_login_marauder_16A",
    L"/Game/UI/Textures/HuntpassRewards/2022_Season17a/ui_hp_login_terramane_17a.ui_hp_login_terramane_17a",
    L"/Game/UI/Textures/HuntpassRewards/2021_Season14a/ui_hp_ranger_background_login.ui_hp_ranger_background_login",
}};
}
