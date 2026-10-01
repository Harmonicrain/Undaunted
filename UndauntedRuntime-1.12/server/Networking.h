/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Further modified in October 2026 for the Undaunted fork (Harmonicrain/Undaunted):
 * moved to server/, the manual actor-replication loop removed.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#pragma once

#include <Windows.h>
#include "SDK.hpp"

using namespace SDK;

namespace Networking {
	extern UNetDriver* NetDriver;

	void Listen(UEngine* Engine, int Port);

	// -UndauntedDiag=repgraph: the replication graph's state, on a connection
	// change and every 2 s. Call on the game thread.
	void LogReplicationGraphState();

	// Opens (or reuses) the actor's channel on the connection and replicates it
	// once: 0 failed, 1 nothing written, 2 written on a new channel, 3 on an
	// existing one.
	int BootstrapActorChannel(AActor* Actor, UNetConnection* Connection);
}
