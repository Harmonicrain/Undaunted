import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./db/schema";
import { RepairLegacyAceChipBalances, RepairLegacySlayerLinkSlots } from "./db/repairs";
import { DatabaseFilename } from "./config/environment";
import { logger } from "./logger";

type Database = ReturnType<typeof drizzle<typeof schema>>;
let database: Database | undefined;

// Startup owns opening, migrations and historical-data repairs. Importing a
// feature or reading the database never performs a migration implicitly.
export function InitializeDatabase(): Database {
    if (database) return database;
    const opened = drizzle(DatabaseFilename(), { schema });
    try {
        migrate(opened, { migrationsFolder: "./src/drizzle" });
        RepairLegacySlayerLinkSlots(opened.$client as any, message => logger.warn(message));
        RepairLegacyAceChipBalances(opened.$client as any, message => logger.warn(message));
        database = opened;
        return opened;
    } catch (error) {
        opened.$client.close();
        throw error;
    }
}

export function GetDb(): Database {
    if (!database) throw new Error("Database has not been initialized; call InitializeDatabase at startup");
    return database;
}
