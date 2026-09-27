"use strict";
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Harness = require('./harness');
let context, dir, library, selection, tracks, config, rewards, writes;
const metadata = id => ({ trackId: id, rowName: `HuntPass_Season${id.slice(6)}`, sku: `${id}_premium`,
    storeTag: `${id}_pass`, entitlement: `${id}_premium`, title: id });
const definition = id => ({ progression_id: id, start_date: '2020-01-01T00:00:00Z', end_date: '2020-02-01T00:00:00Z',
    premium_gating_entitlement: `${id}_premium`, requirements: [{ rank_id: 0, xp_required: 0 }, { rank_id: 1, xp_required: 100 }],
    free_rewards: [{ rank_id: 1, stacked_items: [{ catalog_id: 'CURRENCY_PLATINUM_UNIV', quantity: 5 }] }], premium_rewards: [] });
before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huntpass-library-'));
    fs.mkdirSync(path.join(dir, 'seasons'));
    fs.writeFileSync(path.join(dir, 'seasons', 'paths.json'), JSON.stringify([
        definition('season09a'), definition('season09a_vault'), definition('season19'), definition('season10a'), definition('eventpass_test')
    ]));
    fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify(['season09a', 'season09a_vault', 'season19'].map(metadata)));
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
    for(const id of ['season09a','season09a_vault','season19']) {
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
    for(const id of ['season09a','season09a_vault','season09a']) {
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
    for(const id of ['season19','season09a','season09a_vault']) assert.equal(ids.filter(x => x === id).length, 1);
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
    }
});

test('switching away and back retains XP and claims without paying the same rank twice', () => {
    const a = Harness.SeedAccount(context);
    selection.SetSelectedHuntPassId(a.UserId, 'season09a');
    writes.ApplyProgressAndObjectives(a.UserId, [{ progression_id: 'season09a', progress: 100 }], [], undefined, 'library-award-a');
    writes.ConfirmRank(a.UserId, a.CharacterId, 'season09a', 1, 'free');
    const wallet = require('../dist/controllers/wallet');
    const balance = wallet.WalletBalance(context.Db, a.UserId, 'CURRENCY_PLATINUM_UNIV');
    selection.SetSelectedHuntPassId(a.UserId, 'season09a_vault');
    writes.ApplyProgressAndObjectives(a.UserId, [{ progression_id: 'season09a_vault', progress: 30 }], []);
    selection.SetSelectedHuntPassId(a.UserId, 'season09a');
    assert.equal(tracks.GetWireTrack(a.UserId, 'season09a').progress, 100);
    assert.equal(tracks.GetWireTrack(a.UserId, 'season09a_vault').progress, 30);
    assert.equal(tracks.GetWireTrack(a.UserId, 'season19').progress, 0);
    writes.ApplyProgressAndObjectives(a.UserId, [{ progression_id: 'season09a', progress: 100 }], [], undefined, 'library-award-a');
    writes.ConfirmRank(a.UserId, a.CharacterId, 'season09a', 1, 'free');
    assert.equal(wallet.WalletBalance(context.Db, a.UserId, 'CURRENCY_PLATINUM_UNIV'), balance);
    assert.equal(tracks.GetWireTrack(a.UserId, 'season09a').progress, 100);
    assert.throws(() => rewards.ClaimRanksUpTo(a.UserId, a.CharacterId, 'season09a', 1, 'premium'));
});
