"use strict";
// Free store served from STORE_DATA_DIR in the 1.12.0 wire shape
// (STORE_OFFER_FORMAT=prices). The catalogue here is synthetic.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Harness = require('./harness');
let context, store, server, url, sign, dataDir;

const offer = (id, tag, catalogId, quantity = 1, maxAllowed = 1) => ({
    id, displayName: id, displayDescription: 'Free.', displayPriority: 1, tags: ['webstore', tag],
    platinumPrice: 0, platinumSalePrice: null, items: [{ catalogId, quantity }], entitlements: [],
    maxAllowed, remaining: 1, loadoutSlots: null
});

before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-prices-'));
    fs.writeFileSync(path.join(dataDir, 'store_catalog.json'), JSON.stringify({
        _repeatableItems: ['QI_TEST_TONIC'],
        webstore: [
            offer('sku_em_test_wave', 'social_emote', 'EM_TEST_WAVE'),
            offer('free_qi_test_tonic_x10', 'supplies_supplies', 'QI_TEST_TONIC', 10, 999),
            offer('free_unlisted', 'social_emote', 'EM_NOT_IN_KINDS')
        ],
        season19_pass: [{ ...offer('season19_premium', 'season19_pass', 'unused'), tags: ['season19_pass'],
            items: [], entitlements: [{ name: 'season19_premium', duration: 0 }] }]
    }));
    fs.writeFileSync(path.join(dataDir, 'store_item_kinds.json'), JSON.stringify({
        EM_TEST_WAVE: 'stacked', QI_TEST_TONIC: 'stacked'
    }));
    process.env.STORE_DATA_DIR = dataDir;
    process.env.STORE_OFFER_FORMAT = 'prices';

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
after(async () => {
    await new Promise(resolve => server.close(resolve));
    context.Db.$client.close(); context.Cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const get = async (a, route) => {
    const res = await fetch(url + route, { headers: { Authorization: `Bearer ${sign(a.UserId)}` } });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

test('offers use the 1.12.0 prices shape and no flat price fields', async () => {
    const a = Harness.SeedAccount(context);
    const { status, body } = await get(a, '/product/skus/public?requiredTags=webstore');
    assert.equal(status, 200);
    const wave = body.find(x => x.id === 'sku_em_test_wave');
    assert.deepEqual(wave.prices, [{ currencyId: 'id_currency_platinum', price: 0, salesPrice: null }]);
    assert.deepEqual(wave.items, [{ catalogId: 'EM_TEST_WAVE', quantity: 1 }]);
    assert.deepEqual(wave.tags, ['webstore', 'social_emote']);
    assert.equal(wave.remaining, 1);
    assert.equal('platinumPrice' in wave, false);
});

test('purchase in id_currency_platinum grants the item and marks it owned', async () => {
    const a = Harness.SeedAccount(context);
    const { purchaseToken } = store.CreateFreePurchase(a.UserId, 'id_currency_platinum', 'sku_em_test_wave');
    store.RedeemFreePurchase(a.UserId, 'id_currency_platinum', purchaseToken);
    assert.equal(Harness.StackedQuantity(Harness.ReadInventory(context, a.CharacterId), 'EM_TEST_WAVE'), 1);
    const { body } = await get(a, '/product/sku/sku_em_test_wave');
    assert.equal(body.remaining, 0);
});

test('catalogue repeatables grant their full quantity every time', () => {
    const a = Harness.SeedAccount(context);
    for (let i = 0; i < 2; i++) {
        const { purchaseToken } = store.CreateFreePurchase(a.UserId, 'platinum', 'free_qi_test_tonic_x10');
        store.RedeemFreePurchase(a.UserId, 'platinum', purchaseToken);
    }
    assert.equal(Harness.StackedQuantity(Harness.ReadInventory(context, a.CharacterId), 'QI_TEST_TONIC'), 20);
});

test('the Elite pass is served under its own tag and grants the premium entitlement once', async () => {
    const a = Harness.SeedAccount(context);
    const listed = (await get(a, '/product/skus/public?requiredTags=season19_pass')).body;
    assert.deepEqual(listed.map(x => x.id), ['season19_premium']);
    assert.deepEqual(listed[0].prices, [{ currencyId: 'id_currency_platinum', price: 0, salesPrice: null }]);
    assert.equal(listed[0].remaining, 1);

    const { purchaseToken } = store.CreateFreePurchase(a.UserId, 'id_currency_platinum', 'season19_premium');
    store.RedeemFreePurchase(a.UserId, 'id_currency_platinum', purchaseToken);
    const held = context.Db.select().from(context.Schema.entitlements).all().filter(x => x.userId === a.UserId);
    assert.deepEqual(held.map(x => x.entitlement), ['season19_premium']);
    assert.equal((await get(a, '/product/sku/season19_premium')).body.remaining, 0);
});

test('an item missing from the item kinds is never granted', () => {
    const a = Harness.SeedAccount(context);
    assert.throws(() => store.CreateFreePurchase(a.UserId, 'platinum', 'free_unlisted'), { status: 409 });
});
