import { Router } from "express";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { AnswerInvite, DeleteLink, DeleteLinks, GetRewardGrant, Invite, INVITE_EXPIRY_HOURS, LINK_DURATION_HOURS, ListAvailability, ListInvites, ListLinks, ReplayLinkMutation, SlayerLinkError, StoreRewardPools } from "../controllers/slayerLinks";
import { logger } from "../logger";

export const slayerLinksRouter = Router();
slayerLinksRouter.use("/slayerlink", HasUndauntedMetagameAuth);

function Send(res: any, payload: unknown){ res.json({ code: null, message: "OK", payload }); }
function Fail(res: any, error: unknown){
    const status = error instanceof SlayerLinkError ? error.status : 500;
    if(status >= 500) logger.error({ err: error }, "Slayer Link request failed");
    else logger.warn(`Slayer Link request refused (${status}): ${error instanceof Error ? error.message : error}`);
    res.status(status).json({ code: String(status), message: error instanceof Error ? error.message : "Slayer Link error", payload: null });
}
function Account(req: any){ return req.AuthData.userId as string; }
// Reads that the gameserver may make for a named player never fall back to a
// player's own account: a player token is pinned to that player.
function Auth(req: any){ return { IsGameserver: req.AuthData?.IsGameserver === true, userId: req.AuthData?.userId }; }
function Action(handler: (req: any, res: any) => void){
    return (req: any, res: any) => {
        try{
            if(req.method === "GET"){ handler(req, res); return; }
            const Reply = ReplayLinkMutation(Auth(req), req.headers["x-undaunted-request-id"], `${req.method} ${req.originalUrl}`, req.body, () => {
                let Result: unknown;
                handler(req, { json: (Value: unknown) => { Result = Value; } });
                return Result;
            });
            res.json(Reply);
        } catch(error){ Fail(res, error); }
    };
}

// The linked-slayer heartbeat polls this and hands its invites and links to the
// same handlers as /invites and /links (status payload serializer 0x141600510:
// config, invites, links; link rows 0x1415ffdc0 name the partner
// linked_account_id). Answering with only the durations told the client, on
// every heartbeat, that there were no invites and no links: it dropped its
// stored invites and the next /invites poll re-added each one as new, so the
// social panel gained a duplicate request row every few seconds.
slayerLinksRouter.get("/slayerlink/status_good", (req: any, res) => {
    const AccountId = Account(req);
    const config = { link_duration_hours: LINK_DURATION_HOURS, invite_expiry_hours: INVITE_EXPIRY_HOURS };
    Send(res, {
        ...config,
        config,
        invites: typeof AccountId === "string" ? ListInvites(AccountId) : [],
        links: typeof AccountId === "string" ? ListLinks(AccountId).map(({ account_id, ...Row }) => ({ linked_account_id: account_id, ...Row })) : []
    });
});
slayerLinksRouter.get("/slayerlink/invites", (req: any, res) => {
    Send(res, { invites: ListInvites(Account(req)) });
});
slayerLinksRouter.post("/slayerlink/invites", (req: any, res) => {
    Send(res, { invites: ListInvites(Account(req)) });
});
slayerLinksRouter.get("/slayerlink/links", (req: any, res) => {
    Send(res, { links: ListLinks(Account(req)) });
});
function SendAvailability(req: any, res: any, accounts: unknown){
    const ids = Array.isArray(accounts) ? accounts : typeof accounts === "string" ? accounts.split(",") : [];
    Send(res, { availability: ListAvailability(Account(req), ids.filter((id): id is string => typeof id === "string")) });
}
slayerLinksRouter.get("/slayerlink/availability", (req: any, res) => {
    SendAvailability(req, res, req.query.account_ids);
});
// 1.4.4 posts the friend account IDs as JSON when populating the chooser.
slayerLinksRouter.post("/slayerlink/availability", (req: any, res) => {
    SendAvailability(req, res, req.body?.account_ids);
});
// The 1.4.4 client uses PUT for sending an invitation and POST for
// accepting/rejecting/canceling one (verified in the installed executable).
slayerLinksRouter.put("/slayerlink/invite", Action((req, res) => {
    // Captured service requests also use PUT with action=cancel. Never
    // reinterpret an explicit action as a new invitation.
    if(req.body?.action != undefined){ AnswerRequest(req, res); return; }
    Send(res, { link_id: Invite(Account(req), req.body?.account_id, req.body?.slot) });
}));
// Accept body (serializer 0x1415fdc40): {account_id: inviter, action, slot:
// the accepting player's own slot, action_source}.
function AnswerRequest(req: any, res: any){
    const action = String(req.body?.action ?? "").toLowerCase();
    if(action !== "accept" && action !== "reject" && action !== "cancel"){
        throw new SlayerLinkError(400, "Unknown invitation action");
    }
    const id = AnswerInvite(Account(req), req.body?.link_id ?? req.body?.invite_id ?? req.body?.account_id, action,
        action === "accept" ? req.body?.slot : undefined);
    Send(res, { link_id: id });
}
slayerLinksRouter.post("/slayerlink/invite", Action(AnswerRequest));
slayerLinksRouter.delete("/slayerlink/invite", Action((req, res) => {
    Send(res, { link_id: AnswerInvite(Account(req), req.body?.link_id ?? req.body?.invite_id, "cancel") });
}));
// Pre-native route kept for existing callers: removes the caller's own side.
slayerLinksRouter.delete("/slayerlink/link", Action((req, res) => {
    DeleteLink(Account(req), Number(req.body?.slot ?? req.query.slot), false, req.body?.link_id ?? req.query.link_id);
    Send(res, {});
}));
// ServerDeleteLink -> FOnlineLinkedSlayer::DeleteLinks. A body-less request is
// the debug "delete every link" path, which could erase earned rewards.
slayerLinksRouter.delete("/slayerlink/links", Action((req, res) => {
    if(!Array.isArray(req.body?.links)) throw new SlayerLinkError(400, "Deleting every link is not supported");
    Send(res, { links: DeleteLinks(Auth(req), req.body.links) });
}));

// Prize pool storage (FOnlineLinkedSlayer::SendLinkRewards). Not a grant.
slayerLinksRouter.put("/slayerlink/links/rewards", Action((req, res) => {
    Send(res, { links: StoreRewardPools(Auth(req), req.body) });
}));
// Earned rewards for collection (FOnlineLinkedSlayer::GetLinkRewardsGrant).
slayerLinksRouter.get("/slayerlink/links/rewards/:accountId/:slot", Action((req, res) => {
    Send(res, GetRewardGrant(Auth(req), req.params.accountId, Number(req.params.slot)));
}));
