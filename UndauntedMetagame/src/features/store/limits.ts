
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
    const day = new Date(now);
    return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
}

export function LimitWindowStart(limit: Limit, now: number) {
    const day = DailyResetAt(now);
    if (limit === "daily") return day;
    const sinceThursday = (new Date(day).getUTCDay() - 4 + 7) % 7;
    return day - sinceThursday * 24 * 60 * 60 * 1000;
}
