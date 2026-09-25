"use strict";
// The Escalation registry must be the served client's. The bundled one is
// 1.4.4's, where Frost is disabled and Radiant (ESC_SEASON_6) does not exist,
// so every 1.12.0 snapshot for those seasons was refused. The season below is
// synthetic.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Harness = require("./harness");

let Context, Escalation, Config, Dir;

const Radiant = {
    id: "ESC_SEASON_6", context: "Radiant", displayName: "Radiant Escalation", enabled: true,
    persistentPowerPerLevel: 4,
    levels: [{ level: 1, requiredExperience: 500 }, { level: 2, requiredExperience: 600 }],
    talentsTable: "escalation_talents_S6",
    talents: [{ id: "ESC_TALENT_TEST_TIER1", name: null, type: "Special", pointsToUnlock: 0, rankCosts: [1] }],
    unlocks: [{ id: "ESC_Reward_Test", unlockLevel: 1, rewardType: "ItemGrant", title: null, items: [{ catalogId: "CURRENCY_PJM_WEAPON", quantity: 100 }] }]
};

before(() => {
    Dir = fs.mkdtempSync(path.join(os.tmpdir(), "escalation-registry-"));
    const File = path.join(Dir, "seasons.json");
    fs.writeFileSync(File, JSON.stringify({ revision: "cl-test-registry", seasons: [Radiant] }));
    process.env.ESCALATION_SEASONS_FILE = File;
    Context = Harness.CreateDisposableDatabase();
    Config = require("../dist/controllers/escalationConfig");
    Escalation = require("../dist/controllers/escalation");
});
after(() => {
    delete process.env.ESCALATION_SEASONS_FILE;
    Context.Db.$client.close();
    Context.Cleanup();
    fs.rmSync(Dir, { recursive: true, force: true });
});

test("a registry from ESCALATION_SEASONS_FILE replaces the bundled 1.4.4 one", () => {
    assert.equal(Config.ESCALATION_CONTENT_REVISION, "cl-test-registry");
    assert.equal(Config.GetEscalationSeason("ESC_SEASON_6").context, "Radiant");
    // Only that registry's seasons exist: nothing falls back to 1.4.4's.
    assert.equal(Config.GetEscalationSeason("ESC_SEASON_1"), undefined);
});

test("a snapshot for a season only the served client has is stored", () => {
    const A = Harness.SeedAccount(Context, "RadiantSaver");
    Escalation.ApplyEscalationSnapshot(A.UserId, "ESC_SEASON_6", {
        escalation_level: 1, next_level_xp: 100, update_version: 1,
        talents_progress: [{ talent_id: "ESC_TALENT_TEST_TIER1", rank: 1 }],
        unlock_progress: [{ reward_id: "ESC_Reward_Test", collected: true }]
    });
    const Stored = Escalation.GetEscalationState(A.UserId, "ESC_SEASON_6");
    assert.equal(Stored.escalation_level, 1);
    assert.equal(Stored.next_level_xp, 100);
    assert.deepEqual(Stored.talents_progress, [{ talent_id: "ESC_TALENT_TEST_TIER1", rank: 1 }]);
});
