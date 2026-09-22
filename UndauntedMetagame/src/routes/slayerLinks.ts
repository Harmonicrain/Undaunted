import { Router } from "express";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { AnswerInvite, DeleteLink, Invite, INVITE_EXPIRY_HOURS, LINK_DURATION_HOURS, ListAvailability, ListInvites, ListLinks, SlayerLinkError } from "../controllers/slayerLinks";

export const slayerLinksRouter = Router();
slayerLinksRouter.use("/slayerlink", HasUndauntedMetagameAuth);

function Send(res: any, payload: unknown){ res.json({ code: null, message: "OK", payload }); }
function Fail(res: any, error: unknown){
    const status = error instanceof SlayerLinkError ? error.status : 500;
    res.status(status).json({ code: String(status), message: error instanceof Error ? error.message : "Slayer Link error", payload: null });
}
function Account(req: any){ return req.AuthData.userId as string; }

slayerLinksRouter.get("/slayerlink/status_good", (_req, res) => {
    Send(res, { link_duration_hours: LINK_DURATION_HOURS, invite_expiry_hours: INVITE_EXPIRY_HOURS });
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
slayerLinksRouter.put("/slayerlink/invite", (req: any, res) => {
    try{
        const id = Invite(Account(req), req.body?.account_id, req.body?.slot);
        Send(res, { link_id: id });
    } catch(error){ Fail(res, error); }
});
slayerLinksRouter.post("/slayerlink/invite", (req: any, res) => {
    try{
        const action = String(req.body?.action ?? "").toLowerCase();
        if(action === "accept" || action === "reject" || action === "cancel"){
            const id = AnswerInvite(Account(req), req.body?.link_id ?? req.body?.invite_id ?? req.body?.account_id, action);
            Send(res, { link_id: id });
            return;
        }
        throw new SlayerLinkError(400, "Unknown invitation action");
    } catch(error){ Fail(res, error); }
});
slayerLinksRouter.delete("/slayerlink/invite", (req: any, res) => {
    try{ Send(res, { link_id: AnswerInvite(Account(req), req.body?.link_id ?? req.body?.invite_id, "cancel") }); }
    catch(error){ Fail(res, error); }
});
slayerLinksRouter.delete("/slayerlink/link", (req: any, res) => {
    try{ DeleteLink(Account(req), Number(req.body?.slot ?? req.query.slot)); Send(res, {}); }
    catch(error){ Fail(res, error); }
});

// Progress and rewards have their own native contracts. They are intentionally
// left for capture before acknowledging writes: a false success here could
// permanently lose a claimed reward.
