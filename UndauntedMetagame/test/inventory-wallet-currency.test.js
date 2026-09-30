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

test("event currencies (Harvest Coins) land in the wallet too", async () => {
    const A = Harness.SeedAccount(Context, "HarvestCoins");
    const Result = await Run(A, "TX-DH", [{ catalogId: "CURRENCY_EVENT_DARKHARVEST", quantity: 30 }]);
    assert.deepEqual(Result.data, [{ catalogId: "CURRENCY_EVENT_DARKHARVEST", quantity: 30 }]);
    assert.equal(Wallet.GetWallet(A.UserId).CURRENCY_EVENT_DARKHARVEST, 30);
    assert.equal(Harness.StackedQuantity(Harness.ReadInventory(Context, A.CharacterId), "CURRENCY_EVENT_DARKHARVEST"), 0);
});

test("legacy Ace Chip grants convert to Aetherdust and no Ace balance survives", async () => {
    const A = Harness.SeedAccount(Context, "MiddlemanCurrencies");
    const Granted = await Run(A, "TX-MIDDLEMAN-GRANT", [
        { catalogId: "CURRENCY_CELLDUST", quantity: 500 },
        { catalogId: "CURRENCY_TOKEN_EXCHANGE_SPEED_UP", quantity: 3 }
    ]);
    assert.deepEqual(Granted.data, [{ catalogId: "CURRENCY_CELLDUST", quantity: 512 }]);

    const Spent = await Run(A, "TX-MIDDLEMAN-SPEND", [], [
        { catalogId: "CURRENCY_CELLDUST", quantity: 125 },
        { catalogId: "CURRENCY_TOKEN_EXCHANGE_SPEED_UP", quantity: 1 }
    ]);
    assert.deepEqual(Spent.data, [{ catalogId: "CURRENCY_CELLDUST", quantity: 386 }]);
    assert.equal(Wallet.GetWallet(A.UserId).CURRENCY_CELLDUST, 386);
    assert.equal(Wallet.GetWallet(A.UserId).CURRENCY_TOKEN_EXCHANGE_SPEED_UP, undefined);

    const Held = Harness.ReadInventory(Context, A.CharacterId);
    assert.equal(Harness.StackedQuantity(Held, "CURRENCY_CELLDUST"), 0);
    assert.equal(Harness.StackedQuantity(Held, "CURRENCY_TOKEN_EXCHANGE_SPEED_UP"), 0);
});

test("the legacy speed-up request spends Aetherdust when no Ace Chips remain", async () => {
    const A = Harness.SeedAccount(Context, "MiddlemanDustSpeedUp");
    await Run(A, "TX-DUST-SPEEDUP-GRANT", [{ catalogId: "CURRENCY_CELLDUST", quantity: 760 }]);

    const Spent = await Run(A, "TX-DUST-SPEEDUP-SPEND", [], [
        { catalogId: "CURRENCY_TOKEN_EXCHANGE_SPEED_UP", quantity: 132 }
    ]);

    assert.equal(Spent.success, true);
    assert.equal(Wallet.GetWallet(A.UserId).CURRENCY_CELLDUST, 628);
    assert.equal(Wallet.GetWallet(A.UserId).CURRENCY_TOKEN_EXCHANGE_SPEED_UP, undefined);
});

test("Middleman inventory checks receive the current wallet balance across reloads", async () => {
    const A = Harness.SeedAccount(Context, "MiddlemanInventoryBalance");
    await Run(A, "MM-BALANCE-GRANT", [{ catalogId: "CURRENCY_CELLDUST", quantity: 838 }]);
    const ReadDust = async () => {
        const Result = await Inventory.GetInventoryForUserIdAndCharacterId(A.UserId, A.CharacterId);
        assert.equal(Result.success, true);
        const Dust = Result.data.stackedItems.filter(x => x.catalogId === "CURRENCY_CELLDUST");
        assert.equal(Dust.length, 1);
        assert.equal(Result.data.stackedItems.some(x => x.catalogId === "CURRENCY_TOKEN_EXCHANGE_SPEED_UP"), false);
        return Dust[0].quantity;
    };
    assert.equal(await ReadDust(), 838);
    await Run(A, "MM-BALANCE-SPEND", [], [{ catalogId: "CURRENCY_CELLDUST", quantity: 132 }]);
    assert.equal(await ReadDust(), 706);
    assert.equal(await ReadDust(), 706);
    assert.equal(Wallet.GetWallet(A.UserId).CURRENCY_CELLDUST, 706);
    assert.equal(Harness.StackedQuantity(Harness.ReadInventory(Context, A.CharacterId), "CURRENCY_CELLDUST"), 0);
});

test("stored Ace Chip balances migrate once to Aetherdust at 4:1", () => {
    const A = Harness.SeedAccount(Context, "MiddlemanAceMigration");
    Context.Db.insert(Context.Schema.wallets).values({ userId: A.UserId,
        currencyId: "CURRENCY_TOKEN_EXCHANGE_SPEED_UP", amount: 25, updatedAt: Date.now() }).run();
    const Repairs = require("../dist/db/repairs");
    assert.deepEqual(Repairs.RepairLegacyAceChipBalances(Context.Db.$client), [
        { userId: A.UserId, chips: 25, dust: 100 }
    ]);
    assert.equal(Wallet.GetWallet(A.UserId).CURRENCY_CELLDUST, 100);
    assert.equal(Wallet.GetWallet(A.UserId).CURRENCY_TOKEN_EXCHANGE_SPEED_UP, undefined);
    assert.deepEqual(Repairs.RepairLegacyAceChipBalances(Context.Db.$client), []);
    assert.equal(Wallet.GetWallet(A.UserId).CURRENCY_CELLDUST, 100);
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
