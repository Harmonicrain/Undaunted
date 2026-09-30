import { existsSync } from "node:fs";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import * as schema from "./db/schema";
import { CountPendingRepairs, RepairLegacyAceChipBalances, RepairLegacySlayerLinkSlots } from "./db/repairs";
import { DatabaseFilename } from "./config/environment";
import { logger } from "./logger";

type Database = ReturnType<typeof drizzle<typeof schema>>;
type Client = Database["$client"];
let database: Database | undefined;

const MIGRATIONS_FOLDER = "./src/drizzle";

// Startup owns opening, migrations and historical-data repairs. Importing a
// feature or reading the database never performs a migration implicitly.
//
// Existing player data is copied aside before startup changes it: before
// pending schema migrations, and before a data repair that has rows to fix.
// A new, empty database has nothing to protect.
export function InitializeDatabase(): Database {
    if (database) return database;
    const filename = DatabaseFilename();
    const opened = drizzle(filename, { schema });
    try {
        let backup: string | undefined;
        if (HasPendingMigrations(opened.$client)) {
            backup = BackUpDatabase(opened.$client, filename, "Migration");
        }
        migrate(opened, { migrationsFolder: MIGRATIONS_FOLDER });
        if (!backup && CountPendingRepairs(opened.$client as any) > 0) {
            BackUpDatabase(opened.$client, filename, "Repair");
        }
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

// Mirrors drizzle's own test: a migration runs when no migration has been
// recorded, or when it is newer than the last one recorded.
function HasPendingMigrations(Client: Client): boolean {
    const Tables = Client.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];
    if (Tables.length === 0) return false;
    const Last = Tables.some(Table => Table.name === "__drizzle_migrations")
        ? Client.prepare('SELECT created_at FROM "__drizzle_migrations" ORDER BY created_at DESC LIMIT 1').get() as { created_at: unknown } | undefined
        : undefined;
    return readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER })
        .some(Migration => !Last || Number(Last.created_at) < Migration.folderMillis);
}

// VACUUM INTO writes a consistent copy synchronously, next to the database:
// <db>.bak-pre<Reason>-<UTC timestamp>.
function BackUpDatabase(Client: Client, Filename: string, Reason: string): string | undefined {
    if (Filename === ":memory:" || Filename.startsWith("file::memory:")) return undefined;
    const Stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\.\d+Z$/, "");
    let Target = `${Filename}.bak-pre${Reason}-${Stamp}`;
    for (let Suffix = 2; existsSync(Target); Suffix++) Target = `${Filename}.bak-pre${Reason}-${Stamp}-${Suffix}`;
    Client.prepare("VACUUM INTO ?").run(Target);
    logger.warn(`Backed up the database to ${Target} before the ${Reason.toLowerCase()} at startup`);
    return Target;
}
