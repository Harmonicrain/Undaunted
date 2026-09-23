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
/* Local presence and roster delivery for the 1.4.4 Epic-style XMPP client. */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { GetDb } from "../db";
import { friends } from "../db/schema";
import { logger } from "../logger";
import { sessionRegistry } from "./SessionRegistry";
import { escapeXml } from "./xml";

const DOMAIN = "prod.ol.epicgames.com";
const jid = (id: string, resource?: string) => `${escapeXml(id)}@${DOMAIN}${resource ? `/${escapeXml(resource)}` : ""}`;
const available = (from: string, resource: string, to: string) => `<presence from="${jid(from, resource)}" to="${jid(to)}"/>`;
const unavailable = (from: string, to: string) => `<presence type="unavailable" from="${jid(from)}" to="${jid(to)}"/>`;
const rosterPush = (owner: string, friend: string) => `<iq type="set" to="${jid(owner)}" id="friend-${Date.now()}"><query xmlns="jabber:iq:roster"><item jid="${jid(friend)}" subscription="both"/></query></iq>`;

function accepted(accountId: string){
    return GetDb().select().from(friends).where(eq(friends.ownerId, accountId)).all()
        .filter(row => row.status === "ACCEPTED").map(row => row.friendId);
}

// A dropped connection is often followed within seconds by a reconnect
// (travel, a missed pong). Announcing "offline" at once made friends see the
// player go offline and online again, and each "online" makes the client
// rebuild that friend's social entries. Offline is announced only if the
// account is still gone after the grace period.
export const OFFLINE_GRACE_MS = 15_000;
const pendingOffline = new Map<string, ReturnType<typeof setTimeout>>();

export async function onResourceAvailable(accountId: string, resource: string){
    const pending = pendingOffline.get(accountId);
    if(pending !== undefined){
        clearTimeout(pending);
        pendingOffline.delete(accountId);
    }
    let sent = 0;
    for(const friendId of accepted(accountId)){
        for(const friendConnection of sessionRegistry.connectionsFor(friendId)){
            friendConnection.send(available(accountId, resource, friendId));
            const friendResource = friendConnection.resource ?? "";
            for(const ownConnection of sessionRegistry.connectionsFor(accountId)){
                ownConnection.send(available(friendId, friendResource, accountId));
            }
            sent++;
        }
    }
    logger.info(`[XMPP] ${accountId} online; delivered ${sent} friend presence pair(s)`);
}

export async function onResourceUnavailable(accountId: string, graceMs: number = OFFLINE_GRACE_MS){
    if(sessionRegistry.isOnline(accountId) || pendingOffline.has(accountId)) return;
    const announce = () => {
        pendingOffline.delete(accountId);
        if(sessionRegistry.isOnline(accountId)) return;
        for(const friendId of accepted(accountId)){
            for(const connection of sessionRegistry.connectionsFor(friendId)) connection.send(unavailable(accountId, friendId));
        }
    };
    if(graceMs <= 0){ announce(); return; }
    const timer = setTimeout(announce, graceMs);
    timer.unref?.();
    pendingOffline.set(accountId, timer);
}

export function notifyFriendshipAccepted(a: string, b: string){
    for(const [owner, other] of [[a,b],[b,a]]){
        for(const connection of sessionRegistry.connectionsFor(owner)){
            connection.send(rosterPush(owner, other));
            for(const otherConnection of sessionRegistry.connectionsFor(other))
                connection.send(available(other, otherConnection.resource ?? "", owner));
        }
    }
}

// Friend list changes. The client applies them only from Epic friends-service
// messages sent by xmpp-admin (FOnlineFriendsMcp::OnXmppMessageReceived,
// 0x1408ba550): com.epicgames.friends.core.apiobjects.Friend carries the
// entry as GET /friends returns it, and ...FriendRemoval drops it. Without
// them an open client keeps showing a request as pending after it was
// accepted or removed, until the next login re-reads the list.
const FRIEND = "com.epicgames.friends.core.apiobjects.Friend";
const FRIEND_REMOVAL = "com.epicgames.friends.core.apiobjects.FriendRemoval";
const adminMessage = (to: string, type: string, payload: object) =>
    `<message id="friends-${randomUUID()}" from="xmpp-admin@${DOMAIN}" to="${jid(to)}"><body>${escapeXml(JSON.stringify({ type, payload, timestamp: new Date().toISOString() }))}</body></message>`;

// Sends both players their current entry for the other, read from the
// database, so it is correct whatever the change was.
export function notifyFriendEntries(a: string, b: string){
    for(const [owner, other] of [[a, b], [b, a]]){
        const connections = sessionRegistry.connectionsFor(owner);
        if(connections.length === 0) continue;
        const row = GetDb().select().from(friends).where(and(eq(friends.ownerId, owner), eq(friends.friendId, other))).get();
        const frame = row == undefined
            ? adminMessage(owner, FRIEND_REMOVAL, { accountId: other, reason: "DELETED" })
            : adminMessage(owner, FRIEND, { accountId: other, status: row.status, direction: row.direction, created: row.createdAt, favorite: false });
        for(const connection of connections) connection.send(frame);
    }
}

export function isLocallyOnline(accountId: string){ return sessionRegistry.isOnline(accountId); }
