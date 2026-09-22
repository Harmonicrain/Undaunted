"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const Harness = require("./harness");
let Context, Writes, Tracks, Config, Rewards, Server, BaseUrl, Sign;
const GameKey = crypto.randomBytes(32).toString("hex");
const Player = "MasteryTrack_PlayerLevel";
const Behemoth = "MasteryTrack_Behemoth";
const Sword = "MasteryTrack_Weapon_Sword";

before(async () => {
    const Keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(Keys.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
    process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(Keys.publicKey.export({ type: "spki", format: "pem" })).toString("base64");
    Context = Harness.CreateDisposableDatabase();
    Writes = require("../dist/controllers/progressionWrites");
    Tracks = require("../dist/controllers/progressionTracks");
    Config = require("../dist/controllers/huntpass");
    Rewards = require("../dist/controllers/huntpassRewards");
    Sign = require("../dist/controllers/auth").SignMetagameJWTForUid;
    Context.Db.insert(Context.Schema.gameserverapikeys).values({
        keyHash: crypto.createHash("sha256").update(GameKey).digest("hex")
    }).run();
    const App = require("express")();
    App.use(require("express").json());
    App.use(require("../dist/routes/progression").progressionRouter);
    Server = await new Promise(resolve => { const S = App.listen(0, "127.0.0.1", () => resolve(S)); });
    BaseUrl = `http://127.0.0.1:${Server.address().port}`;
});

after(async () => {
    await new Promise(resolve => Server.close(resolve));
    Context.Db.$client.close();
    Context.Cleanup();
});

function Headers(Account, Gameserver = false) {
    return { "content-type": "application/json", authorization: `bearer ${Sign(Account.UserId)}`,
        ...(Gameserver ? { "x-undaunted-gameserver-apikey": GameKey } : {}) };
}
async function Get(Path, Account) {
    const Response = await fetch(BaseUrl + Path, { headers: Headers(Account) });
    assert.equal(Response.status, 200);
    return (await Response.json()).payload;
}

test("fresh accounts start at Slayer 1 with zero weapon and behemoth mastery", async () => {
    const A = Harness.SeedAccount(Context);
    assert.equal(Tracks.GetDerivedProgress(A.UserId, Player).rank, 1);
    const All = await Get(`/progression/${A.UserId}`, A);
    const Masteries = All.filter(t => t.progression_id.startsWith("MasteryTrack_"));
    assert.equal(Masteries.length, 9);
    for (const T of Masteries) {
        assert.equal(T.progress, 0);
        assert.equal(T.confirmed_fremium_rank, 0);
        if (T.progression_id !== Player) assert.equal(Config.DeriveRank(T.progression_id, 0).rank, 0);
    }
    assert.equal(Context.Db.$client.prepare("select count(*) n from progression where userId=?").get(A.UserId).n, 0,
        "read endpoints do not create or max accounts");
});

test("each mastery track uses its configured thresholds and cap", () => {
    for (const Id of Config.GetAllTrackIds().filter(id => id.startsWith("MasteryTrack_"))) {
        const Requirements = Config.GetTrackConfig(Id).requirements;
        let Total = 0;
        for (const R of Requirements) {
            Total += R.xp_required;
            if (R.xp_required > 0) assert.equal(Config.DeriveRank(Id, Total - 1).rank, R.rank_id - 1);
            // Player ranks 0/1 share the zero-point threshold.
            assert.ok(Config.DeriveRank(Id, Total).rank >= R.rank_id);
        }
        assert.equal(Config.DeriveRank(Id, Total + 1000).rank, Id.includes("Weapon") ? 20 : 50);
    }
});

test("native mastery awards persist identically through list, objectives and single-track reads", async () => {
    const A = Harness.SeedAccount(Context);
    const Body = { progress_tracks: [{ progression_id: Player, progress: 2 }, { progression_id: Sword, progress: 2 }],
        objectives: [{ objective_id: "MasteryObjective_Sword_Craft", value: 1, completed_count: 1 }] };
    const Response = await fetch(`${BaseUrl}/progression/${A.UserId}`, {
        method: "POST", headers: Headers(A, true), body: JSON.stringify(Body)
    });
    assert.equal(Response.status, 200);
    const All = await Get(`/progression/${A.UserId}`, A);
    const Objectives = await Get(`/progression/objectives/${A.UserId}`, A);
    const Single = await Get(`/progression/${A.UserId}/${Sword}`, A);
    assert.deepEqual(Single, All.find(t => t.progression_id === Sword));
    assert.ok(Array.isArray(Objectives), "FindObjectivesEndpoint requires payload to be an array");
    assert.equal(Objectives[0].objective_id, Body.objectives[0].objective_id);
    assert.equal(Objectives[0].progress, 1);
    assert.equal(Objectives[0].completed_count, 1);
    assert.equal(Single.progress, 2);
    assert.equal(Tracks.GetDerivedProgress(A.UserId, Sword).rank, 1);
    // A new process opens the same SQLite file after the HTTP write.
    const Restart = spawnSync(process.execPath, ["-e", `
        const t=require('./dist/controllers/progressionTracks');
        const w=require('./dist/controllers/progressionWrites');
        console.log(JSON.stringify({track:t.GetWireTrack(process.argv[1], process.argv[2]), objectives:w.GetObjectivesForUser(process.argv[1])}));
    `, A.UserId, Sword], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
    assert.equal(Restart.status, 0, Restart.stderr);
    const Reloaded = JSON.parse(Restart.stdout.trim().split(/\r?\n/).at(-1));
    assert.deepEqual(Reloaded.track, Single);
    assert.deepEqual(Reloaded.objectives, Objectives);
    assert.equal(Reloaded.objectives[0].progress, 1);
});

test("replaying an objective-backed mastery award cannot credit its points twice", () => {
    const A = Harness.SeedAccount(Context);
    const Award = [{ progression_id: Sword, progress: 2 }];
    const Objective = [{ objective_id: "CraftSword", value: 1, completed_count: 1 }];
    Writes.ApplyProgressAndObjectives(A.UserId, Award, Objective);
    Writes.ApplyProgressAndObjectives(A.UserId, Award, Objective);
    assert.equal(Tracks.GetTrackState(A.UserId, Sword).totalPoints, 2);
    Writes.ApplyProgressAndObjectives(A.UserId, Award, [{ objective_id: "CraftSword", value: 2, completed_count: 2 }]);
    assert.equal(Tracks.GetTrackState(A.UserId, Sword).totalPoints, 4);
});

test("gameserver-only objective reads hydrate the named account without leaking another account", async () => {
    const A = Harness.SeedAccount(Context), B = Harness.SeedAccount(Context);
    Writes.ApplyProgressAndObjectives(A.UserId, [{ progression_id: Sword, progress: 2 }],
        [{ objective_id: "CraftSword", value: 1, completed_count: 1 }]);
    const Response = await fetch(`${BaseUrl}/progression/objectives/${A.UserId}`, {
        headers: { "x-undaunted-gameserver-apikey": GameKey }
    });
    assert.equal(Response.status, 200);
    const Payload = (await Response.json()).payload;
    assert.ok(Array.isArray(Payload));
    assert.equal(Payload[0].phx_account_id, A.UserId);
    assert.equal(Payload[0].progress, 1);
    assert.equal(Payload[0].completed_count, 1);
    const Other = await Get(`/progression/objectives/${A.UserId}`, B);
    assert.deepEqual(Other, []);
});

test("repeat objectives reset their value only on a newer completion cycle", () => {
    const A = Harness.SeedAccount(Context);
    const Write = (value, completed_count) => Writes.ApplyProgressAndObjectives(A.UserId, [], [{ objective_id: "Repeat", value, completed_count }]);
    Write(100, 1); Write(0, 2); Write(100, 1); Write(5, 2); Write(2, 2);
    const O = Writes.GetObjectiveForUser(A.UserId, "Repeat");
    assert.equal(O.progress, 5);
    assert.equal(O.completed_count, 2);
});

test("native confirm/public pays mastery Rams into the spendable inventory exactly once", async () => {
    for (const A of [Harness.SeedAccount(Context), Harness.SeedAccount(Context)]) {
        Writes.ApplyProgressAndObjectives(A.UserId, [{ progression_id: Sword, progress: 6 }], []);
        const Endpoint = `${BaseUrl}/progression/${A.UserId}/${Sword}/3/confirm/public`;
        for (let i = 0; i < 2; i++) {
            const R = await fetch(Endpoint, { method: "POST", headers: Headers(A, true) });
            assert.equal(R.status, 200);
            assert.equal((await R.json()).payload.confirmed_fremium_rank, 3);
        }
        const Held = Harness.ReadInventory(Context, A.CharacterId);
        assert.equal(Harness.StackedQuantity(Held, "CURRENCY_NOTES"), 500);
        assert.equal(Harness.StackedQuantity(Held, "Container_Core_Weaponsmith_Bronze"), 1);
        assert.equal(Context.Db.$client.prepare("select count(*) n from progressionclaims where userId=?").get(A.UserId).n, 4);
    }
});

test("failed reward delivery rolls back claims, items and confirmation together", () => {
    const A = Harness.SeedAccount(Context);
    Writes.ApplyProgressAndObjectives(A.UserId, [{ progression_id: Sword, progress: 6 }], []);
    Context.Db.$client.exec(`CREATE TEMP TRIGGER fail_mastery_confirmation BEFORE UPDATE OF confirmedRank ON progression
        WHEN NEW.confirmedRank > 0 BEGIN SELECT RAISE(ABORT, 'simulated cursor failure'); END`);
    try {
        assert.throws(() => Writes.ConfirmRank(A.UserId, A.CharacterId, Sword, 3, "free"), /simulated cursor failure/);
        assert.equal(Tracks.GetTrackState(A.UserId, Sword).confirmedRank, 0);
        assert.equal(Harness.ReadInventory(Context, A.CharacterId).stackedItems.length, 0);
        assert.equal(Context.Db.$client.prepare("select count(*) n from progressionclaims where userId=?").get(A.UserId).n, 0);
    } finally { Context.Db.$client.exec("DROP TRIGGER fail_mastery_confirmation"); }
    Writes.ConfirmRank(A.UserId, A.CharacterId, Sword, 3, "free");
    assert.equal(Tracks.GetTrackState(A.UserId, Sword).confirmedRank, 3);
});

test("zero-quantity rewards in the shipped config do not block PlayerLevel confirmation", () => {
    // PlayerLevel ranks 6, 8 and 10 list a Slayer core with quantity 0. That
    // used to fail the whole claim with a 500, so the live account could not
    // confirm rank 13 and the gameserver retried it on every login.
    const A = Harness.SeedAccount(Context);
    Writes.ApplyProgressAndObjectives(A.UserId, [{ progression_id: Player, progress: 62 }], []);
    const Earned = Tracks.GetDerivedProgress(A.UserId, Player).rank;
    assert.ok(Earned >= 10, `expected to reach past rank 10, reached ${Earned}`);

    const Result = Writes.ConfirmRank(A.UserId, A.CharacterId, Player, Earned, "free");

    assert.equal(Result.confirmedRank, Earned);
    for (const Rank of [6, 8, 10]) assert.ok(Result.granted.includes(Rank), `rank ${Rank} should be claimed`);
    const Held = Harness.ReadInventory(Context, A.CharacterId);
    assert.ok(!Held.stackedItems.some(Stack => Stack.quantity === 0), "a zero-quantity reward must not create an empty stack");
});

test("unearned claims and player-authenticated XP awards remain blocked", async () => {
    const A = Harness.SeedAccount(Context);
    assert.throws(() => Rewards.ClaimRanksUpTo(A.UserId, A.CharacterId, Sword, 20, "free"), e => e.status === 400);
    const R = await fetch(`${BaseUrl}/progression/${A.UserId}`, { method: "POST", headers: Headers(A),
        body: JSON.stringify({ progress_tracks: [{ progression_id: Sword, progress: 999 }] }) });
    assert.equal(R.status, 403);
    assert.equal(Tracks.GetTrackState(A.UserId, Sword).totalPoints, 0);
});

test("malformed batches roll back all progress and objective writes", () => {
    const A = Harness.SeedAccount(Context);
    assert.throws(() => Writes.ApplyProgressAndObjectives(A.UserId, [{ progression_id: Sword, progress: 2 }],
        [{ objective_id: "Valid", value: 1, completed_count: 0 }, { objective_id: "Bad", value: -1, completed_count: 0 }]), e => e.status === 400);
    assert.equal(Tracks.GetTrackState(A.UserId, Sword).totalPoints, 0);
    assert.equal(Writes.GetObjectivesForUser(A.UserId).length, 0);
    for (const Bad of [{ progression_id: 42, progress: 1 }, { progression_id: Sword, progress: 1.5 },
        { progression_id: Sword, progress: -1 }, { progression_id: Sword, progress: 2147483648 }]) {
        assert.throws(() => Writes.ApplyProgressAndObjectives(A.UserId, [Bad],
            [{ objective_id: "Valid", value: 1, completed_count: 0 }]), e => e.status === 400);
        assert.equal(Writes.GetObjectivesForUser(A.UserId).length, 0);
    }
});
