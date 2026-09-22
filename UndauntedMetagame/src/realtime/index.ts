/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Further modified in September 2026 for the Undaunted 1.4.4 preservation fork
 * (Harmonicrain/Undaunted): adapted to the 1.4.4 client, SQLite persistence and
 * a raw TCP XMPP listener. Not an official release of either upstream project.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
import type { Server } from "node:http";
import { RealtimeGateway } from "./RealtimeGateway";
import { RawXMPPGateway } from "./RawXMPPGateway";
import { DEFAULT_LIMITS } from "./types";

export function initRealtime(server: Server){
    const gateway = new RealtimeGateway({ enabled: true, wsPaths: ["/", "//", "/__ws/xmpp"], allowedHosts: [], captureEnabled: true, limits: DEFAULT_LIMITS });
    gateway.attach(server);
    const rawGateway = new RawXMPPGateway();
    rawGateway.listen(Number(process.env.XMPP_PORT || 60002), process.env.HOST || "127.0.0.1");
    return { gateway, rawGateway };
}
