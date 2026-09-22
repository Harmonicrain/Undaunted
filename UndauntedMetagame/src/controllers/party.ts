import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { GetDb } from "../db";
import { users } from "../db/schema";

// Parties represent live sessions. A backend restart dissolves them, which is
// safer than restoring a party tied to an expired world/candidate.
export type Party = { partyId: string, leaderPlayerId: string, members: string[], buildId: string };
export type PartyInvite = { inviteId: string, partyId: string, recipientPlayerId: string,
    sendingPlayerId: string, sendingDisplayName: string, sendingPlatform: "win", expiresAt: number };
export class PartyError extends Error { constructor(public status: number, message: string){ super(message); } }

const parties = new Map<string, Party>();
const membership = new Map<string, string>();
const invites = new Map<string, PartyInvite>();
const INVITE_TTL = 10 * 60_000;

export function GetPartyForPlayer(accountId: string){
    const id = membership.get(accountId);
    return id ? parties.get(id) : undefined;
}
export function GetOrCreateParty(accountId: string, buildId = ""){
    const current = GetPartyForPlayer(accountId);
    if(current) return current;
    const party: Party = { partyId: randomUUID(), leaderPlayerId: accountId, members: [accountId], buildId };
    parties.set(party.partyId, party);
    membership.set(accountId, party.partyId);
    return party;
}
export function GetInvitesForPlayer(accountId: string){
    const now = Date.now();
    return [...invites.values()].filter(invite => invite.recipientPlayerId === accountId && invite.expiresAt > now && parties.has(invite.partyId));
}
export function InviteToParty(actorId: string, recipientId: string, buildId = ""){
    if(!recipientId || recipientId === actorId) throw new PartyError(400, "Invalid recipient");
    const target = GetDb().select().from(users).where(eq(users.userId, recipientId)).get();
    if(!target) throw new PartyError(404, "Recipient not found");
    const party = GetOrCreateParty(actorId, buildId);
    if(party.leaderPlayerId !== actorId) throw new PartyError(403, "Only the leader can invite");
    if(party.members.length >= 4) throw new PartyError(409, "Party is full");
    if(party.members.includes(recipientId)) return;
    const existing = [...invites.values()].find(invite => invite.partyId === party.partyId && invite.recipientPlayerId === recipientId && invite.expiresAt > Date.now());
    if(existing) return;
    const sender = GetDb().select().from(users).where(eq(users.userId, actorId)).get();
    const inviteId = randomUUID();
    invites.set(inviteId, { inviteId, partyId: party.partyId,
        recipientPlayerId: recipientId, sendingPlayerId: actorId,
        sendingDisplayName: sender?.name ?? actorId, sendingPlatform: "win", expiresAt: Date.now() + INVITE_TTL });
}
export function LeaveParty(accountId: string){
    const party = GetPartyForPlayer(accountId);
    if(!party) return;
    party.members = party.members.filter(id => id !== accountId);
    membership.delete(accountId);
    if(party.members.length === 0){
        parties.delete(party.partyId);
        for(const [id, invite] of invites) if(invite.partyId === party.partyId) invites.delete(id);
    } else if(party.leaderPlayerId === accountId) party.leaderPlayerId = party.members[0];
}
export function AcceptPartyInvite(actorId: string, inviteId: string){
    const invite = [...invites.values()].find(entry => entry.inviteId === inviteId || entry.sendingPlayerId === inviteId && entry.recipientPlayerId === actorId);
    if(!invite || invite.recipientPlayerId !== actorId || invite.expiresAt <= Date.now()){
        // The 1.4.4 client may retry acceptance while applying the party state from
        // the first successful request. Treat that retry as success when the path
        // identifies a member of the party the player has already joined.
        const current = GetPartyForPlayer(actorId);
        if(current?.members.includes(inviteId)) return current;
        throw new PartyError(404, "Invitation unavailable");
    }
    const party = parties.get(invite.partyId);
    if(!party || party.members.length >= 4) throw new PartyError(409, "Party unavailable or full");
    if(GetPartyForPlayer(actorId)?.partyId === party.partyId) return party;
    LeaveParty(actorId);
    party.members.push(actorId);
    membership.set(actorId, party.partyId);
    for(const [id, entry] of invites) if(entry.recipientPlayerId === actorId) invites.delete(id);
    return party;
}
export function KickPartyMember(actorId: string, targetId: string){
    const party = GetPartyForPlayer(actorId);
    if(!party || party.leaderPlayerId !== actorId || targetId === actorId || !party.members.includes(targetId)) throw new PartyError(403, "Cannot kick member");
    LeaveParty(targetId);
}
export function PromotePartyMember(actorId: string, targetId: string){
    const party = GetPartyForPlayer(actorId);
    if(!party || party.leaderPlayerId !== actorId || !party.members.includes(targetId)) throw new PartyError(403, "Cannot promote member");
    party.leaderPlayerId = targetId;
}
