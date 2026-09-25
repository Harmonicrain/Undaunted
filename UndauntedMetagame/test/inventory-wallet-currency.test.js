"use strict";
// The 1.12.0 gameserver pays a claimed challenge's Elemental Coins as a stacked
// inventory add, but the client shows and spends the account balance. Balance
// currencies in an inventory transaction therefore go to the wallet, once per
// transaction id, while everything else still lands in the inventory.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Harness = require("./harness");

let Context, Inventory, Wallet;

before(() => {
    Context = Harness.CreateDisposableDatabase();
    Inventory = require("../dist/controllers/inventory");
    Wallet = require("../dist/controllers/wallet");
});
after(() => {
    Context.Db.$client.close();
    Context.Cleanup();
});

const Coins = (A) => Wallet.GetWallet(A.UserId).CURRENCY_S19_COIN ?? 0;
const Run = (A, Id, Add, Remove = []) =>
    Inventory.RunInventoryTransaction(A.UserId, A.CharacterId, Id, [], Add, [], Remove, []);

test("challenge coins granted by the gameserver land in the wallet, not the inventory", async () => {
    const A = Harness.SeedAccount(Context, "CoinGrant");
    const Result = await Run(A, "TX1", [
        { catalogId: "CURRENCY_S19_COIN", quantity: 200 },
        { catalogId: "CURRENCY_NOTES", quantity: 50 }
    ]);
    assert.equal(Result.success, true);
    assert.deepEqual(Result.data, [
        { catalogId: "CURRENCY_NOTES", quantity: 50 },
        { catalogId: "CURRENCY_S19_COIN", quantity: 200 }
    ]);
    assert.equal(Coins(A), 200);
    const Held = Harness.ReadInventory(Context, A.CharacterId);
    assert.equal(Harness.StackedQuantity(Held, "CURRENCY_S19_COIN"), 0);
    assert.equal(Harness.StackedQuantity(Held, "CURRENCY_NOTES"), 50);
});

test("a retried transaction does not pay the coins again", async () => {
    const A = Harness.SeedAccount(Context, "CoinReplay");
    const Grant = [{ catalogId: "CURRENCY_S19_COIN", quantity: 400 }];
    await Run(A, "TX2", Grant);
    const Replay = await Run(A, "TX2", Grant);
    assert.equal(Replay.success, true);
    assert.deepEqual(Replay.data, [{ catalogId: "CURRENCY_S19_COIN", quantity: 400 }]);
    assert.equal(Coins(A), 400);
    await Run(A, "TX3", Grant);
    assert.equal(Coins(A), 800);
});

test("removing a balance currency spends the wallet and cannot overdraw it", async () => {
    const A = Harness.SeedAccount(Context, "CoinSpend");
    await Run(A, "TX4", [{ catalogId: "CURRENCY_S19_COIN", quantity: 300 }]);
    const Spent = await Run(A, "TX5", [], [{ catalogId: "CURRENCY_S19_COIN", quantity: 100 }]);
    assert.deepEqual(Spent.data, [{ catalogId: "CURRENCY_S19_COIN", quantity: 200 }]);
    const Overdraw = await Run(A, "TX6", [{ catalogId: "CURRENCY_NOTES", quantity: 5 }],
        [{ catalogId: "CURRENCY_S19_COIN", quantity: 500 }]);
    assert.deepEqual(Overdraw, { success: false, error: "invalid_inventory_item" });
    // The whole transaction rolled back, the inventory part included.
    assert.equal(Coins(A), 200);
    assert.equal(Harness.StackedQuantity(Harness.ReadInventory(Context, A.CharacterId), "CURRENCY_NOTES"), 0);
});
