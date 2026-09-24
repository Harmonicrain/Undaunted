import { eq } from "drizzle-orm";
import { GetDb } from "../db";
import { bounties } from "../db/schema";
import { logger } from "../logger";

// Bounty persistence.
//
// POST /bounty/{account} accepted the client's payload and discarded it, so a
// drafted bounty vanished on relog and bounty progress could never accumulate.
// Bounties are the Hunt Pass XP source, which makes this a prerequisite for XP
// meaning anything.
//
// The payload is stored whole rather than modelled field by field. The native
// gameserver owns objective tracking and posts incremental board updates.
// /bounty/game-data must also list enabled definitions: otherwise the native
// gameserver burns even correctly persisted bounties when loading a world.

// The bounty board is returned inside the usual code/message/payload envelope.
//
// An earlier change served it bare, on the inference that "bounties" and
// "draft_data" appearing as ASCII strings in the executable made them root
// keys. Observation disproved that: served bare, the gameserver parsed nothing
// and posted back a board with no history and zero counts. Served wrapped, it
// reads draft_data correctly. String placement proves vocabulary, not shape.
//
// draft_data_daily and draft_data_weekly appeared in the original stub but do
// not occur anywhere in this executable; they belong to a later build.
const EmptyDraft = () => ({
    current_draft_choices: [],
    previous_draft_selections: [],
    bronze_count: 0,
    silver_count: 0,
    gold_count: 0
});

export function EmptyBountyPayload(){
    return {
        bounties: [],
        draft_data: EmptyDraft()
    };
}

export function GetBountiesForUser(UserId: string){
    const Row = GetDb().select().from(bounties).where(eq(bounties.userId, UserId)).get();

    if(Row == undefined){
        return EmptyBountyPayload();
    }

    try{
        return JSON.parse(Row.payload);
    } catch{
        // A corrupt row must not lock the player out of the bounty board.
        logger.error(`Stored bounties for ${UserId} are not valid JSON; returning an empty board`);

        return EmptyBountyPayload();
    }
}

// The client posts an INCREMENTAL update, not the whole board. Drafting three
// bounties produces three calls, each carrying only the bounty just drafted:
//
//   bounties:[{bounty_id:"Bounty_Bronze_KillAxePike",    slot_index:0}]
//   bounties:[{bounty_id:"Bounty_Bronze_HuntsSwordTwo",  slot_index:1}]
//   bounties:[{bounty_id:"Bounty_Silver_HuntsSwordTwo",  slot_index:2}]
//
// Storing the payload verbatim therefore kept only the most recently drafted
// bounty and silently dropped the rest. Incoming bounties are merged instead.
//
// draft_data is different: it is full state on every call, with
// previous_draft_selections accumulating and the counts current, so those are
// replaced wholesale.

// Whether a post is the gameserver announcing a full board reset.
//
// Deliberately narrow. A draft-options refresh also carries an empty bounties
// list, but it keeps its history and non-zero counts, so it never matches.
//
// previous_draft_selections is NOT used to prune individual bounties, even
// though every held bounty was drafted at some point: the history is capped at
// history_length (10), so a bounty held while ten others were drafted would
// fall out of it and be wrongly dropped.
function IsFullReset(DraftData: any){
    if(DraftData == undefined || typeof DraftData !== "object"){
        return false;
    }

    const History = DraftData.previous_draft_selections;
    const Choices = DraftData.current_draft_choices;

    return Array.isArray(History) && History.length === 0
        && Array.isArray(Choices) && Choices.length === 0
        && DraftData.bronze_count === 0
        && DraftData.silver_count === 0
        && DraftData.gold_count === 0;
}

// 1.12.0 keeps three kinds of bounty in one list, each numbering its own slots
// from 0: drafted bounties (Bounty_*, draft_data), the daily challenge
// (Challenge_Daily_*, draft_data_daily, always slot 0) and the season
// challenges (Challenge_Season_*-seasonNN-W, draft_data_weekly, slots 0-9 for
// every week at once). A slot therefore only identifies a bounty within its
// kind: displacing across kinds let each world load's season challenges and
// daily challenge wipe the player's drafted bounties. Season challenges of
// different weeks share slot numbers while all being held, so they are
// replaced by id alone. 1.4.4 only has drafted bounties.
type BountyKind = "drafted" | "daily" | "challenge";

function KindOf(Entry: any): BountyKind {
    const Id = typeof Entry?.bounty_id === "string" ? Entry.bounty_id : "";
    if(Id.startsWith("Challenge_Daily_")) return "daily";
    if(Id.startsWith("Challenge_")) return "challenge";
    return "drafted";
}

function Displaces(Incoming: any, Stored: any){
    if(Incoming?.bounty_id === Stored?.bounty_id) return true;
    const Kind = KindOf(Incoming);
    return Kind !== "challenge" && Kind === KindOf(Stored) && Incoming?.slot_index === Stored?.slot_index;
}

function MergeBounties(Stored: any, Incoming: any){
    const Merged = { ...Stored, ...Incoming };

    const IncomingBounties: any[] = Array.isArray(Incoming?.bounties) ? Incoming.bounties : [];
    const StoredBounties: any[] = Array.isArray(Stored?.bounties) ? Stored.bounties : [];

    // A full reset is the one case where an empty list DOES mean "I hold
    // nothing". When ServerInitializeBounties resets a board and refunds its
    // tokens, the gameserver posts an empty list together with a draft_data
    // that has no history and zero counts:
    //
    //   {"bounties":[],"draft_data":{"current_draft_choices":[],
    //    "previous_draft_selections":[],"bronze_count":0,"silver_count":0,"gold_count":0}}
    //
    // Ignoring that left the reset bounties stored. They were harmless only
    // while every id was rejected as disabled; once bounty_data enabled them,
    // they came back on the next login as ghosts the player had already been
    // refunded for.
    // draft_data describes the drafted board only, so its reset clears only
    // drafted bounties; the challenges are not part of that board.
    if(IncomingBounties.length === 0 && IsFullReset(Incoming?.draft_data)){
        Merged.bounties = StoredBounties.filter((Entry) => KindOf(Entry) !== "drafted");

        return Merged;
    }

    // Otherwise an empty list means "nothing new to report", not "I hold no
    // bounties" - the client sends one on every draft-options refresh while
    // still holding its board. Treating that as a clear would wipe everything.
    if(IncomingBounties.length === 0){
        Merged.bounties = StoredBounties;

        return Merged;
    }

    // A slot holds one bounty of its kind, so an incoming entry displaces
    // whatever shared its id, or its slot within the same kind.
    const Kept = StoredBounties.filter((Entry) =>
        !IncomingBounties.some((Incoming) => Displaces(Incoming, Entry)));

    Merged.bounties = [...Kept, ...IncomingBounties];

    return Merged;
}

export function SaveBountiesForUser(UserId: string, Payload: unknown){
    if(Payload == undefined || typeof Payload !== "object"){
        throw new Error("Bounty payload must be an object");
    }

    const Serialised = JSON.stringify(MergeBounties(GetBountiesForUser(UserId), Payload));

    const Existing = GetDb().select().from(bounties).where(eq(bounties.userId, UserId)).get();

    if(Existing == undefined){
        GetDb().insert(bounties).values({
            userId: UserId, payload: Serialised, updatedAt: Date.now()
        }).run();
    }
    else{
        GetDb().update(bounties).set({ payload: Serialised, updatedAt: Date.now() })
            .where(eq(bounties.userId, UserId)).run();
    }

    return GetBountiesForUser(UserId);
}

// DeleteBountiesEndpoint. Abandoning a bounty posts
// {"bounty_ids":["Bounty_Bronze_PartDamageReduce"]} to
// /bounty/delete/{account}. The route did not exist, so the gameserver got a
// 404 and the client showed "An error occured. Please try again later."
//
// Removal is by id; draft_data is left alone because the client sends its own
// updated counts separately through the normal save path.
export function RemoveBountiesForUser(UserId: string, BountyIds: unknown){
    if(!Array.isArray(BountyIds)){
        throw new Error("bounty_ids must be an array");
    }

    const ToRemove = new Set(BountyIds.filter((Id) => typeof Id === "string"));

    const Board = GetBountiesForUser(UserId);
    const Existing: any[] = Array.isArray(Board.bounties) ? Board.bounties : [];

    Board.bounties = Existing.filter((Entry: any) => !ToRemove.has(Entry?.bounty_id));

    const Removed = Existing.length - Board.bounties.length;

    GetDb().update(bounties).set({ payload: JSON.stringify(Board), updatedAt: Date.now() })
        .where(eq(bounties.userId, UserId)).run();

    logger.info(`Removed ${Removed} bounty(s) for ${UserId}`);

    return Board;
}
