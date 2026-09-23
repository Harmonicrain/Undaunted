import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator"
import * as schema from "./db/schema"
import { RepairLegacySlayerLinkSlots } from "./db/repairs";
import { logger } from "./logger";

 const db = drizzle(process.env.DB_FILENAME!, {schema});

let didMigration = false;

export function GetDb(){
    if(!didMigration){
        didMigration = true;

        migrate(db, {migrationsFolder: "./src/drizzle"});

        RepairLegacySlayerLinkSlots(db.$client as any, (Message) => logger.warn(Message));
    }

    return db;
}
