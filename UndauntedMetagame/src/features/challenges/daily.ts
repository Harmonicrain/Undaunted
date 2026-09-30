import { DailyWindowStart, ResetWindows } from "../../shared/timeWindows";

// Native daily challenges reset at 17:00 UTC, independently of the store.
export const DailyChallengeResetHourUtc = ResetWindows.dailyChallenges.hourUtc;

export function DailyChallengeWindowStart(Now: Date): number {
    return DailyWindowStart(Now.getTime(), DailyChallengeResetHourUtc);
}
