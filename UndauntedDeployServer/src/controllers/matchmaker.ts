import { logger } from "../logger";
import { GetRamsgateConnectionDetails, GetTrainingDojoConnectionDetails, JoinRunningHunt, StartupGameserverWithArgs, StartupGameserverWithHuntIdAndPlayers } from "./gameservers";

// JoinPort: a running public hunting ground of this hunt the metagame found
// room in. It is used if that world is still running that hunt.
export async function HandleMatchmakingRequest(GameMode: string, GameArgs: string, HuntId: string, ExpectedPlayers: string[] | undefined, JoinPort?: unknown){
    logger.info(`Handling matchmaking with GameMode: ${GameMode} HuntId: ${HuntId} and GameArgs: ${GameArgs} and ExpectedPlayers ${ExpectedPlayers}${JoinPort != undefined ? ` and JoinPort ${JoinPort}` : ""}`);

    if(GameMode === "CITY"){
        return await GetRamsgateConnectionDetails();
    }
    else if(GameMode === "SHARED"){
        if (HuntId != undefined && HuntId.trim().length > 0){
            if(HuntId == "ShatteredIsles_TrainingDojo"){
                return await GetTrainingDojoConnectionDetails();
            }
        }
    }
    else if(GameMode === "ISLAND"){
        if(GameArgs != undefined && GameArgs.trim().length > 0){
            return await StartupGameserverWithArgs(GameArgs, HuntId, ExpectedPlayers);
        }

        if(JoinPort != undefined && HuntId != undefined && HuntId.trim().length > 0){
            const Joined = JoinRunningHunt(HuntId, JoinPort);
            if(Joined != undefined) return Joined;
            logger.info(`The ${HuntId} world on port ${JoinPort} is no longer running; starting a new one`);
        }

        if(HuntId != undefined && HuntId.trim().length > 0 && ExpectedPlayers != undefined){
            // A hunt the tables do not have (a newer client's) falls through
            // to Ramsgate below rather than failing the request.
            try{
                return await StartupGameserverWithHuntIdAndPlayers(HuntId, ExpectedPlayers!);
            }
            catch(error){
                logger.error({ err: error }, `Could not start hunt ${HuntId}`);
            }
        }
    }

    logger.error("Matchmaking failed, sending you to Ramsgate!");

    return await GetRamsgateConnectionDetails();
}