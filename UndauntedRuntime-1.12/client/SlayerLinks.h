/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
#pragma once
#include "core/Runtime.h"
void InstallSlayerLinkRecoveryHook();
void SlayerLinksBeforeEvent(UObject* Object, const std::string& FunctionName);
