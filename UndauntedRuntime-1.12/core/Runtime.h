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

#include <windows.h>
#include <shellapi.h>
#include <tlhelp32.h>
#include <string>
#include <set>
#include <map>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <vector>
#include <thread>
#include <atomic>
#include <iostream>
#include <ranges>
#include <winhttp.h>
#pragma comment(lib, "winhttp.lib")

#include "framework.h"
#include "SDK.hpp"
#include "MinHook/MinHook.h"
#include "constants.h"

#include "SDK/GameplayAbilities_parameters.hpp"
#include "SDK/Archon_parameters.hpp"
#include "SDK/lantern_equipped_ab_parameters.hpp"

#include <cwchar>
#include <fstream>
#include <iomanip>
#include <intrin.h>
#include <mutex>
#include <sstream>

using namespace SDK;
