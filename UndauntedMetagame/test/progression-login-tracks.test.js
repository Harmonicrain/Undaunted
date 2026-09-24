"use strict";
// The progression read the client makes on login must carry the 1.12.0
// ExperienceTrack_* and PrestigeTrack_* tracks, not only MasteryTrack_*;
// without them the weapon XP bar showed 0 in every newly loaded world.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Harness = require("./harness");
let Context, Server, BaseUrl, Sign, SeasonsDir;

const Ranks = (...Costs) => Costs.map((Cost, Index) => ({ rank_id: Index + 1, xp_required: Cost }));

before(async () => {
    SeasonsDir = fs.mkdtempSync(path.join(os.tmpdir(), "login-tracks-"));
    fs.writeFileSync(path.join(SeasonsDir, "tracks.json"), JSON.stringify([
        { progression_id: "ExperienceTrack_Weapon_Sword", requirements: Ranks(0, 350, 500), free_rewards: [], premium_rewards: [] },
        { progression_id: "PrestigeTrack_Weapon_Sword", requirements: [{ rank_id: 0, xp_required: 0 }], free_rewards: [], premium_rewards: [] }
    ]));
    process.env.HUNT_PASS_SEASONS_DIR = SeasonsDir;

    const Keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(Keys.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
    process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(Keys.publicKey.export({ type: "spki", format: "pem" })).toString("base64");
    Context = Harness.CreateDisposableDatabase();
    Sign = require("../dist/controllers/auth").SignMetagameJWTForUid;
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
    fs.rmSync(SeasonsDir, { recursive: true, force: true });
});

test("login progression includes weapon XP and prestige tracks with their stored totals", async () => {
    const Account = Harness.SeedAccount(Context);
    Context.Db.insert(Context.Schema.progression).values({
        userId: Account.UserId, trackId: "ExperienceTrack_Weapon_Sword", totalPoints: 505, updatedAt: Date.now()
    }).run();

    const Response = await fetch(`${BaseUrl}/progression/${Account.UserId}`, { headers: { authorization: `bearer ${Sign(Account.UserId)}` } });
    assert.equal(Response.status, 200);
    const Tracks = (await Response.json()).payload;
    const ById = new Map(Tracks.map(Track => [Track.progression_id, Track]));

    assert.equal(ById.get("ExperienceTrack_Weapon_Sword")?.progress, 505);
    assert.equal(ById.get("PrestigeTrack_Weapon_Sword")?.progress, 0);
    assert.ok([...ById.keys()].some(Id => Id.startsWith("MasteryTrack_")), "mastery tracks are still included");
});
