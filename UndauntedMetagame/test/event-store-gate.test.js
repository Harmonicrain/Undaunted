"use strict";
// An event's store (Honest Ozz's, tag seasonal_event) is listed and sold only
// while its event runs; tags no event lists are unaffected. The catalogue and
// the events here are synthetic.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Harness = require("./harness");

let Context, Store, Wallet, Dir;

const Offer = (id, tag) => ({
    id, displayName: id, displayDescription: "", displayPriority: 0, tags: [tag],
    platinumPrice: 0, platinumSalePrice: null, priceCurrency: "CURRENCY_EVENT_DARKHARVEST", price: 100,
    items: [{ catalogId: "CURRENCY_NOTES", quantity: 1000 }], bundle: true, entitlements: [], maxAllowed: 999, remaining: 1, loadoutSlots: null
});

before(() => {
    Dir = fs.mkdtempSync(path.join(os.tmpdir(), "event-store-"));
    fs.writeFileSync(path.join(Dir, "store_catalog.json"), JSON.stringify({
        running_event_store: [Offer("rams_running", "running_event_store")],
        ended_event_store: [Offer("rams_ended", "ended_event_store")],
        ungated_store: [Offer("rams_ungated", "ungated_store"), { ...Offer("pass_ended", "ended_event_store"), tags: ["ended_event_store", "ungated_store"] }]
    }));
    fs.writeFileSync(path.join(Dir, "store_item_kinds.json"), "{}");
    fs.writeFileSync(path.join(Dir, "seasonal_events.json"), JSON.stringify({ events: [
        { name: "Running", start: "2026-01-01T00:00:00Z", end: "2099-01-01T00:00:00Z", scheduledItems: ["EVENT_A"], storeTags: ["running_event_store"] },
        { name: "Ended", start: "2020-01-01T00:00:00Z", end: "2020-02-01T00:00:00Z", scheduledItems: ["EVENT_B"], storeTags: ["ended_event_store"] }
    ] }));
    process.env.STORE_DATA_DIR = Dir;
    process.env.SEASONAL_EVENTS_FILE = path.join(Dir, "seasonal_events.json");
    Context = Harness.CreateDisposableDatabase();
    Store = require("../dist/controllers/freeStore");
    Wallet = require("../dist/controllers/wallet");
});
after(() => {
    delete process.env.STORE_DATA_DIR;
    delete process.env.SEASONAL_EVENTS_FILE;
    Context.Db.$client.close();
    Context.Cleanup();
    fs.rmSync(Dir, { recursive: true, force: true });
});

const COIN = "id_currency_event_darkharvest";

test("a running event's store is listed and sells in its currency", () => {
    const A = Harness.SeedAccount(Context, "Running");
    const Listed = Store.GetOffersForTag(A.UserId, "running_event_store");
    assert.deepEqual(Listed.map((O) => [O.id, O.availableFrom, O.availableTo]),
        [["rams_running", "2026-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"]]);
    Context.Db.transaction((tx) => Wallet.CreditWallet(tx, A.UserId, "CURRENCY_EVENT_DARKHARVEST", 100));
    const { purchaseToken } = Store.CreateFreePurchase(A.UserId, COIN, "rams_running");
    Store.RedeemFreePurchase(A.UserId, COIN, purchaseToken);
    assert.equal(Wallet.GetWallet(A.UserId).CURRENCY_EVENT_DARKHARVEST, 0);
    assert.equal(Harness.StackedQuantity(Harness.ReadInventory(Context, A.CharacterId), "CURRENCY_NOTES"), 1000);
});

test("an ended event's store lists nothing and refuses purchases", () => {
    const A = Harness.SeedAccount(Context, "Ended");
    assert.deepEqual(Store.GetOffersForTag(A.UserId, "ended_event_store"), []);
    Context.Db.transaction((tx) => Wallet.CreditWallet(tx, A.UserId, "CURRENCY_EVENT_DARKHARVEST", 100));
    assert.throws(() => Store.CreateFreePurchase(A.UserId, COIN, "rams_ended"), { status: 409, message: "This event has ended" });
    assert.throws(() => Store.GetOfferById(A.UserId, "rams_ended"), { status: 404 });
    assert.equal(Wallet.GetWallet(A.UserId).CURRENCY_EVENT_DARKHARVEST, 100);
});

test("a tag no event lists is always open, but an ended event's offer under it is not listed", () => {
    const A = Harness.SeedAccount(Context, "Ungated");
    assert.deepEqual(Store.GetOffersForTag(A.UserId, "ungated_store").map((O) => O.id), ["rams_ungated"]);
});
