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
import type { WebSocket } from "ws";
import { logger } from "../logger";
import { sessionRegistry } from "./SessionRegistry";
import { onResourceAvailable, onResourceUnavailable } from "./PresenceService";
import { summarizeFrame } from "./XMPPProtocol";
import { XMPPSession } from "./XMPPSession";
import { ConnectionInfo, RealtimeConfig, XmppState } from "./types";

let sequence = 0;
export class XMPPConnection {
    readonly connId = `xc_${Date.now().toString(36)}_${(++sequence).toString(36)}`;
    readonly connectedAt = Date.now();
    state = XmppState.Connected;
    accountId?: string;
    resource?: string;
    private closed = false;
    private available = false;
    private session = new XMPPSession();
    private processing: Promise<void> = Promise.resolve();

    constructor(private ws: WebSocket, readonly remoteIp: string, private config: RealtimeConfig, private onClosed: (c: XMPPConnection) => void){
        ws.on("message", (data: Buffer, binary: boolean) => {
            if(binary || data.byteLength > config.limits.maxMessageBytes) return;
            const raw = data.toString("utf8");
            if(config.captureEnabled){ const s = summarizeFrame(raw, config.limits); logger.info(`[XMPP-CAP] ${this.connId} ${s.shape}`); }
            this.processing = this.processing.then(() => this.handle(raw)).catch(error => logger.error(error, "XMPP frame failed"));
        });
        ws.on("close", () => this.teardown());
        ws.on("error", () => this.teardown());
    }

    info(): ConnectionInfo { return { connId: this.connId, remoteIp: this.remoteIp, connectedAt: this.connectedAt, state: this.state, accountId: this.accountId, resource: this.resource }; }
    send(frame: string){ if(!this.closed) this.ws.send(frame); }
    close(code: number, reason: string){ if(!this.closed) this.ws.close(code, reason); }
    terminate(){ this.ws.terminate(); this.teardown(); }

    private async handle(raw: string){
        const action = await this.session.handleFrame(raw);
        if(!action) return;
        action.send.forEach(frame => this.send(frame));
        if(action.nextState) this.state = action.nextState;
        if(action.accountId) this.accountId = action.accountId;
        if(action.resource && this.accountId){
            this.resource = action.resource;
            sessionRegistry.bind(this.accountId, action.resource, this)?.close(1001, "replaced");
        }
        if(action.presence && this.accountId && this.resource){
            if(action.presence.available && !this.available){ this.available = true; await onResourceAvailable(this.accountId, this.resource); }
            if(!action.presence.available && this.available){ this.available = false; await onResourceUnavailable(this.accountId); }
        }
        if(action.close) this.close(action.close.code, action.close.reason);
        logger.info(`[XMPP] ${this.connId} ${action.note}`);
    }

    private teardown(){
        if(this.closed) return;
        this.closed = true;
        this.state = XmppState.Closed;
        if(this.accountId && this.resource){ sessionRegistry.unbind(this.accountId, this.resource, this); void onResourceUnavailable(this.accountId); }
        this.onClosed(this);
    }
}
