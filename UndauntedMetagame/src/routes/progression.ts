import { Router } from "express";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { logger } from "../logger";
import { AddEncounteredContent, GetBreadcrumbsForCharacterIdAndUserId, ProgressionError, QueryEncounteredContent, SetBreadcrumbsForCharacterIdAndUserId } from "../controllers/progression";
import { GetActiveHuntPassId, GetProgressionConfigPayload, GetTrackConfig } from "../controllers/huntpass";
import { GetWireTrack, GetWireProgressionTracks } from "../controllers/progressionTracks";
import { ApplyProgressAndObjectives, ConfirmRank, GetObjectiveForUser, GetObjectivesForUser, ParseConfirmKind, ResetTrack } from "../controllers/progressionWrites";
import { RewardError } from "../controllers/huntpassRewards";
import { IsLinkTrack } from "../controllers/slayerLinkConfig";
import { ConfirmLinkTrackRank, GetLinkTrackWire, IgnoreNativeLinkTrackGrant, SlayerLinkError } from "../controllers/slayerLinks";
import { GetDb } from "../db";
import { characters } from "../db/schema";
import { eq } from "drizzle-orm";
import { RequestHandler } from "express";

export const progressionRouter = Router();

// Registration order in this file is load-bearing. Express matches in order and
// three of these paths are ambiguous, so getting it wrong misroutes silently
// rather than erroring:
//
//   /progression/config        must precede /progression/:userId
//   /progression/objectives/*  must precede /progression/:userId/:trackId,
//                              or /progression/objectives/UID binds as
//                              userId="objectives", trackId="UID"
//
// /progression/config previously lived in systemRouter and resolved only
// because that router happens to be mounted first in app.ts. Keeping it here,
// above its ambiguous sibling, makes the dependency local and visible.
progressionRouter.get("/progression/config", HasUndauntedMetagameAuth, (req: any, res) => {
    logger.info("Progression Config");

    res.status(200);
    res.json(GetProgressionConfigPayload());
});

function StatusForProgressionError(Error: ProgressionError){
    switch(Error){
        case "forbidden":
            return 403;
        case "conflict":
            return 409;
        case "invalid_data":
        case "db_error":
            return 500;
    }
}

progressionRouter.get("/encountered-content/:characterId/:contentType", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestorAccountId = req.AuthData.userId;
    const CharacterId = req.params.characterId;
    const ContentType = req.params.contentType as number;

    logger.info(`Querying encountered content for userId ${RequestorAccountId} and characterId ${CharacterId}`);

    const ContentResult = await QueryEncounteredContent(RequestorAccountId, CharacterId, [ContentType]);

    if(!ContentResult.success){
        res.status(StatusForProgressionError(ContentResult.error));
        res.send();
        return;
    }

    res.status(200);
    res.send({
        code: null,
        message: "OK",
        payload: {
            content_types: ContentResult.data,
            success: true
        }
    });
});

progressionRouter.post("/encountered-content/query/:characterId", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestorAccountId = req.AuthData.userId;
    const CharacterId = req.params.characterId;
    const ContentTypes = req.body.content_types;

    logger.info(`Querying encountered content for userId ${RequestorAccountId} and characterId ${CharacterId}`);

    const ContentResult = await QueryEncounteredContent(RequestorAccountId, CharacterId, ContentTypes);

    if(!ContentResult.success){
        res.status(StatusForProgressionError(ContentResult.error));
        res.send();
        return;
    }

    res.status(200);
    res.send({
        code: null,
        message: "OK",
        payload: {
            content_types: ContentResult.data,
            success: true
        }
    });
});

progressionRouter.post("/encountered-content/:characterId", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestorAccountId = req.AuthData.userId;
    const CharacterId = req.params.characterId;
    const ContentType = req.body.content_type;
    const ContentId = req.body.content_id;

    logger.info(`Adding encountered content ${ContentId} for userId ${RequestorAccountId} and characterId ${CharacterId}`);

    const ContentResult = await AddEncounteredContent(RequestorAccountId, CharacterId, ContentType, ContentId);

    if(!ContentResult.success){
        res.status(StatusForProgressionError(ContentResult.error));
        res.send();
        return;
    }

    res.status(200);
    res.send({
        code: null,
        message: "OK",
        payload: {}
    });
});

progressionRouter.get("/progression/objectives/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
    const RequestorAccountId = ResolveAccountId(req);

    logger.info(`Objective progression fetched for userId ${RequestorAccountId}`);
    
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        // FindObjectivesEndpoint callback 0x140b59610 uses the array response
        // serializer at 0x140b65150 in 1.4.4. An object here is silently skipped.
        // Track progress is fetched separately through /progression/:userId.
        payload: GetObjectivesForUser(RequestorAccountId)
    })
});

progressionRouter.get("/progression/objectives/:userId/:objectiveId", HasUndauntedMetagameAuth, (req: any, res) => {
    const RequestorAccountId = ResolveAccountId(req);

    logger.info(`Objective progression fetched for userId ${RequestorAccountId}`);
    
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: GetObjectiveForUser(RequestorAccountId, req.params.objectiveId) ?? {
            phx_account_id: RequestorAccountId,
            objective_id: req.params.objectiveId,
            progress: 0,
            completed_count: 0,
            created_date: new Date(0).toISOString(),
            last_modified_date: new Date(0).toISOString(),
        }
    })
});

progressionRouter.get("/breadcrumbs/:characterId", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestedCharacterId = req.params.characterId;
    const RequestorUserId = req.AuthData.userId;

    logger.info(`Requested breadcrumbs for characterId ${RequestedCharacterId}`);

    const BreadcrumbsResult = await GetBreadcrumbsForCharacterIdAndUserId(RequestorUserId, RequestedCharacterId);

    if(!BreadcrumbsResult.success){
        res.status(StatusForProgressionError(BreadcrumbsResult.error));
        res.send();
        return;
    }

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: BreadcrumbsResult.data
    });
});

progressionRouter.post("/breadcrumbs/:characterId", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestedCharacterId = req.params.characterId;
    const RequestorUserId = req.AuthData.userId;
    const BreadcrumbsFromUser = req.body.breadcrumbs;
    const UpdateVersion = req.body.updateVersion;

    logger.info(`Setting breadcrumbs for characterId ${RequestedCharacterId}`);

    const BreadcrumbsResult = await SetBreadcrumbsForCharacterIdAndUserId(RequestorUserId, RequestedCharacterId, BreadcrumbsFromUser, UpdateVersion);

    if(!BreadcrumbsResult.success){
        res.status(StatusForProgressionError(BreadcrumbsResult.error));
        res.send();
        return;
    }

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: BreadcrumbsResult.data
    });
});

// Selecting an account id is not authorisation. Progression mutation is
// server-authoritative: only the gameserver may award XP or confirm a rank,
// because a player-authenticated caller could otherwise grant themselves any
// amount on any track. Reads stay open to both.
function AssertGameserver(req: any){
    if(req.AuthData?.IsGameserver !== true){
        throw new RewardError(403, "Progression may only be modified by a gameserver");
    }

    const Target = req.params.userId;

    // When the gameserver relays a player's token, the account it names must be
    // that player's. Delegation is not supported, so a mismatch is refused.
    if(typeof req.AuthData.userId === "string" && req.AuthData.userId !== Target){
        throw new RewardError(403, "Relayed token does not match the requested account");
    }

    return Target;
}

// Rewards go to a character, but progression belongs to the account. The store
// already refuses this ambiguity rather than picking one, so the same rule
// applies here until multi-character accounts are properly modelled.
function ResolveRewardCharacter(UserId: string){
    const Rows = GetDb().select().from(characters).where(eq(characters.userId, UserId)).all();

    if(Rows.length !== 1){
        throw new RewardError(409, `Expected exactly one character for ${UserId}, found ${Rows.length}`);
    }

    return Rows[0].characterId;
}

// Where a gameserver award happened and who was connected there, reported by
// the runtime on every gameserver request (dllmain.cpp ProcessRequest). Only
// a gameserver's word counts; a player cannot claim to be hunting with anyone.
//
// The gameserver's API key is what makes it a gameserver award; the headers
// only describe it. The 1.12.0 runtime does not send them yet, and requiring
// them meant no 1.12.0 award ever advanced a Slayer Link. Link XP follows the
// party rule, which needs neither.
function HuntContextFrom(req: any){
    if(req.AuthData?.IsGameserver !== true){
        return undefined;
    }

    const World = req.headers["x-undaunted-world"];
    const Present = req.headers["x-undaunted-copresent"];

    return {
        world: typeof World === "string" && World.length > 0 ? World : "unreported",
        copresentCharacterIds: typeof Present === "string"
            ? Present.split(",").map((Id) => Id.trim()).filter((Id) => Id.length > 0) : []
    };
}

// The runtime's stable per-request id (dllmain.cpp ProcessRequest). Trusted
// from a gameserver only; it is what makes a retried award a no-op.
function RequestIdFrom(req: any){
    const Id = req.headers["x-undaunted-request-id"];

    return req.AuthData?.IsGameserver === true && typeof Id === "string" && Id.length > 0 && Id.length <= 128 ? Id : undefined;
}

const ProgressionAction = (handler: RequestHandler): RequestHandler => (req: any, res, next) => {
    try{
        return handler(req, res, next);
    } catch(error: any){
        if(error instanceof RewardError || error instanceof SlayerLinkError){
            res.status(error.status).json({ code: String(error.status), message: error.message });
        }
        else{
            logger.error({ err: error }, "Progression request failed");
            res.status(500).json({ code: "500", message: "Progression request failed" });
        }
    }
};

// GrantProgressionWithObjectives. This returned a hardcoded 400 because
// accepting progress against a permanently-maxed read path replayed the
// mastery celebration forever. The read path now reports a real derived rank
// and confirmation is persisted, so the grant can be accepted.
progressionRouter.post("/progression/:userId", HasUndauntedMetagameAuth, ProgressionAction((req: any, res) => {
    const AccountId = AssertGameserver(req);

    const Result = ApplyProgressAndObjectives(AccountId, req.body?.progress_tracks ?? [], req.body?.objectives ?? [], HuntContextFrom(req), RequestIdFrom(req));

    logger.info(`Progression granted for ${AccountId}: ${Result.Applied.map((Entry) => `${Entry.trackId}+${Entry.awarded}`).join(", ") || "nothing"}`);

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {}
    });
}));

// The gameserver calls this on the player's behalf and is the only caller that
// may name a different account; a player is pinned to their own token. Same
// idiom as routes/inventory.ts. Selecting the id is NOT authorisation on its
// own - it is sufficient here only because this route is read-only.
function ResolveAccountId(req: any){
    return req.AuthData.IsGameserver ? (req.params.userId ?? req.AuthData.userId) : req.AuthData.userId;
}

// All tracks use the same persisted totals and confirmation cursors. Missing
// mastery rows mean zero points; the configured player track starts at rank 1.
progressionRouter.get("/progression/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
    const RequestorAccountId = ResolveAccountId(req);

    const ActiveHuntPass = GetActiveHuntPassId();

    logger.info(`Progression fetched for userId ${RequestorAccountId} (${ActiveHuntPass} and masteries from db)`);

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: GetWireProgressionTracks(RequestorAccountId)
    })
});

// FindProgressionTrackEndpoint. This route did not exist, so every call the
// runtime made to it answered 404 - including the ones behind
// DoesPlayerHavePremium, whose own failure text names QueryProgressionInTrack.
//
// The native single-track DTO and confirmation callback consume one track
// object in payload (1.4.4 serializers 0x140b12170 / 0x140b6afe0).
progressionRouter.get("/progression/:userId/:trackId", HasUndauntedMetagameAuth, (req: any, res) => {
    const RequestorAccountId = ResolveAccountId(req);
    const TrackId = req.params.trackId;

    // Linked_Slayer_Slot_N reads the link in that slot, not the table below.
    if(IsLinkTrack(TrackId)){
        try{
            res.status(200).json({ code: null, message: "OK", payload: GetLinkTrackWire(RequestorAccountId, TrackId) });
        } catch(error: any){
            res.status(error instanceof SlayerLinkError ? error.status : 500).json({ code: "404", message: error?.message });
        }

        return;
    }

    if(GetTrackConfig(TrackId) == undefined){
        logger.warn(`Progression requested for unknown track ${TrackId}`);

        res.status(404);
        res.json({ code: "404", message: `Unknown progression track ${TrackId}` });

        return;
    }

    logger.info(`Progression track ${TrackId} fetched for userId ${RequestorAccountId}`);

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: GetWireTrack(RequestorAccountId, TrackId)
    });
});

// GrantProgressionEndpoint: award {amount} on one track directly.
progressionRouter.post("/progression/:userId/:trackId/:amount", HasUndauntedMetagameAuth, ProgressionAction((req: any, res) => {
    const AccountId = AssertGameserver(req);
    const TrackId = req.params.trackId;
    const Amount = Number(req.params.amount);

    if(IsLinkTrack(TrackId)){
        IgnoreNativeLinkTrackGrant(AccountId, TrackId, Amount);
        res.status(200).json({ code: null, message: "OK", payload: GetLinkTrackWire(AccountId, TrackId) });
        return;
    }

    const Result = ApplyProgressAndObjectives(AccountId, [{ progression_id: TrackId, progress: Amount }], [], HuntContextFrom(req), RequestIdFrom(req));

    if(Result.Applied.length === 0 && !Result.Replayed){
        throw new RewardError(400, `Could not award ${req.params.amount} on ${TrackId}`);
    }

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: GetWireTrack(AccountId, TrackId)
    });
}));

// ConfirmProgressionEndpoint. Confirming is what stops the rank-up celebration
// replaying, and it is when the rank's rewards are handed over.
progressionRouter.post("/progression/:userId/:trackId/:rank/confirm/:kind", HasUndauntedMetagameAuth, ProgressionAction((req: any, res) => {
    const AccountId = AssertGameserver(req);
    const TrackId = req.params.trackId;
    const Rank = Number(req.params.rank);

    const Kind = ParseConfirmKind(req.params.kind);

    if(Kind == undefined){
        throw new RewardError(400, `Unrecognised confirmation kind ${req.params.kind}`);
    }

    if(IsLinkTrack(TrackId)){
        const Wire = Kind === "free" ? ConfirmLinkTrackRank(AccountId, TrackId, Rank) : GetLinkTrackWire(AccountId, TrackId);
        res.status(200).json({ code: null, message: "OK", payload: { ...Wire, granted_ranks: [] } });
        return;
    }

    const CharacterId = ResolveRewardCharacter(AccountId);

    const Result = ConfirmRank(AccountId, CharacterId, TrackId, Rank, Kind);

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: { ...GetWireTrack(AccountId, TrackId), granted_ranks: Result.granted }
    });
}));

// DeleteProgressionEndpoint. Resetting bumps the generation rather than
// deleting claim rows: clearing claims alone would collide with the inventory
// replay ledger, and clearing both would re-award items the player still holds.
progressionRouter.delete("/progression/:userId/:trackId", HasUndauntedMetagameAuth, ProgressionAction((req: any, res) => {
    const AccountId = AssertGameserver(req);
    const TrackId = req.params.trackId;

    if(IsLinkTrack(TrackId)){
        throw new RewardError(409, "Slayer Link progress belongs to the link and cannot be reset");
    }

    const Generation = ResetTrack(AccountId, TrackId);

    logger.warn(`Progression reset for ${AccountId} on ${TrackId}, now generation ${Generation}`);

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: GetWireTrack(AccountId, TrackId)
    });
}));

// Observation only, and deliberately last. Several progression endpoints in the
// runtime's map may still be unimplemented. Anything reaching here is a path
// this server does not handle, so record it instead of
// letting it fall through to a silent 404.
progressionRouter.use("/progression", (req: any, res, next) => {
    logger.warn({
        unhandledProgression: {
            method: req.method,
            path: req.originalUrl,
            caller: req.headers["x-undaunted-gameserver-apikey"] != undefined ? "gameserver" : "player"
        }
    }, `Unhandled progression request ${req.method} ${req.originalUrl}`);

    next();
});
