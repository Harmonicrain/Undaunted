"use strict";
// A new character's loadout must not equip a Lantern Core it does not own.
// The default equipped PR_DARKNESS (Revenant), which no new character holds:
// the gameserver could not resolve it and the player had no core at all.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Harness = require("./harness");

let Context, Loadout;

before(() => {
    Context = Harness.CreateDisposableDatabase();
    Loadout = require("../dist/controllers/loadout");
});
after(() => { Context.Db.$client.close(); Context.Cleanup(); });

test("a new character's loadout slots start with an empty Lantern Core slot", async () => {
    const A = Harness.SeedAccount(Context, "NoCore");
    const [First] = await Loadout.GetAllLoadoutsForUserIdAndCharacterId(A.UserId, A.CharacterId);
    assert.deepEqual(First.player_role, { instance_id: "", instance_data: "" });
    await Loadout.EnsureCharacterSlotCount(A.UserId, A.CharacterId, 3);
    const All = await Loadout.GetAllLoadoutsForUserIdAndCharacterId(A.UserId, A.CharacterId);
    for (const Slot of All) assert.equal(Slot.player_role.instance_id, "");
});
