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

extern void* OrigHasFinishedLoading;

bool DiagNaturalMode();

bool HasFinishedLoadingHook(UObject* a1);

bool IsNetReadyHook();

int NetModeHook(void* a1);

bool IsLevelInitForActorHook(void* a1, char a2);

extern void* OrigSetReplicationDriver;

extern void* OrigServerReplicateActors;

bool RepGraphDiag();

bool PlayerRepBoost();

bool OwnerPawnRelevancyFix();

extern void* OrigRepGraphReplicateSingleActor;

uint64_t __fastcall RepGraphReplicateSingleActorGuardHook(
    void* Graph, void* Actor, void* ConnActorInfo, void* GlobalInfo,
    void* ActorInfoMap, void* ConnManager, uint32_t Frame);

extern void* OrigReplicateActorFreq;

uint64_t __fastcall ReplicateActorFreqHook(UActorChannel* channel);

int __fastcall ServerReplicateActorsHook(void* NetDriver, float DeltaSeconds);

extern uint32_t* g_RepDriverEnableFlag;

extern void* OrigCreateRepDriver;

extern void** g_RepGraphFeatureArrayData;

extern int*   g_RepGraphFeatureArrayNum;

void* __fastcall CreateRepDriverHook(void* NetDriver, void* p2, void* p3);

void SetReplicationDriverHook(UNetDriver* NetDriver, UReplicationDriver* RepDriver);

extern void* OrigGetStartSpot;

APlayerStart* GetStartSpotHook(void* a1, void* a2, void* a3);
