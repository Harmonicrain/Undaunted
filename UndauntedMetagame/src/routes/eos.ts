import { Router } from "express";
import { logger } from "../logger";
import { GetUserIDForAPIKey, SignMetagameJWTForUid, ValidateMetagameJWTAndGetPayload } from "../controllers/auth";
import { GetDb } from "../db";
import { users } from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { HasOptionalUndauntedMetagameAuth } from "../middleware/HasOptionalUndauntedMetagameAuth";
import { GetUsernameForUserId } from "../controllers/login";

export const eosRouter = Router();

eosRouter.post("/account/api/oauth/token", async (req, res) => {
    if(process.env.AUTH_MODE === "NONE" && process.env.NODE_ENV !== "production"){
        const UserId = req.body.exchange_code;

        logger.info(`Logging in ${UserId}!`);

        const AuthToken = SignMetagameJWTForUid(UserId);

        res.json({
            "access_token": AuthToken,
            "token_type": "bearer",
            "expires_at": "2085-09-09T01:01:01.703Z", // TODO: We sign 24hr JWTs so we're unlikely to hit this, but just in case (tm)
            "features": ["Achievements", "AntiCheat", "Ecom", "Voice"],
            "organization_id": "o-krlzxj88qrtb69fredeuaf887bl5az",
            "product_id": "prod-jackal",
            "sandbox_id": "jackal",
            "deployment_id": "53565ba467df4edbb6f5a3d939a8b4f2",
            "expires_in": 86400,
            "refresh_token": "refresh.token.lol", // TODO: IDK if we need to support this considering our intended flow, but flagged regardless
            "refresh_expires_at": "2085-09-09T01:01:01.703Z",
            "account_id": UserId
        });
    }
    else if(process.env.AUTH_MODE === "APIKEY"){
        const ApiKey = req.body.exchange_code;

        const UserId = await GetUserIDForAPIKey(ApiKey);

        if(UserId != undefined){
            logger.info(`Logging in ${UserId}!`);

            const AuthToken = SignMetagameJWTForUid(UserId);

            res.json({
                "access_token": AuthToken,
                "token_type": "bearer",
                "expires_at": "2085-09-09T01:01:01.703Z", // TODO: We sign 24hr JWTs so we're unlikely to hit this, but just in case (tm)
                "features": ["Achievements", "AntiCheat", "Ecom", "Voice"],
                "organization_id": "o-krlzxj88qrtb69fredeuaf887bl5az",
                "product_id": "prod-jackal",
                "sandbox_id": "jackal",
                "deployment_id": "53565ba467df4edbb6f5a3d939a8b4f2",
                "expires_in": 86400,
                "refresh_token": "refresh.token.lol", // TODO: IDK if we need to support this considering our intended flow, but flagged regardless
                "refresh_expires_at": "2085-09-09T01:01:01.703Z",
                "account_id": UserId
            });
        }
        else{
            logger.error(`Invalid API key auth!`);

            res.status(400);
            res.send();
        }
    }
    else{
        logger.fatal("No login method configured!");
    }
});

eosRouter.get("/account/api/oauth/verify", (req, res) => {
    const header = req.headers.authorization;
    if(!header?.toLowerCase().startsWith("bearer ")){ res.sendStatus(401); return; }
    let payload: any;
    try{ payload = ValidateMetagameJWTAndGetPayload(header.slice(7)); }
    catch{ res.sendStatus(401); return; }
    if(typeof payload !== "object" || typeof payload.userId !== "string"){
        res.sendStatus(401); return;
    }
    const remaining = Math.max(0, (payload.exp ?? 0) - Math.floor(Date.now() / 1000));
    res.json({
      "active": true,
      "scope": "basic_profile friends_list presence",
      "token_type": "bearer",
      "expires_in": remaining,
      "expires_at": new Date((payload.exp ?? 0) * 1000).toISOString(),
      "account_id": payload.userId,
      "client_id": "xyza7891lhxMVYGCON7LgnKZZ8HQGD5H",
      "application_id": "fghi4567O03HROxEjwbn7kgXpBhnhWwv"
    });
});

eosRouter.get("/account/api/public/account/displayName/:displayName", HasUndauntedMetagameAuth, async (req, res) => {
    const name = String(req.params.displayName);
    const row = GetDb().select().from(users).all().find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    if(!row){ res.sendStatus(404); return; }
    res.json(await BuildAccountInfo(row.userId));
});

eosRouter.get("/account/api/public/account/:AccId", HasUndauntedMetagameAuth, async (req, res) => {
    const row = GetDb().select().from(users).where(eq(users.userId, String(req.params.AccId))).get();
    if(!row){ res.sendStatus(404); return; }
    res.json(await BuildAccountInfo(row.userId));
});

eosRouter.get("/account/api/public/account/:AccId/externalAuths", (req, res) => {
    logger.info("External Auths (stubbed)");

    res.json({});
});

eosRouter.delete("/account/api/oauth/sessions/kill", (req, res) => {
    logger.info("Session kill (stubbed)");

    // TODO: Is this needed?

    res.json({});
})

eosRouter.delete("/account/api/oauth/sessions/kill/:AuthToken", (req, res) => {
    logger.info("Session kill (stubbed)");

    // TODO: Is this needed?

    res.json({});
})

async function BuildAccountInfo(UserId: string){
    const Username = await GetUsernameForUserId(UserId);

    return {
        "id": UserId,
        "displayName": Username,
        "name": "",
        "lastName": "",
        "email": "",
        "failedLoginAttempts": 0,
        "lastLogin": new Date().toISOString(),
        "numberOfDisplayNameChanges": 0,
        "ageGroup": "ADULT",
        "headless": false,
        "country": "US",
        "lastNameChange": new Date().toISOString(),
        "preferredLanguage": "en",
        "canUpdateDisplayName": false,
        "tfaEnabled": false,
        "emailVerified": true,
        "minorVerified": false,
        "minorStatus": "NOT_MINOR"
    };
}

// Epic's bulk account lookup: GET ?accountId=A&accountId=B, answered with an
// ARRAY of public accounts, one per known id. The client's social layer builds
// every player's display name from it. Answered with a single object - always
// the requester's own - it parsed nothing, so the client fell back to the
// launcher name and labelled every player "[No Epic Account]": in chat, the
// friends list, the party and the online notices.
eosRouter.get("/account/api/public/account", HasUndauntedMetagameAuth, async (req: any, res) => {
    const Requested = ([] as unknown[]).concat(req.query.accountId ?? [])
        .filter((Id): Id is string => typeof Id === "string" && Id.length > 0).slice(0, 100);

    if(Requested.length === 0){
        // No ids: the requester's own account, as before.
        res.json(await BuildAccountInfo(req.AuthData.userId));

        return;
    }

    const Known = GetDb().select().from(users).where(inArray(users.userId, Requested)).all();

    logger.info(`Account lookup for ${Requested.length} id(s): ${Known.length} known`);

    res.json(Known.map((Row) => ({ id: Row.userId, displayName: Row.name, externalAuths: {} })));
});

// The runtime builds this lookup by pasting the metagame address straight onto
// "/account" with no separator, producing paths like GET /account127.0.0.1:60000
// that match no route and 404. Until that concatenation is fixed in
// UndauntedInternalServer, serve the same account info rather than a 404. The
// pattern deliberately excludes "/account/..." so the real EOS routes above
// still win.
// It arrives without credentials, so it cannot require auth either.
eosRouter.get(/^\/account(?:[^\/].*)?$/, HasOptionalUndauntedMetagameAuth, async (req: any, res) => {
    const UserId = req.AuthData?.userId;

    logger.warn(`Malformed account lookup ${req.originalUrl}`);

    if(UserId == undefined){
        res.json({});

        return;
    }

    res.json(await BuildAccountInfo(UserId));
});
