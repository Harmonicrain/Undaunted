"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
    ApplyWeeklyChallengeWindow,
    BuildWeeklyChallengePool,
    SelectWeeklyChallenges,
    WeeklyChallengeWindowStart,
    WeeklyChallengeSlots
} = require("../dist/controllers/weeklyChallenges");

const Document = { challenges: Object.fromEntries([
    ...Array.from({ length: 20 }, (_, Index) => [
        `Challenge_Season_Test_${String(Index).padStart(2, "0")}`,
        { category: "WeeklyChallengeGold", objectives: [{ objectiveId: `objective-${Index}`, amount: Index + 1 }] }
    ]),
    ["Challenge_Season_WrongCategory", {
        category: "Seasonal_Challenge_Small", objectives: [{ objectiveId: "excluded", amount: 1 }]
    }],
    ["Challenge_Daily_Gold_Test", {
        category: "WeeklyChallengeGold", objectives: [{ objectiveId: "excluded", amount: 1 }]
    }],
    ["Challenge_Season_Broken", {
        category: "WeeklyChallengeGold", objectives: [{ objectiveId: "broken", amount: 0 }]
    }]
]) };

const Pool = BuildWeeklyChallengePool(Document);

test("weekly pool contains only usable weekly definitions", () => {
    assert.equal(Pool.length, 20);
    assert.ok(Pool.every(Definition => Definition.id.startsWith("Challenge_Season_Test_")));
});

test("weekly selection is shared and stable for the whole reset window", () => {
    const Before = SelectWeeklyChallenges(Pool, new Date("2026-09-28T10:00:00.000Z"));
    const Later = SelectWeeklyChallenges(Pool, new Date("2026-10-01T17:59:59.999Z"));
    const Next = SelectWeeklyChallenges(Pool, new Date("2026-10-01T18:00:00.000Z"));

    assert.equal(Before.length, WeeklyChallengeSlots);
    assert.deepEqual(Before, Later);
    assert.notDeepEqual(Before.map(Definition => Definition.id), Next.map(Definition => Definition.id));
    assert.equal(new Set(Before.map(Definition => Definition.id)).size, WeeklyChallengeSlots);
    assert.equal(WeeklyChallengeWindowStart(new Date("2026-10-01T17:59:59.999Z")),
        Date.parse("2026-09-24T18:00:00.000Z"));
    assert.equal(WeeklyChallengeWindowStart(new Date("2026-10-01T18:00:00.000Z")),
        Date.parse("2026-10-01T18:00:00.000Z"));
});

test("weekly rollover keeps other board entries and current progress", () => {
    const Now = new Date("2026-09-28T10:00:00.000Z");
    const Selected = SelectWeeklyChallenges(Pool, Now);
    const CurrentId = `${Selected[0].id}-season19-0`;
    const Board = {
        bounties: [
            { bounty_id: "Bounty_Bronze_Held", slot_index: 0 },
            { bounty_id: "Challenge_Daily_Bronze_Held", slot_index: 0 },
            { bounty_id: "Challenge_Season_Old-season19-0", slot_index: 0,
                drafted_timestamp: "2026-09-18T18:00:00.000Z" },
            { bounty_id: CurrentId, slot_index: 7, update_version: 4,
                drafted_timestamp: "2026-09-24T18:00:00.000Z",
                objectives: [{ objective_id: Selected[0].objectives[0].objectiveId, progress: 12 }] }
        ]
    };

    ApplyWeeklyChallengeWindow(Board, Pool, Now);

    const Weekly = Board.bounties.filter(Entry => Entry.bounty_id.startsWith("Challenge_Season_"));
    assert.equal(Weekly.length, WeeklyChallengeSlots);
    assert.deepEqual(Weekly.map(Entry => Entry.slot_index), Array.from({ length: WeeklyChallengeSlots }, (_, Index) => Index));
    assert.equal(Weekly.find(Entry => Entry.bounty_id === CurrentId).objectives[0].progress, 12);
    assert.ok(Board.bounties.some(Entry => Entry.bounty_id === "Bounty_Bronze_Held"));
    assert.ok(Board.bounties.some(Entry => Entry.bounty_id === "Challenge_Daily_Bronze_Held"));
    assert.ok(!Board.bounties.some(Entry => Entry.bounty_id === "Challenge_Season_Old-season19-0"));
});
