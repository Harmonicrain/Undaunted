/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), September 2026.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

#pragma once
#include "core/Runtime.h"

// Lets skeletal meshes load without CPU copies of their buffers. Call from
// Init() on world servers, before the engine starts loading content.
void StartServerRenderDataOptions();

// Keeps Chromium (CEF) from starting on world servers. Call after
// MH_Initialize, before the engine loads its plugins.
void InstallServerWebBrowserSkip();

// Frees the CPU copies of mesh render data a world server never draws.
// Call on the game thread; it rate-limits itself.
void TickServerRenderDataRelease();
