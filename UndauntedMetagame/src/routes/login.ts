import { Router } from "express";
import { logger } from "../logger";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { GetDb } from "../db";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";
import { GetUsernameForUserId } from "../controllers/login";

export const loginRouter = Router();

loginRouter.get("/features/platform/win", (req, res) => {
    logger.info("Features");

    res.send({
        "code" : null,
        "message" : "OK",
        "payload" : {
           "crossplay" : true,
           "crossprogression" : true
        }
    });
});

loginRouter.get("/account/link/epic/:AccId", (req, res) => {
    logger.info("Account Linking");

    res.json({
        "code" : null,
        "message" : "OK",
        "payload" : {
           "isLinked" : true
        }
    });
});

loginRouter.post("/login", HasUndauntedMetagameAuth, async (req: any, res) => {
    if(req.AuthData.userId !== req.body.email){
        res.status(400);
        res.send();

        logger.error(`UserID from Undaunted Auth ${req.AuthData.userId} didn't match UserID from token ${req.AuthData.email}`);

        return;
    }

    let UserRecord = await GetDb().query.users.findFirst({where: eq(users.userId, req.AuthData.userId)});

    if(UserRecord == undefined){
        res.status(400);
        res.send();

        logger.error(`UserID from Undaunted Auth ${req.AuthData.userId} had no database entry!`);

        return;
    }

    logger.info(`${req.body.email} is logging in!`);

    res.json({
        "error_code": "TicketRateOk",
        "message": "",
        "state": "OPEN",
        "timeout": 8000,
        "title": ""
    });
});

loginRouter.get("/accountinfo", HasUndauntedMetagameAuth, async (req: any, res) => {
    logger.info("Account info")

    const Username = await GetUsernameForUserId(req.AuthData.userId);

    res.json({
        "accountId" : req.AuthData.userId,
        "creationDate" : "2000-01-01 00:00:00",
        "email" : null,
        "preferredLanguage" : null,
        "username" : Username,
        "verified" : true
    });
});

loginRouter.get("/tags", HasUndauntedMetagameAuth, (req: any, res) => {
    logger.info("Tags")

    res.json({
        "accountId" : req.AuthData.userId,
        "tags": []
    });
});

loginRouter.put("/gamesession/epic", HasUndauntedMetagameAuth, (req: any, res) => {
    const AuthHeader = req.headers.authorization;

    const Token = AuthHeader.slice("bearer ".length);

    // A note on auth tokens:
    // The original flow went Epic Launcher -> Epic -> PHX
    // With each step having it's own auth token.
    // Since this is unneeded complexity for us, we just use the same token for all 3
    // Hence this echo endpoint

    res.json({
        "code": null,
        "message": "OK",
        "payload": {
            "error_code": null,
            "sessionid": "SESSION_ID_LOL", // TODO: This is surfaced in the UI, but I don't think it matters for anything else
            "sessionToken": Token 
        }
    })
});

// The 1.4.4 social search first resolves an Epic display name, then asks the
// Phoenix account service to map those external ids to game accounts. Our LAN
// identities deliberately use one stable id for both sides of that boundary.
// The native response parser expects an object named accountMappings, keyed by
// the queried external id, with accountId/accountType on each value.
loginRouter.post("/account/mapping", HasUndauntedMetagameAuth, (req: any, res) => {
    const rawIds: unknown[] = Array.isArray(req.body)
        ? req.body
        : (Array.isArray(req.body?.ids) ? req.body.ids
            : Array.isArray(req.body?.accountIds) ? req.body.accountIds
            : Array.isArray(req.body?.externalAccountIds) ? req.body.externalAccountIds : []);
    const ids: string[] = [...new Set(rawIds.filter((value: unknown): value is string =>
        typeof value === "string" && value.length > 0))].slice(0, 100);

    const accountMappings: Record<string, { accountId: string, accountType: "Phoenix" }> = {};
    for(const id of ids){
        const local = GetDb().select().from(users).where(eq(users.userId, id)).get();
        if(local) accountMappings[id] = { accountId: local.userId, accountType: "Phoenix" };
    }

    res.json({ accountMappings });
});

loginRouter.post("/accountinfo/public", HasUndauntedMetagameAuth, async (req: any, res) => {
    const AccountIdToLookupFromRequest = req.body.accountId;

    const Username = await GetUsernameForUserId(AccountIdToLookupFromRequest);

    // We allow anybody to look up anybody's username from account id

    res.status(200);
    res.json({
        accountId: AccountIdToLookupFromRequest,
        isSubscribed: true,
        language: null,
        linkedAccounts: [
            {
                accountId: AccountIdToLookupFromRequest,
                accountType: "epic"
            }
        ],
        username: Username
    });
});
