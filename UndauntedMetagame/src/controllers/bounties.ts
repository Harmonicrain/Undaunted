import { eq, sql } from "drizzle-orm";
import { GetDb } from "../db";
import { bounties, bountyretirements } from "../db/schema";
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
// 1.12 additionally supplies draft_data_daily and draft_data_weekly.
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

export function GetBountiesForUser(UserId: string, Now = new Date()){
    const Row = GetDb().select().from(bounties).where(eq(bounties.userId, UserId)).get();

    if(Row == undefined){
        return EmptyBountyPayload();
    }

    try{
        return WithoutExpiredDailyChallenges(JSON.parse(Row.payload), Now);
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

// A daily challenge occupies its slot only for the UTC grant window in which
// it was drafted. Returning an older entry makes the native gameserver believe
// the slot is still occupied, so it never consumes the new day's automatic
// draft token and the client is left displaying the expired challenge at 0s.
//
// Keep malformed or legacy entries with no timestamp: silently deleting data
// whose age cannot be established would be worse than leaving it untouched.
function WithoutExpiredDailyChallenges(Board: any, Now: Date){
    const Entries: any[] = Array.isArray(Board?.bounties) ? Board.bounties : [];
    const WindowStart = Date.UTC(Now.getUTCFullYear(), Now.getUTCMonth(), Now.getUTCDate());

    Board.bounties = Entries.filter((Entry) => {
        if(KindOf(Entry) !== "daily") return true;

        const DraftedAt = Date.parse(Entry?.drafted_timestamp);
        return !Number.isFinite(DraftedAt) || DraftedAt >= WindowStart;
    });

    return Board;
}

function Displaces(Incoming: any, Stored: any){
    if(Incoming?.bounty_id === Stored?.bounty_id) return true;
    const Kind = KindOf(Incoming);
    return Kind !== "challenge" && Kind === KindOf(Stored) && Incoming?.slot_index === Stored?.slot_index;
}

const DraftTime = (Entry: any) => Date.parse(Entry?.drafted_timestamp);
const HasVersion = (Entry: any) => Number.isSafeInteger(Entry?.update_version) && Entry.update_version >= 0;
const DraftField = (Entry: any) => ({ drafted: "draft_data", daily: "draft_data_daily", challenge: "draft_data_weekly" })[KindOf(Entry)];

function CanReplace(Incoming: any, Stored: any){
    const OldTime = DraftTime(Stored), NewTime = DraftTime(Incoming);
    // A later draft is a new generation, even when its version restarts at 0.
    if(Number.isFinite(OldTime)){
        if(!Number.isFinite(NewTime) || NewTime < OldTime) return false;
        if(NewTime > OldTime) return true;
        if(Incoming.bounty_id !== Stored.bounty_id) return false;
    } else if(Number.isFinite(NewTime)){
        return true;
    }
    // Different legacy (undated) drafts have no comparable version counter.
    if(Incoming.bounty_id !== Stored.bounty_id) return true;
    if(HasVersion(Stored)) return HasVersion(Incoming) && Incoming.update_version > Stored.update_version;
    return true;
}

function Retire(tx: any, UserId: string, Entry: any){
    const Time = DraftTime(Entry);
    if(typeof Entry?.bounty_id !== "string" || !Number.isFinite(Time)) return;
    tx.insert(bountyretirements).values({ userId: UserId, bountyId: Entry.bounty_id, draftedAt: Time })
        .onConflictDoUpdate({ target: [bountyretirements.userId, bountyretirements.bountyId],
            set: { draftedAt: sql`max(${bountyretirements.draftedAt}, ${Time})` } }).run();
}

function MergeBounties(tx: any, UserId: string, Stored: any, Incoming: any){
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
    // This native reset has no version or timestamp. It remains an explicit
    // command; ordering old reset/delete commands requires a protocol change.
    if(IncomingBounties.length === 0 && IsFullReset(Incoming?.draft_data)){
        StoredBounties.filter(Entry => KindOf(Entry) === "drafted").forEach(Entry => Retire(tx, UserId, Entry));
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

    const Retired = new Map<string, number>(tx.select().from(bountyretirements)
        .where(eq(bountyretirements.userId, UserId)).all().map((Row: any) => [Row.bountyId, Row.draftedAt]));
    let Kept = [...StoredBounties];
    const RejectedDraftFields = new Set<string>();
    for(const Entry of IncomingBounties){
        const Matches = Kept.filter(Old => Displaces(Entry, Old));
        const RetiredAt = Retired.get(Entry.bounty_id);
        if((RetiredAt !== undefined && (!Number.isFinite(DraftTime(Entry)) || DraftTime(Entry) <= RetiredAt)) ||
            Matches.some(Old => !CanReplace(Entry, Old))){
            RejectedDraftFields.add(DraftField(Entry));
            continue;
        }
        for(const Old of Matches){
            if(Old.bounty_id !== Entry.bounty_id || DraftTime(Entry) > DraftTime(Old)){
                Retire(tx, UserId, Old);
                if(Number.isFinite(DraftTime(Old))) Retired.set(Old.bounty_id, Math.max(Retired.get(Old.bounty_id) ?? -Infinity, DraftTime(Old)));
            }
        }
        // A claimed generation cannot become claimable again. Objective scores
        // may legitimately decrease (damage penalties), so do not max them.
        const WasClaimed = Matches.some(Old => Old.bounty_id === Entry.bounty_id && Old.claimed === true &&
            !(DraftTime(Entry) > DraftTime(Old)));
        Kept = Kept.filter(Old => !Displaces(Entry, Old));
        Kept.push(WasClaimed ? { ...Entry, claimed: true } : Entry);
    }
    // Metadata has no version of its own. When an accompanying entry is stale,
    // do not let its draft history/counts roll back that kind's current state.
    for(const Field of RejectedDraftFields){
        if(Stored[Field] === undefined) delete Merged[Field];
        else Merged[Field] = Stored[Field];
    }
    Merged.bounties = Kept;

    return Merged;
}

export function SaveBountiesForUser(UserId: string, Payload: unknown){
    if(Payload == undefined || typeof Payload !== "object" || Array.isArray(Payload)){
        throw new Error("Bounty payload must be an object");
    }

    const Entries = (Payload as any).bounties;
    if(Entries !== undefined && (!Array.isArray(Entries) || Entries.some((Entry: any) =>
        Entry == null || typeof Entry !== "object" || Array.isArray(Entry) ||
        (Entry.update_version !== undefined && !HasVersion(Entry))))){
        throw new Error("Invalid bounty entries or update_version");
    }
    return GetDb().transaction(tx => {
        const Serialised = JSON.stringify(MergeBounties(tx, UserId, GetBountiesForUser(UserId), Payload));
        const Values = { userId: UserId, payload: Serialised, updatedAt: Date.now() };
        tx.insert(bounties).values(Values).onConflictDoUpdate({ target: bounties.userId, set: Values }).run();
        return GetBountiesForUser(UserId);
    }, { behavior: "immediate" });
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

    return GetDb().transaction(tx => {
        const Board = GetBountiesForUser(UserId);
        const Existing: any[] = Array.isArray(Board.bounties) ? Board.bounties : [];

        Existing.filter(Entry => ToRemove.has(Entry?.bounty_id)).forEach(Entry => Retire(tx, UserId, Entry));
        Board.bounties = Existing.filter((Entry: any) => !ToRemove.has(Entry?.bounty_id));

        const Removed = Existing.length - Board.bounties.length;

        tx.update(bounties).set({ payload: JSON.stringify(Board), updatedAt: Date.now() })
            .where(eq(bounties.userId, UserId)).run();

        logger.info(`Removed ${Removed} bounty(s) for ${UserId}`);

        return Board;
    }, { behavior: "immediate" });
}
