import { logger } from "../logger";
import crypto from "node:crypto";
import { GetPartyForPlayer } from "./party";

const MATCHMAKING_MODE = process.env.MATCHMAKING_MODE;
const DEPLOYSERVER_URL = process.env.DEPLOYSERVER_URL;
const DEPLOYSERVER_MATCHMAKING_PATH = "/api/matchmaker/handle-matchmaking-for-player";

type MatchmakingQueueData = {
    Players: string[],
    LastPlayerAddedTime: Date,
    Resolved: boolean
};

type MatchmakingResult = {
    Ready: boolean,
    // Set when the world could not be allocated. The candidate then reports
    // FAILED (a status the 1.4.4 client knows) instead of Ready with an empty
    // host and port 0, which sent players travelling to nowhere.
    Failed: boolean,
    FailureReason: string | null,
    // The mode the client asked for (CITY, SHARED or ISLAND), echoed by the
    // status route. It always answered ISLAND, even for a return to Ramsgate.
    GameMode: string,
    HuntId: string,
    CandidateId: string,
    Host: string,
    Port: number
};

let MatchmakingQueueMap: Map<string, MatchmakingQueueData> = new Map<string, MatchmakingQueueData>(); // Key is HuntID
let MatchmakingResultMap: Map<string, MatchmakingResult> = new Map<string, MatchmakingResult>(); // Key is PlayerID

// Hunt id to give the world when the client asked for one without it: the
// city is ShatteredIsles_ReturnToRamsgate and the first island (FTUE,
// dia_moss_triforce) is ShatteredIsles_IslandA. The gameserver sets each
// player's hunt id from it (runtime HuntIdBackfill); left empty, the 1.12.0
// client leaves the island a second after joining. Mapping as in Mystic
// Paradox's ParadoxBackend (pranav158/Mystic-Paradox@355934c
// src/controllers/matchmaking.ts GetFallbackHuntId); see NOTICE.md.
export function FallbackHuntId(GameMode: string, GameArgs: string | undefined, HuntId: string | undefined){
    if(HuntId != undefined && HuntId.trim().length > 0) return HuntId;
    if(GameMode === "CITY") return "ShatteredIsles_ReturnToRamsgate";
    if(GameArgs?.includes("/Game/Maps/islands/1705/dia_moss_triforce")) return "ShatteredIsles_IslandA";
    return HuntId;
}

function HuntIdRequiresMatchmaking(HuntId: string){
    return !HuntId.includes("Ramsgate") && !HuntId.includes("Dojo");
    //return HuntId.includes("CR19") || HuntId.includes("11A") || HuntId.includes("Story");
}

async function LaunchGameOnDeployserver(GameMode: string, GameArgs: string, HuntId: string, ExpectedPlayers: string[] | undefined){
    logger.info(`Querying DeployServer for GameMode: ${GameMode} HuntId ${HuntId} with ${ExpectedPlayers?.length} Expected Players!`);

    const URL = "http://" + DEPLOYSERVER_URL + DEPLOYSERVER_MATCHMAKING_PATH;

    const Failure = (Reason: string) => {
        logger.error(`World allocation for HuntId ${HuntId} failed: ${Reason}`);

        return { succeeded: false, readyNow: false, host: "", port: 0, reason: Reason };
    };

    // An unreachable deployserver used to reject out of the queue pop and
    // leave the queue resolved with nobody told.
    let MatchmakingResult: Response;
    try{
        MatchmakingResult = await fetch(URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                GameMode: GameMode,
                GameArgs: GameArgs,
                HuntId: HuntId,
                ExpectedPlayers: ExpectedPlayers!
            })
        });
    } catch(error: any){
        return Failure(`DeployServer unreachable: ${error?.message ?? error}`);
    }

    if(MatchmakingResult.status !== 200){
        return Failure(`DeployServer returned status ${MatchmakingResult.status}`);
    }

    let MatchmakingData: any;
    try{
        MatchmakingData = await MatchmakingResult.json();
    } catch{
        return Failure("DeployServer returned a body that is not JSON");
    }

    // A 200 without somewhere to travel to is still a failure.
    if(typeof MatchmakingData?.host !== "string" || MatchmakingData.host.length === 0 ||
        !Number.isInteger(MatchmakingData?.port) || MatchmakingData.port <= 0 || MatchmakingData.port > 65535){
        return Failure(`DeployServer returned no usable address (${JSON.stringify({ host: MatchmakingData?.host, port: MatchmakingData?.port })})`);
    }

    logger.info(`DeployServer returned gameserver ${MatchmakingData.host}:${MatchmakingData.port}`);

    return {
        succeeded: true,
        readyNow: true,
        host: MatchmakingData.host as string,
        port: MatchmakingData.port as number,
        reason: null
    };
}

// The game session a player is sent to, as the client sees it
// (serverInfo.gameSessionId): the same for everyone in one world, so the
// world's chat room is shared. It was each player's own random candidate id,
// so two players who travelled to Ramsgate separately were put in different
// City chat rooms and never saw each other's messages. Derived from the
// world's address, a UUID in form.
export function WorldSessionId(Host: string, Port: number){
    const Hash = crypto.createHash("sha1").update(`world:${Host}:${Port}`).digest("hex");
    const Variant = ((parseInt(Hash[16], 16) & 3) | 8).toString(16);
    return `${Hash.slice(0, 8)}-${Hash.slice(8, 12)}-5${Hash.slice(13, 16)}-${Variant}${Hash.slice(17, 20)}-${Hash.slice(20, 32)}`;
}

function ApplyLaunch(Result: MatchmakingResult, Launch: Awaited<ReturnType<typeof LaunchGameOnDeployserver>>){
    Result.Host = Launch.host;
    Result.Port = Launch.port;
    Result.Ready = Launch.succeeded;
    Result.Failed = !Launch.succeeded;
    Result.FailureReason = Launch.reason;
}

async function PopQueue(HuntId: string){
    const MatchmakingQueue = MatchmakingQueueMap.get(HuntId);

    if(MatchmakingQueue!.Resolved){
        return;
    }

    MatchmakingQueue!.Resolved = true;
    
    const GameOnDeployServer = await LaunchGameOnDeployserver("ISLAND", "", HuntId, MatchmakingQueue!.Players);

    for(const Player of MatchmakingQueue!.Players){
        const PlayerMatchmakingResultToUpdate = MatchmakingResultMap.get(Player);

        if(PlayerMatchmakingResultToUpdate != undefined){
            ApplyLaunch(PlayerMatchmakingResultToUpdate, GameOnDeployServer);
        }
    }

    MatchmakingQueueMap.delete(HuntId);
}

export async function CheckAndUpdateQueueStatus(PlayerId: string){
    const PlayerMatchmakingResult = MatchmakingResultMap.get(PlayerId);

    if(PlayerMatchmakingResult == undefined){
        return undefined;
    }

    if(!PlayerMatchmakingResult.Ready && !PlayerMatchmakingResult.Failed){
        const MatchmakingQueue = MatchmakingQueueMap.get(PlayerMatchmakingResult.HuntId);

        if(MatchmakingQueue != undefined && (new Date()).getTime() - MatchmakingQueue.LastPlayerAddedTime.getTime() > 20000){ // 20 sec
            await PopQueue(PlayerMatchmakingResult.HuntId);
        }
    }

    return PlayerMatchmakingResult;
}

async function QueuePlayers(GameMode: string, HuntId: string, PlayerIds: string[]){
    const current = MatchmakingQueueMap.get(HuntId);
    if(current?.Resolved) return false;
    const novel = PlayerIds.filter(id => !current?.Players.includes(id));
    if((current?.Players.length ?? 0) + novel.length > 4) return false;
    const queue = current ?? { Players: [], LastPlayerAddedTime: new Date(), Resolved: false };
    queue.Players.push(...novel);
    queue.LastPlayerAddedTime = new Date();
    MatchmakingQueueMap.set(HuntId, queue);
    const candidateId = crypto.randomUUID();
    for(const id of PlayerIds){
        MatchmakingResultMap.set(id, { Ready: false, Failed: false, FailureReason: null,
            GameMode, CandidateId: candidateId, HuntId, Host: "", Port: 0 });
    }
    if(queue.Players.length >= 4) await PopQueue(HuntId);
    return true;
}

// Party changes abandon matchmaking that has not produced a world yet. A
// candidate that has one (Ready) is a hunt the other members may already be
// playing: cancelling it when someone left the party turned every remaining
// member's status checks into 404s for the rest of the hunt, and their
// return to Ramsgate never started. A Ready candidate is replaced by the
// player's next join instead.
export function CancelPendingCandidateForPlayer(PlayerId: string){
    const result = MatchmakingResultMap.get(PlayerId);
    if(!result || result.Ready) return;
    for(const [id, other] of MatchmakingResultMap){
        if(other.CandidateId === result.CandidateId) MatchmakingResultMap.delete(id);
    }
    const queue = MatchmakingQueueMap.get(result.HuntId);
    if(queue && !queue.Resolved){
        queue.Players = queue.Players.filter(id => MatchmakingResultMap.has(id));
        if(queue.Players.length === 0) MatchmakingQueueMap.delete(result.HuntId);
    }
}

export async function HandlePlayerMatchmaking(GameMode: string, GameArgs: string, HuntId: string, PlayerId: string){
    if(MATCHMAKING_MODE === "DISABLED"){
        logger.warn("Matchmaking is disabled, refusing MM!");

        return false;
    }
    else if(MATCHMAKING_MODE === "DEPLOYSERVER"){
        const party = GetPartyForPlayer(PlayerId);
        if(party && party.members.length > 1 && party.leaderPlayerId !== PlayerId){
            return MatchmakingResultMap.has(PlayerId);
        }
        const players = party?.members.slice() ?? [PlayerId];
        if(HuntId == undefined || HuntId.trim().length == 0 || !HuntIdRequiresMatchmaking(HuntId)){
            const LaunchHuntId = FallbackHuntId(GameMode, GameArgs, HuntId) ?? HuntId;
            const GameOnDeployServer = await LaunchGameOnDeployserver(GameMode, GameArgs, LaunchHuntId, players);

            const Result: MatchmakingResult = {
                Ready: false, Failed: false, FailureReason: null,
                GameMode,
                CandidateId: crypto.randomUUID(),
                HuntId: LaunchHuntId,
                Host: "",
                Port: 0
            };
            ApplyLaunch(Result, GameOnDeployServer);
            for(const player of players) MatchmakingResultMap.set(player, { ...Result });

            return true;
        }
        else{
            return await QueuePlayers(GameMode, HuntId, players);
        }
    }
    else{
        logger.fatal("Unsupported MATCHMAKING_MODE!");

        return false;
    }
}
