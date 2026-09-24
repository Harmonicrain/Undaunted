"use strict";
// Priced store offers and the Slayers Club. An offer with a platinumPrice is
// paid from the wallet's Platinum (Hunt Pass ranks and the fountain pay into
// it); the charge commits with the grant. The Slayers Club is the timed
// entitlement ent_boost_vip, in hours, which stacks when bought again. The
// catalogue here is synthetic.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Harness = require('./harness');
let context, store, wallet, entitlementsCtl, server, url, sign, dataDir;

const HOUR = 60 * 60 * 1000;
const realNow = Date.now;
let clock = 0;

const club = (id, hours, price) => ({
    id, displayName: `Slayers Club (${hours / 24} days)`, displayDescription: 'Slayers Club.', displayPriority: 0,
    tags: ['vip_boost'], platinumPrice: price, platinumSalePrice: null, items: [],
    entitlements: [{ name: 'ent_boost_vip', duration: hours }], maxAllowed: 1, remaining: 1, loadoutSlots: null
});

before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-club-'));
    fs.writeFileSync(path.join(dataDir, 'store_catalog.json'), JSON.stringify({
        webstore: [{ id: 'sku_em_test_wave', displayName: 'Wave', displayDescription: 'Free.', displayPriority: 1,
            tags: ['webstore', 'social_emote'], platinumPrice: 0, platinumSalePrice: null,
            items: [{ catalogId: 'EM_TEST_WAVE', quantity: 1 }], entitlements: [], maxAllowed: 1, remaining: 1, loadoutSlots: null }],
        vip_boost: [club('vip_3_day', 72, 300), club('vip_5_day', 120, 500), club('vip_30_day', 720, 1000)]
    }));
    fs.writeFileSync(path.join(dataDir, 'store_item_kinds.json'), JSON.stringify({ EM_TEST_WAVE: 'stacked' }));
    process.env.STORE_DATA_DIR = dataDir;
    process.env.STORE_OFFER_FORMAT = 'prices';

    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(keys.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
    process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(keys.publicKey.export({ type: 'spki', format: 'pem' })).toString('base64');
    context = Harness.CreateDisposableDatabase();
    store = require('../dist/controllers/freeStore');
    wallet = require('../dist/controllers/wallet');
    entitlementsCtl = require('../dist/controllers/entitlements');
    sign = require('../dist/controllers/auth').SignMetagameJWTForUid;
    const express = require('express');
    const app = express(); app.use(express.json());
    app.use(require('../dist/routes/store').storeRouter);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    url = `http://127.0.0.1:${server.address().port}`;

    clock = Date.UTC(2026, 9, 1, 12, 0, 0);
    Date.now = () => clock;
});
after(async () => {
    Date.now = realNow;
    await new Promise(resolve => server.close(resolve));
    context.Db.$client.close(); context.Cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const get = async (a, route) => {
    const res = await fetch(url + route, { headers: { Authorization: `Bearer ${sign(a.UserId)}` } });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const credit = (a, amount) => context.Db.transaction(tx => wallet.CreditWallet(tx, a.UserId, 'CURRENCY_PLATINUM_UNIV', amount));
const platinum = a => wallet.GetWallet(a.UserId).CURRENCY_PLATINUM ?? 0;
const buy = (a, sku) => {
    const { purchaseToken } = store.CreateFreePurchase(a.UserId, 'id_currency_platinum', sku);
    store.RedeemFreePurchase(a.UserId, 'id_currency_platinum', purchaseToken);
    return purchaseToken;
};
const vip = async a => (await entitlementsCtl.GetEntitlementsForUser(a.UserId)).find(e => e.name === 'ent_boost_vip');

test('the Club is listed under vip_boost with its Platinum prices', async () => {
    const a = Harness.SeedAccount(context);
    const { body } = await get(a, '/product/skus/public?requiredTags=vip_boost');
    assert.deepEqual(body.map(o => [o.id, o.prices[0].price, o.remaining]),
        [['vip_3_day', 300, 1], ['vip_5_day', 500, 1], ['vip_30_day', 1000, 1]]);
});

test('a purchase needs enough Platinum and charges it once, with the grant', async () => {
    const a = Harness.SeedAccount(context);
    assert.throws(() => store.CreateFreePurchase(a.UserId, 'id_currency_platinum', 'vip_3_day'), { status: 409 });
    credit(a, 350);
    const token = buy(a, 'vip_3_day');
    assert.equal(platinum(a), 50);
    assert.deepEqual(await vip(a), { name: 'ent_boost_vip', duration: 72, activatedDate: new Date(clock).toISOString() });
    // A retried confirmation neither charges nor extends again.
    store.RedeemFreePurchase(a.UserId, 'id_currency_platinum', token);
    assert.equal(platinum(a), 50);
    assert.equal((await vip(a)).duration, 72);
});

test('Platinum spent between starting and confirming a purchase refuses it and grants nothing', async () => {
    const a = Harness.SeedAccount(context);
    credit(a, 500);
    const first = store.CreateFreePurchase(a.UserId, 'id_currency_platinum', 'vip_5_day').purchaseToken;
    const second = store.CreateFreePurchase(a.UserId, 'id_currency_platinum', 'vip_3_day').purchaseToken;
    store.RedeemFreePurchase(a.UserId, 'id_currency_platinum', first);
    assert.throws(() => store.RedeemFreePurchase(a.UserId, 'id_currency_platinum', second), { status: 409 });
    assert.equal(platinum(a), 0);
    assert.equal((await vip(a)).duration, 120);
});

test('membership stacks while it runs, restarts after it ends, and an ended one is not held', async () => {
    const a = Harness.SeedAccount(context);
    credit(a, 2000);
    const start = clock;
    buy(a, 'vip_3_day');
    clock += 24 * HOUR;
    buy(a, 'vip_5_day');
    assert.deepEqual(await vip(a), { name: 'ent_boost_vip', duration: 192, activatedDate: new Date(start).toISOString() });
    assert.equal(await entitlementsCtl.HasEntitlement(a.UserId, 'ent_boost_vip'), true);
    // Still purchasable: extending is always allowed.
    assert.equal((await get(a, '/product/sku/vip_30_day')).body.remaining, 1);

    clock = start + 193 * HOUR;
    assert.equal(await vip(a), undefined);
    assert.equal(await entitlementsCtl.HasEntitlement(a.UserId, 'ent_boost_vip'), false);
    buy(a, 'vip_30_day');
    assert.deepEqual(await vip(a), { name: 'ent_boost_vip', duration: 720, activatedDate: new Date(clock).toISOString() });
    assert.equal(platinum(a), 2000 - 300 - 500 - 1000);
});

test('free offers are unchanged: no Platinum needed, none taken', async () => {
    const a = Harness.SeedAccount(context);
    buy(a, 'sku_em_test_wave');
    assert.equal(Harness.StackedQuantity(Harness.ReadInventory(context, a.CharacterId), 'EM_TEST_WAVE'), 1);
    assert.equal(platinum(a), 0);
});
