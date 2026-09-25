import { readFileSync } from "node:fs";
import { logger } from "../logger";

// Seasonal events (Dark Harvest, Frostfall, ...), switched on from here.
//
// The 1.12.0 client and gameserver read GET /game_tuning/seasonal_event_schedule
// into UTuningDataProvider::SeasonalEventSchedule (an FServiceSchedule), and
// UPlayerEventModeComponent::IsEventActive(EventID) answers from it: an event
// runs while a schedule row lists its id (the quest series' EventId, e.g.
// EVENT_DARKHARVEST) and the row's StartTime..EndTime covers now.
//
// Some event content is also behind a feature flag baked off in the client's
// paks: Ramsgate's persistent level streams in city_01_event_dark_harvest (the
// decorations and the Unseen, who gives the event's quests) only when
// city_event_dark_harvest_bpff is enabled, and city_01_event_stall (Ozz, the
// event vendor) only with city_event_stall_bpff. The runtime DLL forces on
// the flags GET /undaunted/feature_flags lists, so an event and its Ramsgate
// content are switched on together here.
//
// SEASONAL_EVENTS_FILE holds
// { events: [{ name, start, end, scheduledItems: [eventId], featureFlags?: [flag] }] }
// with start and end as ISO 8601 times. Unset, no event runs, as before.

type SeasonalEvent = { name: string, start: number, end: number, scheduledItems: string[], featureFlags: string[] };

const IsStringArray = (Value: unknown): Value is string[] =>
    Array.isArray(Value) && Value.every((Item) => typeof Item === "string" && Item.length > 0);

function LoadEvents(): SeasonalEvent[] {
    const File = process.env.SEASONAL_EVENTS_FILE;
    if(File == undefined || File.trim().length === 0) return [];
    const Parsed = JSON.parse(readFileSync(File, "utf8"));
    if(!Array.isArray(Parsed?.events)) throw new Error(`SEASONAL_EVENTS_FILE ${File} has no events list`);

    return Parsed.events.map((Event: any, Index: number) => {
        const Start = Date.parse(Event?.start), End = Date.parse(Event?.end);
        if(typeof Event?.name !== "string" || !Number.isFinite(Start) || !Number.isFinite(End) || End <= Start ||
            !IsStringArray(Event?.scheduledItems) || (Event.featureFlags !== undefined && !IsStringArray(Event.featureFlags))){
            throw new Error(`SEASONAL_EVENTS_FILE ${File}: event ${Index} needs a name, start < end and scheduledItems`);
        }
        return { name: Event.name, start: Start, end: End, scheduledItems: Event.scheduledItems, featureFlags: Event.featureFlags ?? [] };
    });
}

const Events = LoadEvents();
if(Events.length > 0){
    logger.info(`Seasonal events loaded: ${Events.map((Event) =>
        `${Event.name} ${new Date(Event.start).toISOString()}..${new Date(Event.end).toISOString()}`).join(", ")}`);
}

// FServiceSchedule as the client's JSON converter reads it: one FScheduleData
// row per event, times in ISO 8601, each event id an FScheduledItem.
export function SeasonalEventSchedule(){
    return {
        ScheduledItems: Events.map((Event) => ({
            Name: Event.name,
            StartTime: new Date(Event.start).toISOString(),
            EndTime: new Date(Event.end).toISOString(),
            IsRepeatable: false,
            bShouldQueueTheSheduleItems: false,
            ScheduledItems: Event.scheduledItems.map((ID) => ({ ID })),
            ItemsToBeLeftOutOfTheRotation: []
        }))
    };
}

// The feature flags of every event running now, for the runtime DLL.
export function ActiveFeatureFlags(Now = Date.now()){
    return [...new Set(Events.filter((Event) => Event.start <= Now && Now < Event.end)
        .flatMap((Event) => Event.featureFlags))];
}
