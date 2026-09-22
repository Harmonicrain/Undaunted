import { RequestHandler, Router } from "express";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { ApplyEscalationSnapshot, EscalationError, GetEscalationState } from "../controllers/escalation";
import { logger } from "../logger";

// GetSeasonalEscalationEndpoint and UpdateSeasonalEscalationEndpoint, both
// /escalation/{season_id}/{account_id}. The response envelope is
// {code, message, payload: <season object>} for both (parsed by 0x140aae300
// into vtable 0x144478e80). See research/escalation/PROTOCOL.md.

export const escalationRouter = Router();

const EscalationAction = (handler: RequestHandler): RequestHandler => (req: any, res, next) => {
    try{
        return handler(req, res, next);
    } catch(error: any){
        if(error instanceof EscalationError){
            logger.warn(`Escalation ${req.method} ${req.params.seasonId} refused (${error.status}): ${error.message}`);
            res.status(error.status).json({ code: String(error.status), message: error.message, payload: null });
        }
        else{
            logger.error({ err: error }, "Escalation request failed");
            res.status(500).json({ code: "500", message: "Escalation request failed", payload: null });
        }
    }
};

// Reads: a gameserver names the account; a player always reads their own.
function ReadAccount(req: any){
    return req.AuthData?.IsGameserver ? req.params.userId : req.AuthData?.userId;
}

// Writes carry the world server's authoritative state, so only a gameserver
// may send them. A relayed player token must match the named account.
function WriteAccount(req: any){
    if(req.AuthData?.IsGameserver !== true){
        throw new EscalationError(403, "Escalation progress may only be written by a gameserver");
    }

    if(typeof req.AuthData.userId === "string" && req.AuthData.userId !== req.params.userId){
        throw new EscalationError(403, "Relayed token does not match the requested account");
    }

    return req.params.userId as string;
}

escalationRouter.get("/escalation/:seasonId/:userId", HasUndauntedMetagameAuth, EscalationAction((req: any, res) => {
    const AccountId = ReadAccount(req);

    if(typeof AccountId !== "string" || AccountId.length === 0){
        throw new EscalationError(401, "Account required");
    }

    const State = GetEscalationState(AccountId, req.params.seasonId);

    logger.info(`Escalation ${req.params.seasonId} read for ${AccountId}: level ${State.escalation_level}, v${State.update_version}`);

    res.status(200).json({ code: null, message: "OK", payload: State });
}));

escalationRouter.post("/escalation/:seasonId/:userId", HasUndauntedMetagameAuth, EscalationAction((req: any, res) => {
    const AccountId = WriteAccount(req);

    const { State, Replayed } = ApplyEscalationSnapshot(AccountId, req.params.seasonId, req.body);

    if(Replayed){
        logger.info(`Escalation ${req.params.seasonId} v${State.update_version} for ${AccountId} replayed`);
    }

    res.status(200).json({ code: null, message: "OK", payload: State });
}));
