"use strict";

// Escalation season storage. The world server owns the arithmetic and POSTs
// whole-season snapshots; these tests hold the backend to the native rules in
// research/escalation/PROTOCOL.md rather than to a shape we chose ourselves.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const Harness = require("./harness");

let Context, Server, BaseUrl, Sign, Config;
const GameKey = crypto.randomBytes(32).toString("hex");
const S1 = "ESC_SEASON_1";
const S2 = "ESC_SEASON_2";

before(async () => {
    const Keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(Keys.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
    process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(Keys.publicKey.export({ type: "spki", format: "pem" })).toString("base64");
    Context = Harness.CreateDisposableDatabase();
    Sign = require("../dist/controllers/auth").SignMetagameJWTForUid;
    Config = require("../dist/controllers/escalationConfig");
    Context.Db.insert(Context.Schema.gameserverapikeys).values({
        keyHash: crypto.createHash("sha256").update(GameKey).digest("hex")
    }).run();
    const App = require("express")();
    App.use(require("express").json());
    App.use(require("../dist/routes/escalation").escalationRouter);
    Server = await new Promise(resolve => { const S = App.listen(0, "127.0.0.1", () => resolve(S)); });
    BaseUrl = `http://127.0.0.1:${Server.address().port}`;
});

after(async () => {
    await new Promise(resolve => Server.close(resolve));
    Context.Db.$client.close();
    Context.Cleanup();
});

function PlayerHeaders(Account) {
    return { "content-type": "application/json", authorization: `bearer ${Sign(Account.UserId)}` };
}
function GameHeaders(Account) {
    return { "content-type": "application/json", "x-undaunted-gameserver-apikey": GameKey,
        ...(Account ? { authorization: `bearer ${Sign(Account.UserId)}` } : {}) };
}
async function Read(Account, Season = S1, Headers = PlayerHeaders(Account)) {
    const Response = await fetch(`${BaseUrl}/escalation/${Season}/${Account.UserId}`, { headers: Headers });
    return { status: Response.status, body: await Response.json() };
}
async function Write(Account, Snapshot, Season = S1, Headers = GameHeaders()) {
    const Response = await fetch(`${BaseUrl}/escalation/${Season}/${Account.UserId}`, {
        method: "POST", headers: Headers, body: JSON.stringify(Snapshot)
    });
    return { status: Response.status, body: await Response.json() };
}
function Snap(Fields = {}) {
    return { escalation_level: 0, next_level_xp: 0, talents_progress: [], unlock_progress: [], update_version: 1, ...Fields };
}
const Count = (Table, UserId) => Context.Db.$client.prepare(`select count(*) n from ${Table} where userId=?`).get(UserId).n;

// ------------------------------------------------------------- registry

test("the registry carries the client's five seasons with Frost disabled", () => {
    const Seasons = Config.GetAllEscalationSeasons();
    assert.deepEqual(Seasons.map(S => S.id), ["ESC_SEASON_1", "ESC_SEASON_2", "ESC_SEASON_3", "ESC_SEASON_4", "ESC_SEASON_5"]);
    assert.deepEqual(Seasons.map(S => S.enabled), [true, true, true, true, false]);
    for (const Season of Seasons) {
        assert.equal(Season.levels.length, 25);
        assert.deepEqual(Season.levels[0], { level: 1, requiredExperience: 500 });
        assert.equal(Season.talents.length, 18);
        assert.equal(Season.unlocks.length, 6);
    }
    assert.equal(Config.GetEscalationSeason("ESC_SEASON_9"), undefined, "unknown ids never fall back");
});

// ---------------------------------------------------------------- reads

test("a fresh account reads the native default for every season and no row is created", async () => {
    const A = Harness.SeedAccount(Context);
    for (const Season of Config.GetAllEscalationSeasons()) {
        const { status, body } = await Read(A, Season.id);
        assert.equal(status, 200);
        assert.equal(body.message, "OK");
        assert.deepEqual(body.payload, { escalation_level: 0, next_level_xp: 0, talents_progress: [], unlock_progress: [], update_version: 0 },
            "never the retired stub's 99999");
    }
    assert.equal(Count("escalationprogression", A.UserId), 0);
});

test("an unknown season reads as the empty default, never another season's data, and refuses writes", async () => {
    const A = Harness.SeedAccount(Context);
    assert.equal((await Write(A, Snap({ escalation_level: 1, next_level_xp: 10 }))).status, 200);
    const Unknown = await Read(A, "ESC_SEASON_9");
    assert.equal(Unknown.status, 200);
    assert.deepEqual(Unknown.body.payload, { escalation_level: 0, next_level_xp: 0, talents_progress: [], unlock_progress: [], update_version: 0 });
    assert.equal((await Write(A, Snap({ escalation_level: 1 }), "ESC_SEASON_9")).status, 404);
});

test("a player reads only their own season; a gameserver reads the named account", async () => {
    const A = Harness.SeedAccount(Context), B = Harness.SeedAccount(Context);
    assert.equal((await Write(A, Snap({ escalation_level: 1, next_level_xp: 10 }))).status, 200);
    const AsB = await fetch(`${BaseUrl}/escalation/${S1}/${A.UserId}`, { headers: PlayerHeaders(B) }).then(R => R.json());
    assert.equal(AsB.payload.escalation_level, 0, "B asking for A's account gets B's own state");
    const AsServer = await Read(A, S1, GameHeaders());
    assert.equal(AsServer.body.payload.escalation_level, 1);
});

// --------------------------------------------------------------- writes

test("only a gameserver may write, and a relayed token must match the account", async () => {
    const A = Harness.SeedAccount(Context), B = Harness.SeedAccount(Context);
    assert.equal((await Write(A, Snap({ escalation_level: 25 }), S1, PlayerHeaders(A))).status, 403);
    assert.equal((await Write(A, Snap(), S1, GameHeaders(B))).status, 403);
    assert.equal((await Write(A, Snap(), S1, GameHeaders(A))).status, 200);
    assert.equal(Count("escalationprogression", A.UserId), 1);
});

test("an accepted snapshot reads back identically, including from a new process", async () => {
    const A = Harness.SeedAccount(Context);
    const Snapshot = Snap({
        escalation_level: 6, next_level_xp: 250, update_version: 3,
        talents_progress: [{ rank: 2, talent_id: "ESC_TALENT_S1_TIER1_PASSIVE" }, { rank: 1, talent_id: "ESC_TALENT_S1_TIER1_UPGRADETWO" }],
        unlock_progress: [{ collected: true, reward_id: "ESC_Reward_3" }, { collected: false, reward_id: "ESC_Reward_2" }]
    });
    const Written = await Write(A, Snapshot);
    assert.equal(Written.status, 200);
    const Read1 = (await Read(A)).body.payload;
    assert.deepEqual(Written.body.payload, Read1);
    assert.equal(Read1.escalation_level, 6);
    assert.equal(Read1.next_level_xp, 250);
    assert.equal(Read1.update_version, 3);
    // Canonical: season order, uncollected unlocks omitted (unlocked-ness is derived natively).
    assert.deepEqual(Read1.talents_progress, [{ rank: 1, talent_id: "ESC_TALENT_S1_TIER1_UPGRADETWO" }, { rank: 2, talent_id: "ESC_TALENT_S1_TIER1_PASSIVE" }]);
    assert.deepEqual(Read1.unlock_progress, [{ collected: true, reward_id: "ESC_Reward_3" }]);

    const Restart = spawnSync(process.execPath, ["-e",
        "console.log(JSON.stringify(require('./dist/controllers/escalation').GetEscalationState(process.argv[1], process.argv[2])))",
        A.UserId, S1], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
    assert.equal(Restart.status, 0, Restart.stderr);
    assert.deepEqual(JSON.parse(Restart.stdout.trim().split(/\r?\n/).at(-1)), Read1);
});

test("an exact retry is a replay; a reused version with different content is refused", async () => {
    const A = Harness.SeedAccount(Context);
    const First = Snap({ escalation_level: 1, next_level_xp: 100, update_version: 1 });
    assert.equal((await Write(A, First)).status, 200);
    assert.equal((await Write(A, First)).status, 200);
    assert.equal(Count("escalationevents", A.UserId), 1, "a retry records nothing new");
    assert.equal((await Write(A, { ...First, next_level_xp: 120 })).status, 409);
    assert.equal((await Read(A)).body.payload.next_level_xp, 100);
});

test("stale and reordered saves cannot overwrite newer state", async () => {
    const A = Harness.SeedAccount(Context);
    assert.equal((await Write(A, Snap({ escalation_level: 2, next_level_xp: 50, update_version: 5 }))).status, 200);
    assert.equal((await Write(A, Snap({ escalation_level: 1, next_level_xp: 0, update_version: 4 }))).status, 409);
    assert.equal((await Write(A, Snap({ escalation_level: 1, next_level_xp: 0, update_version: 6 }))).status, 409,
        "a newer version still may not lower progress");
    assert.equal((await Write(A, Snap({ escalation_level: 2, next_level_xp: 10, update_version: 7 }))).status, 409);
    const State = (await Read(A)).body.payload;
    assert.deepEqual([State.escalation_level, State.next_level_xp, State.update_version], [2, 50, 5]);
});

test("a talent reset lowers ranks and keeps level, XP and collections", async () => {
    const A = Harness.SeedAccount(Context);
    const Talents = [{ rank: 3, talent_id: "ESC_TALENT_S1_TIER1_PASSIVE" }];
    const Unlocks = [{ collected: true, reward_id: "ESC_Reward_3" }];
    assert.equal((await Write(A, Snap({ escalation_level: 5, update_version: 1, talents_progress: Talents, unlock_progress: Unlocks }))).status, 200);
    assert.equal((await Write(A, Snap({ escalation_level: 5, update_version: 2, talents_progress: [], unlock_progress: Unlocks }))).status, 200);
    const State = (await Read(A)).body.payload;
    assert.deepEqual(State.talents_progress, []);
    assert.equal(State.escalation_level, 5);
    assert.deepEqual(State.unlock_progress, Unlocks);
});

test("XP follows native level arithmetic: below the next cost, unbounded only at the cap", async () => {
    const A = Harness.SeedAccount(Context);
    assert.equal((await Write(A, Snap({ escalation_level: 0, next_level_xp: 500 }))).status, 400, "500 XP at level 0 is level 1");
    assert.equal((await Write(A, Snap({ escalation_level: 0, next_level_xp: 499 }))).status, 200);
    assert.equal((await Write(A, Snap({ escalation_level: 26, update_version: 2 }))).status, 400);
    assert.equal((await Write(A, Snap({ escalation_level: -1, update_version: 2 }))).status, 400);
    assert.equal((await Write(A, Snap({ escalation_level: 25, next_level_xp: 123456, update_version: 2 }))).status, 200);
    assert.equal((await Write(A, Snap({ escalation_level: 25, next_level_xp: 2 ** 31, update_version: 3 }))).status, 400, "int32 limit");
});

test("talents are limited to one point per level, known ids and their max rank", async () => {
    const A = Harness.SeedAccount(Context);
    const Over = [{ rank: 3, talent_id: "ESC_TALENT_S1_TIER1_PASSIVE" }, { rank: 1, talent_id: "ESC_TALENT_S1_TIER1_UPGRADETWO" }];
    assert.equal((await Write(A, Snap({ escalation_level: 3, talents_progress: Over }))).status, 400);
    assert.equal((await Write(A, Snap({ escalation_level: 4, talents_progress: Over }))).status, 200);
    assert.equal((await Write(A, Snap({ escalation_level: 25, update_version: 2, talents_progress: [{ rank: 4, talent_id: "ESC_TALENT_S1_TIER1_PASSIVE" }] }))).status, 400);
    assert.equal((await Write(A, Snap({ escalation_level: 25, update_version: 2, talents_progress: [{ rank: 1, talent_id: "ESC_TALENT_S2_TIER1_PASSIVE" }] }))).status, 400,
        "another season's talent");
    assert.equal((await Write(A, Snap({ escalation_level: 25, update_version: 2,
        talents_progress: [{ rank: 1, talent_id: "ESC_TALENT_S1_TIER1_PASSIVE" }, { rank: 1, talent_id: "ESC_TALENT_S1_TIER1_PASSIVE" }] }))).status, 400);
});

test("a talent tier needs its PointsToUnlock spent in earlier tiers, as SharedUpgradeTalent requires", async () => {
    const A = Harness.SeedAccount(Context);
    // TIER2 talents have PointsToUnlock 4.
    const Tier2 = { rank: 1, talent_id: "ESC_TALENT_S1_TIER2_PASSIVE" };
    assert.equal((await Write(A, Snap({ escalation_level: 1, talents_progress: [Tier2] }))).status, 400,
        "a level 1 player cannot hold a tier 2 talent");
    assert.equal((await Write(A, Snap({ escalation_level: 25, talents_progress: [Tier2,
        { rank: 3, talent_id: "ESC_TALENT_S1_TIER1_PASSIVE" }] }))).status, 400, "3 tier-1 points do not open tier 2");
    assert.equal((await Write(A, Snap({ escalation_level: 25, talents_progress: [Tier2,
        { rank: 2, talent_id: "ESC_TALENT_S1_TIER2_UPGRADEONE" }, { rank: 1, talent_id: "ESC_TALENT_S1_TIER2_UPGRADETWO" }] }))).status, 400,
        "a tier cannot pay for its own gate");
    assert.equal((await Write(A, Snap({ escalation_level: 5, talents_progress: [Tier2,
        { rank: 3, talent_id: "ESC_TALENT_S1_TIER1_PASSIVE" }, { rank: 1, talent_id: "ESC_TALENT_S1_TIER1_UPGRADETWO" }] }))).status, 200);
});

test("a collection needs its unlock level and can never be undone", async () => {
    const A = Harness.SeedAccount(Context);
    const Collect = (Level, Version, Ids) => Write(A, Snap({ escalation_level: Level, update_version: Version,
        unlock_progress: Ids.map(Id => ({ collected: true, reward_id: Id })) }));
    assert.equal((await Collect(4, 1, ["ESC_Reward_3"])).status, 400, "ESC_Reward_3 unlocks at level 5");
    assert.equal((await Collect(5, 1, ["ESC_Reward_3"])).status, 200);
    const CollectedAt = Context.Db.$client.prepare("select collectedAt from escalationunlocks where userId=?").get(A.UserId).collectedAt;
    assert.equal((await Collect(8, 2, ["ESC_Reward_3", "ESC_Reward_2"])).status, 200);
    assert.equal((await Collect(9, 3, ["ESC_Reward_2"])).status, 409, "ESC_Reward_3 may not be un-collected");
    assert.equal(Context.Db.$client.prepare("select collectedAt from escalationunlocks where userId=? and unlockId='ESC_Reward_3'").get(A.UserId).collectedAt,
        CollectedAt, "the original collection time is kept");
    assert.equal((await Write(A, Snap({ update_version: 9, unlock_progress: [{ collected: true, reward_id: "ESC_Reward_404" }] }))).status, 400);
});

test("seasons and accounts are isolated", async () => {
    const A = Harness.SeedAccount(Context), B = Harness.SeedAccount(Context);
    assert.equal((await Write(A, Snap({ escalation_level: 7 }), S1)).status, 200);
    assert.equal((await Write(A, Snap({ escalation_level: 3 }), S2)).status, 200, "version 1 is independent per season");
    assert.equal((await Write(B, Snap({ escalation_level: 1 }), S1)).status, 200, "and per account");
    assert.equal((await Read(A, S1)).body.payload.escalation_level, 7);
    assert.equal((await Read(A, S2)).body.payload.escalation_level, 3);
    assert.equal((await Read(B, S1)).body.payload.escalation_level, 1);
    assert.equal((await Read(B, S2)).body.payload.escalation_level, 0);
});

test("the disabled Frost season reads normally but refuses writes", async () => {
    const A = Harness.SeedAccount(Context);
    assert.equal((await Read(A, "ESC_SEASON_5")).status, 200);
    assert.equal((await Write(A, Snap(), "ESC_SEASON_5")).status, 409);
});

test("a world server still holding the retired stub values cannot write them", async () => {
    const A = Harness.SeedAccount(Context);
    // The stub sent level 99999 (clamped natively to 25), xp 99999, version 1.
    assert.equal((await Write(A, Snap({ escalation_level: 25, next_level_xp: 99999, update_version: 2 }))).status, 409);
    assert.equal(Count("escalationprogression", A.UserId), 0);
});

test("malformed snapshots are refused without writing anything", async () => {
    const A = Harness.SeedAccount(Context);
    for (const Bad of [[], Snap({ update_version: 0 }), Snap({ talents_progress: null }), Snap({ unlock_progress: [{ reward_id: "ESC_Reward_2" }] }),
        Snap({ next_level_xp: 1.5 }), Snap({ escalation_level: "3" })]) {
        assert.equal((await Write(A, Bad)).status, 400, JSON.stringify(Bad));
    }
    assert.equal(Count("escalationprogression", A.UserId), 0);
    assert.equal(Count("escalationevents", A.UserId), 0);
});
