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
    HuntId: string,
    CandidateId: string,
    Host: string,
    Port: number
};

let MatchmakingQueueMap: Map<string, MatchmakingQueueData> = new Map<string, MatchmakingQueueData>(); // Key is HuntID
let MatchmakingResultMap: Map<string, MatchmakingResult> = new Map<string, MatchmakingResult>(); // Key is PlayerID

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

async function QueuePlayers(HuntId: string, PlayerIds: string[]){
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
            CandidateId: candidateId, HuntId, Host: "", Port: 0 });
    }
    if(queue.Players.length >= 4) await PopQueue(HuntId);
    return true;
}

export function CancelCandidateForPlayer(PlayerId: string){
    const result = MatchmakingResultMap.get(PlayerId);
    if(!result) return;
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
            const GameOnDeployServer = await LaunchGameOnDeployserver(GameMode, GameArgs, HuntId, players);

            const Result: MatchmakingResult = {
                Ready: false, Failed: false, FailureReason: null,
                CandidateId: crypto.randomUUID(),
                HuntId: HuntId,
                Host: "",
                Port: 0
            };
            ApplyLaunch(Result, GameOnDeployServer);
            for(const player of players) MatchmakingResultMap.set(player, { ...Result });

            return true;
        }
        else{
            return await QueuePlayers(HuntId, players);
        }
    }
    else{
        logger.fatal("Unsupported MATCHMAKING_MODE!");

        return false;
    }
}
