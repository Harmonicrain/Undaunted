import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { GetDb } from "../db";
import { friendblocks, friends, slayerlinkinvites, slayerlinks, users } from "../db/schema";

// Values can be tuned without changing stored expiry times for existing links.
export const LINK_SLOTS = 3;
export const INVITE_EXPIRY_HOURS = 24;
export const LINK_DURATION_HOURS = 168;

export class SlayerLinkError extends Error {
    constructor(public status: number, message: string){ super(message); }
}

function Friend(tx: any, a: string, b: string){
    return tx.select().from(friends).where(and(eq(friends.ownerId, a), eq(friends.friendId, b))).get()?.status === "ACCEPTED";
}
function Blocked(tx: any, a: string, b: string){
    return tx.select().from(friendblocks).where(or(
        and(eq(friendblocks.ownerId, a), eq(friendblocks.blockedId, b)),
        and(eq(friendblocks.ownerId, b), eq(friendblocks.blockedId, a))
    )).get() != undefined;
}
function ActiveLinks(tx: any, accountId: string, now: number){
    return tx.select().from(slayerlinks).where(or(eq(slayerlinks.senderId, accountId), eq(slayerlinks.targetId, accountId)))
        .all().filter((link: any) => link.endsAt > now);
}
function SlotFor(link: any, accountId: string){ return link.senderId === accountId ? link.senderSlot : link.targetSlot; }
function FreeSlot(tx: any, accountId: string, now: number){
    const used = new Set<number>(ActiveLinks(tx, accountId, now).map((link: any) => SlotFor(link, accountId)));
    for(let slot = 0; slot < LINK_SLOTS; slot++) if(!used.has(slot)) return slot;
    return undefined;
}

export function ListInvites(accountId: string){
    const now = Date.now();
    return GetDb().select().from(slayerlinkinvites)
        .where(or(eq(slayerlinkinvites.senderId, accountId), eq(slayerlinkinvites.targetId, accountId)))
        .all().filter(row => row.status === "PENDING" && row.expiresAt > now)
        .map(row => ({
            linked_account_id: row.senderId === accountId ? row.targetId : row.senderId,
            slot: row.senderSlot,
            direction: row.senderId === accountId ? "Sent" : "Received",
            status: "Pending",
            expires: new Date(row.expiresAt).toISOString(),
            link_id: row.inviteId
        }));
}

export function ListLinks(accountId: string){
    const now = Date.now();
    return ActiveLinks(GetDb(), accountId, now).map((link: any) => ({
        linked_account_id: link.senderId === accountId ? link.targetId : link.senderId,
        slot: SlotFor(link, accountId),
        ends: new Date(link.endsAt).toISOString(),
        link_id: link.linkId,
        progress: link.progress
    }));
}

export function ListAvailability(accountId: string, ids: string[]){
    const tx = GetDb();
    const now = Date.now();
    const occupied = new Set(ActiveLinks(tx, accountId, now).map((link: any) =>
        link.senderId === accountId ? link.targetId : link.senderId));
    return ids.slice(0, 50).map(id => ({
        account_id: id,
        available: id !== accountId && !occupied.has(id) &&
            !!tx.select().from(users).where(eq(users.userId, id)).get() &&
            Friend(tx, accountId, id) && Friend(tx, id, accountId) &&
            !tx.select().from(slayerlinkinvites).all().some((invite: any) =>
                invite.status === "PENDING" && invite.expiresAt > now &&
                ((invite.senderId === accountId && invite.targetId === id) ||
                 (invite.senderId === id && invite.targetId === accountId))) &&
            !Blocked(tx, accountId, id) && FreeSlot(tx, id, now) !== undefined && FreeSlot(tx, accountId, now) !== undefined
    }));
}

export function Invite(accountId: string, targetId: string, requestedSlot: number){
    if(!targetId || targetId === accountId || !Number.isInteger(requestedSlot) || requestedSlot < 0 || requestedSlot >= LINK_SLOTS){
        throw new SlayerLinkError(400, "Invalid account or Slayer Link slot");
    }
    return GetDb().transaction((tx) => {
        if(!tx.select().from(users).where(eq(users.userId, targetId)).get()) throw new SlayerLinkError(404, "Unknown account");
        if(Blocked(tx, accountId, targetId)) throw new SlayerLinkError(403, "Blocked account");
        if(!Friend(tx, accountId, targetId) || !Friend(tx, targetId, accountId)) throw new SlayerLinkError(403, "Both accounts must be friends");
        const now = Date.now();
        if(ActiveLinks(tx, accountId, now).some((link: any) => SlotFor(link, accountId) === requestedSlot)){
            throw new SlayerLinkError(409, "Slot already linked");
        }
        if(ActiveLinks(tx, accountId, now).some((link: any) => link.senderId === targetId || link.targetId === targetId)){
            throw new SlayerLinkError(409, "Already linked to this account");
        }
        if(FreeSlot(tx, targetId, now) === undefined) throw new SlayerLinkError(409, "Recipient has no free slot");
        const pending = tx.select().from(slayerlinkinvites).all().find((row: any) =>
            row.status === "PENDING" && row.expiresAt > now &&
            ((row.senderId === accountId && row.targetId === targetId) ||
             (row.senderId === targetId && row.targetId === accountId)));
        if(pending){
            if(pending.senderId === accountId) return pending.inviteId;
            throw new SlayerLinkError(409, "This player already invited you");
        }
        const inviteId = randomUUID();
        tx.insert(slayerlinkinvites).values({
            inviteId, senderId: accountId, targetId, senderSlot: requestedSlot,
            createdAt: now, expiresAt: now + INVITE_EXPIRY_HOURS * 3600_000, status: "PENDING"
        }).run();
        return inviteId;
    }, { behavior: "immediate" });
}

export function AnswerInvite(accountId: string, inviteId: string, action: "accept" | "reject" | "cancel"){
    if(!inviteId){ throw new SlayerLinkError(400, "Missing invite ID"); }
    return GetDb().transaction((tx) => {
        // Some native invite actions identify the other account instead of
        // carrying the generated link ID. Resolve only an invitation that
        // belongs to this authenticated actor.
        const row = tx.select().from(slayerlinkinvites).where(eq(slayerlinkinvites.inviteId, inviteId)).get()
            ?? tx.select().from(slayerlinkinvites).where(and(
                eq(action === "cancel" ? slayerlinkinvites.senderId : slayerlinkinvites.targetId, accountId),
                eq(action === "cancel" ? slayerlinkinvites.targetId : slayerlinkinvites.senderId, inviteId),
                eq(slayerlinkinvites.status, "PENDING")
            )).get();
        if(!row) throw new SlayerLinkError(404, "Unknown invitation");
        if(action === "cancel" ? row.senderId !== accountId : row.targetId !== accountId){
            throw new SlayerLinkError(403, "Invitation belongs to another account");
        }
        if(row.status !== "PENDING"){
            if(row.status === (action === "accept" ? "ACCEPTED" : action === "reject" ? "REJECTED" : "CANCELED")) return row.inviteId;
            throw new SlayerLinkError(409, "Invitation already answered");
        }
        const now = Date.now();
        if(row.expiresAt <= now) throw new SlayerLinkError(409, "Invitation expired");
        if(action === "accept"){
            if(Blocked(tx, row.senderId, row.targetId) || !Friend(tx, row.senderId, row.targetId) || !Friend(tx, row.targetId, row.senderId)){
                throw new SlayerLinkError(403, "Accounts are no longer friends");
            }
            if(ActiveLinks(tx, row.senderId, now).some((link: any) => SlotFor(link, row.senderId) === row.senderSlot)){
                throw new SlayerLinkError(409, "Inviter slot is occupied");
            }
            if(ActiveLinks(tx, row.senderId, now).some((link: any) => link.senderId === row.targetId || link.targetId === row.targetId)){
                throw new SlayerLinkError(409, "Already linked to this account");
            }
            const recipientSlot = FreeSlot(tx, row.targetId, now);
            if(recipientSlot === undefined) throw new SlayerLinkError(409, "Recipient has no free slot");
            tx.insert(slayerlinks).values({
                linkId: row.inviteId, senderId: row.senderId, targetId: row.targetId,
                senderSlot: row.senderSlot, targetSlot: recipientSlot,
                createdAt: now, endsAt: now + LINK_DURATION_HOURS * 3600_000, progress: 0
            }).run();
        }
        tx.update(slayerlinkinvites).set({ status: action === "accept" ? "ACCEPTED" : action === "reject" ? "REJECTED" : "CANCELED" })
            .where(eq(slayerlinkinvites.inviteId, row.inviteId)).run();
        return row.inviteId;
    }, { behavior: "immediate" });
}

export function DeleteLink(accountId: string, slot: number){
    if(!Number.isInteger(slot) || slot < 0 || slot >= LINK_SLOTS) throw new SlayerLinkError(400, "Invalid slot");
    GetDb().transaction((tx) => {
        const link = ActiveLinks(tx, accountId, Date.now()).find((row: any) => SlotFor(row, accountId) === slot);
        if(link) tx.delete(slayerlinks).where(eq(slayerlinks.linkId, link.linkId)).run();
    }, { behavior: "immediate" });
}
