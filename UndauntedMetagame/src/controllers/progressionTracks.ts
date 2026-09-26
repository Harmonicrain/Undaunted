import { and, eq } from "drizzle-orm";
import { GetDb } from "../db";
import { entitlements, progression } from "../db/schema";
import { DeriveRank, GetActiveHuntPassId, GetAllTrackIds, GetPremiumGatingEntitlement, GetPremiumMode, GetTrackConfig } from "./huntpass";
import { GetSelectedHuntPassId } from "./huntpassSelection";

// Account-scoped progression. The existing controllers/progression.ts is
// character-scoped and gates every operation on DoesCharacterBelongToUserId;
// a Hunt Pass belongs to the account (the wire key is phx_account_id), so it
// cannot reuse that wrapper.
//
// Reads do not create rows. Every endpoint uses the same stored state so a
// bulk query cannot overwrite a real rank with a fabricated maxed one.

export type TrackState = {
    trackId: string,
    generation: number,
    totalPoints: number,
    confirmedRank: number,
    confirmedPremiumRank: number,
    updatedAt: number
};

function DefaultState(TrackId: string): TrackState {
    return {
        trackId: TrackId,
        generation: 0,
        totalPoints: 0,
        confirmedRank: 0,
        confirmedPremiumRank: 0,
        updatedAt: 0
    };
}

// Absent row means "no progress yet", not an error. Nothing is written here -
// a read must not create rows, or merely opening a screen would fabricate
// progression for every track the client happens to ask about.
export function GetTrackState(UserId: string, TrackId: string): TrackState {
    const Row = GetDb().select().from(progression)
        .where(and(eq(progression.userId, UserId), eq(progression.trackId, TrackId)))
        .get();

    if(Row == undefined){
        return DefaultState(TrackId);
    }

    return {
        trackId: Row.trackId,
        generation: Row.generation,
        totalPoints: Row.totalPoints,
        confirmedRank: Row.confirmedRank,
        confirmedPremiumRank: Row.confirmedPremiumRank,
        updatedAt: Row.updatedAt
    };
}

export function GetAllTrackStates(UserId: string): TrackState[] {
    return GetDb().select().from(progression).where(eq(progression.userId, UserId)).all()
        .map((Row) => ({
            trackId: Row.trackId,
            generation: Row.generation,
            totalPoints: Row.totalPoints,
            confirmedRank: Row.confirmedRank,
            confirmedPremiumRank: Row.confirmedPremiumRank,
            updatedAt: Row.updatedAt
        }));
}

// Premium access for a track. In "free" mode every player is treated as
// holding the gate, which is the sensible default for a private server with no
// real storefront. In "entitlement" mode the entitlements table decides.
//
// A track with no configured gate has no premium tier to unlock.
export function HasPremiumForTrack(UserId: string, TrackId: string): boolean {
    const Gate = GetPremiumGatingEntitlement(TrackId);

    if(Gate == undefined){
        return false;
    }

    if(GetPremiumMode() === "free"){
        return true;
    }

    return GetDb().select().from(entitlements)
        .where(and(eq(entitlements.userId, UserId), eq(entitlements.entitlement, Gate)))
        .get() != undefined;
}

// The wire DTO. Field names - including the "fremium" spelling - come from the
// original Phoenix API and are what this client parses.
//
// Unverified: whether `progress` is FPlayerProgress::TotalPoints or RankPoints.
// The client carries both but the wire carries one number. Total is used here
// because rank is derived from it; if a capture shows otherwise this is the
// single place to change.
export function ToWireTrack(UserId: string, State: TrackState){
    return {
        phx_account_id: UserId,
        progression_id: State.trackId,
        progress: State.totalPoints,
        confirmed_fremium_rank: State.confirmedRank,
        confirmed_premium_rank: State.confirmedPremiumRank,
        confirmed_date: new Date(State.updatedAt).toISOString()
    };
}

export function GetWireTrack(UserId: string, TrackId: string){
    return ToWireTrack(UserId, GetTrackState(UserId, TrackId));
}

// The per-player tracks the client reads on login. 1.12.0 adds weapon skill
// and player XP (ExperienceTrack_*) and weapon prestige (PrestigeTrack_*)
// beside the mastery tracks; left out, the client showed 0 XP in every newly
// loaded world until the next award returned the real total. The 1.4.4
// configuration has no tracks with those prefixes.
const LOGIN_TRACK_PREFIXES = ["MasteryTrack_", "ExperienceTrack_", "PrestigeTrack_"];

export function GetWireMasteryTracks(UserId: string){
    const States = new Map(GetAllTrackStates(UserId).map((State) => [State.trackId, State]));
    return GetAllTrackIds().filter((Id) => LOGIN_TRACK_PREFIXES.some((Prefix) => Id.startsWith(Prefix)))
        .map((Id) => ToWireTrack(UserId, States.get(Id) ?? DefaultState(Id)));
}

export function GetWireProgressionTracks(UserId: string){
    // The main pass always; the player's chosen event pass beside it, so its
    // levels show on the Hunt Pass screen.
    const Selected = GetSelectedHuntPassId(UserId);
    const Passes = Selected === GetActiveHuntPassId() ? [Selected] : [GetActiveHuntPassId(), Selected];
    return [...Passes.map((TrackId) => GetWireTrack(UserId, TrackId)), ...GetWireMasteryTracks(UserId)];
}

// Rank derived from stored points against the active config, for callers that
// need the computed view rather than the raw wire DTO.
export function GetDerivedProgress(UserId: string, TrackId: string){
    const State = GetTrackState(UserId, TrackId);
    const Derived = DeriveRank(TrackId, State.totalPoints);

    return {
        ...Derived,
        trackId: TrackId,
        totalPoints: State.totalPoints,
        confirmedRank: State.confirmedRank,
        confirmedPremiumRank: State.confirmedPremiumRank,
        hasPremium: HasPremiumForTrack(UserId, TrackId),
        isConfigured: GetTrackConfig(TrackId) != undefined
    };
}
