"use strict";
// The Reward Cache (store tag season_store): offers priced in a seasonal coin
// from the wallet, cosmetics that are refused rather than charged for when
// already held, and currency bundles limited per day or per week. The
// catalogue here is synthetic.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Harness = require('./harness');
let context, store, wallet, server, url, sign, dataDir;

const DAY = 24 * 60 * 60 * 1000;
const realNow = Date.now;
let clock = 0;

const coinOffer = (id, items, price, extra = {}) => ({
    id, displayName: id, displayDescription: '', displayPriority: 0, tags: ['season_store'],
    platinumPrice: 0, platinumSalePrice: null, priceCurrency: 'CURRENCY_S19_COIN', price,
    items, entitlements: [], maxAllowed: 1, remaining: 1, loadoutSlots: null, ...extra
});

before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-cache-'));
    fs.writeFileSync(path.join(dataDir, 'store_catalog.json'), JSON.stringify({
        season_store: [
            coinOffer('rc_helm', [{ catalogId: 'AR_TEST_HELM', quantity: 1 }], 2000),
            coinOffer('rc_rams_daily', [{ catalogId: 'CURRENCY_NOTES', quantity: 5000 }], 400, { limit: 'daily', maxAllowed: 999 }),
            coinOffer('rc_sparks_weekly', [{ catalogId: 'CURRENCY_PJM_PRESTIGE_EMPTY', quantity: 100 }], 2000, { limit: 'weekly', maxAllowed: 999 }),
            coinOffer('rc_merits', [{ catalogId: 'CURRENCY_PJM_WEAPON', quantity: 100 }], 1000, { bundle: true, maxAllowed: 999 })
        ]
    }));
    fs.writeFileSync(path.join(dataDir, 'store_item_kinds.json'), JSON.stringify({ AR_TEST_HELM: 'stacked' }));
    process.env.STORE_DATA_DIR = dataDir;
    process.env.STORE_OFFER_FORMAT = 'prices';

    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(keys.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
    process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(keys.publicKey.export({ type: 'spki', format: 'pem' })).toString('base64');
    context = Harness.CreateDisposableDatabase();
    store = require('../dist/controllers/freeStore');
    wallet = require('../dist/controllers/wallet');
    sign = require('../dist/controllers/auth').SignMetagameJWTForUid;
    const express = require('express');
    const app = express(); app.use(express.json());
    app.use(require('../dist/routes/store').storeRouter);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    url = `http://127.0.0.1:${server.address().port}`;

    clock = Date.UTC(2026, 8, 24, 12, 0, 0); // a Thursday
    Date.now = () => clock;
});
after(async () => {
    Date.now = realNow;
    await new Promise(resolve => server.close(resolve));
    context.Db.$client.close(); context.Cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const COIN = 'id_currency_s19_coin';
const credit = (a, amount) => context.Db.transaction(tx => wallet.CreditWallet(tx, a.UserId, 'CURRENCY_S19_COIN', amount));
const coins = a => wallet.GetWallet(a.UserId).CURRENCY_S19_COIN ?? 0;
const buy = (a, sku, currency = COIN) => {
    const { purchaseToken } = store.CreateFreePurchase(a.UserId, currency, sku);
    store.RedeemFreePurchase(a.UserId, currency, purchaseToken);
};

test('Reward Cache offers are listed priced in the seasonal coin', async () => {
    const a = Harness.SeedAccount(context);
    const res = await fetch(`${url}/product/skus/public?requiredTags=season_store`, { headers: { Authorization: `Bearer ${sign(a.UserId)}` } });
    const body = await res.json();
    assert.deepEqual(body.map(o => [o.id, o.prices[0].currencyId, o.prices[0].price]), [
        ['rc_helm', COIN, 2000], ['rc_rams_daily', COIN, 400], ['rc_sparks_weekly', COIN, 2000], ['rc_merits', COIN, 1000]
    ]);
});

test('a cosmetic costs coins, not Platinum, and cannot be bought again once held', () => {
    const a = Harness.SeedAccount(context);
    assert.throws(() => store.CreateFreePurchase(a.UserId, COIN, 'rc_helm'), { status: 409, message: 'Not enough coins' });
    // Offered in coins: Platinum is not accepted for it.
    assert.throws(() => store.CreateFreePurchase(a.UserId, 'id_currency_platinum', 'rc_helm'), { status: 400 });
    credit(a, 4500);
    buy(a, 'rc_helm');
    assert.equal(coins(a), 2500);
    assert.equal(Harness.StackedQuantity(Harness.ReadInventory(context, a.CharacterId), 'AR_TEST_HELM'), 1);
    assert.throws(() => store.CreateFreePurchase(a.UserId, COIN, 'rc_helm'), { status: 409, message: 'Already owned' });
    assert.equal(coins(a), 2500);
});

test('a daily bundle is bought once per UTC day and pays its currency', () => {
    const a = Harness.SeedAccount(context);
    credit(a, 1000);
    buy(a, 'rc_rams_daily');
    assert.equal(coins(a), 600);
    assert.throws(() => store.CreateFreePurchase(a.UserId, COIN, 'rc_rams_daily'), { status: 409, message: 'Already claimed today' });
    clock += DAY;
    buy(a, 'rc_rams_daily');
    assert.equal(coins(a), 200);
    assert.equal(Harness.StackedQuantity(Harness.ReadInventory(context, a.CharacterId), 'CURRENCY_NOTES'), 10000);
    clock -= DAY;
});

test('a weekly bundle is bought once until the next Thursday', () => {
    const a = Harness.SeedAccount(context);
    credit(a, 6000);
    buy(a, 'rc_sparks_weekly');
    clock += 6 * DAY; // Wednesday
    assert.throws(() => store.CreateFreePurchase(a.UserId, COIN, 'rc_sparks_weekly'), { status: 409, message: 'Already bought this week' });
    clock += DAY; // Thursday again
    buy(a, 'rc_sparks_weekly');
    assert.equal(coins(a), 2000);
    assert.equal(Harness.StackedQuantity(Harness.ReadInventory(context, a.CharacterId), 'CURRENCY_PJM_PRESTIGE_EMPTY'), 200);
    clock -= 7 * DAY;
});

test('an unlimited bundle can be bought again', () => {
    const a = Harness.SeedAccount(context);
    credit(a, 2000);
    buy(a, 'rc_merits');
    buy(a, 'rc_merits');
    assert.equal(coins(a), 0);
    assert.equal(Harness.StackedQuantity(Harness.ReadInventory(context, a.CharacterId), 'CURRENCY_PJM_WEAPON'), 200);
});

test('limits and the week start follow UTC days, Thursday to Thursday', () => {
    const thursday = Date.UTC(2026, 8, 24);
    assert.equal(store.LimitWindowStart('weekly', Date.UTC(2026, 8, 24, 23)), thursday);
    assert.equal(store.LimitWindowStart('weekly', Date.UTC(2026, 8, 30, 23)), thursday);
    assert.equal(store.LimitWindowStart('weekly', Date.UTC(2026, 9, 1, 0, 1)), thursday + 7 * DAY);
    assert.equal(store.LimitWindowStart('daily', Date.UTC(2026, 8, 30, 23)), Date.UTC(2026, 8, 30));
});
