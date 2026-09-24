/*
 * New work for the Undaunted 1.4.4 preservation fork (Harmonicrain/Undaunted),
 * September 2026. Transport for the XMPPSession / PresenceService code, which is
 * derived from Mystic Paradox (see NOTICE.md).
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import crypto from "node:crypto";
import type { Socket } from "node:net";
import { logger } from "../logger";
import { onResourceAvailable, onResourceUnavailable } from "./PresenceService";
import { ApplyChatAction, LeaveAllRooms } from "./RoomService";
import { sessionRegistry } from "./SessionRegistry";
import { XMPPSession, type SessionAction } from "./XMPPSession";

const DOMAIN = "prod.ol.epicgames.com";
const MAX_BUFFER = 64 * 1024;
let sequence = 0;

// Dauntless 1.4.4 predates Epic's WebSocket XMPP transport. It speaks the
// original, long-lived TCP stream where <stream:stream> is intentionally left
// open and individual stanzas follow it.
export class RawXMPPConnection {
    readonly connId = `xt_${Date.now().toString(36)}_${(++sequence).toString(36)}`;
    accountId?: string;
    resource?: string;
    private buffer = "";
    private closed = false;
    private available = false;
    private session = new XMPPSession();
    private processing: Promise<void> = Promise.resolve();

    constructor(private socket: Socket, remoteIp: string, private onClosed: (connection: RawXMPPConnection) => void){
        socket.setEncoding("utf8");
        socket.setKeepAlive(true, 30_000);
        socket.setTimeout(5 * 60_000, () => socket.end());
        socket.on("data", chunk => this.onData(String(chunk)));
        socket.on("close", () => this.teardown());
        socket.on("error", error => logger.warn({ error: error.message, connId: this.connId }, "[XMPP-TCP] socket error"));
        logger.info(`[XMPP-TCP] accepted ${this.connId} from ${remoteIp}`);
    }

    send(frame: string){ if(!this.closed && this.socket.writable) this.socket.write(frame); }
    close(_code: number, _reason: string){ if(!this.closed) this.socket.end("</stream:stream>"); }

    private onData(chunk: string){
        this.buffer += chunk;
        if(this.buffer.length > MAX_BUFFER){ this.socket.destroy(); return; }
        const frames = this.takeFrames();
        for(const frame of frames){
            this.processing = this.processing.then(() => frame === "__OPEN__" ? this.handleOpen() : this.handleStanza(frame))
                .catch(error => logger.error(error, "[XMPP-TCP] frame failed"));
        }
    }

    private takeFrames(): string[]{
        const frames: string[] = [];
        while(true){
            this.buffer = this.buffer.replace(/^\s+/, "");
            if(this.buffer.startsWith("<?xml")){
                const end = this.buffer.indexOf("?>");
                if(end < 0) break;
                this.buffer = this.buffer.slice(end + 2);
                continue;
            }
            if(this.buffer.startsWith("</stream:stream")){
                const end = this.buffer.indexOf(">");
                if(end < 0) break;
                this.buffer = this.buffer.slice(end + 1);
                this.socket.end();
                break;
            }
            if(this.buffer.startsWith("<stream:stream")){
                const end = this.buffer.indexOf(">");
                if(end < 0) break;
                this.buffer = this.buffer.slice(end + 1);
                frames.push("__OPEN__");
                continue;
            }
            const match = /^<([A-Za-z_][\w:.-]*)\b/.exec(this.buffer);
            if(!match) break;
            const name = match[1];
            const tagEnd = this.buffer.indexOf(">");
            if(tagEnd < 0) break;
            if(this.buffer[tagEnd - 1] === "/"){
                frames.push(this.buffer.slice(0, tagEnd + 1));
                this.buffer = this.buffer.slice(tagEnd + 1);
                continue;
            }
            const close = `</${name}>`;
            const closeAt = this.buffer.indexOf(close, tagEnd + 1);
            if(closeAt < 0) break;
            const end = closeAt + close.length;
            frames.push(this.buffer.slice(0, end));
            this.buffer = this.buffer.slice(end);
        }
        return frames;
    }

    private async handleOpen(){
        const action = await this.session.handleFrame(`<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="${DOMAIN}"/>`);
        if(!action) return;
        const stream = `<?xml version="1.0"?><stream:stream from="${DOMAIN}" id="${crypto.randomBytes(8).toString("hex")}" xmlns="jabber:client" xmlns:stream="http://etherx.jabber.org/streams" version="1.0">`;
        action.send.forEach(frame => this.send(frame.startsWith("<open ") ? stream : frame));
        await this.apply(action);
    }

    private async handleStanza(frame: string){
        const action = await this.session.handleFrame(frame);
        if(!action) return;
        action.send.forEach(out => this.send(out));
        await this.apply(action);
    }

    private async apply(action: SessionAction){
        if(action.accountId) this.accountId = action.accountId;
        if(action.resource && this.accountId){
            this.resource = action.resource;
            sessionRegistry.bind(this.accountId, action.resource, this)?.close(1001, "replaced");
        }
        if(action.presence && this.accountId && this.resource){
            if(action.presence.available && !this.available){ this.available = true; await onResourceAvailable(this.accountId, this.resource); }
            if(!action.presence.available && this.available){ this.available = false; await onResourceUnavailable(this.accountId, this.resource); }
        }
        if((action.room || action.direct) && this.accountId && this.resource) ApplyChatAction(this, this.accountId, this.resource, action);
        if(action.close) this.close(action.close.code, action.close.reason);
        logger.info(`[XMPP-TCP] ${this.connId} ${action.note}`);
    }

    private teardown(){
        if(this.closed) return;
        this.closed = true;
        logger.info(`[XMPP-TCP] ${this.connId} closed account=${this.accountId ?? "-"}`);
        LeaveAllRooms(this);
        if(this.accountId && this.resource){
            sessionRegistry.unbind(this.accountId, this.resource, this);
            void onResourceUnavailable(this.accountId, this.resource);
        }
        this.onClosed(this);
    }
}
