import { spawn } from "node:child_process"
import { execFile } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

import crypto from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";

import PlayerHuntTable from "../vendor/player_hunts_table.json";
import MatchmakerHuntTable from "../vendor/matchmaker_hunts_table.json";
import TrialsHardHuntTable from "../vendor/trials_hard_table.json";
import TrialsEliteHuntTable from "../vendor/trials_elite_table.json";
import { kill } from "node:process";
import { logger } from "../logger";

const RAMSGATE_MAP_PATH = "/Game/Maps/ramsgate/ramsgate_01_persistent";
const TRAINING_DOJO_MAP_PATH = "/Game/Maps/islands/dojo/training_dojo_persistent";
const TRIALS_MAP_PATH = "/Game/Maps/islands/arenas/arena_ramsgate_00";

export type Gameserver = {
    id: string,
    port: number,
    map: string,
    behemoth: string | undefined,
    matchmakerHuntId: string | undefined,
    expectedPlayers: ExpectedPlayer[] | undefined,
    isRamsgate: boolean,
    isTrainingDojo: boolean,
    processId: number,
    startTime: Date
};

type ExpectedPlayer = {
    playerUid: string,
    playerHuntId: string
};

export let Gameservers: Gameserver[] = [];
let FreePorts: number[] = [];

let RamsgateServer : Gameserver | undefined;
let TrainingDojoServer : Gameserver | undefined;

const PORT_RANGE_BEGIN = Number(process.env.PORT_RANGE_BEGIN!);
const PORT_RANGE_END = Number(process.env.PORT_RANGE_END!);
const RAMSGATE_PORT = PORT_RANGE_END;
const TRAINING_DOJO_PORT = PORT_RANGE_END - 1;
const GAMESERVER_BINARY_PATH = process.env.GAMESERVER_BINARY_PATH!;
const STANDARD_GAMESERVER_ARGS = ["-EpicPortal", "-server", "-nullrhi"];

// Gameserver output is otherwise discarded: the child is spawned onto a pipe
// nothing reads and then unref'd. That matters because the gameserver, not the
// client, is what talks to the metagame for progression and entitlements, so
// when something it fetches does not take effect there is no way to see why.
//
// Opt-in and off by default. GAMESERVER_LOG_DIR turns capture on;
// GAMESERVER_LOG_CMDS is passed straight through to UE's -LogCmds, e.g.
// "global none, LogOnlineEntitlement Verbose" to get one category and nothing
// else.
const GAMESERVER_LOG_DIR = process.env.GAMESERVER_LOG_DIR;
const GAMESERVER_LOG_CMDS = process.env.GAMESERVER_LOG_CMDS;
const METAGAME_API_KEY = process.env.METAGAME_API_KEY!;
const MY_IP = process.env.MY_IP!;
const METAGAME_ADDRESS = process.env.METAGAME_ADDRESS!;
const SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP = Number(process.env.SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP!);
const execFileAsync = promisify(execFile);

async function WaitForGamePort(pid: number, port: number) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        try {
            const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "UDP"]);
            const listening = stdout.split(/\r?\n/).some(line => {
                // Windows netstat -ano prints: UDP  local-address  remote-address  PID.
                const fields = line.trim().split(/\s+/);
                if (fields.length < 4 || fields[0].toUpperCase() !== "UDP") return false;
                const local = fields[1].replace(/^\[|\]$/g, "");
                const localPort = Number(local.slice(local.lastIndexOf(":") + 1));
                return localPort === port && Number(fields.at(-1)) === pid;
            });
            if (listening) return;
        } catch (error) {
            logger.error({ error }, "Could not check gameserver UDP readiness");
            throw error;
        }
        await setTimeout(1000);
    }
    throw new Error(`Gameserver PID ${pid} did not listen on UDP ${port} within 60 seconds`);
}

function TransformExpectedPlayerArgs(ExpectedPlayers: ExpectedPlayer[]){
    let ToReturn = "";

    for(const Player of ExpectedPlayers){
        ToReturn = ToReturn + Player.playerUid + ":" + Player.playerHuntId + ",";
    }

    if(ToReturn.length > 0){
        ToReturn = ToReturn.slice(0, -1); // Remove trailing ','
    }

    return ToReturn;
}

export async function CleanupServer(ServerToShutdown: Gameserver){
    Gameservers = Gameservers.filter(Server => Server !== ServerToShutdown);

    if(ServerToShutdown.isRamsgate){
        logger.warn("RAMSGATE HAS FALLEN! Restarting!");

        RamsgateServer = await StartServer(RAMSGATE_MAP_PATH, undefined, undefined, undefined, true, false);
    }
    else if(ServerToShutdown.isTrainingDojo){
        logger.warn("Training Dojo Crashed! Restarting!");

        TrainingDojoServer = await StartServer(TRAINING_DOJO_MAP_PATH, undefined, undefined, undefined, false, true);
    }
    else{
        FreePorts.push(ServerToShutdown.port);
    }
}

let ServerLaunchQueue: Promise<void> = Promise.resolve();

async function StartServer(Map: string, Behemoth: string | undefined, MatchmakerHuntId: string | undefined, ExpectedPlayers: ExpectedPlayer[] | undefined, IsRamsgate: boolean, IsTrainingDojo: boolean){
    const LaunchProc = ServerLaunchQueue;

    ServerLaunchQueue = ServerLaunchQueue.catch(() => {}).then(async () => await setTimeout(SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP * 1000));

    await LaunchProc;
    
    let Port;

    if(IsRamsgate){
        Port = RAMSGATE_PORT;
    }
    else if(IsTrainingDojo){
        Port = TRAINING_DOJO_PORT;
    }
    else{
        Port = FreePorts.pop();
    }

    const Id = crypto.randomUUID();

    if(Port == undefined){
        throw new Error("No free ports left!");
    }

    const DiagnosticArgs = GAMESERVER_LOG_DIR != undefined
        ? ["-log", ...(GAMESERVER_LOG_CMDS != undefined ? [`-LogCmds=${GAMESERVER_LOG_CMDS}`] : [])]
        : [];

    const Child = spawn(GAMESERVER_BINARY_PATH, [
        METAGAME_API_KEY,
        Port.toString(),
        Map,
        Behemoth != undefined ? Behemoth : "NO_BEHEMOTH",
        MatchmakerHuntId != undefined ? MatchmakerHuntId : "NO_MM_HUNTID",
        ExpectedPlayers != undefined ? TransformExpectedPlayerArgs(ExpectedPlayers) : "NO_EXPECTED_PLAYERS",
        MY_IP + ":" + Port.toString(),
        METAGAME_ADDRESS,
        ...STANDARD_GAMESERVER_ARGS,
        ...DiagnosticArgs
    ]);

    if(GAMESERVER_LOG_DIR != undefined){
        try{
            mkdirSync(GAMESERVER_LOG_DIR, { recursive: true });

            const LogPath = join(GAMESERVER_LOG_DIR, `gameserver-${Port}-${Child.pid}.log`);
            const LogStream = createWriteStream(LogPath, { flags: "a" });

            Child.stdout?.pipe(LogStream);
            Child.stderr?.pipe(LogStream);

            logger.info({ port: Port, pid: Child.pid, logPath: LogPath }, "Capturing gameserver output");
        } catch(Error){
            // Diagnostics must never stop a world from starting.
            logger.warn({ Error, port: Port }, "Could not capture gameserver output");
        }
    }

    Child.on("error", error => logger.error({ error, port: Port }, "Gameserver process failed"));
    Child.on("exit", (code, signal) => logger.warn({ pid: Child.pid, port: Port, code, signal }, "Gameserver exited"));

    Child.unref();

    const NewGameserver: Gameserver = {
        id: Id,
        port: Port,
        map: Map,
        behemoth: Behemoth,
        matchmakerHuntId: MatchmakerHuntId,
        expectedPlayers: ExpectedPlayers,
        isRamsgate: IsRamsgate,
        isTrainingDojo: IsTrainingDojo,
        processId: Child.pid!,
        startTime: new Date()
    };

    Gameservers.push(NewGameserver);

    try {
        await WaitForGamePort(Child.pid!, Port);
    } catch (error) {
        Gameservers = Gameservers.filter(server => server !== NewGameserver);
        if (!IsRamsgate && !IsTrainingDojo) FreePorts.push(Port);
        if (Child.exitCode === null) Child.kill();
        throw error;
    }

    return NewGameserver;
}

function IsProcessAlive(ProcessId: number){
    try{
        kill(ProcessId, 0);

        return true;
    } catch {
        return false;
    }
}

// A persistent world can die without the deploy service noticing: the watchdog
// is optional, runs on a 60 second timer and only reclaims ports. Anything that
// hands out a connection has to confirm the world is actually alive first, or
// the client is sent to a port nothing is listening on and travel fails with no
// error on this side.
async function EnsurePersistentWorldAlive(Existing: Gameserver | undefined, MapPath: string, IsRamsgate: boolean, IsTrainingDojo: boolean, Label: string){
    if(Existing != undefined && IsProcessAlive(Existing.processId)){
        return Existing;
    }

    logger.warn(`${Label} is not running - starting it before handing out a connection`);

    if(Existing != undefined){
        Gameservers = Gameservers.filter(Server => Server !== Existing);
    }

    return await StartServer(MapPath, undefined, undefined, undefined, IsRamsgate, IsTrainingDojo);
}

export async function GetRamsgateConnectionDetails(){
    RamsgateServer = await EnsurePersistentWorldAlive(RamsgateServer, RAMSGATE_MAP_PATH, true, false, "Ramsgate");

    return {
        host: MY_IP,
        port: RamsgateServer.port
    };
}

export async function GetTrainingDojoConnectionDetails(){
    TrainingDojoServer = await EnsurePersistentWorldAlive(TrainingDojoServer, TRAINING_DOJO_MAP_PATH, false, true, "Training dojo");

    return {
        host: MY_IP,
        port: TrainingDojoServer.port
    };
}

export async function StartupGameserverWithArgs(GameArgs: string){
    const Map = GameArgs.split("?")[0];
    const Behemoth = GameArgs.split("?")[2].split("=")[1];

    const GameServerToReturn = await StartServer(Map, Behemoth, undefined, undefined, false, false);

    return {
        host: MY_IP,
        port: GameServerToReturn.port
    };
}

function GetMatchmakerHuntIdFromPlayerHuntId(PlayerHuntId: string){
    const MatchmakerHuntIDs = (PlayerHuntTable[0].Rows as any)[PlayerHuntId].MatchmakerHuntIDs;

    let MatchmakerHuntObject;

    if(MatchmakerHuntIDs.length !== 0){
        MatchmakerHuntObject = MatchmakerHuntIDs[crypto.randomInt(0, MatchmakerHuntIDs.length)];
    }

    return MatchmakerHuntObject?.RowName;
}

function GetBehemothPathFromMatchmakerHuntId(MatchmakerHuntId: string): string{
    const MatchmakerHuntObject = (MatchmakerHuntTable[0].Rows as any)[MatchmakerHuntId];

    return MatchmakerHuntObject.SpecificBehemoth.BehemothAsset.AssetPathName;
}

function GetMapPathFromMatchmakerHuntId(MatchmakerHuntId: string): string{
    const MatchmakerHuntObject = (MatchmakerHuntTable[0].Rows as any)[MatchmakerHuntId];

    const MapList = MatchmakerHuntObject.MapList;

    return MapList[crypto.randomInt(0, MapList.length)].MapAssetName.split(".")[0];
}

function GetGameModeOverrideFromMatchmakerHuntId(MatchmakerHuntId: string): string{
    const MatchmakerHuntObject = (MatchmakerHuntTable[0].Rows as any)[MatchmakerHuntId];

    return MatchmakerHuntObject.GameModeOverride.replaceAll("Archon/Content", "/Game");
}

type TrialsData = {
    Behemoth: string;
    TrialsHuntId: string;
}

function RandomlyGenTrialsData(IsElite: boolean): TrialsData{
    const RandomTrialNum = String(crypto.randomInt(1, 89)).padStart(3, "0");

    const Difficulty = IsElite ? "Elite" : "Hard";

    const TrialsHuntId = `Arena_MatchmakerHunt_${Difficulty}_${RandomTrialNum}`;

    const Row = IsElite ? (TrialsEliteHuntTable[0].Rows as any)[TrialsHuntId] : (TrialsHardHuntTable[0].Rows as any)[TrialsHuntId];

    const Behemoth = Row.SpecificBehemoth.BehemothAsset.AssetPathName;

    return {
        Behemoth: Behemoth,
        TrialsHuntId: TrialsHuntId
    };
}

export async function StartupGameserverWithHuntIdAndPlayers(HuntId: string, ExpectedPlayers: string[]){
    const TrialsData = HuntId.includes("Arena") ? RandomlyGenTrialsData(HuntId.includes("Elite")) : undefined;
    const MatchmakerHuntId = TrialsData == undefined ? GetMatchmakerHuntIdFromPlayerHuntId(HuntId) : TrialsData.TrialsHuntId;
    let BehemothPath = TrialsData == undefined ? GetBehemothPathFromMatchmakerHuntId(MatchmakerHuntId!) : TrialsData.Behemoth;
    let MapPath = TrialsData == undefined ? GetMapPathFromMatchmakerHuntId(MatchmakerHuntId!) : TRIALS_MAP_PATH;

    if(MatchmakerHuntId != undefined && !MatchmakerHuntId.includes("Arena")){
        const OverrideGameMode = GetGameModeOverrideFromMatchmakerHuntId(MatchmakerHuntId);

        if(OverrideGameMode != undefined && OverrideGameMode.includes("_C")){
            logger.info(`Overriding gamemode to ${OverrideGameMode}`);
            MapPath = `${MapPath}?game=${OverrideGameMode}`;
        }
    }

    const GameServerToReturn = await StartServer(MapPath, BehemothPath, MatchmakerHuntId, ExpectedPlayers.map((PlayerId) => {
        return {
            playerUid: PlayerId,
            playerHuntId: HuntId
        };
    }), false, false);

    return {
        host: MY_IP,
        port: GameServerToReturn.port
    }
}

export async function Startup(){
    for(let i = PORT_RANGE_BEGIN; i <= PORT_RANGE_END - 2; i++){
        FreePorts.push(i);
    }

    RamsgateServer = await StartServer(RAMSGATE_MAP_PATH, undefined, undefined, undefined, true, false);

    TrainingDojoServer = await StartServer(TRAINING_DOJO_MAP_PATH, undefined, undefined, undefined, false, true);
}
