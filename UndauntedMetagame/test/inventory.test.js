"use strict";

// Inventory transaction behaviour.
//
// The F02 section covers grant authority, quantity validation and replay
// protection. These were written as todo tests against the unfixed server and
// were flipped once F02 landed, so they assert desired behaviour throughout.

const { test, before, after } = require("node:test");
const assert = require("node:assert");

const Harness = require("./harness.js");

let Context;
let Inventory;

before(() => {
    Context = Harness.CreateDisposableDatabase();
    Inventory = require("../dist/controllers/inventory.js");
});

after(() => {
    Context.Cleanup();
});

function FreshAccount() {
    return Harness.SeedAccount(Context);
}

function Transaction(Account, TransactionId, Options = {}) {
    return Inventory.RunInventoryTransaction(
        Account.UserId,
        Account.CharacterId,
        TransactionId,
        Options.AddInstanced ?? [],
        Options.AddStacked ?? [],
        Options.RemoveInstanced ?? [],
        Options.RemoveStacked ?? [],
        Options.SaveInstanced ?? []
    );
}

// ---------------------------------------------------------------- current behaviour

test("grants a stacked item", async () => {
    const Account = FreshAccount();

    const Result = await Transaction(Account, "tx-grant-1", {
        AddStacked: [{ catalogId: "BREAK_TEST_HIDE", quantity: 5 }]
    });

    assert.strictEqual(Result.success, true);

    const Held = Harness.ReadInventory(Context, Account.CharacterId);
    assert.strictEqual(Harness.StackedQuantity(Held, "BREAK_TEST_HIDE"), 5);
});

test("accumulates repeated grants of the same catalog id", async () => {
    const Account = FreshAccount();

    await Transaction(Account, "tx-acc-1", { AddStacked: [{ catalogId: "ORB_TEST", quantity: 3 }] });
    await Transaction(Account, "tx-acc-2", { AddStacked: [{ catalogId: "ORB_TEST", quantity: 4 }] });

    const Held = Harness.ReadInventory(Context, Account.CharacterId);
    assert.strictEqual(Harness.StackedQuantity(Held, "ORB_TEST"), 7);
});

test("removes a stacked item", async () => {
    const Account = FreshAccount();

    await Transaction(Account, "tx-rem-1", { AddStacked: [{ catalogId: "ORB_TEST", quantity: 10 }] });
    await Transaction(Account, "tx-rem-2", { RemoveStacked: [{ catalogId: "ORB_TEST", quantity: 4 }] });

    const Held = Harness.ReadInventory(Context, Account.CharacterId);
    assert.strictEqual(Harness.StackedQuantity(Held, "ORB_TEST"), 6);
});

test("refuses a transaction against a character the account does not own", async () => {
    const Mine = FreshAccount();
    const Theirs = FreshAccount();

    const Result = await Inventory.RunInventoryTransaction(
        Mine.UserId, Theirs.CharacterId, "tx-cross-1",
        [], [{ catalogId: "ORB_TEST", quantity: 1 }], [], [], []);

    assert.strictEqual(Result.success, false);
    assert.strictEqual(Result.error, "forbidden");

    const Held = Harness.ReadInventory(Context, Theirs.CharacterId);
    assert.strictEqual(Harness.StackedQuantity(Held, "ORB_TEST"), 0,
        "a cross-account transaction must not write anything");
});

// ---------------------------------------------------------------- F02 acceptance

test("a replayed transaction id grants only once", async () => {
    const Account = FreshAccount();

    await Transaction(Account, "tx-replay-1", { AddStacked: [{ catalogId: "ORB_TEST", quantity: 5 }] });
    await Transaction(Account, "tx-replay-1", { AddStacked: [{ catalogId: "ORB_TEST", quantity: 5 }] });

    const Held = Harness.ReadInventory(Context, Account.CharacterId);
    assert.strictEqual(Harness.StackedQuantity(Held, "ORB_TEST"), 5,
        "the same transaction id must not grant twice");
});

test("refuses to remove more of a stacked item than is held", async () => {
    const Account = FreshAccount();

    await Transaction(Account, "tx-over-1", { AddStacked: [{ catalogId: "ORB_TEST", quantity: 2 }] });

    const Result = await Transaction(Account, "tx-over-2", {
        RemoveStacked: [{ catalogId: "ORB_TEST", quantity: 5 }]
    });

    assert.strictEqual(Result.success, false, "overspending must be rejected");

    const Held = Harness.ReadInventory(Context, Account.CharacterId);
    assert.strictEqual(Harness.StackedQuantity(Held, "ORB_TEST"), 2,
        "a rejected removal must leave the held quantity untouched");
});

test("refuses a negative grant quantity", async () => {
    const Account = FreshAccount();

    await Transaction(Account, "tx-neg-1", { AddStacked: [{ catalogId: "ORB_TEST", quantity: 10 }] });

    const Result = await Transaction(Account, "tx-neg-2", {
        AddStacked: [{ catalogId: "ORB_TEST", quantity: -8 }]
    });

    assert.strictEqual(Result.success, false, "a negative quantity must be rejected");

    const Held = Harness.ReadInventory(Context, Account.CharacterId);
    assert.strictEqual(Harness.StackedQuantity(Held, "ORB_TEST"), 10);
});

// ------------------------------------------------ reported stack quantities
//
// The response's updatedStackedItems is how the client learns new balances.
// Removals were applied to storage but never reported, so after crafting the
// client kept showing the pre-crafting Rams and materials.

test("crafting-style removals report the final quantity of every changed stack", async () => {
    const Account = FreshAccount();
    await Transaction(Account, "seed-craft", { AddStacked: [
        { catalogId: "CURRENCY_NOTES", quantity: 4160 }, { catalogId: "MAT_TEST_ORE", quantity: 14 }] });

    const Result = await Transaction(Account, "craft-1", {
        AddStacked: [{ catalogId: "MAT_TEST_PART", quantity: 1 }],
        RemoveStacked: [{ catalogId: "CURRENCY_NOTES", quantity: 10 }, { catalogId: "MAT_TEST_ORE", quantity: 1 }]
    });

    assert.strictEqual(Result.success, true);
    assert.deepStrictEqual(Result.data, [
        { catalogId: "CURRENCY_NOTES", quantity: 4150 },
        { catalogId: "MAT_TEST_ORE", quantity: 13 },
        { catalogId: "MAT_TEST_PART", quantity: 1 }
    ]);

    const Held = Harness.ReadInventory(Context, Account.CharacterId);
    assert.strictEqual(Harness.StackedQuantity(Held, "CURRENCY_NOTES"), 4150);
    assert.strictEqual(Harness.StackedQuantity(Held, "MAT_TEST_ORE"), 13);
});

test("a stack used up entirely is reported at zero, not omitted", async () => {
    const Account = FreshAccount();
    await Transaction(Account, "seed-deplete", { AddStacked: [{ catalogId: "MAT_TEST_ORE", quantity: 2 }] });

    const Result = await Transaction(Account, "deplete-1", { RemoveStacked: [{ catalogId: "MAT_TEST_ORE", quantity: 2 }] });

    assert.deepStrictEqual(Result.data, [{ catalogId: "MAT_TEST_ORE", quantity: 0 }]);
});

test("a stack touched more than once is reported once, at its final quantity", async () => {
    const Account = FreshAccount();
    await Transaction(Account, "seed-twice", { AddStacked: [{ catalogId: "MAT_TEST_ORE", quantity: 5 }] });

    const Result = await Transaction(Account, "twice-1", {
        RemoveStacked: [{ catalogId: "MAT_TEST_ORE", quantity: 3 }],
        AddStacked: [{ catalogId: "MAT_TEST_ORE", quantity: 1 }, { catalogId: "MAT_TEST_ORE", quantity: 1 }]
    });

    assert.deepStrictEqual(Result.data, [{ catalogId: "MAT_TEST_ORE", quantity: 4 }]);
});

test("a retried transaction returns the same reported quantities, not the current ones", async () => {
    const Account = FreshAccount();
    await Transaction(Account, "seed-retry", { AddStacked: [{ catalogId: "CURRENCY_NOTES", quantity: 100 }] });

    const Options = { RemoveStacked: [{ catalogId: "CURRENCY_NOTES", quantity: 30 }] };
    const First = await Transaction(Account, "retry-craft", Options);
    await Transaction(Account, "later-spend", { RemoveStacked: [{ catalogId: "CURRENCY_NOTES", quantity: 5 }] });
    const Retry = await Transaction(Account, "retry-craft", Options);

    assert.deepStrictEqual(First.data, [{ catalogId: "CURRENCY_NOTES", quantity: 70 }]);
    assert.deepStrictEqual(Retry.data, First.data, "a replay answers with what the original reported");
    assert.strictEqual(Harness.StackedQuantity(Harness.ReadInventory(Context, Account.CharacterId), "CURRENCY_NOTES"), 65,
        "and does not deduct again");
});
