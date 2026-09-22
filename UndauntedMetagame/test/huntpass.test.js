"use strict";

// Hunt Pass phase 1: configuration, rank derivation, the account-scoped read
// path, and the route ordering that the read path depends on.
//
// Route shadowing is the reason several of these are HTTP tests rather than
// controller tests: Express matches in registration order, so a mistake there
// misroutes silently instead of failing.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const Harness = require("./harness");

let Context;
let HuntPass;
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

    HuntPass = require("../dist/controllers/huntpass");
    Tracks = require("../dist/controllers/progressionTracks");
    Sign = require("../dist/controllers/auth").SignMetagameJWTForUid;

    const express = require("express");
    const App = express();
    App.use(express.json());
    App.use(require("../dist/routes/progression").progressionRouter);

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

function Get(Path, UserId) {
    return fetch(`${BaseUrl}${Path}`, { headers: { authorization: `bearer ${Sign(UserId)}` } });
}

function SetPoints(UserId, TrackId, TotalPoints) {
    Context.Db.insert(Context.Schema.progression).values({
        userId: UserId, trackId: TrackId, generation: 0,
        totalPoints: TotalPoints, confirmedRank: 0, confirmedPremiumRank: 0,
        updatedAt: Date.now()
    }).run();
}

// ------------------------------------------------------------ configuration

test("the active season is loaded and is a known track", () => {
    const Active = HuntPass.GetActiveHuntPassId();

    assert.equal(Active, SEASON);
    assert.ok(HuntPass.GetTrackConfig(Active), "the active season must exist in the loaded config");
});

test("the config payload carries the season and the mastery tracks", () => {
    const Paths = HuntPass.GetProgressionConfigPayload().payload.paths;

    assert.ok(Paths.length >= 10, "season plus nine mastery tracks");
    assert.ok(Paths.some((Path) => Path.progression_id === SEASON));
    assert.ok(Paths.some((Path) => Path.progression_id === "MasteryTrack_PlayerLevel"));
});

test("the premium gate is read from config, not hardcoded", () => {
    assert.equal(HuntPass.GetPremiumGatingEntitlement(SEASON), "season09b_premium");
    assert.equal(HuntPass.GetPremiumGatingEntitlement("MasteryTrack_Behemoth"), undefined,
        "an empty gate means no premium tier, not a gate named empty string");
});

// -------------------------------------------------------- rank derivation

test("requirements are per-rank xp, not cumulative", () => {
    // season09b charges 100 for each of ranks 1..50. If these were read as
    // cumulative thresholds, 100 points would buy every rank at once.
    assert.equal(HuntPass.DeriveRank(SEASON, 0).rank, 0);
    assert.equal(HuntPass.DeriveRank(SEASON, 100).rank, 1);
    assert.equal(HuntPass.DeriveRank(SEASON, 250).rank, 2);
    assert.equal(HuntPass.DeriveRank(SEASON, 500).rank, 5);
});

test("rank points are the remainder within the current rank", () => {
    const Derived = HuntPass.DeriveRank(SEASON, 250);

    assert.equal(Derived.rank, 2);
    assert.equal(Derived.rankPoints, 50);
});

test("rank is clamped to the configured maximum", () => {
    const Derived = HuntPass.DeriveRank(SEASON, 99999999);

    assert.equal(Derived.rank, Derived.maxRank);
    assert.equal(Derived.maxRank, 50);
});

test("a rank costing zero xp is reached immediately", () => {
    // MasteryTrack_PlayerLevel has rank_id 1 at xp_required 0 - a real case in
    // the shipped config, and one an off-by-one would get wrong.
    assert.equal(HuntPass.DeriveRank("MasteryTrack_PlayerLevel", 0).rank >= 1, true);
});

test("negative or nonsense point totals do not produce a negative rank", () => {
    assert.equal(HuntPass.DeriveRank(SEASON, -500).rank, 0);
    assert.equal(HuntPass.DeriveRank(SEASON, Number.NaN).rank, 0);
});

test("an unknown track derives nothing rather than throwing", () => {
    assert.equal(HuntPass.DeriveRank("NotATrack", 1000).rank, 0);
});

// ------------------------------------------------------------- read path

test("a player with no progression reads as rank zero, and no row is created", () => {
    const Account = Harness.SeedAccount(Context);

    const State = Tracks.GetTrackState(Account.UserId, SEASON);

    assert.equal(State.totalPoints, 0);
    assert.equal(State.confirmedRank, 0);

    const Rows = Context.Db.select().from(Context.Schema.progression).all();

    assert.equal(Rows.length, 0, "a read must not fabricate progression rows");
});

test("stored points drive the derived rank", () => {
    const Account = Harness.SeedAccount(Context);
    SetPoints(Account.UserId, SEASON, 1000);

    const Derived = Tracks.GetDerivedProgress(Account.UserId, SEASON);

    assert.equal(Derived.rank, 10);
    assert.equal(Derived.totalPoints, 1000);
});

test("the wire track uses the field names the client parses", () => {
    const Account = Harness.SeedAccount(Context);

    const Wire = Tracks.GetWireTrack(Account.UserId, SEASON);

    // "fremium" is the original Phoenix spelling, not a typo to fix.
    assert.deepEqual(Object.keys(Wire).sort(), [
        "confirmed_date", "confirmed_fremium_rank", "confirmed_premium_rank",
        "phx_account_id", "progress", "progression_id"
    ]);
    assert.equal(Wire.progression_id, SEASON);
    assert.ok(!Number.isNaN(Date.parse(Wire.confirmed_date)));
});

// --------------------------------------------------------- premium gating

test("premium is withheld without the entitlement and released with it", () => {
    const Account = Harness.SeedAccount(Context);

    assert.equal(Tracks.HasPremiumForTrack(Account.UserId, SEASON), false);

    Context.Db.insert(Context.Schema.entitlements).values({
        userId: Account.UserId, entitlement: "season09b_premium",
        duration: 0, activatedAt: Date.now(), source: "test"
    }).run();

    assert.equal(Tracks.HasPremiumForTrack(Account.UserId, SEASON), true);
});

test("a track with no gate has no premium tier to unlock", () => {
    const Account = Harness.SeedAccount(Context);

    assert.equal(Tracks.HasPremiumForTrack(Account.UserId, "MasteryTrack_Behemoth"), false);
});

// ---------------------------------------------------------- route ordering

test("GET /progression/config is not shadowed by /progression/:userId", async () => {
    const Account = Harness.SeedAccount(Context);

    const Response = await Get("/progression/config", Account.UserId);
    const Body = await Response.json();

    assert.equal(Response.status, 200);
    assert.ok(Array.isArray(Body.payload?.paths), "config must return paths, not a progression track");
});

test("GET /progression/objectives/:userId is not bound as a track lookup", async () => {
    const Account = Harness.SeedAccount(Context);

    const Response = await Get(`/progression/objectives/${Account.UserId}`, Account.UserId);
    const Body = await Response.json();

    assert.equal(Response.status, 200);
    // If /progression/:userId/:trackId had matched first, userId would be
    // "objectives" and this would be a track payload instead.
    assert.deepEqual(Body.payload, []);
});

test("GET /progression/:userId/:trackId answers instead of 404", async () => {
    const Account = Harness.SeedAccount(Context);
    SetPoints(Account.UserId, SEASON, 300);

    // This is the endpoint the runtime calls as FindProgressionTrackEndpoint.
    // Before this change it returned 404 for every request.
    const Response = await Get(`/progression/${Account.UserId}/${SEASON}`, Account.UserId);
    const Body = await Response.json();

    assert.equal(Response.status, 200);
    assert.equal(Body.payload.progression_id, SEASON);
    assert.equal(Body.payload.progress, 300);
});

test("an unknown track is still a 404", async () => {
    const Account = Harness.SeedAccount(Context);

    const Response = await Get(`/progression/${Account.UserId}/NotATrack`, Account.UserId);

    assert.equal(Response.status, 404);
});

test("the progression list carries the hunt pass track plus the masteries", async () => {
    const Account = Harness.SeedAccount(Context);
    SetPoints(Account.UserId, SEASON, 700);

    const Response = await Get(`/progression/${Account.UserId}`, Account.UserId);
    const Body = await Response.json();

    const Season = Body.payload.find((Track) => Track.progression_id === SEASON);

    assert.equal(Season.progress, 700, "the season comes from the database");

    // A fresh account has no mastery points; all routes use persisted values.
    const Mastery = Body.payload.find((Track) => Track.progression_id === "MasteryTrack_Behemoth");

    assert.equal(Mastery.progress, 0);
    assert.equal(Mastery.confirmed_fremium_rank, 0);
});
