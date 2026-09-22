import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { GetDb } from "../db";
import { escalationevents, escalationprogression, escalationtalents, escalationunlocks } from "../db/schema";
import { ESCALATION_CONTENT_REVISION, EscalationSeason, ExperienceForNextLevel, GetEscalationSeason, MaxEscalationLevel, TalentRankCost } from "./escalationConfig";
import { logger } from "../logger";

// Escalation season state: reads and the gameserver's snapshot writes.
//
// The world server levels players, spends talent points and grants rewards
// natively, then POSTs the whole season (UpdateSeasonalEscalationEndpoint).
// The backend's job is to hold the last legitimate snapshot and refuse any
// that no native state could produce, or that would erase newer progress.
// Evidence for every rule here is in research/escalation/PROTOCOL.md.

export class EscalationError extends Error {
    constructor(public status: number, message: string){ super(message); }
}

export type WireTalent = { rank: number, talent_id: string };
export type WireUnlock = { collected: boolean, reward_id: string };
export type WireSeason = {
    escalation_level: number,
    next_level_xp: number,
    talents_progress: WireTalent[],
    unlock_progress: WireUnlock[],
    update_version: number
};

const INT32_MAX = 2147483647;

function IsInt32Count(Value: unknown): Value is number {
    return Number.isSafeInteger(Value) && (Value as number) >= 0 && (Value as number) <= INT32_MAX;
}

function SeasonOrThrow(SeasonId: string){
    const Season = GetEscalationSeason(SeasonId);

    if(Season == undefined){
        throw new EscalationError(404, `Unknown escalation season ${SeasonId}`);
    }

    return Season;
}

// The native default for an account with no stored season: level 0, no XP,
// nothing bought or collected, version 0. Reads never create rows, and an
// account never inherits the old stub's 99999.
function ReadState(tx: any, UserId: string, Season: EscalationSeason): WireSeason {
    const Row = tx.select().from(escalationprogression)
        .where(and(eq(escalationprogression.userId, UserId), eq(escalationprogression.seasonId, Season.id))).get();

    const Talents = tx.select().from(escalationtalents)
        .where(and(eq(escalationtalents.userId, UserId), eq(escalationtalents.seasonId, Season.id))).all();

    const Unlocks = tx.select().from(escalationunlocks)
        .where(and(eq(escalationunlocks.userId, UserId), eq(escalationunlocks.seasonId, Season.id))).all();

    // Emitted in the season table's order so identical state always
    // serialises identically.
    const RankById = new Map<string, number>(Talents.map((Talent: any) => [Talent.talentId, Talent.rank]));
    const Collected = new Set<string>(Unlocks.map((Unlock: any) => Unlock.unlockId));

    return {
        escalation_level: Row?.level ?? 0,
        next_level_xp: Row?.xp ?? 0,
        talents_progress: Season.talents
            .filter((Talent) => RankById.has(Talent.id))
            .map((Talent) => ({ rank: RankById.get(Talent.id) as number, talent_id: Talent.id })),
        unlock_progress: Season.unlocks
            .filter((Unlock) => Collected.has(Unlock.id))
            .map((Unlock) => ({ collected: true, reward_id: Unlock.id })),
        update_version: Row?.updateVersion ?? 0
    };
}

export function GetEscalationState(UserId: string, SeasonId: string): WireSeason {
    const Season = SeasonOrThrow(SeasonId);

    return ReadState(GetDb(), UserId, Season);
}

// Validates a POSTed snapshot against what native code can produce and returns
// it in canonical form (known ids only, season order, rank-0 talents dropped,
// only collected unlocks kept).
export function CanonicaliseSnapshot(Season: EscalationSeason, Body: any): WireSeason {
    if(Body == null || typeof Body !== "object" || Array.isArray(Body)){
        throw new EscalationError(400, "Escalation snapshot must be an object");
    }

    const Level = Body.escalation_level;
    const Xp = Body.next_level_xp;
    const Version = Body.update_version;
    const MaxLevel = MaxEscalationLevel(Season);

    if(!IsInt32Count(Level) || Level > MaxLevel){
        throw new EscalationError(400, `escalation_level must be an integer from 0 to ${MaxLevel}`);
    }

    if(!IsInt32Count(Xp)){
        throw new EscalationError(400, "next_level_xp must be a non-negative int32");
    }

    // After GrantExperience the remainder is always below the next level's
    // cost; only the cap accumulates without bound.
    const NextCost = ExperienceForNextLevel(Season, Level);
    if(NextCost !== undefined && Xp >= NextCost){
        throw new EscalationError(400, `next_level_xp ${Xp} is not below the level ${Level} cost ${NextCost}`);
    }

    // The native counter is incremented before every POST, so a write is at
    // least version 1.
    if(!IsInt32Count(Version) || Version < 1){
        throw new EscalationError(400, "update_version must be a positive int32");
    }

    if(!Array.isArray(Body.talents_progress) || !Array.isArray(Body.unlock_progress)){
        throw new EscalationError(400, "talents_progress and unlock_progress must be arrays");
    }

    const Ranks = new Map<string, number>();
    for(const Entry of Body.talents_progress){
        const Talent = Season.talents.find((Candidate) => Candidate.id === Entry?.talent_id);

        if(Talent == undefined){
            throw new EscalationError(400, `Unknown talent ${Entry?.talent_id} for ${Season.id}`);
        }
        if(Ranks.has(Talent.id)){
            throw new EscalationError(400, `Talent ${Talent.id} listed twice`);
        }
        if(!IsInt32Count(Entry.rank) || Entry.rank > Talent.rankCosts.length){
            throw new EscalationError(400, `Talent ${Talent.id} rank must be 0..${Talent.rankCosts.length}`);
        }

        Ranks.set(Talent.id, Entry.rank);
    }

    // One point per level (GetUnspentTalentPoints = level - spent).
    const Spent = Season.talents.reduce((Total, Talent) => Total + TalentRankCost(Talent, Ranks.get(Talent.id) ?? 0), 0);
    if(Spent > Level){
        throw new EscalationError(400, `Talents spend ${Spent} points but level ${Level} only earns ${Level}`);
    }

    // SharedUpgradeTalent (0x1414c0600) refuses a rank-up while the points
    // already spent are below the talent's PointsToUnlock. Spent points only
    // grow, so a snapshot is reachable exactly when every held tier is
    // covered by what the lower tiers cost - buying lower tiers first is the
    // most favourable order, and a talent can never pay for its own gate.
    for(const Talent of Season.talents){
        if((Ranks.get(Talent.id) ?? 0) === 0 || Talent.pointsToUnlock === 0){
            continue;
        }

        const SpentBelow = Season.talents
            .filter((Other) => Other.pointsToUnlock < Talent.pointsToUnlock)
            .reduce((Total, Other) => Total + TalentRankCost(Other, Ranks.get(Other.id) ?? 0), 0);

        if(SpentBelow < Talent.pointsToUnlock){
            throw new EscalationError(400, `Talent ${Talent.id} needs ${Talent.pointsToUnlock} points spent in earlier tiers, found ${SpentBelow}`);
        }
    }

    const Collected = new Set<string>();
    const Listed = new Set<string>();
    for(const Entry of Body.unlock_progress){
        const Unlock = Season.unlocks.find((Candidate) => Candidate.id === Entry?.reward_id);

        if(Unlock == undefined){
            throw new EscalationError(400, `Unknown unlock ${Entry?.reward_id} for ${Season.id}`);
        }
        if(Listed.has(Unlock.id)){
            throw new EscalationError(400, `Unlock ${Unlock.id} listed twice`);
        }
        if(typeof Entry.collected !== "boolean"){
            throw new EscalationError(400, `Unlock ${Unlock.id} collected must be a boolean`);
        }
        if(Entry.collected && Level < Unlock.unlockLevel){
            throw new EscalationError(400, `Unlock ${Unlock.id} needs level ${Unlock.unlockLevel}`);
        }

        Listed.add(Unlock.id);
        if(Entry.collected){
            Collected.add(Unlock.id);
        }
    }

    return {
        escalation_level: Level,
        next_level_xp: Xp,
        talents_progress: Season.talents
            .filter((Talent) => (Ranks.get(Talent.id) ?? 0) > 0)
            .map((Talent) => ({ rank: Ranks.get(Talent.id) as number, talent_id: Talent.id })),
        unlock_progress: Season.unlocks
            .filter((Unlock) => Collected.has(Unlock.id))
            .map((Unlock) => ({ collected: true, reward_id: Unlock.id })),
        update_version: Version
    };
}

function HashSnapshot(Snapshot: WireSeason){
    const { update_version: _Version, ...Content } = Snapshot;

    return createHash("sha256").update(JSON.stringify(Content)).digest("hex");
}

// Accepts the gameserver's season snapshot.
//
// Version rules, from the native counter that is incremented before every
// POST and starts from the value last loaded:
// - newer version: accepted if it does not erase progress or a collection;
// - same version, same content: a retry, answered with the stored state;
// - same or older version with different content: refused, so a stale or
//   reordered save can never overwrite newer state.
export function ApplyEscalationSnapshot(UserId: string, SeasonId: string, Body: any){
    const Season = SeasonOrThrow(SeasonId);

    if(!Season.enabled){
        throw new EscalationError(409, `Escalation season ${SeasonId} is disabled in this client`);
    }

    const Snapshot = CanonicaliseSnapshot(Season, Body);
    const Hash = HashSnapshot(Snapshot);

    return GetDb().transaction((tx: any) => {
        const Existing = tx.select().from(escalationprogression)
            .where(and(eq(escalationprogression.userId, UserId), eq(escalationprogression.seasonId, Season.id))).get();

        const Prior = tx.select().from(escalationevents)
            .where(and(
                eq(escalationevents.userId, UserId),
                eq(escalationevents.seasonId, Season.id),
                eq(escalationevents.updateVersion, Snapshot.update_version))).get();

        if(Prior != undefined){
            if(Prior.requestHash !== Hash){
                throw new EscalationError(409, `update_version ${Snapshot.update_version} was already used with different content`);
            }

            return { State: ReadState(tx, UserId, Season), Replayed: true };
        }

        if(Existing != undefined){
            if(Snapshot.update_version <= Existing.updateVersion){
                throw new EscalationError(409, `Stale escalation snapshot: version ${Snapshot.update_version} is not newer than ${Existing.updateVersion}`);
            }

            // Talent resets may lower ranks; nothing native lowers level or XP.
            const Regresses = Snapshot.escalation_level < Existing.level ||
                (Snapshot.escalation_level === Existing.level && Snapshot.next_level_xp < Existing.xp);
            if(Regresses){
                throw new EscalationError(409, `Escalation snapshot would lower progress from ${Existing.level}/${Existing.xp} to ${Snapshot.escalation_level}/${Snapshot.next_level_xp}`);
            }
        }
        else if(Snapshot.escalation_level === MaxEscalationLevel(Season) && Snapshot.next_level_xp === 99999){
            // The exact state a world server holds if it loaded the old stub
            // (level 99999 clamped to max, next_level_xp 99999). Never real.
            throw new EscalationError(409, "Snapshot carries the retired stub values; reload the season first");
        }

        const AlreadyCollected = tx.select().from(escalationunlocks)
            .where(and(eq(escalationunlocks.userId, UserId), eq(escalationunlocks.seasonId, Season.id))).all()
            .map((Row: any) => Row.unlockId as string);

        const NowCollected = new Set(Snapshot.unlock_progress.map((Unlock) => Unlock.reward_id));
        const Lost = AlreadyCollected.filter((UnlockId: string) => !NowCollected.has(UnlockId));
        if(Lost.length > 0){
            throw new EscalationError(409, `Escalation snapshot would un-collect ${Lost.join(", ")}`);
        }

        const Now = Date.now();

        if(Existing == undefined){
            tx.insert(escalationprogression).values({
                userId: UserId, seasonId: Season.id,
                level: Snapshot.escalation_level, xp: Snapshot.next_level_xp,
                updateVersion: Snapshot.update_version, contentRevision: ESCALATION_CONTENT_REVISION,
                requestHash: Hash, updatedAt: Now
            }).run();
        }
        else{
            tx.update(escalationprogression).set({
                level: Snapshot.escalation_level, xp: Snapshot.next_level_xp,
                updateVersion: Snapshot.update_version, contentRevision: ESCALATION_CONTENT_REVISION,
                requestHash: Hash, updatedAt: Now
            }).where(and(eq(escalationprogression.userId, UserId), eq(escalationprogression.seasonId, Season.id))).run();
        }

        // Ranks are replaced wholesale: a talent reset legitimately drops them.
        tx.delete(escalationtalents)
            .where(and(eq(escalationtalents.userId, UserId), eq(escalationtalents.seasonId, Season.id))).run();
        for(const Talent of Snapshot.talents_progress){
            tx.insert(escalationtalents).values({ userId: UserId, seasonId: Season.id, talentId: Talent.talent_id, rank: Talent.rank }).run();
        }

        for(const Unlock of Snapshot.unlock_progress){
            if(!AlreadyCollected.includes(Unlock.reward_id)){
                tx.insert(escalationunlocks).values({ userId: UserId, seasonId: Season.id, unlockId: Unlock.reward_id, collectedAt: Now }).run();
            }
        }

        tx.insert(escalationevents).values({
            userId: UserId, seasonId: Season.id, updateVersion: Snapshot.update_version,
            requestHash: Hash, level: Snapshot.escalation_level, xp: Snapshot.next_level_xp, createdAt: Now
        }).run();

        logger.info(`Escalation ${Season.id} for ${UserId}: v${Snapshot.update_version} level ${Snapshot.escalation_level} xp ${Snapshot.next_level_xp}, ${Snapshot.talents_progress.length} talent(s), ${Snapshot.unlock_progress.length} collected`);

        return { State: ReadState(tx, UserId, Season), Replayed: false };
    }, { behavior: "immediate" });
}
