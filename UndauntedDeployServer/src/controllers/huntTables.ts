import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import BundledPlayerHunts from "../vendor/player_hunts_table.json";
import BundledMatchmakerHunts from "../vendor/matchmaker_hunts_table.json";
import BundledTrialsHard from "../vendor/trials_hard_table.json";
import BundledTrialsElite from "../vendor/trials_elite_table.json";
import { logger } from "../logger";

type Rows = Record<string, any>;

// The bundled tables are 1.4.4's. HUNT_DATA_DIR points at tables of the same
// shape for the client being served - tools/Build-Hunts112.mjs builds 1.12.0's,
// with its new islands, escalations and trials - kept outside the repo because
// they are game data. A table missing there falls back to the bundled one.
function Load(File: string, Bundled: any[] | undefined): Rows | undefined {
    const Dir = process.env.HUNT_DATA_DIR;

    if(Dir != undefined && Dir.length > 0){
        const Path = join(Dir, File);

        if(existsSync(Path)){
            const Loaded: Rows = JSON.parse(readFileSync(Path, "utf8"))[0].Rows;

            logger.info(`Hunt table ${File}: ${Object.keys(Loaded).length} rows from HUNT_DATA_DIR`);

            return Loaded;
        }

        logger.warn(`Hunt table ${File} is not in HUNT_DATA_DIR${Bundled ? ", using the bundled one" : ""}`);
    }

    return Bundled?.[0].Rows;
}

export const PlayerHunts = Load("player_hunts_table.json", BundledPlayerHunts)!;
export const MatchmakerHunts = Load("matchmaker_hunts_table.json", BundledMatchmakerHunts)!;

const TrialsHard = Load("trials_hard_table.json", BundledTrialsHard)!;

// Easy trials are new in 1.12.0; with no table for them they run as Hard ones.
export const TrialsHunts: Record<"Easy" | "Hard" | "Elite", Rows> = {
    Easy: Load("trials_easy_table.json", undefined) ?? TrialsHard,
    Hard: TrialsHard,
    Elite: Load("trials_elite_table.json", BundledTrialsElite)!
};
