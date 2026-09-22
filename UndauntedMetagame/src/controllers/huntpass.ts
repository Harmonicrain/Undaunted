import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger";
import bundledProgressionConfig from "../vendor/progression_config.json";

// Hunt Pass configuration.
//
// Every other config in this server is `import`ed and therefore compiled into
// the bundle, which means changing a reward needs a rebuild. A server owner
// has to be able to pick a season and edit its rewards without touching
// TypeScript, so this is the one module that reads from disk.
//
// Seasons are loaded once, at boot, and validated there. A malformed file must
// fail while the operator is watching the server start, not on the first
// request from a player hours later.
//
// The shape of a path matches FOnlineProgressionTrackTableData in the client's
// own SDK: progression_id, premium_gating_entitlement, start/end dates,
// progression_multiplier, requirements[], free_rewards[], premium_rewards[].

export type ProgressionRequirement = { rank_id: number, xp_required: number };

export type ProgressionPath = {
    progression_id: string,
    premium_gating_entitlement?: string,
    progression_multiplier?: number,
    start_date?: string,
    end_date?: string,
    requirements?: ProgressionRequirement[],
    free_rewards?: any[],
    premium_rewards?: any[],
    prestige?: any
};

export class HuntPassConfigError extends Error {}

const SEASONS_DIR = process.env.HUNT_PASS_SEASONS_DIR;
const PREMIUM_MODE = process.env.HUNT_PASS_PREMIUM_MODE === "free" ? "free" : "entitlement";

// A path loaded from disk replaces a bundled path with the same id, so an
// owner can override season09b without editing the vendored file.
function LoadPathsFromDisk(Directory: string): ProgressionPath[] {
    if(!existsSync(Directory)){
        logger.info(`Hunt Pass seasons directory ${Directory} does not exist - using the bundled configuration only`);
        return [];
    }

    const Files = readdirSync(Directory).filter((Name) => Name.toLowerCase().endsWith(".json"));
    const Loaded: ProgressionPath[] = [];

    for(const Name of Files){
        const FullPath = join(Directory, Name);
        let Parsed: unknown;

        try{
            Parsed = JSON.parse(readFileSync(FullPath, "utf8"));
        } catch(Error: any){
            throw new HuntPassConfigError(`${FullPath} is not valid JSON: ${Error.message}`);
        }

        // A file may hold one path or an array of them.
        const Paths = Array.isArray(Parsed) ? Parsed : [Parsed];

        for(const Path of Paths){
            AssertValidPath(Path, FullPath);
            Loaded.push(Path as ProgressionPath);
        }
    }

    return Loaded;
}

function AssertValidPath(Path: any, Source: string): void {
    if(Path == undefined || typeof Path !== "object"){
        throw new HuntPassConfigError(`${Source} does not contain a progression path object`);
    }

    if(typeof Path.progression_id !== "string" || Path.progression_id.length === 0){
        throw new HuntPassConfigError(`${Source} is missing a progression_id`);
    }

    if(!Array.isArray(Path.requirements) || Path.requirements.length === 0){
        throw new HuntPassConfigError(`${Source} (${Path.progression_id}) has no requirements, so no rank could ever be reached`);
    }

    for(const Requirement of Path.requirements){
        if(!Number.isInteger(Requirement?.rank_id) || !Number.isInteger(Requirement?.xp_required) || Requirement.xp_required < 0){
            throw new HuntPassConfigError(`${Source} (${Path.progression_id}) has a requirement that is not a {rank_id, xp_required} pair of non-negative integers`);
        }
    }

    for(const Field of ["free_rewards", "premium_rewards"]){
        if(Path[Field] != undefined && !Array.isArray(Path[Field])){
            throw new HuntPassConfigError(`${Source} (${Path.progression_id}) has a ${Field} that is not an array`);
        }
    }
}

const BundledPaths = (bundledProgressionConfig as any).payload.paths as ProgressionPath[];

const DiskPaths = SEASONS_DIR ? LoadPathsFromDisk(SEASONS_DIR) : [];

const PathsById = new Map<string, ProgressionPath>();

for(const Path of BundledPaths){
    PathsById.set(Path.progression_id, Path);
}

for(const Path of DiskPaths){
    if(PathsById.has(Path.progression_id)){
        logger.info(`Hunt Pass season ${Path.progression_id} overridden from ${SEASONS_DIR}`);
    }

    PathsById.set(Path.progression_id, Path);
}

// The active Hunt Pass. ACTIVE_HUNT_PASS is the bootstrap default; an
// administrative change persists and takes precedence over it on restart,
// which is why this is a variable rather than a constant read at use sites.
const ConfiguredActive = process.env.ACTIVE_HUNT_PASS ?? "season09b";

let ActiveHuntPassId = ConfiguredActive;

if(!PathsById.has(ConfiguredActive)){
    throw new HuntPassConfigError(
        `ACTIVE_HUNT_PASS is "${ConfiguredActive}" but no such progression path was loaded. Known paths: ${[...PathsById.keys()].join(", ")}`);
}

logger.info(`Hunt Pass configuration loaded: ${PathsById.size} path(s), active season ${ActiveHuntPassId}, premium mode ${PREMIUM_MODE}`);

export function GetActiveHuntPassId(){
    return ActiveHuntPassId;
}

export function SetActiveHuntPassId(SeasonId: string){
    if(!PathsById.has(SeasonId)){
        throw new HuntPassConfigError(`Unknown season ${SeasonId}`);
    }

    ActiveHuntPassId = SeasonId;

    logger.info(`Active Hunt Pass set to ${SeasonId}`);
}

export function GetPremiumMode(){
    return PREMIUM_MODE;
}

export function GetTrackConfig(TrackId: string){
    return PathsById.get(TrackId);
}

export function GetAllTrackIds(){
    return [...PathsById.keys()];
}

// Served by GET /progression/config, in the envelope the client expects.
export function GetProgressionConfigPayload(){
    return {
        code: null,
        message: "OK",
        payload: {
            paths: [...PathsById.values()]
        }
    };
}

// Requirements are per-rank XP, not cumulative: season09b lists 100 for each of
// ranks 1..50. Rank is therefore the highest rank whose running total has been
// paid for. A rank costing 0 is reached immediately, which is a real case -
// MasteryTrack_PlayerLevel has rank_id 1 at xp_required 0.
export function DeriveRank(TrackId: string, TotalPoints: number){
    const Track = PathsById.get(TrackId);

    if(Track?.requirements == undefined || Track.requirements.length === 0){
        return { rank: 0, rankPoints: 0, maxRank: 0, nextRankCost: 0 };
    }

    const Ordered = [...Track.requirements].sort((Left, Right) => Left.rank_id - Right.rank_id);

    const Points = Number.isFinite(TotalPoints) && TotalPoints > 0 ? Math.floor(TotalPoints) : 0;

    let Cumulative = 0;
    let CumulativeAtRank = 0;
    let Rank = 0;
    let NextRankCost = 0;

    for(const Requirement of Ordered){
        Cumulative += Requirement.xp_required;

        if(Points >= Cumulative){
            Rank = Requirement.rank_id;
            CumulativeAtRank = Cumulative;
        }
        else{
            NextRankCost = Requirement.xp_required;
            break;
        }
    }

    return {
        rank: Rank,
        rankPoints: Points - CumulativeAtRank,
        maxRank: Ordered[Ordered.length - 1].rank_id,
        nextRankCost: NextRankCost
    };
}

export function GetPremiumGatingEntitlement(TrackId: string){
    const Gate = PathsById.get(TrackId)?.premium_gating_entitlement;

    return Gate != undefined && Gate.length > 0 ? Gate : undefined;
}
