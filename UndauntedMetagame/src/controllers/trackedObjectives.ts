import { eq } from "drizzle-orm";
import { GetDb } from "../db";
import { trackedobjectives } from "../db/schema";

export type TrackingSettings = {
    current_set: string,
    omitted_quests: string[],
    tracked_quests: string[],
    tracked_craftables: string[]
};

export class TrackingSettingsError extends Error {}

export function GetTrackedObjectives(UserId: string){
    const Row = GetDb().select().from(trackedobjectives).where(eq(trackedobjectives.userId, UserId)).get();
    const Settings: TrackingSettings = Row == undefined
        ? { current_set: "quest_slayer_links", omitted_quests: [], tracked_quests: [], tracked_craftables: [] }
        : JSON.parse(Row.payload);
    return { ...Settings, phx_account_id: UserId };
}

export function SaveTrackedObjectives(UserId: string, Payload: any){
    // The native request is a full snapshot. Reject incomplete writes rather
    // than accidentally clearing pins; explicit empty arrays mean unpin all.
    const IsStringList = (Value: unknown): Value is string[] =>
        Array.isArray(Value) && Value.every(Item => typeof Item === "string");
    if(Payload == null || typeof Payload !== "object" || Array.isArray(Payload) ||
        typeof Payload.current_set !== "string" ||
        !IsStringList(Payload.omitted_quests) || !IsStringList(Payload.tracked_quests) ||
        !IsStringList(Payload.tracked_craftables) ||
        (Payload.phx_account_id !== undefined && Payload.phx_account_id !== UserId)){
        throw new TrackingSettingsError("Invalid tracked objectives snapshot");
    }
    const Settings: TrackingSettings = {
        current_set: Payload.current_set,
        omitted_quests: Payload.omitted_quests,
        tracked_quests: Payload.tracked_quests,
        tracked_craftables: Payload.tracked_craftables
    };
    const Values = { userId: UserId, payload: JSON.stringify(Settings), updatedAt: Date.now() };
    GetDb().insert(trackedobjectives).values(Values)
        .onConflictDoUpdate({ target: trackedobjectives.userId, set: Values }).run();
}
