import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { GetDb } from "../db";
import { progression, progressionobjectives, progressionrequests } from "../db/schema";
import { DeriveRank, GetActiveHuntPassId, GetTrackConfig } from "./huntpass";
import { ClaimRanksUpTo, RewardError, RewardKind } from "./huntpassRewards";
import { IsLinkTrack } from "./slayerLinkConfig";
import { ApplyHuntPassXpToLinks, IgnoreNativeLinkTrackGrant } from "./slayerLinks";
import { logger } from "../logger";

// Progression mutation: XP accrual, objective progress, and rank confirmation.
//
// POST /progression/{account} returned a hardcoded 400 with the note that
// anything else reopened "the infinite mastery pop issue". That happened
// because the read path reported a permanently maxed rank, so any accepted
// grant immediately looked like a fresh rank-up against an already-maxed track
// and the celebration replayed forever. The read path now reports a real
// derived rank and confirmation is persisted, which is what makes accepting
// progress safe.

export type ProgressTrackUpdate = { progression_id: string, progress: number };
export type ObjectiveUpdate = { objective_id: string, value: number, completed_count: number };

// Inbound progress is a delta, matching GrantProgressionEndpoint's
// /{track}/{amount} form. Still worth stating plainly: it is not a total, so
// applying it twice awards twice.
export function AddProgress(tx: any, UserId: string, TrackId: string, Delta: number){
    const Track = GetTrackConfig(TrackId);

    if(Track == undefined){
        return undefined;
    }

    if(!Number.isSafeInteger(Delta) || Delta <= 0 || Delta > 2147483647){
        return undefined;
    }

    const Multiplier = Number.isFinite(Track.progression_multiplier) && (Track.progression_multiplier ?? 0) > 0
        ? Track.progression_multiplier as number
        : 1;

    const Awarded = Math.floor(Delta * Multiplier);

    const Existing = tx.select().from(progression)
        .where(and(eq(progression.userId, UserId), eq(progression.trackId, TrackId))).get();

    const Total = (Existing?.totalPoints ?? 0) + Awarded;
    // The native DTO reads signed int32 progress. Never wrap it negative.
    if(!Number.isSafeInteger(Total) || Total > 2147483647){
        throw new RewardError(400, "Progress exceeds the native int32 limit");
    }

    if(Existing == undefined){
        tx.insert(progression).values({
            userId: UserId, trackId: TrackId, generation: 0,
            totalPoints: Total, confirmedRank: 0, confirmedPremiumRank: 0,
            updatedAt: Date.now()
        }).run();
    }
    else{
        tx.update(progression).set({ totalPoints: Total, updatedAt: Date.now() })
            .where(and(eq(progression.userId, UserId), eq(progression.trackId, TrackId))).run();
    }

    return { totalPoints: Total, awarded: Awarded };
}

function UpsertObjective(tx: any, UserId: string, Update: ObjectiveUpdate): boolean {
    if(typeof Update?.objective_id !== "string" || Update.objective_id.length === 0){
        throw new RewardError(400, "Objective id is required");
    }

    const Value = Update.value;
    const Completed = Update.completed_count;
    if(![Value, Completed].every((Number) => globalThis.Number.isInteger(Number) && Number >= 0 && Number <= 2147483647)){
        throw new RewardError(400, "Objective counters must be non-negative int32 values");
    }

    const Existing = tx.select().from(progressionobjectives)
        .where(and(eq(progressionobjectives.userId, UserId), eq(progressionobjectives.objectiveId, Update.objective_id))).get();

    if(Existing == undefined){
        tx.insert(progressionobjectives).values({
            userId: UserId, objectiveId: Update.objective_id,
            progress: Value, completedCount: Completed,
            createdAt: Date.now(), updatedAt: Date.now()
        }).run();

        return Value > 0 || Completed > 0;
    }

    // A repeating objective may reset its value after completion. Compare the
    // completion count first, then value within that completion cycle.
    if(Completed < Existing.completedCount || (Completed === Existing.completedCount && Value <= Existing.progress)){
        return false;
    }
    tx.update(progressionobjectives).set({
        progress: Value,
        completedCount: Completed,
        updatedAt: Date.now()
    }).where(and(eq(progressionobjectives.userId, UserId), eq(progressionobjectives.objectiveId, Update.objective_id))).run();
    return true;
}

// The body of POST /progression/{account}, applied as one unit so a partial
// failure cannot leave objectives advanced with the track unchanged.
//
// Hunt is the gameserver's report of where the award happened and who was
// connected there. Hunt Pass XP awarded in that context also advances the
// player's Slayer Links, in this same transaction.
//
// RequestId is the gameserver's stable id for this request. A request seen
// before is answered as a replay without awarding anything again (a reused id
// with different content is refused), and link XP events derive their ids
// from it, so a retry can never advance a link twice either. Requests without
// an id keep the old additive behaviour.
export function ApplyProgressAndObjectives(UserId: string, Tracks: ProgressTrackUpdate[], Objectives: ObjectiveUpdate[], Hunt?: { world: string, copresentCharacterIds: string[] }, RequestId?: string){
    if(!Array.isArray(Tracks) || !Array.isArray(Objectives)){
        throw new RewardError(400, "Progress tracks and objectives must be arrays");
    }
    for(const Update of Tracks){
        if(typeof Update?.progression_id !== "string" || Update.progression_id.length === 0 ||
            !Number.isSafeInteger(Update.progress) || Update.progress < 0 || Update.progress > 2147483647){
            throw new RewardError(400, "Track updates require an id and a non-negative int32 delta");
        }
    }
    const Applied: { trackId: string, totalPoints: number, awarded: number }[] = [];
    const Ignored: string[] = [];
    let Replayed = false;

    GetDb().transaction((tx: any) => {
        if(RequestId != undefined){
            const RequestHash = createHash("sha256").update(JSON.stringify({ UserId, Tracks, Objectives })).digest("hex");
            const Seen = tx.select().from(progressionrequests).where(eq(progressionrequests.requestId, RequestId)).get();

            if(Seen != undefined){
                if(Seen.requestHash !== RequestHash || Seen.userId !== UserId){
                    throw new RewardError(409, `Progression request ${RequestId} was already applied with different content`);
                }

                Replayed = true;
                return;
            }

            tx.insert(progressionrequests).values({ requestId: RequestId, userId: UserId, requestHash: RequestHash, appliedAt: Date.now() }).run();
        }

        let ObjectivesAdvanced = false;
        for(const Objective of Objectives){
            ObjectivesAdvanced = UpsertObjective(tx, UserId, Objective) || ObjectivesAdvanced;
        }

        for(const [Index, Update] of (Tracks ?? []).entries()){
            // Native mastery grants carry the absolute objective snapshots
            // that earned them. A replay with no newer snapshot must not add
            // its mastery deltas again. Bare grants (including bounty XP) do
            // not carry that evidence and remain additive.
            if(Update?.progression_id?.startsWith("MasteryTrack_") && Objectives.length > 0 && !ObjectivesAdvanced){
                continue;
            }
            // Link progress is owned by the link, not the progression table.
            if(IsLinkTrack(Update?.progression_id)){
                IgnoreNativeLinkTrackGrant(UserId, Update.progression_id, Update.progress);
                continue;
            }
            const Result = AddProgress(tx, UserId, Update?.progression_id, Update?.progress);

            if(Result == undefined){
                if(typeof Update?.progression_id === "string"){
                    Ignored.push(Update.progression_id);
                }

                continue;
            }

            Applied.push({ trackId: Update.progression_id, ...Result });

            if(Update.progression_id === GetActiveHuntPassId()){
                const Context = Hunt == undefined ? undefined : { world: Hunt.world };
                const EventId = RequestId != undefined ? `huntpass:${RequestId}:${Index}` : `huntpass:${randomUUID()}`;
                ApplyHuntPassXpToLinks(tx, UserId, Result.awarded, Context, EventId);
            }
        }

    }, { behavior: "immediate" });

    if(Replayed){
        logger.info(`Progression request ${RequestId} for ${UserId} was already applied; nothing awarded again`);
    }

    if(Ignored.length > 0){
        logger.warn(`Ignored progress for unconfigured or invalid track(s): ${Ignored.join(", ")}`);
    }

    return { Applied, Ignored, Replayed };
}

// 1.4.4 ConfirmProgressionEndpoint at 0x140b3ab22 maps Normal=1 to "public"
// and Premium=2 to "premium". Keep the older aliases for admin/test callers.
export function ParseConfirmKind(Raw: string): RewardKind | undefined {
    const Value = String(Raw ?? "").trim().toLowerCase();

    if(Value === "premium" || Value === "2"){
        return "premium";
    }

    if(Value === "public" || Value === "normal" || Value === "free" || Value === "fremium" || Value === "1"){
        return "free";
    }

    return undefined;
}

// Confirming a rank is what stops the rank-up celebration replaying, and it is
// also the moment the rewards for that rank are handed over.
//
// The invariant is 0 <= confirmedRank <= earnedRank. Confirmation is a reward
// cursor, so it may never run ahead of what the player has actually earned -
// acknowledging an unearned rank would suppress the claim for it later.
export function ConfirmRank(UserId: string, CharacterId: string, TrackId: string, Rank: number, Kind: RewardKind){
    const Track = GetTrackConfig(TrackId);

    if(Track == undefined){
        throw new RewardError(404, `Unknown progression track ${TrackId}`);
    }

    if(!Number.isSafeInteger(Rank) || Rank < 0){
        throw new RewardError(400, `Invalid rank ${Rank}`);
    }

    return GetDb().transaction((tx: any) => {
    const State = tx.select().from(progression)
        .where(and(eq(progression.userId, UserId), eq(progression.trackId, TrackId))).get();

    const Earned = DeriveRank(TrackId, State?.totalPoints ?? 0).rank;

    const Confirmable = Math.min(Rank, Earned);

    // Rewards first, cursor second: if the grant fails the rank stays
    // unconfirmed and will be retried, rather than being recorded as paid.
    const Granted = ClaimRanksUpTo(UserId, CharacterId, TrackId, Confirmable, Kind, tx);

    const Column = Kind === "premium" ? "confirmedPremiumRank" : "confirmedRank";
    const Current = Kind === "premium" ? (State?.confirmedPremiumRank ?? 0) : (State?.confirmedRank ?? 0);
    const Next = Math.max(Current, Confirmable);

    if(State == undefined){
        tx.insert(progression).values({
            userId: UserId, trackId: TrackId, generation: 0,
            totalPoints: 0, confirmedRank: Kind === "premium" ? 0 : Next,
            confirmedPremiumRank: Kind === "premium" ? Next : 0,
            updatedAt: Date.now()
        }).run();
    }
    else{
        tx.update(progression).set({ [Column]: Next, updatedAt: Date.now() } as any)
            .where(and(eq(progression.userId, UserId), eq(progression.trackId, TrackId))).run();
    }

    logger.info(`Confirmed ${Kind} rank ${Confirmable} on ${TrackId} for ${UserId} (requested ${Rank}, earned ${Earned})`);

    return { confirmedRank: Next, earnedRank: Earned, granted: Granted };
    }, { behavior: "immediate" });
}

// Resetting a track bumps its generation and zeroes progress. Claim rows are
// deliberately left in place: the claims ledger shares a key space with the
// inventory replay ledger, so deleting claims alone reintroduces replay
// conflicts, and deleting both re-awards items the player still holds. A new
// generation gives a clean key space without rewriting history.
export function ResetTrack(UserId: string, TrackId: string){
    if(GetTrackConfig(TrackId) == undefined){
        throw new RewardError(404, `Unknown progression track ${TrackId}`);
    }

    const Existing = GetDb().select().from(progression)
        .where(and(eq(progression.userId, UserId), eq(progression.trackId, TrackId))).get();

    const Generation = (Existing?.generation ?? 0) + 1;

    if(Existing == undefined){
        GetDb().insert(progression).values({
            userId: UserId, trackId: TrackId, generation: Generation,
            totalPoints: 0, confirmedRank: 0, confirmedPremiumRank: 0,
            updatedAt: Date.now()
        }).run();
    }
    else{
        GetDb().update(progression).set({
            generation: Generation, totalPoints: 0,
            confirmedRank: 0, confirmedPremiumRank: 0, updatedAt: Date.now()
        }).where(and(eq(progression.userId, UserId), eq(progression.trackId, TrackId))).run();
    }

    return Generation;
}

// The read DTO uses "progress" (1.4.4 serializer 0x140b6a890), whereas
// the gameserver write DTO uses "value" (0x141481240).
export function GetObjectivesForUser(UserId: string){
    return GetDb().select().from(progressionobjectives)
        .where(eq(progressionobjectives.userId, UserId)).all()
        .map((Row) => ({
            phx_account_id: UserId,
            objective_id: Row.objectiveId,
            progress: Row.progress,
            completed_count: Row.completedCount,
            created_date: new Date(Row.createdAt).toISOString(),
            last_modified_date: new Date(Row.updatedAt).toISOString()
        }));
}

export function GetObjectiveForUser(UserId: string, ObjectiveId: string){
    return GetObjectivesForUser(UserId).find((Entry) => Entry.objective_id === ObjectiveId);
}
