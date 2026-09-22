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
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "../logger";
import { XMPPConnection } from "./XMPPConnection";
import { RealtimeConfig } from "./types";

export class RealtimeGateway {
    private wss: WebSocketServer;
    private connections = new Map<string, XMPPConnection>();
    constructor(private config: RealtimeConfig){
        this.wss = new WebSocketServer({ noServer: true, maxPayload: config.limits.maxMessageBytes,
            handleProtocols: protocols => protocols.has("xmpp") ? "xmpp" : false });
    }
    attach(server: Server){ server.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head)); }
    private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer){
        const path = (req.url ?? "").split("?")[0];
        if(!this.config.wsPaths.includes(path)){ socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
        this.wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
            const connection = new XMPPConnection(ws, req.socket.remoteAddress ?? "unknown", this.config, closed => this.connections.delete(closed.connId));
            this.connections.set(connection.connId, connection);
            logger.info(`[XMPP] accepted ${connection.connId} path=${path}`);
        });
    }
}
