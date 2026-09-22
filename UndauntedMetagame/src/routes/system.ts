import { Router } from "express";
import { logger } from "../logger";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { HasOptionalUndauntedMetagameAuth } from "../middleware/HasOptionalUndauntedMetagameAuth";
import { UpdatePlayerActivity } from "../controllers/undauntedapi";
import { GetEntitlementsForUser } from "../controllers/entitlements";
import { GetActiveHuntPassId } from "../controllers/huntpass";
import { GetCooldownsForUser, SetCooldownsForUser, StartCooldownForUser } from "../controllers/cooldowns";
import { GetBountiesForUser, RemoveBountiesForUser, SaveBountiesForUser } from "../controllers/bounties";
import bountyData from "../vendor/bounty_data.json";

export const systemRouter = Router();

// Shown at the bottom of the login screen, keyed by client language.
const STATUS_MESSAGE = "This is a private beta test";

systemRouter.get("/dauntless-status", (req, res) => {
    logger.info("Status");

    res.json({
	    "show-status": true,
	    "en": STATUS_MESSAGE,
	    "fr": STATUS_MESSAGE,
	    "it": STATUS_MESSAGE,
	    "es": STATUS_MESSAGE,
	    "de": STATUS_MESSAGE,
	    "pt": STATUS_MESSAGE,
	    "ru": STATUS_MESSAGE,
	    "ja": STATUS_MESSAGE
    });
});

// The caller does not attach credentials to this request, so requiring auth
// turned every heartbeat into a 401 and it never received its interval. Answer
// with the interval either way, and only record activity when the token
// identifies someone.
systemRouter.post("/heartbeat", HasOptionalUndauntedMetagameAuth, async (req: any, res) => {
	const UserId = req.AuthData?.userId;

	const UserMap = req.body?.map;

	if(UserId != undefined){
		await UpdatePlayerActivity(UserId, UserMap);
	}

    res.status(200).type("text/plain").send("20000");
});

systemRouter.post("/event", (req, res) => {
    res.status(200);
    res.json({});
});

systemRouter.post("/account/migrate", HasUndauntedMetagameAuth, (req, res) => {
	logger.info("Account migration (stubbed)");

	res.status(200);
	res.json({
		migration_failed: false,
		migration_finished: true
	});
});

systemRouter.post("/profile/update", HasUndauntedMetagameAuth, (req, res) => {
	logger.info("Leaderboard update profile (stubbed)");

	res.status(200);
	res.send();
});

systemRouter.get("/vivox/login", HasUndauntedMetagameAuth, (req, res) => {
	logger.info("Vivox login (stubbed)");

	res.status(404);
	res.send();
});

systemRouter.post("/motd/", HasUndauntedMetagameAuth, (req, res) => {
	logger.info("MOTD (stubbed)");

	res.status(204);
	res.send();
});

// QueryEntitlements' response serializer (1.4.4 VA 0x140b1b570) reads a
// top-level "entitlements" array. It does not unwrap code/message/payload.
systemRouter.get("/entitlementsv2", HasUndauntedMetagameAuth, async (req: any, res) => {
	const UserId = req.AuthData.userId;

	const Held = await GetEntitlementsForUser(UserId);

	logger.info(`Player ${UserId} has ${Held.length} entitlement(s)`);

	res.status(200);
	res.json({
		entitlements: Held
	});
});

systemRouter.post("/entitlementv2/:userId", HasUndauntedMetagameAuth, (req, res) => {
	logger.info("Entitlements (stubbed)");

	res.status(200);
	res.json({
		code: null,
		message: "OK",
		payload: []
	});
});

systemRouter.get("/playertreatments/:userId", HasUndauntedMetagameAuth, (req, res) => {
	logger.info("Cohorts (stubbed)");

	res.status(200);
	res.json({
		treatments: [
			"CohortTreatment.Dojo.B"
		]
	});
});

// GET/POST /escalation/:seasonId/:userId live in routes/escalation.ts.

systemRouter.get("/eventstats/", HasUndauntedMetagameAuth, (req, res) => {
	logger.info("Event stats (stubbed)");

	res.status(200);
	res.json({
		stats: []
	});
});

// GET /progression/config now lives in progressionRouter, directly above the
// ambiguous /progression/:userId it must outrank. It resolved here only because
// systemRouter happens to be mounted first in app.ts, which made the ordering
// invisible and fragile.

// SelectedHuntPassEndpoint. The active season is configuration, not a literal:
// ACTIVE_HUNT_PASS seeds it and an administrative change overrides it, so a
// server owner can swap seasons without a rebuild.
systemRouter.get("/huntpass/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
	const ActiveHuntPass = GetActiveHuntPassId();

	logger.info(`Active Hunt Pass is ${ActiveHuntPass}`);

	res.status(200);
	res.json({
        code: null,
        message: "OK",
        payload: ActiveHuntPass
    });
});

// Cooldowns. The original note here read "Cooldowns might be gameplay-important,
// impl if so" - they are. The bounty system keeps its token-grant marker in a
// cooldown, and with these stubbed every login looked like a new bounty season:
// tokens were revoked and regranted and stored bounties were never recreated.
//
// Registration order matters: /cooldown/batch/{acct} and
// /cooldown/{acct}/{cooldownId} are both three segments, so batch must be
// registered first or it binds as userId="batch".
const CooldownUserId = (req: any) => req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;

const CooldownResponse = (res: any, Entries: any[]) => {
	res.status(200);
	res.json({
		code: null,
		message: "OK",
		// GET consumes a TMap<FString, FString>, unlike the batch write DTO.
		payload: Object.fromEntries(Entries.map((Entry) => [Entry.cooldown_id, Entry.cooldown_started_date]))
	});
};

// GetCooldownEndpoint
systemRouter.get("/cooldown/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
	const UserId = CooldownUserId(req);
	const Entries = GetCooldownsForUser(UserId);

	logger.info(`Cooldowns fetched for ${UserId}: ${Entries.length}`);

	CooldownResponse(res, Entries);
});

// SetCooldownBatchEndpoint. The method is not recorded in the runtime's map, so
// both verbs are accepted rather than guessing one.
const SetBatch = (req: any, res: any) => {
	CooldownResponse(res, SetCooldownsForUser(CooldownUserId(req), req.body));
};
systemRouter.put("/cooldown/batch/:userId", HasUndauntedMetagameAuth, SetBatch);
systemRouter.post("/cooldown/batch/:userId", HasUndauntedMetagameAuth, SetBatch);

// SetCooldownEndpoint
const SetOne = (req: any, res: any) => {
	CooldownResponse(res, SetCooldownsForUser(CooldownUserId(req), req.body));
};
systemRouter.put("/cooldown/:userId", HasUndauntedMetagameAuth, SetOne);
systemRouter.post("/cooldown/:userId", HasUndauntedMetagameAuth, SetOne);

// StartCooldownEndpoint. Never implemented before.
const StartOne = (req: any, res: any) => {
	try{
		CooldownResponse(res, StartCooldownForUser(CooldownUserId(req), req.params.cooldownId, req.body?.cooldown_started_date));
	} catch(Error){
		res.status(400);
		res.json({ code: "400", message: "Invalid cooldown" });
	}
};
systemRouter.post("/cooldown/:userId/:cooldownId", HasUndauntedMetagameAuth, StartOne);
systemRouter.put("/cooldown/:userId/:cooldownId", HasUndauntedMetagameAuth, StartOne);

// The gameserver checks every stored bounty against bounty_data on login.
// An explicitly disabled entry is reset and its token refunded. A missing
// entry falls through to the normal unlock check; absence alone does not burn it.
//
// Definitions come from src/vendor/bounty_data.json, whose ids are the row
// names of the client's own Gameplay/Bounty/bounty_table.
const BountyDefinitions = (bountyData as any).bounty_data as any[];

systemRouter.get("/bounty/game-data", HasUndauntedMetagameAuth, (req: any, res) => {
	logger.info(`Bounty game data (${BountyDefinitions.length} definitions)`);

	res.status(200);
	res.json({
    code: null,
    message: "OK",
    payload: {
      max_slots: 4,
      num_draft_options: 3,
      num_spicy_options: 1,
      bounty_token_id: "TOKEN_BOUNTY_DRAFT",
      premium_bounty_token_id: "TOKEN_BOUNTY_DRAFT_PREMIUM",
      num_tokens_hp_start: 4,
      num_tokens_per_day: 0,
      bounty_token_grant_hour: 0,
      history_length: 10,
      bronze_count: 9,
      silver_count: 3,
      gold_count: 1,
      new_season_reset_bounties: false,
      // 1.4.4 entry serializer 0x1413f2d20 reads bounty_id, enabled,
      // reward_amount. Omitting enabled makes every configured bounty
      // unavailable; omitting the list makes held bounties burn on reload.
      bounty_data: BountyDefinitions,
      item_grant_data: [],
      token_rollover_warning_days: 1000,
      automatic_draft: false,
      automatic_claim: false,
      delete_claimed_bounties: false,
    },
  });
});

// Bounties are now persisted, so a drafted board survives a relog.
systemRouter.get("/bounty/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
	const UserId = req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;

	logger.info(`Bounties fetched for ${UserId}`);

	// Wrapped in code/message/payload. An earlier change served this bare, on
	// the inference that "bounties" and "draft_data" being ASCII strings made
	// them root keys. That was wrong: with the bare shape the gameserver parsed
	// nothing - not even draft_data - and posted back a fully zeroed board. With
	// the wrapper it reads draft_data and keeps the draft history intact.
	res.status(200);
	res.json({
		code: null,
		message: "OK",
		payload: GetBountiesForUser(UserId)
	});
});

// This previously accepted the board and threw it away.
systemRouter.post("/bounty/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
	const UserId = req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;

	try{
		const Saved = SaveBountiesForUser(UserId, req.body);

		logger.info(`Bounties saved for ${UserId}`);

		res.status(200);
		res.json({
			code: null,
			message: "OK",
			payload: Saved
		});
	} catch(Error){
		logger.error({ Error }, `Could not save bounties for ${UserId}`);

		res.status(400);
		res.json({ code: "400", message: "Invalid bounty payload" });
	}
});

// DeleteBountiesEndpoint. Abandoning a bounty 404'd here, which surfaced in
// game as "An error occured. Please try again later."
systemRouter.post("/bounty/delete/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
	const UserId = req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;

	try{
		const Board = RemoveBountiesForUser(UserId, req.body?.bounty_ids);

		res.status(200);
		res.json({
			code: null,
			message: "OK",
			payload: Board
		});
	} catch(Error){
		logger.error({ Error }, `Could not delete bounties for ${UserId}`);

		res.status(400);
		res.json({ code: "400", message: "Invalid bounty_ids" });
	}
});

systemRouter.get("/all/", HasUndauntedMetagameAuth, (req: any, res) => {
	logger.info("Mailbox (stubbed)");

	res.json({
		code: null,
		message: "OK",
		payload: {
			messages: []
		}
	});
});
