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
#include "core/Runtime.h"

extern UObject* s_LastPossessedPC;

extern UObject* s_LastRestartPawn;

extern uint64_t s_LastPossessedAtMs;

extern bool s_ArchonInputActivated;

void TriggerArchonInputActivation(UObject* PC, const char* TriggerLabel);

bool RunClientRolePumpGuarded(UObject* PC);

void Move10_PatchMovByteImm(uintptr_t Rva, uintptr_t TargetOff, uint8_t ExpectImm, uint8_t NewImm,
                                   const char* Tag, std::string& Status);

void Move10_PatchMovRegToImm0(uintptr_t Rva, uintptr_t TargetOff, const char* Tag, std::string& Status);

void Move10_NopMovByteAlStore(uintptr_t Rva, uintptr_t TargetOff, const char* Tag, std::string& Status);

void Move10_PatchCallToMovAl1(uintptr_t Rva, uintptr_t ExpectTargetOff, const char* Tag, std::string& Status);

extern void* OrigApplyPlayerRole;

void TickPlayerRolePostActivationRefresh();

void TickTempestModifierEnsure();

void TickTempestChargeDiag();

void TickPlayerRoleRetries();

void ApplyPlayerRoleHook(void* a1);
