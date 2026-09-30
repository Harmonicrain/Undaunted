import { DailyWindowStart, WeeklyWindowStart, ResetWindows } from "../../shared/timeWindows";

// A limited offer is bought once per window: "limit": "daily" per UTC day
// ("daily": true, the fountain's form, means the same) or "weekly" from
// Thursday 00:00 UTC. Challenge and Middleman rotation use separate policies.
export type Limit = "daily" | "weekly";


export function LimitOf(offer: any): Limit | undefined {
    if (offer?.limit === "daily" || offer?.daily === true) return "daily";
    if (offer?.limit === "weekly") return "weekly";
    return undefined;
}

export function DailyResetAt(now: number) {
    return DailyWindowStart(now, ResetWindows.dailyStore.hourUtc);
}

export function LimitWindowStart(limit: Limit, now: number) {
    return limit === "daily" ? DailyResetAt(now) : WeeklyWindowStart(now,
        ResetWindows.weeklyStore.dayUtc, ResetWindows.weeklyStore.hourUtc);
}
