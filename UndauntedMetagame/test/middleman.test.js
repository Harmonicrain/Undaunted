const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness');
let ctx, inv, store;
before(() => {
    process.env.STORE_OFFER_FORMAT = 'prices';
    ctx = H.CreateDisposableDatabase();
    inv = require('../dist/features/inventory/inventory');
    const catalog = require('../dist/features/store/catalog');
    // Fixture mimics the configured 1.12 game catalogue without live files.
    const id = 'CELL_AR_HEALTH_UC';
    catalog.StoreItemKinds[id] = 'stacked';
    catalog.StoreCatalog.weekly_cell_offering = [{ id: 'middleman_test_cell', tags: ['weekly_cell_offering'],
        items: [{ catalogId: id, quantity: 1 }], entitlements: [], repeatable: true,
        priceCurrency: 'CURRENCY_CELLDUST', price: 80 }];
    store = require('../dist/features/store/store');
});
after(() => { ctx.Db.$client.close(); ctx.Cleanup(); });
const run = (a, id, add = [], remove = [], stacks = []) => inv.RunInventoryTransaction(a.UserId, a.CharacterId, id, add, stacks, remove, [], []);
test('completed fusion consumes version-zero token; replay cannot duplicate reward', async () => {
    const a = H.SeedAccount(ctx);
    const token = { catalogId: 'TOKEN_CELL_EXCHANGE', instanceId: 'TOKEN_CELL_EXCHANGE', updateVersion: 0,
        itemData: JSON.stringify({ SlotID: 1, ExchangeID: 'fusion-a', EndTime: '2020-01-01T00:00:00Z', ResultCell: 'CELL_AR_HEALTH_UC' }) };
    assert.equal((await run(a, 'seed-fusion', [token])).success, true);
    const remove = [{ catalogId: token.catalogId, instanceId: token.instanceId, updateVersion: 0 }];
    const prize = [{ catalogId: 'CELL_AR_HEALTH_UC', quantity: 1 }];
    assert.equal((await run(a, 'bad-reward', [], remove, [{ catalogId: 'CELL_WRONG', quantity: 1 }])).success, false);
    assert.equal((await run(a, 'reveal', [], remove, prize)).success, true);
    assert.equal((await run(a, 'reveal', [], remove, prize)).success, true);
    assert.equal((await run(a, 'reveal-new-id', [], remove, prize)).success, false);
    assert.equal(H.StackedQuantity(H.ReadInventory(ctx, a.CharacterId), prize[0].catalogId), 1);
});
test('unfinished fusion remains intact', async () => {
    const a = H.SeedAccount(ctx);
    const token = { catalogId: 'TOKEN_CELL_EXCHANGE', instanceId: 'token', updateVersion: 0,
        itemData: JSON.stringify({ SlotID: 1, ExchangeID: 'later', EndTime: '2099-01-01T00:00:00Z', ResultCell: 'CELL_AR_HEALTH_UC' }) };
    await run(a, 'seed-later', [token]);
    assert.equal((await run(a, 'early', [], [token], [{ catalogId: 'CELL_AR_HEALTH_UC', quantity: 1 }])).success, false);
    assert.equal(H.ReadInventory(ctx, a.CharacterId).instancedItems.length, 1);
});
test('all three fusion slots persist independently and speed-up followed by reveal works', async () => {
    const a = H.SeedAccount(ctx);
    await run(a, 'three-slot-dust', [], [], [{ catalogId: 'CURRENCY_CELLDUST', quantity: 700 }]);
    for (const slot of [1, 2, 3]) {
        const token = { catalogId: 'TOKEN_CELL_EXCHANGE', instanceId: 'TOKEN_CELL_EXCHANGE', updateVersion: 0,
            itemData: JSON.stringify({ SlotID: slot, ExchangeID: `fusion-${slot}`,
                EndTime: '2099-01-01T00:00:00Z', ResultCell: 'CELL_AR_HEALTH_UC' }) };
        assert.equal((await run(a, `start-${slot}`, [token])).success, true);
    }
    let held = H.ReadInventory(ctx, a.CharacterId);
    assert.deepEqual(held.instancedItems.map(i => i.instanceId).sort(), [
        'TOKEN_CELL_EXCHANGE:1', 'TOKEN_CELL_EXCHANGE:2', 'TOKEN_CELL_EXCHANGE:3']);

    const slot2 = held.instancedItems.find(i => i.instanceId === 'TOKEN_CELL_EXCHANGE:2');
    const spedUp = { ...slot2, itemData: JSON.stringify({ ...JSON.parse(slot2.itemData), EndTime: '2020-01-01T00:00:00Z' }) };
    const speedResult = await inv.RunInventoryTransaction(a.UserId, a.CharacterId, 'speed-2', [], [], [],
        [{ catalogId: 'CURRENCY_TOKEN_EXCHANGE_SPEED_UP', quantity: 132 }], [spedUp]);
    assert.equal(speedResult.success, true);
    const wallet = require('../dist/features/wallet/wallet').GetWallet(a.UserId);
    assert.equal(wallet.CURRENCY_CELLDUST, 568);
    assert.equal(wallet.CURRENCY_TOKEN_EXCHANGE_SPEED_UP, undefined);

    const reveal = await run(a, 'reveal-2', [], [spedUp], [{ catalogId: 'CELL_AR_HEALTH_UC', quantity: 1 }]);
    assert.equal(reveal.success, true);
    held = H.ReadInventory(ctx, a.CharacterId);
    assert.deepEqual(held.instancedItems.map(i => i.instanceId).sort(), [
        'TOKEN_CELL_EXCHANGE:1', 'TOKEN_CELL_EXCHANGE:3']);
    assert.equal(H.StackedQuantity(held, 'CELL_AR_HEALTH_UC'), 1);
});
test('both free slot offers grant permanent entitlements once', () => {
    const a = H.SeedAccount(ctx);
    for (const n of [2, 3]) {
        const offer = store.GetOffersForTag(a.UserId, `exchange_vendor_slot_${n}`)[0];
        assert.equal(offer.platinumPrice, 0);
        const t = store.CreateFreePurchase(a.UserId, 'platinum', offer.id).purchaseToken;
        store.RedeemFreePurchase(a.UserId, 'platinum', t);
        store.RedeemFreePurchase(a.UserId, 'platinum', t);
        assert.equal(store.GetOffersForTag(a.UserId, `exchange_vendor_slot_${n}`)[0].remaining, 0);
    }
    const rows = ctx.Db.select().from(ctx.Schema.entitlements).all().filter(r => r.userId === a.UserId);
    assert.deepEqual(rows.map(r => r.entitlement).sort(), ['exchange_slot_2', 'exchange_slot_3']);
    assert.ok(rows.every(r => r.duration === 0));
});
test('cell purchases spend dust atomically, allow another purchase, and reject insufficient dust', async () => {
    const a = H.SeedAccount(ctx);
    await run(a, 'dust-seed', [], [], [{ catalogId: 'CURRENCY_CELLDUST', quantity: 160 }]);
    for (let i = 0; i < 2; i++) {
        const t = store.CreateFreePurchase(a.UserId, 'id_currency_celldust', 'middleman_test_cell').purchaseToken;
        store.RedeemFreePurchase(a.UserId, 'id_currency_celldust', t);
        store.RedeemFreePurchase(a.UserId, 'id_currency_celldust', t);
    }
    assert.equal(H.StackedQuantity(H.ReadInventory(ctx, a.CharacterId), 'CELL_AR_HEALTH_UC'), 2);
    assert.throws(() => store.CreateFreePurchase(a.UserId, 'id_currency_celldust', 'middleman_test_cell'));
});
