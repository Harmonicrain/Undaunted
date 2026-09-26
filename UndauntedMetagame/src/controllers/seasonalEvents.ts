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
// An event's pass (Dark Harvest: eventpass_unseenrecruit) is a progression
// track the client opens only between its start_date and end_date, and the
// captured config carries the dates of its last live run. Listing it under
// eventPasses serves it with the event's own window instead.
//
// An event's store (Honest Ozz's Event Store lists the offers tagged
// seasonal_event) is listed under storeTags: those tags are listed and sold
// only while the event runs. Tags no event lists are always open.
//
// SEASONAL_EVENTS_FILE holds
// { events: [{ name, start, end, scheduledItems: [eventId], featureFlags?: [flag],
//              eventPasses?: [trackId], storeTags?: [tag] }] }
// with start and end as ISO 8601 times. Unset, no event runs, as before.

type SeasonalEvent = { name: string, start: number, end: number, scheduledItems: string[], featureFlags: string[],
    eventPasses: string[], storeTags: string[] };

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
            !IsStringArray(Event?.scheduledItems) || (Event.featureFlags !== undefined && !IsStringArray(Event.featureFlags)) ||
            (Event.eventPasses !== undefined && !IsStringArray(Event.eventPasses)) ||
            (Event.storeTags !== undefined && !IsStringArray(Event.storeTags))){
            throw new Error(`SEASONAL_EVENTS_FILE ${File}: event ${Index} needs a name, start < end and scheduledItems`);
        }
        return { name: Event.name, start: Start, end: End, scheduledItems: Event.scheduledItems,
            featureFlags: Event.featureFlags ?? [], eventPasses: Event.eventPasses ?? [], storeTags: Event.storeTags ?? [] };
    });
}

const Events = LoadEvents();
if(Events.length > 0){
    logger.info(`Seasonal events loaded: ${Events.map((Event) =>
        `${Event.name} ${new Date(Event.start).toISOString()}..${new Date(Event.end).toISOString()}`).join(", ")}`);
}

// FServiceSchedule as the client's JSON converter reads it, times in ISO 8601.
//
// A row's Name is the event id, one row per id. The game asks
// UTuningDataStatics::IsScheduledItemActive (1.12.0: 0x01C98C50), which walks
// UTuningDataProvider::SeasonalEventSchedule and compares each row's Name
// (FText::EqualTo against FText::FromName(ID)) before checking StartTime <= now
// < EndTime; it never reads the nested ScheduledItems. Rows named after the
// event ("Dark Harvest") matched nothing, so EVENT_DARKHARVEST never counted as
// active and its quests were never offered.
export function SeasonalEventSchedule(){
    return {
        ScheduledItems: Events.flatMap((Event) => Event.scheduledItems.map((ID) => ({
            Name: ID,
            StartTime: new Date(Event.start).toISOString(),
            EndTime: new Date(Event.end).toISOString(),
            IsRepeatable: false,
            bShouldQueueTheSheduleItems: false,
            ScheduledItems: [{ ID }],
            ItemsToBeLeftOutOfTheRotation: []
        })))
    };
}

// The window each event pass is served with, in the progression config's own
// date format ("2024-11-05T17:00:00+00:00").
export function EventPassWindows(){
    const Format = (Time: number) => new Date(Time).toISOString().replace(/\.\d{3}Z$/, "+00:00");
    const Windows = new Map<string, { start_date: string, end_date: string }>();
    for(const Event of Events){
        for(const TrackId of Event.eventPasses){
            Windows.set(TrackId, { start_date: Format(Event.start), end_date: Format(Event.end) });
        }
    }
    return Windows;
}

// Whether a store tag is open now: always, unless an event lists it, and then
// only while one of the events listing it runs.
export function IsStoreTagOpen(Tag: string, Now = Date.now()){
    const Listing = Events.filter((Event) => Event.storeTags.includes(Tag));
    return Listing.length === 0 || Listing.some((Event) => Event.start <= Now && Now < Event.end);
}

// The window of the running event that lists a store tag, for the offers'
// availableFrom / availableTo (the Hunt Pass selection screen shows an event
// pass as "Available until" its availableTo). Undefined when no running event
// lists the tag.
export function StoreTagWindow(Tag: string, Now = Date.now()){
    const Event = Events.find((Candidate) => Candidate.storeTags.includes(Tag) && Candidate.start <= Now && Now < Candidate.end);
    return Event == undefined ? undefined
        : { availableFrom: new Date(Event.start).toISOString(), availableTo: new Date(Event.end).toISOString() };
}

// The feature flags of every event running now, for the runtime DLL.
export function ActiveFeatureFlags(Now = Date.now()){
    return [...new Set(Events.filter((Event) => Event.start <= Now && Now < Event.end)
        .flatMap((Event) => Event.featureFlags))];
}
