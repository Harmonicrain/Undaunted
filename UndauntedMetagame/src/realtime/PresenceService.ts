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
import { eq } from "drizzle-orm";
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

export async function onResourceAvailable(accountId: string, resource: string){
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

export async function onResourceUnavailable(accountId: string){
    if(sessionRegistry.isOnline(accountId)) return;
    for(const friendId of accepted(accountId)){
        for(const connection of sessionRegistry.connectionsFor(friendId)) connection.send(unavailable(accountId, friendId));
    }
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

export function isLocallyOnline(accountId: string){ return sessionRegistry.isOnline(accountId); }
