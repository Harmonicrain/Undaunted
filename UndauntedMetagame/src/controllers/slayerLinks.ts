import { createHash, randomUUID } from "node:crypto";
import { and, eq, or, getTableColumns, sql } from "drizzle-orm";
import { GetDb } from "../db";
import { characters, friendblocks, friends, slayerlinkinvites, slayerlinkpools, slayerlinkrequests, slayerlinks, slayerlinkxp, users } from "../db/schema";
import { logger } from "../logger";
import { ApplyInventoryTransaction } from "./inventory";
import { CreditWallet, IsCurrency } from "./wallet";
import { DeriveLinkRank, IsKnownLinkReward, LINK_SLOTS, LinkTrackId, MAX_LINK_RANK, MAX_LINK_REWARDS, ParseLinkTrack } from "./slayerLinkConfig";
import { GetPartyForPlayer } from "./party";
import { isLocallyOnline } from "../realtime/PresenceService";

// Slayer Links for the 1.4.4 client.
//
// The native side owns reward selection and delivery. The gameserver rolls a
// prize pool from the packaged tables and PUTs it here; when a link ends it
// GETs the earned rewards and grants them through its own inventory
// transaction (source SlayerLinks.GrantRewards); afterwards it deletes the
// player's side of the link. This module stores links and pools, derives what
// was earned, and guards the grant so it happens exactly once.
//
// Lifecycle, per participant side of a link:
//   earning     not canceled and createdAt <= now < endsAt
//   listed      not canceled and that side not released (expired links stay
//               listed: the client offers collection only once they expire)
//   occupies    same as listed; the slot is free again once the side releases
//   collectable listed, ended, pool stored and not yet claimed
//   retained    earned-but-unclaimed rewards block releasing the side, so an
//               interrupted collection can always be retried. A side that
//               earned chests but has no stored pool is retained too: its
//               rewards are unknown, not absent, and a late pool write from
//               the gameserver makes them collectable.
//
// Native requests address a link by (account, slot). Only one listed link can
// hold an account's slot, so that pair resolves to a single link generation;
// once a side is released the same pair addresses the next link instead.

export { LINK_SLOTS };
export const INVITE_EXPIRY_HOURS = 24;
export const LINK_DURATION_HOURS = 168;
export const GRANT_SOURCE = "SlayerLinks.GrantRewards";

export class SlayerLinkError extends Error {
    constructor(public status: number, message: string){ super(message); }
}

// Injectable for tests; production always uses the wall clock.
let Clock: () => number = () => Date.now();
export function SetSlayerLinkClock(Fn?: () => number){ Clock = Fn ?? (() => Date.now()); }
function Now(){ return Clock(); }

export type AuthContext = { IsGameserver?: boolean, userId?: string };

export function ReplayLinkMutation(Auth: AuthContext, RequestId: unknown, Operation: string, Body: unknown, Apply: () => unknown){
    // Legacy callers remain supported, but only identified retries can be
    // distinguished from new operations on a reused native slot.
    if(RequestId === undefined) return Apply();
    if(typeof RequestId !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(RequestId)) throw new SlayerLinkError(400, "Invalid request ID");
    const Actor = `${Auth.IsGameserver ? "server" : "player"}:${Auth.userId ?? ""}`;
    const Hash = createHash("sha256").update(JSON.stringify([Operation, Body])).digest("hex");
    return GetDb().transaction(tx => {
        const Existing = tx.select().from(slayerlinkrequests).where(and(eq(slayerlinkrequests.actor, Actor), eq(slayerlinkrequests.requestId, RequestId))).get();
        if(Existing){
            if(Existing.requestHash !== Hash) throw new SlayerLinkError(409, "Request ID reused with different content");
            return JSON.parse(Existing.response);
        }
        const Response = Apply();
        tx.insert(slayerlinkrequests).values({ actor: Actor, requestId: RequestId, requestHash: Hash, response: JSON.stringify(Response), appliedAt: Now() }).run();
        return Response;
    }, { behavior: "immediate" });
}
export type PoolItem = { catalog_id: string, quantity: number, received_for_level: number };
type Link = typeof slayerlinks.$inferSelect;

// ------------------------------------------------------------ link helpers

function SideOf(Link: Link, AccountId: string): "sender" | "target" | undefined {
    return Link.senderId === AccountId ? "sender" : Link.targetId === AccountId ? "target" : undefined;
}
function SlotFor(Link: Link, AccountId: string){ return SideOf(Link, AccountId) === "sender" ? Link.senderSlot : Link.targetSlot; }
function PartnerOf(Link: Link, AccountId: string){ return Link.senderId === AccountId ? Link.targetId : Link.senderId; }
function ReleasedAt(Link: Link, AccountId: string){ return SideOf(Link, AccountId) === "sender" ? Link.senderReleasedAt : Link.targetReleasedAt; }
function ConfirmedRank(Link: Link, AccountId: string){ return SideOf(Link, AccountId) === "sender" ? Link.senderConfirmedRank : Link.targetConfirmedRank; }
function HasEnded(Link: Link, At: number){ return At >= Link.endsAt; }
function IsEarning(Link: Link, At: number){ return Link.canceledAt == null && At >= Link.createdAt && At < Link.endsAt; }
function Occupies(Link: Link, AccountId: string){
    return Link.canceledAt == null && SideOf(Link, AccountId) !== undefined && ReleasedAt(Link, AccountId) == null;
}

function LinksFor(tx: any, AccountId: string): Link[] {
    return tx.select().from(slayerlinks)
        .where(or(eq(slayerlinks.senderId, AccountId), eq(slayerlinks.targetId, AccountId))).all();
}
function ListedLinks(tx: any, AccountId: string){
    return LinksFor(tx, AccountId).filter((Link) => Occupies(Link, AccountId));
}
function ReservedSlot(tx: any, AccountId: string, Slot: number, Except?: string){
    return tx.select().from(slayerlinkinvites).where(eq(slayerlinkinvites.senderId, AccountId)).all()
        .some((Row: any) => Row.inviteId !== Except && Row.status === "PENDING" && Row.expiresAt > Now() && Row.senderSlot === Slot);
}
function FreeSlot(tx: any, AccountId: string){
    const Used = new Set(ListedLinks(tx, AccountId).map((Link) => SlotFor(Link, AccountId)));
    for(let Slot = 1; Slot <= LINK_SLOTS; Slot++) if(!Used.has(Slot) && !ReservedSlot(tx, AccountId, Slot)) return Slot;
    return undefined;
}
function ResolveSide(tx: any, AccountId: string, Slot: number){
    return ListedLinks(tx, AccountId).find((Link) => SlotFor(Link, AccountId) === Slot);
}
function AssertGeneration(Link: Link | undefined, Expected: unknown){
    if(Expected !== undefined && (typeof Expected !== "string" || !Expected || Link?.linkId !== Expected)){
        throw new SlayerLinkError(409, "Slayer Link generation has changed");
    }
}
function IsValidSlot(Slot: unknown): Slot is number {
    return Number.isInteger(Slot) && (Slot as number) >= 1 && (Slot as number) <= LINK_SLOTS;
}
// Either player still listing a link with the other blocks a new one, so
// neither ever sees the same partner in two slots.
function LinkedTo(tx: any, AccountId: string, OtherId: string){
    return ListedLinks(tx, AccountId).some((Link) => PartnerOf(Link, AccountId) === OtherId) ||
        ListedLinks(tx, OtherId).some((Link) => PartnerOf(Link, OtherId) === AccountId);
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

function PoolRow(tx: any, LinkId: string, AccountId: string){
    return tx.select().from(slayerlinkpools)
        .where(and(eq(slayerlinkpools.linkId, LinkId), eq(slayerlinkpools.userId, AccountId))).get();
}
function ParsePool(Row: any): PoolItem[] {
    return Row == undefined ? [] : JSON.parse(Row.pool);
}

// Rewards a participant has earned: the pool entries whose level the link's
// shared total has reached. Entries at -1 (or 0) are display-only.
function EarnedRewards(Link: Link, Pool: PoolItem[]){
    const Rank = DeriveLinkRank(Link.progress);
    return Pool.filter((Item) => Item.received_for_level >= 1 && Item.received_for_level <= Rank);
}

// Totals per catalogue id. Native may split or merge equal items across
// transaction lines, so grants are compared by totals rather than line order.
function Totals(Items: { catalogId: string, quantity: number }[]){
    const Out = new Map<string, number>();
    for(const Item of Items) Out.set(Item.catalogId, (Out.get(Item.catalogId) ?? 0) + Item.quantity);
    return Out;
}
function SameTotals(A: Map<string, number>, B: Map<string, number>){
    return A.size === B.size && [...A].every(([Key, Value]) => B.get(Key) === Value);
}
function RewardTotals(Items: PoolItem[]){
    return Totals(Items.map((Item) => ({ catalogId: Item.catalog_id, quantity: Item.quantity })));
}

// ------------------------------------------------------------ invites and reads

// Invite status names as the client's ELinkInviteStatus spells them.
const INVITE_STATUS: Record<string, string> = { PENDING: "Pending", ACCEPTED: "Accepted", REJECTED: "Declined", CANCELED: "Canceled" };

// Pending invites for both sides, plus answered invites for their sender until
// the invite would have expired. The inviter's client learns that its invite
// was accepted only from this list: the invite-list handler (0x141607670)
// marks the slot it invited from for activation when that invite reads
// Accepted, and the next slot refresh then asks the gameserver to roll the
// prize pool (HandleSlayerLinkSlotActivated -> ServerGeneratePrizePool).
// Declined and Canceled free the inviter's slot the same way. The accepting
// side activates from its own accept callback instead.
export function ListInvites(AccountId: string){
    const At = Now();
    const tx = GetDb();
    const Current = ListedLinks(tx, AccountId);
    const SeenPartners = new Set<string>();
    const SeenSlots = new Set<number>();
    return tx.select({ ...getTableColumns(slayerlinkinvites), rowOrder: sql<number>`rowid` }).from(slayerlinkinvites)
        .where(or(eq(slayerlinkinvites.senderId, AccountId), eq(slayerlinkinvites.targetId, AccountId)))
        .all().sort((A, B) => B.createdAt - A.createdAt || B.rowOrder - A.rowOrder)
        .filter(Row => {
            // Native matches notices by partner, not invite UUID. Never let
            // historical notices reactivate or clear a replacement slot.
            const Partner = Row.senderId === AccountId ? Row.targetId : Row.senderId;
            if(SeenPartners.has(Partner)) return false;
            SeenPartners.add(Partner);
            if(Row.expiresAt <= At || (Row.status !== "PENDING" && Row.senderId !== AccountId)) return false;
            if(Row.senderId === AccountId){
                if(SeenSlots.has(Row.senderSlot)) return false;
                if(Current.some(Link => SlotFor(Link, AccountId) === Row.senderSlot && Link.linkId !== Row.inviteId)) return false;
                SeenSlots.add(Row.senderSlot);
            }
            return true;
        })
        .map(Row => ({
            account_id: Row.senderId === AccountId ? Row.targetId : Row.senderId,
            slot: Row.senderSlot,
            direction: Row.senderId === AccountId ? "Sent" : "Received",
            status: Row.status === "ACCEPTED" && !Current.some(Link => Link.linkId === Row.inviteId)
                ? "Canceled" : INVITE_STATUS[Row.status] ?? "Pending",
            expires: new Date(Row.expiresAt).toISOString(),
            link_id: Row.inviteId
        }));
}

// The link-slot row serializer (0x141600170) reads account_id, slot, ends and
// prize_pool. account_id is the partner; slot is the requesting player's own
// slot. Expired links stay listed until the player's side is released,
// because the client only offers collection for a listed, expired link.
export function ListLinks(AccountId: string){
    const tx = GetDb();
    return ListedLinks(tx, AccountId).map((Link) => ({
        link_id: Link.linkId,
        account_id: PartnerOf(Link, AccountId),
        slot: SlotFor(Link, AccountId),
        ends: new Date(Link.endsAt).toISOString(),
        prize_pool: ParsePool(PoolRow(tx, Link.linkId, AccountId))
    }));
}

export function ListAvailability(AccountId: string, Ids: string[]){
    const tx = GetDb();
    const At = Now();
    return Ids.slice(0, 50).map(Id => ({
        account_id: Id,
        available: Id !== AccountId && !LinkedTo(tx, AccountId, Id) &&
            !!tx.select().from(users).where(eq(users.userId, Id)).get() &&
            Friend(tx, AccountId, Id) && Friend(tx, Id, AccountId) &&
            !tx.select().from(slayerlinkinvites).all().some((Invite: any) =>
                Invite.status === "PENDING" && Invite.expiresAt > At &&
                ((Invite.senderId === AccountId && Invite.targetId === Id) ||
                 (Invite.senderId === Id && Invite.targetId === AccountId))) &&
            !Blocked(tx, AccountId, Id) && FreeSlot(tx, Id) !== undefined && FreeSlot(tx, AccountId) !== undefined
    }));
}

export function Invite(AccountId: string, TargetId: string, RequestedSlot: number){
    if(!TargetId || TargetId === AccountId || !IsValidSlot(RequestedSlot)){
        throw new SlayerLinkError(400, "Invalid account or Slayer Link slot");
    }
    return GetDb().transaction((tx) => {
        if(!tx.select().from(users).where(eq(users.userId, TargetId)).get()) throw new SlayerLinkError(404, "Unknown account");
        if(Blocked(tx, AccountId, TargetId)) throw new SlayerLinkError(403, "Blocked account");
        if(!Friend(tx, AccountId, TargetId) || !Friend(tx, TargetId, AccountId)) throw new SlayerLinkError(403, "Both accounts must be friends");
        const At = Now();
        if(ResolveSide(tx, AccountId, RequestedSlot)) throw new SlayerLinkError(409, "Slot already linked");
        if(LinkedTo(tx, AccountId, TargetId)) throw new SlayerLinkError(409, "Already linked to this account");
        if(FreeSlot(tx, TargetId) === undefined) throw new SlayerLinkError(409, "Recipient has no free slot");
        const Pending = tx.select().from(slayerlinkinvites).all().find((Row: any) =>
            Row.status === "PENDING" && Row.expiresAt > At &&
            ((Row.senderId === AccountId && Row.targetId === TargetId) ||
             (Row.senderId === TargetId && Row.targetId === AccountId)));
        if(Pending){
            if(Pending.senderId === AccountId && Pending.senderSlot === RequestedSlot) return Pending.inviteId;
            throw new SlayerLinkError(409, "This player already invited you");
        }
        if(ReservedSlot(tx, AccountId, RequestedSlot)) throw new SlayerLinkError(409, "Slot has a pending invitation");
        const InviteId = randomUUID();
        tx.insert(slayerlinkinvites).values({
            inviteId: InviteId, senderId: AccountId, targetId: TargetId, senderSlot: RequestedSlot,
            createdAt: At, expiresAt: At + INVITE_EXPIRY_HOURS * 3600_000, status: "PENDING"
        }).run();
        return InviteId;
    }, { behavior: "immediate" });
}

// RecipientSlot is the accepting player's own slot. The 1.4.4 accept path
// (ULinkedSlayersViewModel::AcceptRequest -> 0x1415d4ed0) starts from slot -1
// and replaces it with the first free slot in the recipient's local view
// before AcceptLinkInvite serialises it, so the body carries the recipient's
// choice, not the inviter's slot. Callers that omit it get the lowest free
// slot; a stale choice that is now taken is refused rather than moved.
export function AnswerInvite(AccountId: string, InviteId: string, Action: "accept" | "reject" | "cancel", RecipientSlot?: unknown){
    if(!InviteId){ throw new SlayerLinkError(400, "Missing invite ID"); }
    if(Action === "accept" && RecipientSlot != undefined && !IsValidSlot(RecipientSlot)){
        throw new SlayerLinkError(400, "Invalid Slayer Link slot");
    }
    return GetDb().transaction((tx) => {
        // Native invite actions identify the other account instead of the
        // generated invite id. Resolve only an invitation belonging to this
        // authenticated actor: the pending one if any, otherwise the most
        // recent, so a retried answer is recognised as already applied.
        const At = Now();
        const Row = tx.select().from(slayerlinkinvites).where(eq(slayerlinkinvites.inviteId, InviteId)).get()
            ?? tx.select({ ...getTableColumns(slayerlinkinvites), rowOrder: sql<number>`rowid` }).from(slayerlinkinvites).where(and(
                eq(Action === "cancel" ? slayerlinkinvites.senderId : slayerlinkinvites.targetId, AccountId),
                eq(Action === "cancel" ? slayerlinkinvites.targetId : slayerlinkinvites.senderId, InviteId)
            )).all().sort((A: any, B: any) => B.createdAt - A.createdAt || B.rowOrder - A.rowOrder)[0];
        if(!Row) throw new SlayerLinkError(404, "Unknown invitation");
        if(Action === "cancel" ? Row.senderId !== AccountId : Row.targetId !== AccountId){
            throw new SlayerLinkError(403, "Invitation belongs to another account");
        }
        if(Row.status !== "PENDING"){
            if(Action === "accept" && Row.status === "ACCEPTED"){
                const Link = tx.select().from(slayerlinks).where(eq(slayerlinks.linkId, Row.inviteId)).get();
                if(!Link || !Occupies(Link, Row.senderId) || !Occupies(Link, Row.targetId) ||
                    (RecipientSlot !== undefined && RecipientSlot !== Link.targetSlot)){
                    throw new SlayerLinkError(409, "Accepted invitation no longer identifies this link and slot");
                }
            }
            if(Row.status === (Action === "accept" ? "ACCEPTED" : Action === "reject" ? "REJECTED" : "CANCELED")) return Row.inviteId;
            throw new SlayerLinkError(409, "Invitation already answered");
        }
        if(Row.expiresAt <= At) throw new SlayerLinkError(409, "Invitation expired");
        if(Action === "accept"){
            if(Blocked(tx, Row.senderId, Row.targetId) || !Friend(tx, Row.senderId, Row.targetId) || !Friend(tx, Row.targetId, Row.senderId)){
                throw new SlayerLinkError(403, "Accounts are no longer friends");
            }
            if(ResolveSide(tx, Row.senderId, Row.senderSlot)) throw new SlayerLinkError(409, "Inviter slot is occupied");
            if(ReservedSlot(tx, Row.senderId, Row.senderSlot, Row.inviteId)) throw new SlayerLinkError(409, "Inviter slot has another pending invitation");
            if(LinkedTo(tx, Row.senderId, Row.targetId)) throw new SlayerLinkError(409, "Already linked to this account");
            let Slot: number | undefined;
            if(RecipientSlot == undefined){
                Slot = FreeSlot(tx, Row.targetId);
                if(Slot === undefined) throw new SlayerLinkError(409, "Recipient has no free slot");
            }
            else{
                Slot = RecipientSlot as number;
                if(ResolveSide(tx, Row.targetId, Slot) || ReservedSlot(tx, Row.targetId, Slot)) throw new SlayerLinkError(409, "Recipient slot is occupied or reserved");
            }
            tx.insert(slayerlinks).values({
                linkId: Row.inviteId, senderId: Row.senderId, targetId: Row.targetId,
                senderSlot: Row.senderSlot, targetSlot: Slot,
                createdAt: At, endsAt: At + LINK_DURATION_HOURS * 3600_000, progress: 0
            }).run();
            logger.info(`Slayer Link ${Row.inviteId} formed: ${Row.senderId} slot ${Row.senderSlot} <-> ${Row.targetId} slot ${Slot}`);
        }
        tx.update(slayerlinkinvites).set({ status: Action === "accept" ? "ACCEPTED" : Action === "reject" ? "REJECTED" : "CANCELED" })
            .where(eq(slayerlinkinvites.inviteId, Row.inviteId)).run();
        return Row.inviteId;
    }, { behavior: "immediate" });
}

// ------------------------------------------------------------ deleting a side

// One side of one link, for the account that owns it.
//
// Before the link ends it can only be broken while it has no XP, and breaking
// it cancels it for both players. After it ends, a player only ever releases
// their own side, and only once nothing they earned is still unclaimed - the
// partner's side and rewards are never touched. delete_pair is recorded in the
// log but cannot widen what one player may remove.
function DeleteSide(tx: any, AccountId: string, Slot: number, DeletePair: boolean, ExpectedLinkId?: unknown){
    if(!IsValidSlot(Slot)) throw new SlayerLinkError(400, "Invalid slot");
    const At = Now();
    const Link = ResolveSide(tx, AccountId, Slot);
    AssertGeneration(Link, ExpectedLinkId);
    if(!Link) return "absent" as const;

    if(!HasEnded(Link, At)){
        if(Link.progress > 0){
            throw new SlayerLinkError(409, "A link that has earned XP cannot be broken before it ends");
        }
        tx.update(slayerlinks).set({ canceledAt: At }).where(eq(slayerlinks.linkId, Link.linkId)).run();
        tx.update(slayerlinkinvites).set({ status: "CANCELED" }).where(eq(slayerlinkinvites.inviteId, Link.linkId)).run();
        logger.info(`Slayer Link ${Link.linkId} canceled by ${AccountId} before earning XP`);
        return "canceled" as const;
    }

    const Pool = PoolRow(tx, Link.linkId, AccountId);
    if(Pool == undefined && DeriveLinkRank(Link.progress) > 0){
        throw new SlayerLinkError(409, "This link earned rewards but its prize pool has not been stored yet");
    }
    const Unclaimed = Pool?.claimedAt == null ? EarnedRewards(Link, ParsePool(Pool)) : [];
    if(Unclaimed.length > 0){
        throw new SlayerLinkError(409, "Rewards for this link have not been collected yet");
    }
    tx.update(slayerlinks).set(SideOf(Link, AccountId) === "sender" ? { senderReleasedAt: At } : { targetReleasedAt: At })
        .where(eq(slayerlinks.linkId, Link.linkId)).run();
    logger.info(`Slayer Link ${Link.linkId}: ${AccountId} released slot ${Slot} (delete_pair ${DeletePair})`);
    return "released" as const;
}

export function DeleteLink(AccountId: string, Slot: number, DeletePair = false, ExpectedLinkId?: unknown){
    return GetDb().transaction((tx) => DeleteSide(tx, AccountId, Slot, DeletePair, ExpectedLinkId), { behavior: "immediate" });
}

// DELETE /slayerlink/links: FOnlineLinkedSlayer::DeleteLinks serialises
// {links: [{account_id, slot, delete_pair}]}. The gameserver sends it for
// ServerDeleteLink(slot, bInclusiveDelete). Applied as one unit.
export function DeleteLinks(Auth: AuthContext, Entries: unknown){
    if(!Array.isArray(Entries) || Entries.length === 0 || Entries.length > LINK_SLOTS){
        throw new SlayerLinkError(400, "Expected between one and three links to delete");
    }
    return GetDb().transaction((tx) => Entries.map((Entry: any) => {
        const AccountId = ActorFor(Auth, Entry?.account_id);
        return { account_id: AccountId, slot: Entry?.slot, result: DeleteSide(tx, AccountId, Entry?.slot, Entry?.delete_pair === true, Entry?.link_id) };
    }), { behavior: "immediate" });
}

// A player may only act for themselves. The gameserver names the account; if
// it also relays a player token, the two must agree.
function ActorFor(Auth: AuthContext, Named: unknown){
    if(Auth.IsGameserver === true){
        if(typeof Named !== "string" || Named.length === 0) throw new SlayerLinkError(400, "account_id is required");
        if(typeof Auth.userId === "string" && Auth.userId !== Named) throw new SlayerLinkError(403, "Relayed token does not match account_id");
        return Named;
    }
    if(typeof Auth.userId !== "string") throw new SlayerLinkError(401, "Not authenticated");
    if(Named != undefined && Named !== Auth.userId) throw new SlayerLinkError(403, "Cannot act for another account");
    return Auth.userId;
}

// ------------------------------------------------------------ prize pools

function NormalisePool(Raw: unknown): PoolItem[] {
    if(!Array.isArray(Raw) || Raw.length === 0 || Raw.length > 32){
        throw new SlayerLinkError(400, "prize_pool must be a non-empty array of at most 32 items");
    }
    const Pool = Raw.map((Item: any) => {
        const Entry = { catalog_id: Item?.catalog_id, quantity: Item?.quantity, received_for_level: Item?.received_for_level };
        if(!IsKnownLinkReward(Entry.catalog_id, Entry.quantity)){
            throw new SlayerLinkError(400, `Prize ${JSON.stringify(Item)} is not in the native Slayer Link rewards table`);
        }
        // The native generator marks prizes that are shown but not won with
        // -1, and the one prize won at each chest with that chest's level.
        if(!Number.isInteger(Entry.received_for_level) || Entry.received_for_level < -1 || Entry.received_for_level > MAX_LINK_RANK){
            throw new SlayerLinkError(400, `Prize ${Entry.catalog_id} has invalid received_for_level ${JSON.stringify(Item?.received_for_level)}`);
        }
        return Entry as PoolItem;
    });
    const Awarded = Pool.map((Item) => Item.received_for_level).filter((Level) => Level > 0);
    if(Awarded.length > MAX_LINK_REWARDS || new Set(Awarded).size !== Awarded.length){
        throw new SlayerLinkError(400, `A pool may award at most one prize per chest (${MAX_LINK_REWARDS} chests)`);
    }
    return Pool;
}

// PUT /slayerlink/links/rewards. The generator is native; this only stores
// its result. An identical retry is accepted without change; different
// content for a pool that already exists is refused, so a reroll can never
// replace an outcome. All entries commit together.
//
// The client asks the gameserver for a pool whenever it sees a linked slot
// (HandleSlayerLinkSlotActivated), so an ended link that never got one is
// still given one: the first pool stored for a link is accepted whenever it
// arrives, and every later one is refused.
export function StoreRewardPools(Auth: AuthContext, Body: unknown){
    if(Auth.IsGameserver !== true) throw new SlayerLinkError(403, "Only a gameserver may store prize pools");
    const Entries: any[] = Array.isArray(Body) ? Body
        : Array.isArray((Body as any)?.links) ? (Body as any).links
        : Body != undefined && typeof Body === "object" && "prize_pool" in (Body as any) ? [Body] : [];
    if(Entries.length === 0 || Entries.length > LINK_SLOTS){
        throw new SlayerLinkError(400, "Expected between one and three prize pools");
    }
    const Prepared = Entries.map((Entry) => ({
        accountId: ActorFor(Auth, Entry?.account_id),
        expectedLinkId: Entry?.link_id,
        slot: Entry?.slot,
        pool: NormalisePool(Entry?.prize_pool)
    }));
    return GetDb().transaction((tx) => {
        const At = Now();
        return Prepared.map(({ accountId, slot, pool, expectedLinkId }) => {
            if(!IsValidSlot(slot)) throw new SlayerLinkError(400, "Invalid slot");
            const Link = ResolveSide(tx, accountId, slot);
            AssertGeneration(Link, expectedLinkId);
            if(!Link) throw new SlayerLinkError(404, `No Slayer Link in slot ${slot} for ${accountId}`);
            const Hash = createHash("sha256").update(JSON.stringify(pool)).digest("hex");
            const Existing = PoolRow(tx, Link.linkId, accountId);
            if(Existing){
                if(Existing.poolHash !== Hash) throw new SlayerLinkError(409, "A different prize pool is already stored for this link");
                return { linkId: Link.linkId, stored: false };
            }
            tx.insert(slayerlinkpools).values({
                linkId: Link.linkId, userId: accountId, pool: JSON.stringify(pool), poolHash: Hash, createdAt: At
            }).run();
            logger.info(`Slayer Link ${Link.linkId}: stored ${pool.length}-item prize pool for ${accountId} slot ${slot}: ${JSON.stringify(pool)}`);
            return { linkId: Link.linkId, stored: true };
        });
    }, { behavior: "immediate" });
}

// ------------------------------------------------------------ reward collection

// GET /slayerlink/links/rewards/{account_id}/{slot}. Nothing is marked
// delivered here, because the grant is a separate native inventory
// transaction that can still fail. After a successful grant this returns an
// empty list, which native treats as "nothing to grant".
//
// A gameserver read records servedAt on the pool. The inventory transaction
// that follows carries no link id, so servedAt is what ties it to the link
// whose rewards were just handed out. It consumes nothing.
//
// is_service_granting is always false: the gameserver does the granting.
export function GetRewardGrant(Auth: AuthContext, AccountId: string, Slot: number){
    const Actor = ActorFor(Auth, AccountId);
    if(!IsValidSlot(Slot)) throw new SlayerLinkError(400, "Invalid slot");
    return GetDb().transaction((tx) => {
        const Link = ResolveSide(tx, Actor, Slot);
        if(!Link) throw new SlayerLinkError(404, `No Slayer Link in slot ${Slot} for ${Actor}`);
        if(!HasEnded(Link, Now())) throw new SlayerLinkError(409, "Slayer Link rewards are revealed when the link ends");
        const Pool = PoolRow(tx, Link.linkId, Actor);
        if(Pool == undefined && DeriveLinkRank(Link.progress) > 0){
            logger.warn(`Slayer Link ${Link.linkId}: ${Actor} earned ${DeriveLinkRank(Link.progress)} chest(s) but no prize pool is stored; collection deferred`);
            throw new SlayerLinkError(409, "This link earned rewards but its prize pool has not been stored yet");
        }
        const Rewards = Pool?.claimedAt == null ? EarnedRewards(Link, ParsePool(Pool)) : [];
        if(Pool != undefined && Pool.claimedAt == null && Auth.IsGameserver === true){
            tx.update(slayerlinkpools).set({ servedAt: Now() })
                .where(and(eq(slayerlinkpools.linkId, Link.linkId), eq(slayerlinkpools.userId, Actor))).run();
        }
        return { is_service_granting: false, rewards: Rewards };
    }, { behavior: "immediate" });
}

// The inventory side of collection, called from POST /inventory for
// transactions whose source is SlayerLinks.GrantRewards. It runs inside the
// inventory transaction so the items and the claim commit or roll back
// together.
//
// Native gives each collection attempt a fresh transaction id, so the
// transaction ledger alone cannot stop a second attempt from granting again.
// The claim on the pool row can. A grant claims the link whose rewards the
// gameserver most recently read (servedAt) among the player's unclaimed
// links whose earned rewards it matches exactly; a link whose rewards were
// never read cannot be claimed. A later attempt with the same rewards is
// answered without granting anything; anything else is refused.
export function ApplyLinkRewardGrant(tx: any, Auth: AuthContext, UserId: string, CharacterId: string, TransactionId: string,
    AddInstanced: any[], AddStacked: any[], RemoveInstanced: any[], RemoveStacked: any[], SaveInstanced: any[]){
    if(Auth.IsGameserver !== true) throw new SlayerLinkError(403, "Only a gameserver may grant Slayer Link rewards");
    if((RemoveInstanced ?? []).length > 0 || (RemoveStacked ?? []).length > 0 || (SaveInstanced ?? []).length > 0){
        throw new SlayerLinkError(400, "A Slayer Link grant may only add items");
    }
    if(typeof TransactionId !== "string" || TransactionId.length === 0) throw new SlayerLinkError(400, "transactionId is required");

    const Character = tx.select().from(characters).where(eq(characters.characterId, CharacterId)).get();
    if(Character == undefined || Character.userId !== UserId) throw new SlayerLinkError(403, "Character does not belong to this account");

    const Stacked = (AddStacked ?? []).map((Item: any) => ({ catalogId: Item?.catalogId, quantity: Number(Item?.quantity) }));
    const Instanced = (AddInstanced ?? []).map((Item: any) => ({ catalogId: Item?.catalogId, quantity: 1 }));
    if([...Stacked, ...Instanced].some((Item) => typeof Item.catalogId !== "string" || !Number.isSafeInteger(Item.quantity) || Item.quantity <= 0)){
        throw new SlayerLinkError(400, "Malformed Slayer Link grant item");
    }
    const Requested = Totals([...Stacked, ...Instanced]);
    if(Requested.size === 0) throw new SlayerLinkError(400, "Empty Slayer Link grant");

    const Candidates = LinksFor(tx, UserId).filter((Link) => Link.canceledAt == null && HasEnded(Link, Now()))
        .map((Link) => ({ Link, Pool: PoolRow(tx, Link.linkId, UserId) }))
        .filter(({ Pool }) => Pool != undefined)
        .sort((A, B) => A.Link.endsAt - B.Link.endsAt);

    // A retry of a transaction that already committed replays its stored
    // result through the inventory ledger.
    const Replay = Candidates.find(({ Pool }) => Pool.claimTransactionId === TransactionId);
    if(Replay){
        const Result = ApplyInventoryTransaction(tx, UserId, CharacterId, TransactionId, AddInstanced,
            (AddStacked ?? []).filter((Item: any) => !IsCurrency(Item.catalogId)), [], [], []);
        return { TouchedStackedItems: Result.TouchedStackedItems, Granted: false, LinkId: Replay.Link.linkId };
    }

    const Unclaimed = Candidates
        .filter(({ Link, Pool }) => Pool.claimedAt == null && Pool.servedAt != null && ReleasedAt(Link, UserId) == null &&
            SameTotals(RewardTotals(EarnedRewards(Link, ParsePool(Pool))), Requested))
        .sort((A, B) => B.Pool.servedAt - A.Pool.servedAt)[0];
    if(Unclaimed){
        const Earned = EarnedRewards(Unclaimed.Link, ParsePool(Unclaimed.Pool));
        // Currencies are account balances (GET /balance reads the wallet);
        // everything else is character inventory, as for Hunt Pass rewards.
        const InventoryStacked = (AddStacked ?? []).filter((Item: any) => !IsCurrency(Item.catalogId));
        const Result = ApplyInventoryTransaction(tx, UserId, CharacterId, TransactionId, AddInstanced ?? [], InventoryStacked, [], [], []);
        for(const Item of Stacked.filter((Item: any) => IsCurrency(Item.catalogId))){
            CreditWallet(tx, UserId, Item.catalogId, Item.quantity);
        }
        tx.update(slayerlinkpools).set({
            claimTransactionId: TransactionId, claimCharacterId: CharacterId,
            claimedRewards: JSON.stringify(Earned), claimedAt: Now()
        }).where(and(eq(slayerlinkpools.linkId, Unclaimed.Link.linkId), eq(slayerlinkpools.userId, UserId))).run();
        logger.info(`Slayer Link ${Unclaimed.Link.linkId}: ${UserId} collected ${JSON.stringify(Earned)} in ${TransactionId}`);
        return { TouchedStackedItems: Result.TouchedStackedItems, Granted: true, LinkId: Unclaimed.Link.linkId };
    }

    const AlreadyClaimed = Candidates
        .filter(({ Pool }) => Pool.claimedAt != null && SameTotals(RewardTotals(JSON.parse(Pool.claimedRewards ?? "[]")), Requested))
        .sort((A, B) => (B.Pool.servedAt ?? 0) - (A.Pool.servedAt ?? 0))[0];
    if(AlreadyClaimed){
        logger.warn(`Slayer Link ${AlreadyClaimed.Link.linkId}: ${UserId} repeated collection in ${TransactionId}; already granted in ${AlreadyClaimed.Pool.claimTransactionId}, granting nothing`);
        return { TouchedStackedItems: [], Granted: false, LinkId: AlreadyClaimed.Link.linkId };
    }

    throw new SlayerLinkError(409, "Grant does not match any uncollected Slayer Link rewards");
}

// ------------------------------------------------------------ link XP

// Where a gameserver awarded the XP. Only a gameserver's award carries one.
export type HuntContext = { world: string };

// Slayer Links follow the live game's rule: any Hunt Pass XP (hunts, bounties,
// events, quests) earned while in a party with the linked Slayer advances that
// link. Bounty XP in 1.4.4 is paid by Ramsgate after the party returns, so
// where the award happens does not matter; being partied with the partner
// does. A party member only counts while their client is connected, so a
// party left behind by a closed client cannot earn on its own.
let IsOnline: (AccountId: string) => boolean = isLocallyOnline;
export function SetSlayerLinkOnlineCheck(Fn?: (AccountId: string) => boolean){ IsOnline = Fn ?? isLocallyOnline; }

function PartyPartners(AccountId: string){
    return (GetPartyForPlayer(AccountId)?.members ?? []).filter((Id) => Id !== AccountId && IsOnline(Id));
}

// The award is applied to every earning link whose partner is in the
// player's party when the XP is granted. The event key makes one Hunt Pass
// award count once per link, and the caller runs this inside the transaction
// that applied the award, so link XP can never exist without the Hunt Pass
// XP it came from.
export function ApplyHuntPassXpToLinks(tx: any, UserId: string, Awarded: number, Context: HuntContext | undefined, EventId: string){
    if(!Number.isSafeInteger(Awarded) || Awarded <= 0) return [];
    if(Context == undefined){
        logger.debug(`Hunt Pass XP for ${UserId} was not awarded by a gameserver; Slayer Links unchanged`);
        return [];
    }
    const At = Now();
    const Partners = PartyPartners(UserId);
    const Applied: { linkId: string, progress: number }[] = [];
    if(Partners.length === 0) return Applied;
    for(const Link of LinksFor(tx, UserId)){
        if(!IsEarning(Link, At) || !Partners.includes(PartnerOf(Link, UserId))) continue;
        const Already = tx.select().from(slayerlinkxp)
            .where(and(eq(slayerlinkxp.eventId, EventId), eq(slayerlinkxp.linkId, Link.linkId))).get();
        if(Already) continue;
        const Total = Link.progress + Awarded;
        if(Total > 2147483647) throw new SlayerLinkError(400, "Link progress exceeds the native int32 limit");
        tx.insert(slayerlinkxp).values({
            eventId: EventId, linkId: Link.linkId, sourceUserId: UserId, amount: Awarded, source: `huntpass:${Context.world}`, createdAt: At
        }).run();
        tx.update(slayerlinks).set({ progress: Total }).where(eq(slayerlinks.linkId, Link.linkId)).run();
        Applied.push({ linkId: Link.linkId, progress: Total });
        logger.info(`Slayer Link ${Link.linkId}: +${Awarded} XP from ${UserId} partied with ${PartnerOf(Link, UserId)} in ${Context.world} (total ${Total}, chests ${DeriveLinkRank(Total)})`);
    }
    return Applied;
}

// ------------------------------------------------------------ link tracks

// GET /progression/{account}/Linked_Slayer_Slot_N. Reads the link currently
// in that slot; progress belongs to the link generation, so a reused slot
// starts from zero. An empty slot reads as zero rather than 404.
export function GetLinkTrackWire(AccountId: string, TrackId: string){
    const Slot = ParseLinkTrack(TrackId);
    if(Slot === undefined) throw new SlayerLinkError(404, `Unknown progression track ${TrackId}`);
    const Link = ResolveSide(GetDb(), AccountId, Slot);
    return {
        phx_account_id: AccountId,
        progression_id: LinkTrackId(Slot),
        progress: Link?.progress ?? 0,
        confirmed_fremium_rank: Link ? ConfirmedRank(Link, AccountId) : 0,
        confirmed_premium_rank: 0,
        confirmed_date: new Date(Link?.createdAt ?? 0).toISOString()
    };
}

// Rank confirmation only stops the rank-up celebration replaying. Link tracks
// carry no rank rewards, so nothing is granted and the cursor never runs
// ahead of the chests actually reached.
export function ConfirmLinkTrackRank(AccountId: string, TrackId: string, Rank: number){
    const Slot = ParseLinkTrack(TrackId);
    if(Slot === undefined) throw new SlayerLinkError(404, `Unknown progression track ${TrackId}`);
    if(!Number.isSafeInteger(Rank) || Rank < 0) throw new SlayerLinkError(400, `Invalid rank ${Rank}`);
    GetDb().transaction((tx) => {
        const Link = ResolveSide(tx, AccountId, Slot);
        if(!Link) return;
        const Next = Math.max(ConfirmedRank(Link, AccountId), Math.min(Rank, DeriveLinkRank(Link.progress)));
        tx.update(slayerlinks).set(SideOf(Link, AccountId) === "sender" ? { senderConfirmedRank: Next } : { targetConfirmedRank: Next })
            .where(eq(slayerlinks.linkId, Link.linkId)).run();
    }, { behavior: "immediate" });
    return GetLinkTrackWire(AccountId, TrackId);
}

// Native never grants on these tracks in 1.4.4 (no producer builds the track
// id outside the client's read path). If one ever does, it would double the
// Hunt Pass mirror above, so such grants are logged and ignored.
export function IgnoreNativeLinkTrackGrant(AccountId: string, TrackId: string, Amount: unknown){
    logger.warn(`Ignored direct ${TrackId} grant of ${JSON.stringify(Amount)} for ${AccountId}: link XP comes from shared Hunt Pass awards`);
}
