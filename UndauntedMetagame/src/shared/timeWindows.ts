export const DayMilliseconds = 86_400_000;
export const WeekMilliseconds = 7 * DayMilliseconds;

// These boundaries differ in the native protocol. Keep their policies named
// instead of silently changing store limits to use the challenge clock.
export const ResetWindows = {
    dailyChallenges: { hourUtc: 17 },
    weeklyChallenges: { dayUtc: 4, hourUtc: 18 },
    middleman: { dayUtc: 4, hourUtc: 18 },
    dailyStore: { hourUtc: 0 },
    weeklyStore: { dayUtc: 4, hourUtc: 0 }
} as const;

export function DailyWindowStart(now: number, hourUtc = 0): number {
    const date = new Date(now);
    const boundary = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hourUtc);
    return now < boundary ? boundary - DayMilliseconds : boundary;
}

export function WeeklyWindowStart(now: number, dayUtc: number, hourUtc = 0): number {
    const date = new Date(now);
    const boundary = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hourUtc);
    const daysSinceReset = (date.getUTCDay() - dayUtc + 7) % 7;
    const start = boundary - daysSinceReset * DayMilliseconds;
    return now < start ? start - WeekMilliseconds : start;
}
