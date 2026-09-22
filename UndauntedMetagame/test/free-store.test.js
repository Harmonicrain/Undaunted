"use strict";
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { eq } = require('drizzle-orm');
const Harness = require('./harness');
let context, store, server, url, sign;
const sku = 'single_armour_helm_savant';
const itemId = 'AR_SAINTS19_ROMANTIC_HELM_01';
before(async () => {
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(keys.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
    process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(keys.publicKey.export({ type: 'spki', format: 'pem' })).toString('base64');
    context = Harness.CreateDisposableDatabase();
    store = require('../dist/controllers/freeStore');
    sign = require('../dist/controllers/auth').SignMetagameJWTForUid;
    const express = require('express');
    const app = express(); app.use(express.json());
    app.use(require('../dist/routes/store').storeRouter);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); context.Db.$client.close(); context.Cleanup(); });
const account = () => Harness.SeedAccount(context);
const token = (a, id = sku) => store.CreateFreePurchase(a.UserId, 'platinum', id).purchaseToken;
const redeem = (a, t) => store.RedeemFreePurchase(a.UserId, 'platinum', t);
const quantity = (a, id = itemId) => Harness.StackedQuantity(Harness.ReadInventory(context, a.CharacterId), id);

test('free grant persists, marks owned, and retries/new tokens do not duplicate it', () => {
    const a = account(), t = token(a);
    redeem(a, t); redeem(a, t); redeem(a, token(a));
    assert.equal(quantity(a), 1);
    assert.equal(store.GetFreeStoreOffers(a.UserId).find(x => x.id === sku).remaining, 0);
    // A separate database connection sees the committed item and receipt.
    const Db = require('better-sqlite3'); const reopened = new Db(context.DbPath, { readonly: true });
    try {
        const row = reopened.prepare('SELECT stackedItems FROM inventories WHERE characterId=?').get(a.CharacterId);
        assert.equal(JSON.parse(row.stackedItems).find(x => x.catalogId === itemId).quantity, 1);
        assert.equal(reopened.prepare('SELECT count(*) AS n FROM storepurchases WHERE userId=? AND redeemedAt IS NOT NULL').get(a.UserId).n, 2);
    } finally { reopened.close(); }
});

test('overlapping bundle and single item unlock each cosmetic once', () => {
    const a = account();
    redeem(a, token(a, 'single_armour_monk_chest'));
    redeem(a, token(a, 'bundle_armour_monk'));
    const held = Harness.ReadInventory(context, a.CharacterId).stackedItems;
    assert.equal(held.length, 4);
    assert.ok(held.every(x => x.quantity === 1));
});

test('cross-account, wrong currency, unknown SKU and malformed token are refused', () => {
    const a = account(), b = account(), t = token(a);
    assert.throws(() => redeem(b, t), { status: 403 });
    assert.throws(() => store.RedeemFreePurchase(a.UserId, 'notes', t), { status: 400 });
    assert.throws(() => store.CreateFreePurchase(a.UserId, 'platinum', 'made_up'), { status: 404 });
    assert.throws(() => redeem(a, 'made_up'), { status: 400 });
    assert.equal(quantity(a), 0); assert.equal(quantity(b), 0);
});

test('expired token and changed offer cannot grant', () => {
    const a = account(), t = token(a);
    const ledger = context.Schema.storepurchases;
    context.Db.update(ledger).set({ expiresAt: 0 }).where(eq(ledger.userId, a.UserId)).run();
    assert.throws(() => redeem(a, t), { status: 410 });
    const changed = token(a);
    context.Db.update(ledger).set({ offerHash: 'changed' }).where(eq(ledger.userId, a.UserId)).run();
    assert.throws(() => redeem(a, changed), { status: 409 });
    assert.equal(quantity(a), 0);
});

test('grant and receipt roll back together if the database rejects the receipt', () => {
    const a = account(), t = token(a);
    context.Db.$client.exec("CREATE TRIGGER test_store_abort BEFORE UPDATE ON storepurchases BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    try { assert.throws(() => redeem(a, t), /test failure/); }
    finally { context.Db.$client.exec('DROP TRIGGER test_store_abort'); }
    assert.equal(quantity(a), 0);
    redeem(a, t); assert.equal(quantity(a), 1);
});

test('does not pick an arbitrary character or redeem to a transferred character', () => {
    const a = account(), b = account(), t = token(a), table = context.Schema.characters;
    context.Db.update(table).set({ userId: a.UserId }).where(eq(table.characterId, b.CharacterId)).run();
    assert.throws(() => token(a), { status: 409 });
    context.Db.update(table).set({ userId: b.UserId }).where(eq(table.characterId, a.CharacterId)).run();
    assert.throws(() => redeem(a, t), { status: 403 });
});

test('HTTP authenticates, ignores requested grants/prices, and follows the legacy token protocol', async () => {
    const a = account(), headers = { Authorization: `Bearer ${sign(a.UserId)}`, 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${url}/token/platinum/${sku}`)).status, 401);
    const response = await fetch(`${url}/token/platinum/${sku}?price=-100&quantity=999&catalogId=anything`, { headers });
    assert.equal(response.status, 200);
    const { purchaseToken } = await response.json();
    const confirm = () => fetch(`${url}/notification/platinum?token=${purchaseToken}`, {
        method: 'POST', headers, body: JSON.stringify({ quantity: 999, price: -100, catalogId: 'anything' })
    });
    assert.equal((await confirm()).status, 204); assert.equal((await confirm()).status, 204);
    assert.equal(quantity(a), 1); assert.equal(quantity(a, 'anything'), 0);
    const listed = await fetch(`${url}/product/skus/public?requiredTags=webstore`, { headers }).then(r => r.json());
    // Every listed offer is free and sits in a real store category, not just the
    // webstore request filter. (This asserted skin_armour when the store sold armour only.)
    assert.ok(listed.every(x => x.platinumPrice === 0 && x.tags.some(t => t !== 'webstore')));
});
