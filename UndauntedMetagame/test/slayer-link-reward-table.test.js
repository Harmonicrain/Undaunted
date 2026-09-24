"use strict";
// The Slayer Link rewards table must be the one the gameserver rolls from.
// The bundled copy is 1.4.4's; 1.12.0 pays different amounts (15000 Rams,
// Combat Merits), and every pool it rolled was refused as unknown.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("a table from LINKED_SLAYER_REWARDS_FILE replaces the bundled 1.4.4 one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "link-rewards-"));
    const file = path.join(dir, "linked_slayer_rewards.json");
    fs.writeFileSync(file, JSON.stringify({
        config: { classes_to_draw: [5, 4, 2, 1], max_rewards: 4 },
        rewards: [
            { row: "Rams_3_00", catalog_id: "CURRENCY_NOTES", quantity: 15000, weight: 100, class: 3 },
            { row: "CombatMerits_1_01", catalog_id: "CURRENCY_PJM_WEAPON", quantity: 30, weight: 80, class: 1 }
        ]
    }));
    process.env.LINKED_SLAYER_REWARDS_FILE = file;
    try {
        const Config = require("../dist/controllers/slayerLinkConfig");
        assert.equal(Config.IsKnownLinkReward("CURRENCY_NOTES", 15000), true);
        assert.equal(Config.IsKnownLinkReward("CURRENCY_PJM_WEAPON", 30), true);
        // A 1.4.4 amount is not in this table.
        assert.equal(Config.IsKnownLinkReward("CURRENCY_NOTES", 1000), false);
        assert.equal(Config.MAX_LINK_REWARDS, 4);
        assert.equal(Config.MAX_POOL_SIZE, 12);
    } finally {
        delete process.env.LINKED_SLAYER_REWARDS_FILE;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
