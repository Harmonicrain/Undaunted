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

bool IsReadablePointer(const void* Ptr, size_t Size = sizeof(void*));

bool IsRegisteredLiveObject(const void* Ptr);

bool IsSanePointerArray(void* Data, int32_t Num, int32_t Max, int32_t Limit);

void* EngineRealloc(void* Ptr, size_t NewSize);

uint8_t SafeReadByte(uintptr_t base, uintptr_t offset, uint8_t fallback);

bool SafeWriteByte(uintptr_t base, uintptr_t offset, uint8_t value);

float SafeReadFloat(void* addr, float fallback);

uintptr_t SafeReadPtr(uintptr_t base, uintptr_t offset);

int SafeReadU8At(uintptr_t base, uintptr_t offset);

int32_t SafeReadI32At(uintptr_t base, uintptr_t offset);

std::string CoreCapFString(void* fstr);
