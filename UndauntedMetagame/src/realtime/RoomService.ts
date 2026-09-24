/*
 * New work for the Undaunted fork (Harmonicrain/Undaunted), September 2026.
 * Text chat rooms for the XMPPSession / PresenceService code, which is derived
 * from Mystic Paradox (see NOTICE.md).
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { logger } from "../logger";
import { escapeXml, sanitizeName } from "./xml";
import { sessionRegistry, RegisteredConnection } from "./SessionRegistry";

// Text chat: multi-user chat rooms (XEP-0045, the subset the client uses) and
// direct messages. The client joins City-, Party- and Hunt- rooms on
// muc.prod.ol.epicgames.com with a presence to room/nick, and only lets the
// player type in a room once its own presence comes back marked as self
// (status 110); until then it reports "Unable to send message". A groupchat
// message is reflected to every occupant, the sender included. Rooms live in
// memory: they are transient, like the worlds and parties they belong to.

const DOMAIN = "prod.ol.epicgames.com";
const MUC_USER = "http://jabber.org/protocol/muc#user";

type Occupant = { nick: string; accountId: string; resource: string; conn: RegisteredConnection };

// Room bare JID (lower-case) -> occupants by connection id.
const rooms = new Map<string, Map<string, Occupant>>();
// Display form of each room JID, as the first joiner sent it.
const roomNames = new Map<string, string>();

const realJid = (Entry: { accountId: string; resource: string }) => `${Entry.accountId}@${DOMAIN}/${Entry.resource}`;

function splitJid(Jid: string){
    const Slash = Jid.indexOf("/");
    return Slash < 0 ? { bare: Jid, resource: "" } : { bare: Jid.slice(0, Slash), resource: Jid.slice(Slash + 1) };
}

function OccupantPresence(Room: string, Of: Occupant, To: Occupant, Self: boolean, Available = true){
    return `<presence from="${escapeXml(`${Room}/${Of.nick}`)}" to="${escapeXml(realJid(To))}"${Available ? "" : ` type="unavailable"`}>` +
        `<x xmlns="${MUC_USER}"><item affiliation="member" role="${Available ? "participant" : "none"}" jid="${escapeXml(realJid(Of))}"/>` +
        (Self ? `<status code="110"/>` : "") + `</x></presence>`;
}

export function JoinRoom(Conn: RegisteredConnection, AccountId: string, Resource: string, To: string){
    const { bare, resource: Nick } = splitJid(To);
    const Key = bare.toLowerCase();

    // A nick names its owner; a player cannot speak under someone else's account.
    if(!Nick || (/UID-/.test(Nick) && !Nick.includes(AccountId))){
        Conn.send(`<presence from="${escapeXml(To)}" to="${escapeXml(realJid({ accountId: AccountId, resource: Resource }))}" type="error">` +
            `<error type="cancel"><not-acceptable xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></error></presence>`);
        logger.warn(`[XMPP] MUC join refused for ${AccountId}: nick does not belong to the account`);
        return;
    }

    let Occupants = rooms.get(Key);
    if(Occupants == undefined){
        Occupants = new Map();
        rooms.set(Key, Occupants);
        roomNames.set(Key, bare);
    }
    const Room = roomNames.get(Key) ?? bare;
    const Joiner: Occupant = { nick: Nick, accountId: AccountId, resource: Resource, conn: Conn };
    const Rejoin = Occupants.has(Conn.connId);
    Occupants.set(Conn.connId, Joiner);

    // Everyone already present, then the joiner's own presence (status 110),
    // then an empty subject: the order XEP-0045 gives, which completes the join.
    for(const Other of Occupants.values()){
        if(Other.conn.connId !== Conn.connId) Conn.send(OccupantPresence(Room, Other, Joiner, false));
    }
    Conn.send(OccupantPresence(Room, Joiner, Joiner, true));
    Conn.send(`<message type="groupchat" from="${escapeXml(Room)}" to="${escapeXml(realJid(Joiner))}"><subject/></message>`);

    if(!Rejoin){
        for(const Other of Occupants.values()){
            if(Other.conn.connId !== Conn.connId) Other.conn.send(OccupantPresence(Room, Joiner, Other, false));
        }
    }
    logger.info(`[XMPP] MUC ${sanitizeName(Room.split("@")[0])}: ${sanitizeName(Nick.split(":")[0])} joined (${Occupants.size} present)`);
}

export function LeaveRoom(Conn: RegisteredConnection, To: string){
    const Key = splitJid(To).bare.toLowerCase();
    const Occupants = rooms.get(Key);
    const Leaver = Occupants?.get(Conn.connId);
    if(!Occupants || !Leaver) return;

    const Room = roomNames.get(Key) ?? Key;
    Occupants.delete(Conn.connId);
    Conn.send(OccupantPresence(Room, Leaver, Leaver, true, false));
    for(const Other of Occupants.values()) Other.conn.send(OccupantPresence(Room, Leaver, Other, false, false));
    if(Occupants.size === 0){ rooms.delete(Key); roomNames.delete(Key); }
}

// A connection that closes leaves every room it was in.
export function LeaveAllRooms(Conn: RegisteredConnection){
    for(const Key of [...rooms.keys()]){
        if(rooms.get(Key)?.has(Conn.connId)) LeaveRoom(Conn, roomNames.get(Key) ?? Key);
    }
}

export function SendGroupchat(Conn: RegisteredConnection, To: string, StanzaId: string, Body: string){
    const Key = splitJid(To).bare.toLowerCase();
    const Occupants = rooms.get(Key);
    const Sender = Occupants?.get(Conn.connId);
    // Only occupants may speak in a room.
    if(!Occupants || !Sender) return false;

    const Room = roomNames.get(Key) ?? Key;
    for(const Other of Occupants.values()){
        Other.conn.send(`<message type="groupchat" id="${escapeXml(StanzaId)}" from="${escapeXml(`${Room}/${Sender.nick}`)}" to="${escapeXml(realJid(Other))}">` +
            `<body>${escapeXml(Body)}</body></message>`);
    }
    return true;
}

// Direct (whisper) messages go to every connection of the addressed account,
// or to the one resource named.
export function SendDirect(AccountId: string, Resource: string, To: string, StanzaId: string, Body: string){
    const { bare, resource } = splitJid(To);
    const TargetAccount = bare.split("@")[0];
    if(!TargetAccount) return 0;
    const Targets = resource ? [sessionRegistry.connectionFor(TargetAccount, resource)].filter((C): C is RegisteredConnection => C != undefined)
        : sessionRegistry.connectionsFor(TargetAccount);
    const From = `${AccountId}@${DOMAIN}/${Resource}`;
    for(const Recipient of Targets){
        Recipient.send(`<message type="chat" id="${escapeXml(StanzaId)}" from="${escapeXml(From)}" to="${escapeXml(`${Recipient.accountId}@${DOMAIN}/${Recipient.resource}`)}">` +
            `<body>${escapeXml(Body)}</body></message>`);
    }
    return Targets.length;
}

type ChatAction = {
    room?: { kind: "join" | "leave"; to: string } | { kind: "groupchat"; to: string; stanzaId: string; body: string };
    direct?: { to: string; stanzaId: string; body: string };
};

// The one entry point both XMPP transports (WebSocket and raw TCP) call with a
// session's parsed stanza.
export function ApplyChatAction(Conn: RegisteredConnection, AccountId: string, Resource: string, Action: ChatAction){
    const Room = Action.room;
    if(Room?.kind === "join") JoinRoom(Conn, AccountId, Resource, Room.to);
    else if(Room?.kind === "leave") LeaveRoom(Conn, Room.to);
    else if(Room?.kind === "groupchat") SendGroupchat(Conn, Room.to, Room.stanzaId, Room.body);
    if(Action.direct) SendDirect(AccountId, Resource, Action.direct.to, Action.direct.stanzaId, Action.direct.body);
}

export function RoomOccupantCount(Room: string){
    return rooms.get(splitJid(Room).bare.toLowerCase())?.size ?? 0;
}
