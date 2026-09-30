"use strict";
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Harness = require('./harness');
let context, dir, library, selection, tracks, config, rewards, writes;
const metadata = id => ({ trackId: id, rowName: `HuntPass_Season${id.slice(6)}`, sku: `${id}_premium`,
    storeTag: `${id}_pass`, entitlement: `${id}_premium`, title: id,
    description: `Description of ${id}`, hasFreeTrack: !id.endsWith('_vault') });
const definition = id => ({ progression_id: id, start_date: '2020-01-01T00:00:00Z', end_date: '2020-02-01T00:00:00Z',
    premium_gating_entitlement: `${id}_premium`, requirements: [{ rank_id: 0, xp_required: 0 }, { rank_id: 1, xp_required: 100 }],
    free_rewards: id.endsWith('_vault') ? [] : [{ rank_id: 1, stacked_items: [{ catalog_id: 'CURRENCY_PLATINUM_UNIV', quantity: 5 },
        { catalog_id: 'CURRENCY_S15_COIN', quantity: 200 },
        { catalog_id: 'CURRENCY_TOKEN_EXCHANGE_SPEED_UP', quantity: 25 }] }], premium_rewards: [] });
before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huntpass-library-'));
    fs.mkdirSync(path.join(dir, 'seasons'));
    fs.writeFileSync(path.join(dir, 'seasons', 'paths.json'), JSON.stringify([
        definition('season09a'), definition('season09a_vault'), definition('season08a_vault'), definition('season19'), definition('season10a'), definition('eventpass_test')
    ]));
    fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify(['season09a', 'season09a_vault', 'season08a_vault', 'season19'].map(metadata)));
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify({ events: [{ name: 'Timed', start: '2026-09-01T00:00:00Z',
        end: '2026-10-01T00:00:00Z', scheduledItems: ['EVENT_TEST'], eventPasses: ['eventpass_test'], storeTags: ['eventpass_test_pass'] }] }));
    process.env.HUNT_PASS_LIBRARY_FILE = path.join(dir, 'library.json');
    process.env.HUNT_PASS_SEASONS_DIR = path.join(dir, 'seasons');
    process.env.SEASONAL_EVENTS_FILE = path.join(dir, 'events.json');
    process.env.ACTIVE_HUNT_PASS = 'season19';
    context = Harness.CreateDisposableDatabase();
    library = require('../dist/controllers/huntpassLibrary');
    selection = require('../dist/controllers/huntpassSelection');
    tracks = require('../dist/controllers/progressionTracks');
    config = require('../dist/controllers/huntpass');
    rewards = require('../dist/controllers/huntpassRewards');
    writes = require('../dist/controllers/progressionWrites');
});
after(() => {
    context.Db.$client.close(); context.Cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
    for(const key of ['HUNT_PASS_LIBRARY_FILE','HUNT_PASS_SEASONS_DIR','SEASONAL_EVENTS_FILE','ACTIVE_HUNT_PASS']) delete process.env[key];
});
test('only explicitly listed regular/vault tracks are permanent; event dates and other tracks remain unchanged', () => {
    const paths = new Map(config.GetProgressionConfigPayload().payload.paths.map(p => [p.progression_id, p]));
    for(const id of ['season09a','season08a_vault','season19']) {
        assert.equal(paths.get(id).end_date, '2099-01-01T00:00:00+00:00');
        assert.equal(paths.get(id).start_date, '2020-01-01T00:00:00Z');
    }
    assert.equal(paths.get('eventpass_test').end_date, '2026-10-01T00:00:00+00:00');
    assert.equal(paths.get('season10a').end_date, '2020-02-01T00:00:00Z');
    assert.equal(config.GetActiveHuntPassId(), 'season19');
});
test('library rejects events, placeholders, duplicate track IDs, rows and SKUs', () => {
    for(const entry of [metadata('eventpass_test'), metadata('test_minipass01'), metadata('MasteryTrack_PlayerLevel')])
        assert.throws(() => library.ParseHuntPassLibrary([entry]));
    const first = metadata('season09a'), second = metadata('season09b');
    for(const field of ['trackId','rowName','sku']) assert.throws(() => library.ParseHuntPassLibrary([first, {...second, [field]: first[field]}]));
});
test('regular/vault selection survives switching and events fall back exactly at expiry', () => {
    const a = Harness.SeedAccount(context), b = Harness.SeedAccount(context);
    const now = Date.parse('2026-09-26T20:00:00Z');
    for(const id of ['season09a','season08a_vault','season09a']) {
        selection.SetSelectedHuntPassId(a.UserId, id, now);
        assert.equal(selection.GetSelectedHuntPassId(a.UserId, now), id);
        assert.equal(selection.GetSelectedHuntPassId(b.UserId, now), 'season19');
    }
    assert.throws(() => selection.SetSelectedHuntPassId(a.UserId, 'season10a', now));
    selection.SetSelectedHuntPassId(a.UserId, 'eventpass_test', now);
    assert.equal(selection.GetSelectedHuntPassId(a.UserId, Date.parse('2026-10-01T00:00:00Z')), 'season19');
    selection.SetSelectedHuntPassId(a.UserId, 'season09a', now);
    assert.equal(selection.GetSelectedHuntPassId(a.UserId, Date.parse('2030-10-01T00:00:00Z')), 'season09a');
});
test('selector receives each library track once and merely reading/selecting creates no progress or premium', () => {
    const a = Harness.SeedAccount(context);
    selection.SetSelectedHuntPassId(a.UserId, 'season09a');
    const ids = tracks.GetWireProgressionTracks(a.UserId).map(t => t.progression_id);
    for(const id of ['season19','season09a','season08a_vault']) assert.equal(ids.filter(x => x === id).length, 1);
    assert.equal(context.Db.select().from(context.Schema.progression).all().length, 0);
    assert.equal(tracks.HasPremiumForTrack(a.UserId, 'season09a'), false);
});
test('store library adds distinct free unlock offers without altering timed event offers', () => {
    const event = { id: 'eventpass_test_premium', tags: ['eventpass_test_pass','huntpass_store'], platinumPrice: 100 };
    const input = { huntpass_store: [event], eventpass_test_pass: [event], season19_pass: [{id:'season19_premium'}] };
    const result = library.AddHuntPassLibraryOffers(input);
    assert.equal(result.huntpass_store.length, 4);
    assert.equal(result.huntpass_store[0], event);
    assert.equal(result.eventpass_test_pass[0], event);
    assert.equal(result.season19_pass[0], result.huntpass_store.find(o => o.id === 'season19_premium'));
    for(const pass of library.HuntPassLibrary) {
        const offer = result[pass.storeTag][0];
        assert.equal(offer.platinumPrice, 0);
        assert.equal(offer.availableTo, null);
        assert.deepEqual(offer.entitlements, [{ name: pass.entitlement, duration: 0 }]);
        assert.ok(offer.displayDescription.includes(pass.description));
        if(pass.hasFreeTrack) assert.equal(offer.displayName, `${pass.title} — Elite Upgrade`);
    }
});

test('switching away and back retains XP and claims without paying the same rank twice', () => {
    const a = Harness.SeedAccount(context);
    selection.SetSelectedHuntPassId(a.UserId, 'season09a');
    writes.ApplyProgressAndObjectives(a.UserId, [{ progression_id: 'season09a', progress: 100 }], [], undefined, 'library-award-a');
    writes.ConfirmRank(a.UserId, a.CharacterId, 'season09a', 1, 'free');
    const wallet = require('../dist/controllers/wallet');
    const balance = wallet.WalletBalance(context.Db, a.UserId, 'CURRENCY_PLATINUM_UNIV');
    selection.SetSelectedHuntPassId(a.UserId, 'season08a_vault');
    writes.ApplyProgressAndObjectives(a.UserId, [{ progression_id: 'season08a_vault', progress: 30 }], []);
    selection.SetSelectedHuntPassId(a.UserId, 'season09a');
    assert.equal(tracks.GetWireTrack(a.UserId, 'season09a').progress, 100);
    assert.equal(tracks.GetWireTrack(a.UserId, 'season08a_vault').progress, 30);
    assert.equal(tracks.GetWireTrack(a.UserId, 'season19').progress, 0);
    writes.ApplyProgressAndObjectives(a.UserId, [{ progression_id: 'season09a', progress: 100 }], [], undefined, 'library-award-a');
    writes.ConfirmRank(a.UserId, a.CharacterId, 'season09a', 1, 'free');
    assert.equal(wallet.WalletBalance(context.Db, a.UserId, 'CURRENCY_PLATINUM_UNIV'), balance);
    assert.equal(wallet.WalletBalance(context.Db, a.UserId, 'CURRENCY_S19_COIN'), 200);
    assert.equal(wallet.WalletBalance(context.Db, a.UserId, 'CURRENCY_S15_COIN'), 0);
    assert.equal(wallet.WalletBalance(context.Db, a.UserId, 'CURRENCY_CELLDUST'), 100);
    assert.equal(wallet.GetWallet(a.UserId).CURRENCY_TOKEN_EXCHANGE_SPEED_UP, undefined);
    assert.equal(tracks.GetWireTrack(a.UserId, 'season09a').progress, 100);
    assert.throws(() => rewards.ClaimRanksUpTo(a.UserId, a.CharacterId, 'season09a', 1, 'premium'));
});

test('regular selection and cancelled checkout do not grant Elite; explicit redemption persists it once', () => {
    const a = Harness.SeedAccount(context);
    const store = require('../dist/controllers/freeStore');
    selection.SetSelectedHuntPassId(a.UserId, 'season09a');
    const offer = store.GetOffersForTag(a.UserId, 'season09a_pass')[0];
    assert.equal(offer.platinumPrice, 0);
    assert.equal(offer.remaining, 1);
    assert.equal(tracks.HasPremiumForTrack(a.UserId, 'season09a'), false);
    const token = store.CreateFreePurchase(a.UserId, 'platinum', offer.id).purchaseToken;
    // Obtaining a checkout token without confirming it must grant nothing.
    assert.equal(tracks.HasPremiumForTrack(a.UserId, 'season09a'), false);
    assert.throws(() => rewards.ClaimRanksUpTo(a.UserId, a.CharacterId, 'season09a', 1, 'premium'));
    store.RedeemFreePurchase(a.UserId, 'platinum', token);
    store.RedeemFreePurchase(a.UserId, 'platinum', token);
    assert.equal(tracks.HasPremiumForTrack(a.UserId, 'season09a'), true);
    selection.SetSelectedHuntPassId(a.UserId, 'season19');
    selection.SetSelectedHuntPassId(a.UserId, 'season09a');
    assert.equal(tracks.HasPremiumForTrack(a.UserId, 'season09a'), true);
    assert.equal(tracks.HasPremiumForTrack(a.UserId, 'season19'), false);
    assert.equal(store.GetOffersForTag(a.UserId, 'season09a_pass')[0].remaining, 0);
});

test('metadata cannot silently regress to placeholder titles or lose descriptions and track classification', () => {
    for(const change of [{title:'Hunt Pass 13a'}, {description:''}, {hasFreeTrack:undefined}])
        assert.throws(() => library.ParseHuntPassLibrary([{...metadata('season13a'), ...change}]));
});

test('a free track requires actual rewards, not merely placeholder rank rows or a naming convention', () => {
    assert.equal(library.HasFreeHuntPassRewards({free_rewards:[{rank_id:0},{rank_id:1,stacked_items:[]}]}), false);
    assert.equal(library.HasFreeHuntPassRewards({free_rewards:[{rank_id:1,stacked_items:[{catalog_id:'X',quantity:1}]}]}), true);
    assert.equal(library.HasFreeHuntPassRewards({}), false);
});

test('premium-only library passes are accessible without purchasing or creating entitlements; other passes are not', () => {
    const a = Harness.SeedAccount(context);
    const store = require('../dist/controllers/freeStore');
    selection.SetSelectedHuntPassId(a.UserId, 'season08a_vault');
    assert.equal(tracks.HasPremiumForTrack(a.UserId, 'season08a_vault'), true);
    assert.equal(store.GetOffersForTag(a.UserId, 'season08a_vault_pass')[0].remaining, 0);
    assert.equal(tracks.HasPremiumForTrack(a.UserId, 'season09a'), false);
    assert.equal(tracks.HasPremiumForTrack(a.UserId, 'eventpass_test'), false);
    assert.equal(tracks.HasPremiumForTrack(a.UserId, 'season09a_vault'), false); // hidden duplicate
    const { eq } = require('drizzle-orm');
    assert.equal(context.Db.select().from(context.Schema.entitlements)
        .where(eq(context.Schema.entitlements.userId, a.UserId)).all().length, 0);
});

test('season coin display and payouts share the normalized config; other rewards and events stay intact', () => {
    const wire = config.GetProgressionConfigPayload().payload.paths.find(p => p.progression_id === 'season09a');
    assert.deepEqual(wire.free_rewards, config.GetTrackConfig('season09a').free_rewards);
    assert.deepEqual(wire.free_rewards[0].stacked_items, [
        {catalog_id:'CURRENCY_PLATINUM_UNIV',quantity:5}, {catalog_id:'CURRENCY_S19_COIN',quantity:200},
        {catalog_id:'CURRENCY_CELLDUST',quantity:100}]);
    assert.equal(config.GetTrackConfig('eventpass_test').free_rewards[0].stacked_items[1].catalog_id, 'CURRENCY_S15_COIN');
    const original = {...definition('season08a_vault'), prestige: {xp_per_level:100,
        premium_rewards:{stacked_items:[{catalog_id:'CURRENCY_S14_COIN',quantity:10}]}}};
    const normalized = config.WithElementalCacheRewards(original);
    assert.equal(normalized.prestige.premium_rewards.stacked_items[0].catalog_id,'CURRENCY_S19_COIN');
    assert.equal(original.prestige.premium_rewards.stacked_items[0].catalog_id,'CURRENCY_S14_COIN');
});

test('each Ace Chip reward becomes 100 Aetherdust across regular and vault lanes without changing existing dust', () => {
    for(const id of ['season12b', 'season12b_vault']) {
        const reward = quantity => ({stacked_items:[
            {catalog_id:'CURRENCY_TOKEN_EXCHANGE_SPEED_UP',quantity,hidden:false,priority:2},
            {catalog_id:'CURRENCY_CELLDUST',quantity:30}]});
        const input = {...definition(id), free_rewards:[reward(25)], premium_rewards:[reward(50)],
            prestige:{xp_per_level:100,free_rewards:reward(100),premium_rewards:reward(25)}};
        const result = config.WithElementalCacheRewards(input);
        for(const entry of [result.free_rewards[0],result.premium_rewards[0],
            result.prestige.free_rewards,result.prestige.premium_rewards]) {
            assert.deepEqual(entry.stacked_items,[
                {catalog_id:'CURRENCY_CELLDUST',quantity:100,hidden:false,priority:2},
                {catalog_id:'CURRENCY_CELLDUST',quantity:30}]);
        }
        assert.equal(input.free_rewards[0].stacked_items[0].catalog_id,'CURRENCY_TOKEN_EXCHANGE_SPEED_UP');
        assert.deepEqual(config.WithElementalCacheRewards(result),result);
    }
});

test('vault coins convert at ranks and prestige, and legacy cosmetics appear once in the ordered rewards', () => {
    const item = 'BNC_FABRIC_EVENT_HP09B_COMMANDO_00';
    const rank = {rank_id:13, instanced_items:[item,'BNC_STANDARD_HP10A_CELESTIAL_00'],
        ordered_instanced_items:[{catalog_id:item,hidden:false,priority:2}],
        stacked_items:[{catalog_id:'CURRENCY_PRESTIGE',quantity:50}]};
    const input = {...definition('season09b'), premium_rewards:[rank],
        prestige:{xp_per_level:100,free_rewards:{stacked_items:[{catalog_id:'CURRENCY_PRESTIGE',quantity:1}]}}};
    const result = config.WithElementalCacheRewards(input);
    assert.deepEqual(result.premium_rewards[0].instanced_items, []);
    assert.equal(result.premium_rewards[0].ordered_instanced_items.length,2);
    assert.equal(result.premium_rewards[0].ordered_instanced_items[0].priority,2);
    assert.deepEqual(rewards.ClassifyReward(result.premium_rewards[0]).InstancedIds,
        [item,'BNC_STANDARD_HP10A_CELESTIAL_00']);
    assert.deepEqual(rewards.ClassifyReward(result.premium_rewards[0]).Currencies,
        [{currencyId:'CURRENCY_S19_COIN',quantity:50}]);
    assert.equal(result.prestige.free_rewards.stacked_items[0].catalog_id,'CURRENCY_S19_COIN');
    assert.equal(rank.stacked_items[0].catalog_id,'CURRENCY_PRESTIGE');
    assert.deepEqual(config.WithElementalCacheRewards(result),result);
});

test('legacy instanced cosmetics follow the current catalog grant kind without duplicating unlocks', () => {
    const kinds = require('../dist/controllers/storeCatalog').StoreItemKinds;
    const id = 'TEST_LEGACY_BANNER';
    kinds[id] = 'stacked';
    try {
        const input = {...definition('season10a'), premium_rewards:[{rank_id:13,
            instanced_items:[id], ordered_instanced_items:[{catalog_id:id,priority:2}], stacked_items:[]}]};
        const result = config.WithElementalCacheRewards(input);
        const grant = rewards.ClassifyReward(result.premium_rewards[0]);
        assert.deepEqual(grant.InstancedIds, []);
        assert.deepEqual(grant.StackedItems, [{catalogId:id,quantity:1}]);
        assert.deepEqual(config.WithElementalCacheRewards(result),result);
    } finally { delete kinds[id]; }
});

test('duplicate vaults are hidden, unselectable, and retained selections fall back without deleting progress', () => {
    assert.equal(library.IsLibraryHuntPass('season09a_vault'), false);
    assert.equal(library.IsLibraryHuntPass('season08a_vault'), true);
    const a = Harness.SeedAccount(context);
    context.Db.insert(context.Schema.selectedhuntpasses).values({userId:a.UserId, progressionId:'season09a_vault', updatedAt:Date.now()}).run();
    assert.equal(selection.GetSelectedHuntPassId(a.UserId), 'season19');
    assert.throws(() => selection.SetSelectedHuntPassId(a.UserId, 'season09a_vault'));
    assert.ok(!tracks.GetWireProgressionTracks(a.UserId).some(t => t.progression_id === 'season09a_vault'));
    const old = {id:'season09a_vault_premium'};
    const catalog = library.AddHuntPassLibraryOffers({huntpass_store:[old],season09a_vault_pass:[old]});
    assert.ok(!catalog.huntpass_store.some(o => o.id === old.id));
    assert.deepEqual(catalog.season09a_vault_pass, []);
});
