"use strict";
// The Bazaar fountain: tossing a coin claims the offer under
// fountain_daily_free_bundle, once per account per UTC day. It pays out a
// core, tokens and currencies, which the storefront never grants. The
// catalogue here is synthetic.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Harness = require('./harness');
let context, store, wallet, server, url, sign, dataDir;

const SKU = 'fountain_daily_free_bundle';
const realNow = Date.now;
let clock = 0;

before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-fountain-'));
    fs.writeFileSync(path.join(dataDir, 'store_catalog.json'), JSON.stringify({
        webstore: [],
        fountain_daily_free_bundle: [{
            id: SKU, displayName: 'Fountain Core', displayDescription: 'Free.', displayPriority: 0,
            tags: ['fountain_daily_free_bundle'], daily: true, platinumPrice: 0, platinumSalePrice: null,
            items: [
                { catalogId: 'CONTAINER_CORE_REWARD_DAILY_02', quantity: 1 },
                { catalogId: 'TOKEN_BOUNTY_DRAFT', quantity: 4 },
                { catalogId: 'CURRENCY_NOTES', quantity: 1000 },
                { catalogId: 'CURRENCY_PJM_WEAPON', quantity: 25 },
                { catalogId: 'CURRENCY_TOKEN_EXCHANGE_SPEED_UP', quantity: 5 },
                { catalogId: 'CURRENCY_PLATINUM', quantity: 20 }
            ],
            entitlements: [], maxAllowed: 1, remaining: 1, loadoutSlots: null
        }]
    }));
    fs.writeFileSync(path.join(dataDir, 'store_item_kinds.json'), JSON.stringify({}));
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

    // Midday UTC, so a day's claims never straddle the reset by accident.
    clock = Date.UTC(2026, 9, 31, 12, 0, 0);
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
const listed = async a => (await get(a, `/product/skus/public?requiredTags=${SKU}`)).body;
const claim = a => {
    const { purchaseToken } = store.CreateFreePurchase(a.UserId, 'id_currency_platinum', SKU);
    store.RedeemFreePurchase(a.UserId, 'id_currency_platinum', purchaseToken);
};
const held = (a, id) => Harness.StackedQuantity(Harness.ReadInventory(context, a.CharacterId), id);

test('the fountain offer is listed, claimable once, and pays the character and the wallet as the game keeps them', async () => {
    const a = Harness.SeedAccount(context);
    const [offer] = await listed(a);
    assert.equal(offer.id, SKU);
    assert.equal(offer.remaining, 1);
    assert.deepEqual(offer.prices, [{ currencyId: 'id_currency_platinum', price: 0, salesPrice: null }]);

    claim(a);
    assert.equal(held(a, 'CONTAINER_CORE_REWARD_DAILY_02'), 1);
    assert.equal(held(a, 'TOKEN_BOUNTY_DRAFT'), 4);
    assert.equal(held(a, 'CURRENCY_NOTES'), 1000);
    // Combat Merits are an inventory stack (the game spends them from there);
    // Ace Chips are on the balance sheet.
    assert.equal(held(a, 'CURRENCY_PJM_WEAPON'), 25);
    assert.equal(wallet.GetWallet(a.UserId).CURRENCY_PJM_WEAPON, undefined);
    assert.equal(wallet.GetWallet(a.UserId).CURRENCY_TOKEN_EXCHANGE_SPEED_UP, 5);
    // The daily Platinum lands in the wallet the store charges from.
    assert.equal(wallet.GetWallet(a.UserId).CURRENCY_PLATINUM, 20);
    assert.equal(wallet.GetWallet(a.UserId).id_currency_platinum, 20);

    assert.equal((await listed(a))[0].remaining, 0);
    assert.throws(() => store.CreateFreePurchase(a.UserId, 'id_currency_platinum', SKU), { status: 409 });
});

test('two tokens fetched the same day pay out once', () => {
    const a = Harness.SeedAccount(context);
    const first = store.CreateFreePurchase(a.UserId, 'id_currency_platinum', SKU).purchaseToken;
    const second = store.CreateFreePurchase(a.UserId, 'id_currency_platinum', SKU).purchaseToken;
    store.RedeemFreePurchase(a.UserId, 'id_currency_platinum', first);
    assert.throws(() => store.RedeemFreePurchase(a.UserId, 'id_currency_platinum', second), { status: 409 });
    // A retried confirmation of the claim that did pay out is still accepted.
    store.RedeemFreePurchase(a.UserId, 'id_currency_platinum', first);
    assert.equal(held(a, 'TOKEN_BOUNTY_DRAFT'), 4);
});

test('the fountain refills at the next UTC midnight and grants add up', async () => {
    const a = Harness.SeedAccount(context);
    claim(a);
    clock += 11 * 60 * 60 * 1000 + 59 * 60 * 1000;   // 23:59, same day
    assert.equal((await listed(a))[0].remaining, 0);
    clock += 2 * 60 * 1000;                          // 00:01, next day
    assert.equal((await listed(a))[0].remaining, 1);
    claim(a);
    assert.equal(held(a, 'CONTAINER_CORE_REWARD_DAILY_02'), 2);
    assert.equal(held(a, 'CURRENCY_NOTES'), 2000);
    assert.equal(held(a, 'CURRENCY_PJM_WEAPON'), 50);
    assert.equal(wallet.GetWallet(a.UserId).CURRENCY_TOKEN_EXCHANGE_SPEED_UP, 10);
});
