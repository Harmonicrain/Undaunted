// The 1.12 native BountyComponent_Daily anchors its windows at 17:00 UTC
// (BeginDateTime = 2021-03-18T17:00:00Z). Token grants and persisted-board
// expiry must use that same boundary as the client's challenge timer.
export const DailyChallengeResetHourUtc = 17;

export function DailyChallengeWindowStart(Now: Date): number {
    const Boundary = Date.UTC(Now.getUTCFullYear(), Now.getUTCMonth(), Now.getUTCDate(), DailyChallengeResetHourUtc);
    return Now.getTime() < Boundary ? Boundary - 86_400_000 : Boundary;
}
