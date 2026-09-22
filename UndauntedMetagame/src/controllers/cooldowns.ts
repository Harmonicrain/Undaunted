import { and, eq } from "drizzle-orm";
import { GetDb } from "../db";
import { cooldowns } from "../db/schema";
import { logger } from "../logger";

// Account cooldowns.
//
// The shapes here come from the 1.4.4 executable, not from inference:
//
//   - The cooldown DTO's container serializer (0x141448700) reads the ASCII
//     root key "cooldowns"; its entry serializer (0x141448e50) reads the wide
//     strings "cooldown_id" and "cooldown_started_date", both as strings.
//     That same container is what SetCooldownBatch sends, so the batch PUT body
//     is {"cooldowns":[{"cooldown_id":..., "cooldown_started_date":...}]}.
//
//   - The GET response is parsed by OnQueryCooldownDataRequestComplete into a
//     DTO (vtable 0x1446b11d8) whose serializer reads code / message / payload,
//     with payload held as TMap<FString, FString>: cooldown id -> ISO date.
//     At 0x14143c820 the consumer walks 0x28-byte map entries, parses the
//     FString at +0x10 as a date, then copies the key as TrackingId. It does
//     NOT consume the batch write DTO ({cooldowns: [...]}) on a read.
//
// The bounty system is the reason this matters. See the note on the table in
// db/schema.ts.

export type CooldownEntry = { cooldown_id: string, cooldown_started_date: string };

export function GetCooldownsForUser(UserId: string): CooldownEntry[] {
    return GetDb().select().from(cooldowns).where(eq(cooldowns.userId, UserId)).all()
        .map((Row) => ({ cooldown_id: Row.cooldownId, cooldown_started_date: Row.startedDate }));
}

function Upsert(UserId: string, CooldownId: string, StartedDate: string){
    const Existing = GetDb().select().from(cooldowns)
        .where(and(eq(cooldowns.userId, UserId), eq(cooldowns.cooldownId, CooldownId))).get();

    if(Existing == undefined){
        GetDb().insert(cooldowns).values({
            userId: UserId, cooldownId: CooldownId, startedDate: StartedDate, updatedAt: Date.now()
        }).run();
    }
    else{
        GetDb().update(cooldowns).set({ startedDate: StartedDate, updatedAt: Date.now() })
            .where(and(eq(cooldowns.userId, UserId), eq(cooldowns.cooldownId, CooldownId))).run();
    }
}

// The date is stored as the string the gameserver sent, not reparsed: it is
// read back by the same client that wrote it, so preserving its exact format
// is safer than normalising it into one this server prefers.
function ValidEntry(Entry: any): Entry is CooldownEntry {
    return typeof Entry?.cooldown_id === "string" && Entry.cooldown_id.length > 0
        && typeof Entry?.cooldown_started_date === "string" && Entry.cooldown_started_date.length > 0;
}

// SetCooldownBatch / SetCooldown. Merged by id - a batch names the cooldowns it
// is setting, not the complete set the account holds.
export function SetCooldownsForUser(UserId: string, Body: any){
    const Entries: any[] = Array.isArray(Body?.cooldowns) ? Body.cooldowns : [];

    let Applied = 0;

    for(const Entry of Entries){
        if(!ValidEntry(Entry)){
            logger.warn(`Ignoring malformed cooldown entry for ${UserId}: ${JSON.stringify(Entry)}`);
            continue;
        }

        Upsert(UserId, Entry.cooldown_id, Entry.cooldown_started_date);
        Applied++;
    }

    logger.info(`Set ${Applied} cooldown(s) for ${UserId}`);

    return GetCooldownsForUser(UserId);
}

// StartCooldown: start one cooldown now, by id in the path.
export function StartCooldownForUser(UserId: string, CooldownId: string, StartedDate?: string){
    if(typeof CooldownId !== "string" || CooldownId.length === 0){
        throw new Error("cooldown id is required");
    }

    const When = typeof StartedDate === "string" && StartedDate.length > 0 ? StartedDate : new Date().toISOString();

    Upsert(UserId, CooldownId, When);

    logger.info(`Started cooldown ${CooldownId} for ${UserId} at ${When}`);

    return GetCooldownsForUser(UserId);
}
