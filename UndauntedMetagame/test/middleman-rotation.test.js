const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness');
const rotation = require('../dist/features/middleman/offers');
const source = Array.from({ length: 12 }, (_, index) => {
    const family = Math.floor(index / 2), rank = index % 2 + 1;
    const id = `CELL_TEST_${family}_${rank === 1 ? 'UC' : 'R'}`;
    return { id: `free_${id}`, displayName: `+${rank} Test ${family} Cell`, tags: ['webstore'],
        items: [{ catalogId: id, quantity: 1 }], entitlements: [], platinumPrice: 0 };
});
const kinds = Object.fromEntries(source.map(offer => [offer.items[0].catalogId, 'stacked']));
let ctx, pool, store, wallet;
before(() => {
    process.env.STORE_OFFER_FORMAT = 'prices';
    pool = rotation.AddMiddlemanOffers({ webstore: source }, kinds).weekly_cell_offering;
    ctx = H.CreateDisposableDatabase();
    const catalog = require('../dist/features/store/catalog');
    catalog.StoreCatalog.weekly_cell_offering = pool;
    Object.assign(catalog.StoreItemKinds, kinds);
    store = require('../dist/features/store/store');
    wallet = require('../dist/features/wallet/wallet');
});
after(() => { ctx.Db.$client.close(); ctx.Cleanup(); });

test('rotation excludes prototypes, unknown grants and incomplete cell ranks', () => {
    const bad = [
        { ...source[0], displayName: 'Old Prototype Cell', items: [{ catalogId: 'CELL_OLD_UC', quantity: 1 }] },
        { ...source[0], items: [{ catalogId: 'CELL_UNKNOWN_UC', quantity: 1 }] },
        { ...source[0], items: [{ catalogId: 'CELL_LONE_UC', quantity: 1 }] },
        { ...source[0], items: [{ catalogId: 'CELL_MULTI_UC', quantity: 2 }] }
    ];
    const catalog = rotation.AddMiddlemanOffers({ webstore: [...source, ...bad] },
        { ...kinds, CELL_OLD_UC: 'stacked', CELL_LONE_UC: 'stacked', CELL_MULTI_UC: 'stacked' });
    assert.equal(catalog.weekly_cell_offering.length, 12);
});

test('same week is stable across catalogue ordering and server reloads', () => {
    const now = new Date('2026-09-29T12:00:00Z');
    const current = rotation.SelectWeeklyMiddlemanOffers(pool, now);
    const reloaded = rotation.AddMiddlemanOffers({ webstore: [...source].reverse() }, kinds).weekly_cell_offering;
    assert.deepEqual(rotation.SelectWeeklyMiddlemanOffers(reloaded, now), current);
    assert.deepEqual(rotation.SelectWeeklyMiddlemanOffers(pool, new Date('2026-10-01T17:59:59Z')), current);
    assert.deepEqual(current.map(row => row.price), [80, 80, 200]);
    assert.equal(new Set(current.map(row => row._middlemanFamily)).size, 3);
    assert.ok(current.every(row => row.availableFrom === '2026-09-24T18:00:00.000Z'
        && row.availableTo === '2026-10-01T18:00:00.000Z'));
});

test('Thursday 18:00 UTC changes all three families without a restart', () => {
    const before = rotation.SelectWeeklyMiddlemanOffers(pool, new Date('2026-10-01T17:59:59Z'));
    const after = rotation.SelectWeeklyMiddlemanOffers(pool, new Date('2026-10-01T18:00:00Z'));
    assert.equal(after.length, 3);
    assert.ok(after.every(row => !before.some(old => old._middlemanFamily === row._middlemanFamily)));
});

test('players share offers; dust purchases work and expired-window tokens cannot charge', t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T17:59:59Z') });
    const a = H.SeedAccount(ctx), b = H.SeedAccount(ctx);
    wallet.CreditWallet(ctx.Db, a.UserId, 'CURRENCY_CELLDUST', 1000);
    const current = store.GetOffersForTag(a.UserId, 'weekly_cell_offering');
    assert.deepEqual(store.GetOffersForTag(b.UserId, 'weekly_cell_offering'), current);
    const inactive = pool.find(offer => !current.some(row => row.id === offer.id));
    assert.throws(() => store.GetOfferById(a.UserId, inactive.id), /Unknown store offer/);
    assert.throws(() => store.CreateFreePurchase(a.UserId, 'platinum', current[0].id), /Unsupported store currency/);
    const purchase = store.CreateFreePurchase(a.UserId, 'id_currency_celldust', current[0].id);
    store.RedeemFreePurchase(a.UserId, 'id_currency_celldust', purchase.purchaseToken);
    assert.equal(wallet.WalletBalance(ctx.Db, a.UserId, 'CURRENCY_CELLDUST'), 920);
    assert.equal(H.StackedQuantity(H.ReadInventory(ctx, a.CharacterId), current[0].items[0].catalogId), 1);
    const stale = store.CreateFreePurchase(a.UserId, 'id_currency_celldust', current[0].id);
    t.mock.timers.tick(2000);
    const next = store.GetOffersForTag(a.UserId, 'weekly_cell_offering');
    assert.ok(next.every(row => !current.some(old => old.id === row.id)));
    assert.deepEqual(store.GetOffersForTag(b.UserId, 'weekly_cell_offering'), next);
    assert.throws(() => store.RedeemFreePurchase(a.UserId, 'id_currency_celldust', stale.purchaseToken), /ended/);
    assert.equal(wallet.WalletBalance(ctx.Db, a.UserId, 'CURRENCY_CELLDUST'), 920);
    // Retrying an already redeemed token remains safe across the reset.
    store.RedeemFreePurchase(a.UserId, 'id_currency_celldust', purchase.purchaseToken);
    assert.equal(wallet.WalletBalance(ctx.Db, a.UserId, 'CURRENCY_CELLDUST'), 920);
});
