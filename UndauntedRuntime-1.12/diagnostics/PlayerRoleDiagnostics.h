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
 * Hunt Pass selector. In October 2026 this file was split out of
 * diagnostics/RuntimeDiagnostics.cpp. Not an official release of
 * Mystic Paradox or Undaunted.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#pragma once
#include "core/Runtime.h"

// Readable summaries of player roles, ability specs and experience grants for
// the runtime's logs.

float SafeCallPlayerRoleFloat(void* PlayerRole, uintptr_t Rva);

int SafeCallPlayerRoleBoolRva(void* PlayerRole, uintptr_t Rva);

struct PlayerRoleModifierSnapshot {
    bool Valid = false;
    void* Group = nullptr;
    int DesiredBuffs = -1;
    int DesiredEffects = -1;
    int DesiredAbilities = -1;
    int AppliedBuffs = -1;
    int AppliedEffects = -1;
    int AppliedAbilities = -1;
    int PendingBuffs = -1;
    int PendingEffects = -1;
    int PendingAbilities = -1;
};

PlayerRoleModifierSnapshot CapturePlayerRoleModifiers(void* PlayerRole);

std::string PlayerRoleModifierSummary(void* PlayerRole);

std::string PlayerRoleChargeSummary(void* PlayerRole);

struct AbilitySpecDiagnostic {
    void* Ability = nullptr;
    void* SourceObject = nullptr;
    int Level = -1;
    int InputId = -1;
};

AbilitySpecDiagnostic FindAbilitySpecDiagnostic(UAbilitySystemComponent* Component, uint32_t Handle);

std::string ExperienceGrantSummary(const FExperienceGrant& Grant);

bool IsClientExperienceGrantConsumer(const std::string& FunctionName);
