import { eq } from "drizzle-orm";
import { GetDb } from "../db";
import { selectedhuntpasses } from "../db/schema";
import { GetActiveHuntPassId, GetProgressionConfigPayload } from "./huntpass";

// The hunt pass each player has chosen. The Hunt Pass selection screen lists
// the season's main pass and the event passes on offer (huntpass_store); when
// a player picks one, the gameserver posts {"progression_id"} to
// /huntpass/{account}, and GET /huntpass/{account} (SelectedHuntPassEndpoint)
// is how the client and the gameserver learn it. The POST was unrouted, so a
// player's choice (seen: eventpass_unseenrecruit, straight after buying it)
// was lost and everyone stayed on the main pass.
//
// The main pass is always selectable; an event pass only while the progression
// config serves it as open (its event's window, controllers/seasonalEvents).
// A selection whose event has ended reads as the main pass again.

export class HuntPassSelectionError extends Error {}

function IsSelectable(TrackId: string, Now: number){
    if(TrackId === GetActiveHuntPassId()) return true;
    if(!TrackId.startsWith("eventpass_")) return false;
    const Path: any = GetProgressionConfigPayload().payload.paths.find((Candidate: any) => Candidate.progression_id === TrackId);
    const Start = Date.parse(Path?.start_date ?? ""), End = Date.parse(Path?.end_date ?? "");
    return Number.isFinite(Start) && Number.isFinite(End) && Start <= Now && Now < End;
}

export function GetSelectedHuntPassId(UserId: string, Now = Date.now()){
    const Row = GetDb().select().from(selectedhuntpasses).where(eq(selectedhuntpasses.userId, UserId)).get();
    return Row != undefined && IsSelectable(Row.progressionId, Now) ? Row.progressionId : GetActiveHuntPassId();
}

export function SetSelectedHuntPassId(UserId: string, TrackId: unknown, Now = Date.now()){
    if(typeof TrackId !== "string" || !IsSelectable(TrackId, Now)){
        throw new HuntPassSelectionError(`${String(TrackId)} is not a hunt pass that can be selected now`);
    }
    GetDb().insert(selectedhuntpasses).values({ userId: UserId, progressionId: TrackId, updatedAt: Now })
        .onConflictDoUpdate({ target: selectedhuntpasses.userId, set: { progressionId: TrackId, updatedAt: Now } }).run();
    return TrackId;
}
