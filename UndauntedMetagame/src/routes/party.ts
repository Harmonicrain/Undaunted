import { Router } from "express";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { logger } from "../logger";
import { GetUsernameForUserId } from "../controllers/login";
import { AcceptPartyInvite, GetInvitesForPlayer, GetOrCreateParty, GetPartyForPlayer, InviteToParty, KickPartyMember, LeaveParty, PartyError, PromotePartyMember } from "../controllers/party";
import { CancelCandidateForPlayer, CheckAndUpdateQueueStatus } from "../controllers/matchmaking";

export const partyRouter = Router();

function Fail(res: any, error: unknown){
    if(error instanceof PartyError) res.status(error.status).json({ message: error.message });
    else { logger.error(error, "Party request failed"); res.sendStatus(500); }
}

async function SendPartyState(req: any, res: any){
    const UserId = req.AuthData.userId;
    const party = GetOrCreateParty(UserId, req.body?.buildId ?? "");
    const candidate = await CheckAndUpdateQueueStatus(UserId);
    const states = await Promise.all(party.members.map(async member => ({
        consoleSessionId: null, displayName: await GetUsernameForUserId(member),
        isMemberOfCandidate: true, platform: "win", playerId: member
    })));

    res.status(200);
    res.json({
        candidateId: candidate?.CandidateId ?? null,
        candidateState: candidate?.Failed ? "FAILED" : candidate?.Ready ? "IN_PROGRESS" : candidate ? "MATCHING" : "QUEUED_FOR_START",
        gauntletLevel: null,
        leaderPlayerId: party.leaderPlayerId,
        partyId: party.partyId,
        playerHuntId: candidate?.HuntId ?? null,
        playerStates: states
    });
}

partyRouter.post("/party", HasUndauntedMetagameAuth, SendPartyState);
partyRouter.get("/party/status", HasUndauntedMetagameAuth, SendPartyState);

partyRouter.put("/party/invite", HasUndauntedMetagameAuth, (req: any, res) => {
    try{ InviteToParty(req.AuthData.userId, req.body?.recipientPlayerId, req.body?.buildId ?? ""); res.json({}); }
    catch(error){ Fail(res, error); }
});
partyRouter.get("/party/invites", HasUndauntedMetagameAuth, (req: any, res) => {
    res.json({ invitations: GetInvitesForPlayer(req.AuthData.userId).map(invite => ({
        inviteId: invite.inviteId, partyId: invite.partyId, recipientPlayerId: invite.recipientPlayerId,
        sendingDisplayName: invite.sendingDisplayName, sendingPlatform: invite.sendingPlatform,
        sendingPlayerId: invite.sendingPlayerId
    })) });
});
partyRouter.put("/party/invite/accept/:inviteId", HasUndauntedMetagameAuth, (req: any, res) => {
    try{
        const oldMembers = GetPartyForPlayer(req.AuthData.userId)?.members.slice() ?? [req.AuthData.userId];
        const party = AcceptPartyInvite(req.AuthData.userId, String(req.params.inviteId));
        for(const member of [...oldMembers, ...party.members]) CancelCandidateForPlayer(member);
        res.json({});
    }
    catch(error){ Fail(res, error); }
});
partyRouter.delete("/party/member", HasUndauntedMetagameAuth, (req: any, res) => {
    for(const member of GetPartyForPlayer(req.AuthData.userId)?.members ?? [req.AuthData.userId]) CancelCandidateForPlayer(member);
    LeaveParty(req.AuthData.userId); res.json({});
});
partyRouter.delete("/party/member/:memberId", HasUndauntedMetagameAuth, (req: any, res) => {
    try{
        const members = GetPartyForPlayer(req.AuthData.userId)?.members.slice() ?? [];
        KickPartyMember(req.AuthData.userId, String(req.params.memberId));
        for(const member of members) CancelCandidateForPlayer(member);
        res.json({});
    }
    catch(error){ Fail(res, error); }
});
partyRouter.put("/party/member/promote/:memberId", HasUndauntedMetagameAuth, (req: any, res) => {
    try{ PromotePartyMember(req.AuthData.userId, String(req.params.memberId)); res.json({}); }
    catch(error){ Fail(res, error); }
});
