// Endpoints the 1.12.0 client calls that 1.4.4 never did (DefaultGame.ini
// [OnlineSubsystemPhoenix] in CL392819). Response shapes follow Mystic
// Paradox's ParadoxBackend (pranav158/Mystic-Paradox@355934c:
// src/routes/login.ts, system.ts, progression.ts); see NOTICE.md.
import { Router } from "express";
import { logger } from "../logger";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";

export const client112Router = Router();

// IsBannedEndpoint: checked right after login; a 404 stops the client with
// "An error occurred while communicating with the game servers".
client112Router.get("/isbanned", (req, res) => {
    res.json({ isBanned: false });
});

// PatchNotesGetDataEndpoint, shown on the title screen.
client112Router.get("/patchnotes/:language/:buildId", (req, res) => {
    res.json({
        code: null,
        message: "OK",
        payload: {
            date: "2026-09-23T00:00:00.000+00:00",
            description: "Welcome to Undaunted!",
            language: req.params.language,
            notes: [],
            permalink: "/patch-notes/undaunted/",
            release_version: "1.12.0",
            title: "Undaunted"
        }
    });
});

// PlayerDataMigrationTrigger/CheckStatusEndpoint: accounts here were never on
// the live service, so there is nothing to migrate.
client112Router.post("/migration/trigger", HasUndauntedMetagameAuth, (req, res) => {
    res.json({ migration_failed: false, migration_finished: true });
});
client112Router.get("/migration/status", HasUndauntedMetagameAuth, (req, res) => {
    res.json({ code: null, message: "OK", payload: { migration_failed: false, migration_finished: true } });
});

// MailboxQueryTriggerConfigEndpoint: no surveys. The client treats the error
// as "nothing to show", as it did against the live service.
client112Router.get("/survey/config", HasUndauntedMetagameAuth, (req, res) => {
    res.sendStatus(400);
});

// GetTrialsLeaderboardsEndpoint and the solo submissions: no leaderboards yet.
client112Router.post("/trials/leaderboards/all", HasUndauntedMetagameAuth, (req: any, res) => {
    const Body = req.body ?? {};
    const Difficulty = Body.difficulty ?? 1;
    res.json({
        code: null,
        message: "OK",
        payload: {
            difficulty: Difficulty,
            guild: {},
            page: Body.page ?? 0,
            page_size: Body.page_size ?? 100,
            trial_id: Body.trial_id ?? "",
            world: { group: { difficulty: Difficulty, entries: [] }, solo: { all: { difficulty: Difficulty, entries: [] } } }
        }
    });
});
client112Router.post(["/trials/leaderboards/solo", "/trials/leaderboards/solo/individual"], HasUndauntedMetagameAuth, (req, res) => {
    res.json({ code: null, message: "OK", payload: {} });
});

// TrackedObjectivesEndpoint: which quests the player pins. Not stored yet;
// the client starts from an empty set each session.
client112Router.get("/progression/tracked_objectives/:accountId", HasUndauntedMetagameAuth, (req, res) => {
    res.json({
        code: null,
        message: "OK",
        payload: {
            current_set: "quest_slayer_links",
            omitted_quests: [],
            phx_account_id: req.params.accountId,
            tracked_craftables: [],
            tracked_quests: []
        }
    });
});
client112Router.post("/progression/tracked_objectives/:accountId", HasUndauntedMetagameAuth, (req, res) => {
    logger.debug(`Tracked objectives update for ${req.params.accountId} not stored`);
    res.json({ code: null, message: "OK", payload: null });
});

// Game tuning blobs the 1.12.0 client reads (GameTuningEndpoint). Bounties
// moved from /bounty/game-data to these three; until their 1.12.0 tables are
// generated, the draft pools are empty and every listed bounty is disabled.
const Tuning: Record<string, unknown> = {
    island_content_config: { DisallowedIslandContentAssets: [] },
    bounty_game_data: {
        bounty_data: [
            { bounty_id: "Bounty_Bronze_KillWithFriends", enabled: false },
            { bounty_id: "Bounty_Silver_KillWithFriends", enabled: false },
            { bounty_id: "Bounty_Gold_KillWithFriends", enabled: false }
        ],
        bounty_token_grant_hour: 0, bounty_token_id: "TOKEN_BOUNTY_DRAFT",
        bronze_count: 9, silver_count: 3, gold_count: 1, history_length: 10, item_grant_data: [],
        max_slots: 4, new_season_reset_bounties: false, num_draft_options: 3, num_spicy_options: 1,
        num_tokens_hp_start: 4, num_tokens_per_day: 0,
        premium_bounty_token_id: "TOKEN_BOUNTY_DRAFT_PREMIUM", token_rollover_warning_days: 1000
    },
    bounty_game_data_daily: {
        automatic_claim: true, automatic_draft: true,
        bounty_data: [{ bounty_id: "Challenge_Daily_Bronze_GetHuntPassXP", enabled: false }],
        bounty_token_grant_hour: 0, bounty_token_id: "TOKEN_DAILY_CHALLENGE_DRAFT",
        bronze_count: 1, delete_claimed_bounties: false, gold_count: 0, history_length: 10, item_grant_data: [],
        max_slots: 1, new_season_reset_bounties: true, num_draft_options: 3, num_spicy_options: 1,
        num_tokens_hp_start: 1, num_tokens_per_day: 0,
        premium_bounty_token_id: "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM", silver_count: 0, token_rollover_warning_days: 1000
    },
    bounty_game_data_weekly: {
        automatic_claim: true, automatic_draft: true,
        bounty_data: [{ bounty_id: "26_11_7_Challenge_Season_BreakParts_Firesacs_Aether_Sally_Terra", enabled: false }],
        item_grant_data: [], bounty_token_id: "TOKEN_WEEKLY_CHALLENGE_DRAFT", bounty_token_grant_hour: 0,
        bronze_count: 0, silver_count: 0, gold_count: 0, history_length: 8, max_slots: 4,
        num_draft_options: 3, num_spicy_options: 1, num_tokens_hp_start: 4, num_tokens_per_day: 0,
        new_season_reset_bounties: true, delete_claimed_bounties: false,
        premium_bounty_token_id: "TOKEN_WEEKLY_CHALLENGE_DRAFT_PREMIUM", token_rollover_warning_days: 1000
    }
};
client112Router.get("/game_tuning/:blobId", (req, res, next) => {
    const Payload = Tuning[req.params.blobId];
    if(Payload === undefined){ next(); return; }
    res.json({ code: null, message: "OK", payload: Payload });
});
