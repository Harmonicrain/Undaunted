import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const WeeklyChallengeSlots = 10;
export const WeeklyChallengeResetDayUtc = 4; // Thursday
export const WeeklyChallengeResetHourUtc = 18;

const WeekMilliseconds = 7 * 24 * 60 * 60 * 1000;
const DayMilliseconds = 24 * 60 * 60 * 1000;
const WeeklyCategory = "WeeklyChallengeGold";
const BoardSeason = "season19";
// The native component stamps Season 19 week zero onto every generated row.
// Keep that wire value so its progress posts belong to the same generation;
// undaunted_weekly_window_start carries the real rolling-week generation.
const NativeSeasonWeekStart = "2022-10-13T18:00:00.000Z";

export type WeeklyChallengeDefinition = {
    id: string;
    objectives: { objectiveId: string; amount: number }[];
};

type ChallengeRewardsDocument = {
    challenges?: Record<string, {
        category?: unknown;
        objectives?: { objectiveId?: unknown; amount?: unknown }[];
    }>;
};

let CachedPath: string | undefined;
let CachedPool: WeeklyChallengeDefinition[] | undefined;

export function BuildWeeklyChallengePool(Document: ChallengeRewardsDocument): WeeklyChallengeDefinition[] {
    return Object.entries(Document?.challenges ?? {})
        .filter(([Id, Definition]) => Id.startsWith("Challenge_Season_") && Definition?.category === WeeklyCategory)
        .map(([Id, Definition]) => ({
            id: Id,
            objectives: Array.isArray(Definition.objectives) ? Definition.objectives
                .filter(Objective => typeof Objective?.objectiveId === "string" &&
                    Number.isFinite(Objective?.amount) && Number(Objective.amount) > 0)
                .map(Objective => ({ objectiveId: String(Objective.objectiveId), amount: Number(Objective.amount) })) : []
        }))
        .filter(Definition => Definition.objectives.length > 0)
        .sort((Left, Right) => Left.id.localeCompare(Right.id));
}

export function GetSupportedWeeklyChallenges(): WeeklyChallengeDefinition[] {
    const Path = process.env.CHALLENGE_REWARDS_FILE;
    if(!Path) return [];
    if(CachedPool && CachedPath === Path) return CachedPool;

    const Document = JSON.parse(readFileSync(Path, "utf8")) as ChallengeRewardsDocument;
    const Pool = BuildWeeklyChallengePool(Document);
    if(Pool.length < WeeklyChallengeSlots){
        throw new Error(`CHALLENGE_REWARDS_FILE has only ${Pool.length} supported weekly challenges`);
    }
    CachedPath = Path;
    CachedPool = Pool;
    return Pool;
}

export function WeeklyChallengeWindowStart(Now: Date): number {
    const TodayAtReset = Date.UTC(Now.getUTCFullYear(), Now.getUTCMonth(), Now.getUTCDate(),
        WeeklyChallengeResetHourUtc);
    const DaysSinceThursday = (Now.getUTCDay() - WeeklyChallengeResetDayUtc + 7) % 7;
    let Start = TodayAtReset - DaysSinceThursday * DayMilliseconds;
    if(Now.getTime() < Start) Start -= WeekMilliseconds;
    return Start;
}

export function SelectWeeklyChallenges(Pool: WeeklyChallengeDefinition[], Now = new Date()): WeeklyChallengeDefinition[] {
    const WindowStart = WeeklyChallengeWindowStart(Now);
    return Pool.map(Definition => ({
        Definition,
        Score: createHash("sha256").update(`undaunted-weekly-v1:${WindowStart}:${Definition.id}`).digest("hex")
    })).sort((Left, Right) => Left.Score.localeCompare(Right.Score))
        .slice(0, WeeklyChallengeSlots)
        .map(Entry => Entry.Definition);
}

export function GetSelectedWeeklyChallenges(Now = new Date()): WeeklyChallengeDefinition[] {
    return SelectWeeklyChallenges(GetSupportedWeeklyChallenges(), Now);
}

const BoardId = (Definition: WeeklyChallengeDefinition) => `${Definition.id}-${BoardSeason}-0`;

export function ApplyWeeklyChallengeWindow(Board: any, Pool: WeeklyChallengeDefinition[], Now = new Date()) {
    if(Pool.length < WeeklyChallengeSlots) return Board;

    const WindowStart = WeeklyChallengeWindowStart(Now);
    const WindowEnd = WindowStart + WeekMilliseconds;
    const Selected = SelectWeeklyChallenges(Pool, Now);
    const Entries: any[] = Array.isArray(Board?.bounties) ? Board.bounties : [];
    const ExistingById = new Map<string, any>();
    const SameWindow = Board?.undaunted_weekly_window_start === WindowStart;

    for(const Entry of Entries){
        const Id = typeof Entry?.bounty_id === "string" ? Entry.bounty_id : "";
        if(!Id.startsWith("Challenge_") || Id.startsWith("Challenge_Daily_")) continue;
        const DraftedAt = Date.parse(Entry?.drafted_timestamp);
        if(SameWindow || (Number.isFinite(DraftedAt) && DraftedAt >= WindowStart && DraftedAt < WindowEnd)){
            ExistingById.set(Id, Entry);
        }
    }

    const NonWeekly = Entries.filter(Entry => {
        const Id = typeof Entry?.bounty_id === "string" ? Entry.bounty_id : "";
        return !Id.startsWith("Challenge_") || Id.startsWith("Challenge_Daily_");
    });
    const Weekly = Selected.map((Definition, SlotIndex) => {
        const Id = BoardId(Definition);
        const Existing = ExistingById.get(Id);
        if(Existing){
            return { ...Existing, bounty_id: Id, slot_index: SlotIndex, drafted_timestamp: NativeSeasonWeekStart };
        }
        return {
            bounty_id: Id,
            slot_index: SlotIndex,
            drafted_timestamp: NativeSeasonWeekStart,
            update_version: 0,
            claimed: false,
            objectives: Definition.objectives.map(Objective => ({ objective_id: Objective.objectiveId, progress: 0 }))
        };
    });

    Board.bounties = [...NonWeekly, ...Weekly];
    Board.draft_data_weekly = {
        current_draft_choices: [], previous_draft_selections: [],
        bronze_count: 0, silver_count: 0, gold_count: 0
    };
    Board.undaunted_weekly_window_start = WindowStart;
    return Board;
}

export function ApplyConfiguredWeeklyChallengeWindow(Board: any, Now = new Date()) {
    const Pool = GetSupportedWeeklyChallenges();
    return Pool.length >= WeeklyChallengeSlots ? ApplyWeeklyChallengeWindow(Board, Pool, Now) : Board;
}
