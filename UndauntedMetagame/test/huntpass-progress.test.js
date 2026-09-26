"use strict";

// Hunt Pass phase 2/3: XP accrual, rank confirmation, reward granting,
// currency wallets and bounty persistence.
//
// The cases that matter most here are the ones that go wrong quietly: two
// accounts claiming the same rank, a retried grant paying twice, and a
// confirmation running ahead of what was earned.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const Harness = require("./harness");

let Context;
let Writes;
let Rewards;
let Wallet;
let Bounties;
let Tracks;
let Server;
let BaseUrl;
let Sign;

const SEASON = "season09b";

before(async () => {
    const Keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(Keys.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
    process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(Keys.publicKey.export({ type: "spki", format: "pem" })).toString("base64");

    Context = Harness.CreateDisposableDatabase();

    Writes = require("../dist/controllers/progressionWrites");
    Rewards = require("../dist/controllers/huntpassRewards");
    Wallet = require("../dist/controllers/wallet");
    Bounties = require("../dist/controllers/bounties");
    Tracks = require("../dist/controllers/progressionTracks");
    Sign = require("../dist/controllers/auth").SignMetagameJWTForUid;

    const express = require("express");
    const App = express();
    App.use(express.json());
    App.use(require("../dist/routes/progression").progressionRouter);
    App.use(require("../dist/routes/system").systemRouter);

    Server = await new Promise((resolve) => {
        const Listening = App.listen(0, "127.0.0.1", () => resolve(Listening));
    });

    BaseUrl = `http://127.0.0.1:${Server.address().port}`;
});

after(async () => {
    await new Promise((resolve) => Server.close(resolve));
    Context.Db.$client.close();
    Context.Cleanup();
});

function GrantPremium(UserId) {
    Context.Db.insert(Context.Schema.entitlements).values({
        userId: UserId, entitlement: "season09b_premium",
        duration: 0, activatedAt: Date.now(), source: "test"
    }).run();
}

function Claims(UserId) {
    const { eq } = require("drizzle-orm");
    return Context.Db.select().from(Context.Schema.progressionclaims)
        .where(eq(Context.Schema.progressionclaims.userId, UserId)).all();
}

// ------------------------------------------------------------ XP accrual

test("xp accrues and drives the derived rank", () => {
    const Account = Harness.SeedAccount(Context);

    Writes.ApplyProgressAndObjectives(Account.UserId, [{ progression_id: SEASON, progress: 250 }], []);

    const Derived = Tracks.GetDerivedProgress(Account.UserId, SEASON);

    assert.equal(Derived.totalPoints, 250);
    assert.equal(Derived.rank, 2);
});

test("progress is a delta, so repeated awards accumulate", () => {
    const Account = Harness.SeedAccount(Context);

    for (let i = 0; i < 3; i++) {
        Writes.ApplyProgressAndObjectives(Account.UserId, [{ progression_id: SEASON, progress: 100 }], []);
    }

    assert.equal(Tracks.GetDerivedProgress(Account.UserId, SEASON).rank, 3);
});

test("progress for an unconfigured track is ignored rather than stored", () => {
    const Account = Harness.SeedAccount(Context);

    const Result = Writes.ApplyProgressAndObjectives(Account.UserId, [{ progression_id: "NotATrack", progress: 100 }], []);

    assert.equal(Result.Applied.length, 0);
    assert.deepEqual(Result.Ignored, ["NotATrack"]);
});

test("objectives persist and survive out-of-order delivery", () => {
    const Account = Harness.SeedAccount(Context);

    Writes.ApplyProgressAndObjectives(Account.UserId, [], [{ objective_id: "Obj_A", value: 5, completed_count: 1 }]);
    // A late duplicate carrying a smaller value must not roll progress back.
    Writes.ApplyProgressAndObjectives(Account.UserId, [], [{ objective_id: "Obj_A", value: 2, completed_count: 0 }]);

    const Objective = Writes.GetObjectiveForUser(Account.UserId, "Obj_A");

    assert.equal(Objective.progress, 5);
    assert.equal(Objective.completed_count, 1);
});

// --------------------------------------------------------- confirm + claim

test("confirming a rank grants its rewards and advances the cursor", () => {
    const Account = Harness.SeedAccount(Context);

    Writes.ApplyProgressAndObjectives(Account.UserId, [{ progression_id: SEASON, progress: 300 }], []);

    const Result = Writes.ConfirmRank(Account.UserId, Account.CharacterId, SEASON, 3, "free");

    assert.equal(Result.confirmedRank, 3);
    assert.deepEqual(Result.granted, [0, 1, 2, 3], "catch-up grants every unclaimed rank");

    // Rank 1 of the free track awards a title and an emote.
    const Held = Harness.ReadInventory(Context, Account.CharacterId);
    assert.ok(Held.stackedItems.some((Stack) => Stack.catalogId === "TITLE_HP09B_COMMANDO_00"));
});

test("confirming twice does not grant twice", () => {
    const Account = Harness.SeedAccount(Context);

    Writes.ApplyProgressAndObjectives(Account.UserId, [{ progression_id: SEASON, progress: 300 }], []);
    Writes.ConfirmRank(Account.UserId, Account.CharacterId, SEASON, 3, "free");
    const Second = Writes.ConfirmRank(Account.UserId, Account.CharacterId, SEASON, 3, "free");

    assert.deepEqual(Second.granted, [], "a replayed confirmation grants nothing further");
    assert.equal(Claims(Account.UserId).length, 4);
});

test("confirmation cannot run ahead of the earned rank", () => {
    const Account = Harness.SeedAccount(Context);

    Writes.ApplyProgressAndObjectives(Account.UserId, [{ progression_id: SEASON, progress: 200 }], []);

    // Claiming rank 40 while standing at rank 2 must not acknowledge ranks the
    // player has not earned - doing so would suppress their claim later.
    const Result = Writes.ConfirmRank(Account.UserId, Account.CharacterId, SEASON, 40, "free");

    assert.equal(Result.earnedRank, 2);
    assert.equal(Result.confirmedRank, 2);
});

test("two accounts can claim the same rank", () => {
    const First = Harness.SeedAccount(Context, "SlayerOne");
    const Second = Harness.SeedAccount(Context, "SlayerTwo");

    for (const Account of [First, Second]) {
        Writes.ApplyProgressAndObjectives(Account.UserId, [{ progression_id: SEASON, progress: 100 }], []);
    }

    // The first draft of the claim key omitted the account and character. Since
    // inventorytransactions.transactionId is a global primary key, the second
    // account's claim collided with the first and was rejected.
    Writes.ConfirmRank(First.UserId, First.CharacterId, SEASON, 1, "free");
    Writes.ConfirmRank(Second.UserId, Second.CharacterId, SEASON, 1, "free");

    assert.equal(Claims(First.UserId).length, 2);
    assert.equal(Claims(Second.UserId).length, 2);
});

// ------------------------------------------------------------ premium gating

test("premium ranks are refused without the entitlement", () => {
    const Account = Harness.SeedAccount(Context);

    Writes.ApplyProgressAndObjectives(Account.UserId, [{ progression_id: SEASON, progress: 200 }], []);

    assert.throws(
        () => Writes.ConfirmRank(Account.UserId, Account.CharacterId, SEASON, 2, "premium"),
        (Error) => Error.status === 403);
});

test("buying elite late releases the premium ranks already earned", () => {
    const Account = Harness.SeedAccount(Context);

    Writes.ApplyProgressAndObjectives(Account.UserId, [{ progression_id: SEASON, progress: 500 }], []);
    Writes.ConfirmRank(Account.UserId, Account.CharacterId, SEASON, 5, "free");

    GrantPremium(Account.UserId);

    const Result = Writes.ConfirmRank(Account.UserId, Account.CharacterId, SEASON, 5, "premium");

    assert.deepEqual(Result.granted, [0, 1, 2, 3, 4, 5], "all five earned premium ranks pay out retroactively");
});

// ---------------------------------------------------------------- wallet

test("currency rewards reach the wallet, not inventory", () => {
    const Account = Harness.SeedAccount(Context);

    // Free rank 10 awards 50 CURRENCY_PLATINUM_UNIV.
    Writes.ApplyProgressAndObjectives(Account.UserId, [{ progression_id: SEASON, progress: 1000 }], []);
    Writes.ConfirmRank(Account.UserId, Account.CharacterId, SEASON, 10, "free");

    const Balances = Wallet.GetWallet(Account.UserId);

    // CURRENCY_PLATINUM_UNIV is how the config spells it; the balance sheet
    // calls it CURRENCY_PLATINUM.
    assert.ok(Balances.CURRENCY_PLATINUM >= 50);
    assert.equal(Balances.CURRENCY_PLATINUM, Balances.id_currency_platinum, "both spellings report one balance");

    const Held = Harness.ReadInventory(Context, Account.CharacterId);
    assert.ok(!Held.stackedItems.some((Stack) => Stack.catalogId.startsWith("CURRENCY_")),
        "currencies must not be stacked into inventory");
});

// --------------------------------------------------------------- bounties

test("bounties persist across a read", () => {
    const Account = Harness.SeedAccount(Context);

    assert.deepEqual(Bounties.GetBountiesForUser(Account.UserId).bounties, []);

    Bounties.SaveBountiesForUser(Account.UserId, {
        bounties: [{ id: "BountyA", progress: 3 }],
        draft_data: { current_draft_choices: ["X"], previous_draft_selections: [], bronze_count: 1, silver_count: 0, gold_count: 0 }
    });

    const Stored = Bounties.GetBountiesForUser(Account.UserId);

    assert.equal(Stored.bounties.length, 1);
    assert.equal(Stored.bounties[0].id, "BountyA");
    assert.equal(Stored.draft_data.bronze_count, 1);
});

test("drafting several bounties keeps all of them", () => {
    const Account = Harness.SeedAccount(Context);

    // The client posts one bounty per draft, not the whole board. Replacing the
    // stored payload each time kept only the last draft and silently dropped
    // the earlier ones.
    const Draft = (Id, Slot, Previous) => Bounties.SaveBountiesForUser(Account.UserId, {
        bounties: [{ bounty_id: Id, slot_index: Slot, objectives: [{ objective_id: Id, progress: 0 }], update_version: 0 }],
        draft_data: { current_draft_choices: [], previous_draft_selections: Previous, bronze_count: 7, silver_count: 2, gold_count: 1 }
    });

    Draft("Bounty_Bronze_KillAxePike", 0, ["Bounty_Bronze_KillAxePike"]);
    Draft("Bounty_Bronze_HuntsSwordTwo", 1, ["Bounty_Bronze_KillAxePike", "Bounty_Bronze_HuntsSwordTwo"]);
    Draft("Bounty_Silver_HuntsSwordTwo", 2, ["Bounty_Bronze_KillAxePike", "Bounty_Bronze_HuntsSwordTwo", "Bounty_Silver_HuntsSwordTwo"]);

    const Stored = Bounties.GetBountiesForUser(Account.UserId);

    assert.equal(Stored.bounties.length, 3, "all three drafted bounties survive");
    assert.deepEqual(Stored.bounties.map((Entry) => Entry.slot_index).sort(), [0, 1, 2]);
    assert.equal(Stored.draft_data.previous_draft_selections.length, 3, "draft_data is full state and replaces");
});

test("a draft-options refresh does not wipe the held board", () => {
    const Account = Harness.SeedAccount(Context);

    Bounties.SaveBountiesForUser(Account.UserId, {
        bounties: [{ bounty_id: "Held", slot_index: 0 }],
        draft_data: { current_draft_choices: [], previous_draft_selections: ["Held"], bronze_count: 7, silver_count: 3, gold_count: 1 }
    });

    // Between drafts the client posts an empty bounties list alongside its new
    // draft choices. That means "nothing new", not "I hold nothing".
    Bounties.SaveBountiesForUser(Account.UserId, {
        bounties: [],
        draft_data: { current_draft_choices: ["A", "B", "C"], previous_draft_selections: ["Held"], bronze_count: 6, silver_count: 3, gold_count: 1 }
    });

    const Stored = Bounties.GetBountiesForUser(Account.UserId);

    assert.equal(Stored.bounties.length, 1, "the held bounty survives a draft refresh");
    assert.deepEqual(Stored.draft_data.current_draft_choices, ["A", "B", "C"]);
});

test("re-posting a bounty updates it in place", () => {
    const Account = Harness.SeedAccount(Context);

    Bounties.SaveBountiesForUser(Account.UserId, {
        bounties: [{ bounty_id: "Tracked", slot_index: 0, objectives: [{ objective_id: "Tracked", progress: 0 }] }]
    });
    Bounties.SaveBountiesForUser(Account.UserId, {
        bounties: [{ bounty_id: "Tracked", slot_index: 0, objectives: [{ objective_id: "Tracked", progress: 5 }] }]
    });

    const Stored = Bounties.GetBountiesForUser(Account.UserId);

    assert.equal(Stored.bounties.length, 1, "progress updates must not duplicate the bounty");
    assert.equal(Stored.bounties[0].objectives[0].progress, 5);
});

// 1.12.0 keeps drafted bounties, the daily challenge and the season
// challenges in one list, each kind numbering its slots from 0. A world load
// posts the season challenges and a daily challenge; displacing by slot across
// kinds wiped every drafted bounty on reload.
const Entry = (Id, Slot) => ({ bounty_id: Id, slot_index: Slot, objectives: [{ objective_id: Id, progress: 0 }], update_version: 0 });
const Ids = (UserId) => Bounties.GetBountiesForUser(UserId).bounties.map((Bounty) => Bounty.bounty_id).sort();

test("season and daily challenges do not displace drafted bounties sharing their slots", () => {
    const Account = Harness.SeedAccount(Context);
    const Drafted = ["Bounty_Bronze_StaggerDamageReduce", "Bounty_Bronze_HuntsSwordTwo", "Bounty_Bronze_HuntsChainbladesTwo"];
    Drafted.forEach((Id, Slot) => Bounties.SaveBountiesForUser(Account.UserId, { bounties: [Entry(Id, Slot)] }));

    const Challenges = ["Challenge_Season_Quest_S19a_01-season19-0", "Challenge_Season_Kills_Raging-season19-1",
        "Challenge_Season_Break_Snowflake-season19-2"];
    Bounties.SaveBountiesForUser(Account.UserId, { bounties: Challenges.map((Id) => Entry(Id, 0)) });
    Bounties.SaveBountiesForUser(Account.UserId, { bounties: [Entry("Challenge_Daily_Bronze_PartDamageReduce", 0)] });
    // A later update to one week's challenge keeps the other weeks' challenges in that slot.
    Bounties.SaveBountiesForUser(Account.UserId, { bounties: [{ ...Entry(Challenges[1], 0), update_version: 3 }] });

    assert.deepEqual(Ids(Account.UserId), [...Drafted, ...Challenges, "Challenge_Daily_Bronze_PartDamageReduce"].sort());
});

test("a bounty still replaces one of its own kind in its slot", () => {
    const Account = Harness.SeedAccount(Context);
    Bounties.SaveBountiesForUser(Account.UserId, { bounties: [Entry("Bounty_Bronze_Old", 0), Entry("Challenge_Daily_Bronze_Old", 0)] });
    Bounties.SaveBountiesForUser(Account.UserId, { bounties: [Entry("Bounty_Silver_New", 0)] });
    Bounties.SaveBountiesForUser(Account.UserId, { bounties: [Entry("Challenge_Daily_Bronze_New", 0)] });

    assert.deepEqual(Ids(Account.UserId), ["Bounty_Silver_New", "Challenge_Daily_Bronze_New"]);
});

test("an expired daily challenge releases its slot at the next UTC reset", () => {
    const Account = Harness.SeedAccount(Context);
    Bounties.SaveBountiesForUser(Account.UserId, {
        bounties: [
            Entry("Bounty_Bronze_Held", 0),
            Entry("Challenge_Season_Quest_S19a_01-season19-0", 0),
            { ...Entry("Challenge_Daily_Bronze_Old", 0), drafted_timestamp: "2026-09-24T23:59:59.999Z", claimed: true }
        ]
    });

    const BeforeReset = Bounties.GetBountiesForUser(Account.UserId, new Date("2026-09-24T23:59:59.999Z"));
    assert.ok(BeforeReset.bounties.some((Bounty) => Bounty.bounty_id === "Challenge_Daily_Bronze_Old"));

    const AfterReset = Bounties.GetBountiesForUser(Account.UserId, new Date("2026-09-25T00:00:00.000Z"));
    assert.deepEqual(AfterReset.bounties.map((Bounty) => Bounty.bounty_id).sort(), [
        "Bounty_Bronze_Held", "Challenge_Season_Quest_S19a_01-season19-0"
    ]);
});

test("a drafted-board reset clears drafted bounties and keeps the challenges", () => {
    const Account = Harness.SeedAccount(Context);
    Bounties.SaveBountiesForUser(Account.UserId, {
        bounties: [Entry("Bounty_Bronze_Held", 0), Entry("Challenge_Season_Quest_S19a_01-season19-0", 0)]
    });
    Bounties.SaveBountiesForUser(Account.UserId, {
        bounties: [],
        draft_data: { current_draft_choices: [], previous_draft_selections: [], bronze_count: 0, silver_count: 0, gold_count: 0 }
    });

    assert.deepEqual(Ids(Account.UserId), ["Challenge_Season_Quest_S19a_01-season19-0"]);
});

// ------------------------------------------------------------ authorisation

test("a player token cannot award itself progression", async () => {
    const Account = Harness.SeedAccount(Context);

    // Selecting an account id is not authorisation: without an explicit write
    // guard any player could grant themselves any amount on any track.
    const Response = await fetch(`${BaseUrl}/progression/${Account.UserId}`, {
        method: "POST",
        headers: { authorization: `bearer ${Sign(Account.UserId)}`, "content-type": "application/json" },
        body: JSON.stringify({ progress_tracks: [{ progression_id: SEASON, progress: 99999 }], objectives: [] })
    });

    assert.equal(Response.status, 403);
    assert.equal(Tracks.GetDerivedProgress(Account.UserId, SEASON).totalPoints, 0);
});

// ---------------------------------------------------------------- reset

test("reset zeroes progress and lets ranks be earned again", () => {
    const Account = Harness.SeedAccount(Context);

    Writes.ApplyProgressAndObjectives(Account.UserId, [{ progression_id: SEASON, progress: 200 }], []);
    Writes.ConfirmRank(Account.UserId, Account.CharacterId, SEASON, 2, "free");

    Writes.ResetTrack(Account.UserId, SEASON);

    assert.equal(Tracks.GetDerivedProgress(Account.UserId, SEASON).totalPoints, 0);

    // A new generation gives a clean claim key space without deleting the old
    // rows, which would otherwise collide with the inventory replay ledger.
    Writes.ApplyProgressAndObjectives(Account.UserId, [{ progression_id: SEASON, progress: 200 }], []);
    const Result = Writes.ConfirmRank(Account.UserId, Account.CharacterId, SEASON, 2, "free");

    assert.deepEqual(Result.granted, [0, 1, 2], "ranks are claimable again after a reset");
});

test("the bounty board is served inside the code/message/payload envelope", async () => {
    const Account = Harness.SeedAccount(Context);

    Bounties.SaveBountiesForUser(Account.UserId, {
        bounties: [{ bounty_id: "Wire", slot_index: 0 }],
        draft_data: { current_draft_choices: [], previous_draft_selections: ["Wire"], bronze_count: 7, silver_count: 3, gold_count: 1 }
    });

    const Response = await fetch(`${BaseUrl}/bounty/${Account.UserId}`, {
        headers: { authorization: `bearer ${Sign(Account.UserId)}` }
    });
    const Body = await Response.json();

    // Served bare, the gameserver parsed nothing and posted back a board with
    // no history and zero counts. Served wrapped, it reads draft_data and keeps
    // the history - so the envelope is what this client expects.
    assert.equal(Response.status, 200);
    assert.equal(Body.message, "OK");
    assert.ok(Body.payload, "the board must sit inside payload");
    assert.equal(Body.bounties, undefined, "the board must not also be at the root");
    assert.equal(Body.payload.bounties[0].bounty_id, "Wire");
    assert.equal(Body.payload.draft_data.bronze_count, 7);

    // These two keys do not occur anywhere in the 1.4.4 executable.
    assert.equal(Body.payload.draft_data_daily, undefined);
    assert.equal(Body.payload.draft_data_weekly, undefined);
});

test("abandoning a bounty removes it instead of erroring", async () => {
    const Account = Harness.SeedAccount(Context);

    Bounties.SaveBountiesForUser(Account.UserId, {
        bounties: [
            { bounty_id: "Keep", slot_index: 0 },
            { bounty_id: "Abandon", slot_index: 1 }
        ]
    });

    // The runtime posts {"bounty_ids":[...]} to /bounty/delete/{account}. That
    // route did not exist, so abandoning answered 404 and the client showed
    // "An error occured. Please try again later."
    const Response = await fetch(`${BaseUrl}/bounty/delete/${Account.UserId}`, {
        method: "POST",
        headers: { authorization: `bearer ${Sign(Account.UserId)}`, "content-type": "application/json" },
        body: JSON.stringify({ bounty_ids: ["Abandon"] })
    });

    assert.equal(Response.status, 200);

    const Remaining = Bounties.GetBountiesForUser(Account.UserId).bounties;

    assert.equal(Remaining.length, 1);
    assert.equal(Remaining[0].bounty_id, "Keep");
});

test("abandoning an unknown bounty is harmless", async () => {
    const Account = Harness.SeedAccount(Context);

    Bounties.SaveBountiesForUser(Account.UserId, { bounties: [{ bounty_id: "Held", slot_index: 0 }] });

    const Response = await fetch(`${BaseUrl}/bounty/delete/${Account.UserId}`, {
        method: "POST",
        headers: { authorization: `bearer ${Sign(Account.UserId)}`, "content-type": "application/json" },
        body: JSON.stringify({ bounty_ids: ["NeverHeld"] })
    });

    assert.equal(Response.status, 200);
    assert.equal(Bounties.GetBountiesForUser(Account.UserId).bounties.length, 1);
});

test("a full board reset clears stored bounties instead of leaving ghosts", () => {
    const Account = Harness.SeedAccount(Context);

    Bounties.SaveBountiesForUser(Account.UserId, {
        bounties: [{ bounty_id: "Stale_A", slot_index: 2 }, { bounty_id: "Stale_B", slot_index: 3 }],
        draft_data: { current_draft_choices: [], previous_draft_selections: ["Stale_A", "Stale_B"], bronze_count: 7, silver_count: 2, gold_count: 1 }
    });

    // When ServerInitializeBounties resets a board and refunds its tokens, the
    // gameserver posts this. Treating it as "nothing new" left the reset
    // bounties stored, and once bounty_data enabled their ids they reappeared
    // on the next login as bounties the player had already been refunded for.
    Bounties.SaveBountiesForUser(Account.UserId, {
        bounties: [],
        draft_data: { current_draft_choices: [], previous_draft_selections: [], bronze_count: 0, silver_count: 0, gold_count: 0 }
    });

    assert.equal(Bounties.GetBountiesForUser(Account.UserId).bounties.length, 0, "a reset must clear the board");

    // Drafting afterwards builds the board back up from nothing.
    Bounties.SaveBountiesForUser(Account.UserId, {
        bounties: [{ bounty_id: "Fresh", slot_index: 0 }],
        draft_data: { current_draft_choices: [], previous_draft_selections: ["Fresh"], bronze_count: 8, silver_count: 3, gold_count: 1 }
    });

    const Board = Bounties.GetBountiesForUser(Account.UserId).bounties;

    assert.equal(Board.length, 1);
    assert.equal(Board[0].bounty_id, "Fresh");
});

// Reconstructed. GPT added two tests covering bounty game data; they were
// deleted by an over-broad edit and their original text could not be
// recovered. These cover the same contract.
test("bounty game data enables the 1.4.4 definitions instead of burning them on reload", async () => {
    const Account = Harness.SeedAccount(Context);

    const Response = await fetch(`${BaseUrl}/bounty/game-data`, {
        headers: { authorization: `bearer ${Sign(Account.UserId)}` }
    });
    const Body = await Response.json();

    const Definitions = Body.payload.bounty_data;

    // ServerInitializeBounties resets explicitly disabled definitions and
    // refunds their tokens. Missing definitions fall through to unlock checks.
    assert.equal(Response.status, 200);
    assert.ok(Array.isArray(Definitions) && Definitions.length > 0, "definitions must be served");

    for (const Definition of Definitions) {
        assert.equal(typeof Definition.bounty_id, "string");
        assert.equal(Definition.enabled, true, `${Definition.bounty_id} must be enabled or it is burned on load`);
        assert.ok(Number.isInteger(Definition.reward_amount) && Definition.reward_amount > 0);
    }
});

test("bounty definitions use exactly the fields the 1.4.4 serializer reads", async () => {
    const Account = Harness.SeedAccount(Context);

    const Response = await fetch(`${BaseUrl}/bounty/game-data`, {
        headers: { authorization: `bearer ${Sign(Account.UserId)}` }
    });
    const Definitions = (await Response.json()).payload.bounty_data;

    // The entry serializer at 0x1413f2d20 reads bounty_id, enabled and
    // reward_amount. An earlier attempt carried on_claim_grant_item_* fields
    // inferred from nearby strings and omitted enabled, which left the draft
    // pool empty ("only found 0 options").
    assert.deepEqual(Object.keys(Definitions[0]).sort(), ["bounty_id", "enabled", "reward_amount"]);

    // The ids the client actually drafted in play must all be present.
    const Ids = new Set(Definitions.map((Definition) => Definition.bounty_id));
    for (const Id of ["Bounty_Bronze_KillShockBlaze", "Bounty_Silver_HuntsASTwo", "Bounty_Bronze_PartDamageReduce"]) {
        assert.ok(Ids.has(Id), `${Id} was drafted in game and must have a definition`);
    }
});

// ------------------------------------------------------------- cooldowns

test("cooldowns persist, so the bounty token marker survives a login", async () => {
    const Account = Harness.SeedAccount(Context);
    const Auth = { authorization: `bearer ${Sign(Account.UserId)}`, "content-type": "application/json" };

    // The gameserver records when it last granted bounty tokens as a cooldown.
    // With these stubbed the marker was never found on login, every login was
    // treated as a new bounty season, and stored bounties were never recreated.
    const Put = await fetch(`${BaseUrl}/cooldown/batch/${Account.UserId}`, {
        method: "PUT", headers: Auth,
        body: JSON.stringify({ cooldowns: [{ cooldown_id: "BountyTokens", cooldown_started_date: "2026-09-21T13:38:13.654Z" }] })
    });
    assert.equal(Put.status, 200);

    const Got = await (await fetch(`${BaseUrl}/cooldown/${Account.UserId}`, { headers: Auth })).json();

    // Native OnQueryCooldownDataRequestComplete iterates payload as id -> date,
    // not the {cooldowns: [...]} DTO used to WRITE a batch. This distinction is
    // necessary for the persisted season marker to survive native parsing.
    assert.equal(Got.message, "OK");
    assert.deepEqual(Got.payload, { BountyTokens: "2026-09-21T13:38:13.654Z" });
});

test("a batch updates the cooldowns it names and keeps the rest", async () => {
    const Account = Harness.SeedAccount(Context);
    const Auth = { authorization: `bearer ${Sign(Account.UserId)}`, "content-type": "application/json" };
    const Batch = (Entries) => fetch(`${BaseUrl}/cooldown/batch/${Account.UserId}`, {
        method: "PUT", headers: Auth, body: JSON.stringify({ cooldowns: Entries })
    });

    await Batch([{ cooldown_id: "A", cooldown_started_date: "2026-01-01T00:00:00.000Z" },
                 { cooldown_id: "B", cooldown_started_date: "2026-01-01T00:00:00.000Z" }]);
    await Batch([{ cooldown_id: "A", cooldown_started_date: "2026-06-01T00:00:00.000Z" }]);

    const ById = (await (await fetch(`${BaseUrl}/cooldown/${Account.UserId}`, { headers: Auth })).json()).payload;

    assert.equal(ById.A, "2026-06-01T00:00:00.000Z", "a named cooldown is updated");
    assert.equal(ById.B, "2026-01-01T00:00:00.000Z", "an unnamed cooldown is kept");
});

test("the batch route is not swallowed by the start-cooldown route", async () => {
    const Account = Harness.SeedAccount(Context);
    const Auth = { authorization: `bearer ${Sign(Account.UserId)}`, "content-type": "application/json" };

    // /cooldown/batch/{acct} and /cooldown/{acct}/{id} are both three segments.
    // If start were registered first, this would store a cooldown called
    // "<account id>" under an account called "batch".
    await fetch(`${BaseUrl}/cooldown/batch/${Account.UserId}`, {
        method: "PUT", headers: Auth,
        body: JSON.stringify({ cooldowns: [{ cooldown_id: "Real", cooldown_started_date: "2026-01-01T00:00:00.000Z" }] })
    });

    const Got = (await (await fetch(`${BaseUrl}/cooldown/${Account.UserId}`, { headers: Auth })).json()).payload;

    assert.deepEqual(Object.keys(Got), ["Real"]);
});

test("starting a cooldown by id records it", async () => {
    const Account = Harness.SeedAccount(Context);
    const Auth = { authorization: `bearer ${Sign(Account.UserId)}`, "content-type": "application/json" };

    const Response = await fetch(`${BaseUrl}/cooldown/${Account.UserId}/DailyThing`, { method: "POST", headers: Auth, body: "{}" });

    assert.equal(Response.status, 200);
    const Got = (await Response.json()).payload;
    assert.deepEqual(Object.keys(Got), ["DailyThing"]);
    assert.ok(!Number.isNaN(Date.parse(Got.DailyThing)));
});
