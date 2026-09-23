import nativeRewardTable from "../vendor/linked_slayer_rewards.json";

// Slayer Link constants and the progression tracks the 1.4.4 client reads.
//
// UArchonLinkedSlayers (constructor 0x1415ce540) builds the track id from the
// prefix below plus the player's own slot number (1..3), then asks
// GET /progression/{account}/{track}. The gameserver also looks the track up
// in /progression/config when it rolls a prize pool
// (GeneratePrizePoolInternal), so the paths must be present there.
//
// Requirements are per-rank costs, the same representation as every other
// path in progression_config (DeriveRank accumulates them). The documented
// cumulative thresholds 5 / 405 / 1205 / 2805 are these costs summed.

export const LINK_TRACK_PREFIX = "Linked_Slayer_Slot_";
export const LINK_SLOTS = 3;
export const LINK_RANK_COSTS = [5, 400, 800, 1600];

export function LinkTrackId(Slot: number){
    return `${LINK_TRACK_PREFIX}${Slot}`;
}

// The slot a Linked_Slayer_Slot_N track addresses, or undefined for any other
// track. Only the exact native spelling of 1..3 is accepted.
export function ParseLinkTrack(TrackId: unknown): number | undefined {
    if(typeof TrackId !== "string" || !TrackId.startsWith(LINK_TRACK_PREFIX)){
        return undefined;
    }

    const Slot = Number(TrackId.slice(LINK_TRACK_PREFIX.length));

    return Number.isInteger(Slot) && Slot >= 1 && Slot <= LINK_SLOTS && TrackId === LinkTrackId(Slot) ? Slot : undefined;
}

export function IsLinkTrack(TrackId: unknown){
    return typeof TrackId === "string" && TrackId.startsWith(LINK_TRACK_PREFIX);
}

// Same shape as the mastery paths in the vendored progression_config. Link
// tracks carry no rank rewards: the prize pool is the reward.
export function LinkTrackPaths(){
    return Array.from({ length: LINK_SLOTS }, (_, Index) => ({
        progression_id: LinkTrackId(Index + 1),
        premium_gating_entitlement: "",
        progression_multiplier: 1,
        start_date: "2019-01-01T14:00:00+00:00",
        end_date: "2099-01-01T14:00:00+00:00",
        requirements: [
            { rank_id: 0, xp_required: 0 },
            ...LINK_RANK_COSTS.map((Cost, Rank) => ({ rank_id: Rank + 1, xp_required: Cost }))
        ],
        free_rewards: [],
        premium_rewards: []
    }));
}

// Chests reached for a link total. Mirrors DeriveRank for these paths.
export function DeriveLinkRank(TotalPoints: number){
    let Remaining = Number.isFinite(TotalPoints) && TotalPoints > 0 ? Math.floor(TotalPoints) : 0;
    let Rank = 0;

    for(const Cost of LINK_RANK_COSTS){
        if(Remaining < Cost){
            break;
        }

        Remaining -= Cost;
        Rank++;
    }

    return Rank;
}

export const MAX_LINK_RANK = LINK_RANK_COSTS.length;
export const MAX_LINK_REWARDS: number = (nativeRewardTable as any).config.max_rewards;

// Every catalogue id and amount the native rewards table can produce. A pool
// write naming anything else did not come from the native generator.
const AllowedAmounts = new Map<string, Set<number>>();

for(const Row of (nativeRewardTable as any).rewards as { catalog_id: string, quantity: number }[]){
    if(!AllowedAmounts.has(Row.catalog_id)){
        AllowedAmounts.set(Row.catalog_id, new Set());
    }

    AllowedAmounts.get(Row.catalog_id)!.add(Row.quantity);
}

export function IsKnownLinkReward(CatalogId: unknown, Quantity: unknown){
    return typeof CatalogId === "string" && Number.isSafeInteger(Quantity) &&
        AllowedAmounts.get(CatalogId)?.has(Quantity as number) === true;
}

// The largest pool the native generator can draw (sum of ClassesToDraw).
export const MAX_POOL_SIZE: number = ((nativeRewardTable as any).config.classes_to_draw as number[])
    .reduce((Sum, Count) => Sum + Count, 0);
