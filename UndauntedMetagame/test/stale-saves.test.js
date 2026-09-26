"use strict";
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Harness = require('./harness');
let context, bounties, server, url;
const key = 'disposable-stale-save-test-key';
const today = new Date().toISOString().slice(0, 10);
const time = `${today}T01:00:00.000Z`;
const later = `${today}T02:00:00.000Z`;
const draft = (id = 'Bounty_Test', version = 0, progress = 0, timestamp = time) => ({
    bounty_id: id, slot_index: 0, drafted_timestamp: timestamp,
    update_version: version, claimed: false,
    objectives: [{ objective_id: id, progress }]
});
const reset = { bounties: [], draft_data: {
    current_draft_choices: [], previous_draft_selections: [], bronze_count: 0, silver_count: 0, gold_count: 0
} };
before(async () => {
    context = Harness.CreateDisposableDatabase();
    context.Db.insert(context.Schema.gameserverapikeys).values({ keyHash: crypto.createHash('sha256').update(key).digest('hex') }).run();
    bounties = require('../dist/controllers/bounties');
    const express = require('express'), app = express();
    app.use(express.json());
    app.use(require('../dist/routes/playerJourney').playerJourneyRouter);
    app.use(require('../dist/routes/system').systemRouter);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    await new Promise(resolve => server.close(resolve));
    context.Db.$client.close(); context.Cleanup();
});
async function call(route, body) {
    const res = await fetch(url + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', 'x-undaunted-gameserver-apikey': key },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: res.status, body: await res.json() };
}
const account = () => Harness.SeedAccount(context).UserId;
const save = (id, ...entries) => bounties.SaveBountiesForUser(id, { bounties: entries });
const read = id => bounties.GetBountiesForUser(id).bounties;

test('Slayer Path ignores older and same-version conflicting saves, accepts retries and newer snapshots', async () => {
    const id = account(), route = `/pjm/${id}`;
    const latest = { nodes: { node_a: { unlocked: true }, node_b: { unlocked: true } }, update_version: 12 };
    assert.equal((await call(route, latest)).status, 200);
    for(const stale of [{ nodes: {}, update_version: 11 }, { nodes: {}, update_version: 12 }, latest, { nodes: {} }]) {
        const res = await call(route, stale);
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.payload, latest);
    }
    const next = { nodes: { node_c: { unlocked: true } }, update_version: 13 };
    assert.deepEqual((await call(route, next)).body.payload, next);
    assert.deepEqual((await call(route)).body.payload, next);
    for(const version of [-1, 1.5, '14']) assert.equal((await call(route, { nodes: {}, update_version: version })).status, 400);
    assert.deepEqual((await call(route)).body.payload, next);
});

test('Slayer Path concurrent requests retain the highest version and accounts stay separate', async () => {
    const a = account(), b = account();
    await Promise.all([8, 2, 15, 4, 14].map(v => call(`/pjm/${a}`, { nodes: { value: v }, update_version: v })));
    assert.deepEqual((await call(`/pjm/${a}`)).body.payload, { nodes: { value: 15 }, update_version: 15 });
    assert.deepEqual((await call(`/pjm/${b}`)).body.payload, { nodes: {}, update_version: 1 });
});

test('older, equal-version conflicting, and unversioned bounty saves cannot lower saved progress', async () => {
    const id = account(), latest = draft('Bounty_Test', 5, 70);
    await call(`/bounty/${id}`, { bounties: [latest] });
    for(const entry of [draft('Bounty_Test', 2, 0), draft('Bounty_Test', 5, 0), { ...draft(), update_version: undefined }, latest]) {
        const res = await call(`/bounty/${id}`, { bounties: [entry] });
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.payload.bounties, [latest]);
    }
});

test('newer bounty versions may decrease a penalty-based objective but cannot undo a claim', () => {
    const id = account();
    save(id, draft('Bounty_Test', 2, 500));
    save(id, draft('Bounty_Test', 3, 250));
    assert.equal(read(id)[0].objectives[0].progress, 250);
    save(id, { ...draft('Bounty_Test', 4, 1000), claimed: true });
    save(id, draft('Bounty_Test', 5, 1000));
    assert.equal(read(id)[0].claimed, true);
});

test('new draft generations restart their version and an old generation cannot overwrite them', () => {
    const id = account();
    save(id, { ...draft('Bounty_Test', 9, 100), claimed: true });
    const next = draft('Bounty_Test', 0, 0, later);
    save(id, next);
    save(id, draft('Bounty_Test', 99, 200));
    assert.deepEqual(read(id), [next]);
});

test('replacement of a slot prevents late saves resurrecting its previous occupant', () => {
    const id = account(), next = draft('Bounty_New', 0, 0, later);
    save(id, draft());
    save(id, next);
    save(id, draft('Bounty_Test', 99, 100));
    assert.deepEqual(read(id), [next]);
});

test('a late save cannot resurrect an abandoned bounty, but a later redraft is allowed', () => {
    const id = account();
    save(id, draft());
    bounties.RemoveBountiesForUser(id, ['Bounty_Test']);
    save(id, draft('Bounty_Test', 8, 100));
    assert.deepEqual(read(id), []);
    const fresh = draft('Bounty_Test', 0, 0, later);
    save(id, fresh);
    assert.deepEqual(read(id), [fresh]);
});

test('an explicit drafted-board reset keeps challenges and retires the removed bounty generation', () => {
    const id = account(), challenge = draft('Challenge_Season_Test-season19-0');
    save(id, draft(), challenge);
    bounties.SaveBountiesForUser(id, reset);
    save(id, draft('Bounty_Test', 5, 99));
    assert.deepEqual(read(id), [challenge]);
});

test('incremental batches accept fresh entries without replacing stale entries or their draft metadata', () => {
    const id = account(), current = draft('Bounty_Test', 8, 12);
    const metadata = { previous_draft_selections: ['Bounty_Test'], bronze_count: 7 };
    bounties.SaveBountiesForUser(id, { bounties: [current], draft_data: metadata });
    const challenge = draft('Challenge_Daily_Test', 1, 3);
    bounties.SaveBountiesForUser(id, { bounties: [draft(), challenge], draft_data: { bronze_count: 9 } });
    assert.deepEqual(read(id), [current, challenge]);
    assert.deepEqual(bounties.GetBountiesForUser(id).draft_data, metadata);
    bounties.SaveBountiesForUser(id, { bounties: [], draft_data: { ...metadata, current_draft_choices: ['A'] } });
    assert.deepEqual(read(id), [current, challenge]);
});

test('UTC rollover accepts a new daily challenge and rejects a late save from yesterday', () => {
    const id = account();
    const yesterday = new Date(Date.parse(time) - 86400000).toISOString();
    const old = { ...draft('Challenge_Daily_Test', 10, 100, yesterday), claimed: true };
    save(id, old);
    const fresh = draft('Challenge_Daily_Test', 0, 0);
    save(id, fresh);
    save(id, { ...old, update_version: 99 });
    assert.deepEqual(read(id), [fresh]);
});

test('bounty protection and retirements survive a separate process and stay account-scoped', () => {
    const a = account(), b = account();
    save(a, draft()); bounties.RemoveBountiesForUser(a, ['Bounty_Test']);
    save(b, draft());
    const script = `const b=require('./dist/controllers/bounties');
        console.log(JSON.stringify(b.SaveBountiesForUser(process.argv[1], {bounties:[JSON.parse(process.argv[2])]}).bounties));
        require('./dist/db').GetDb().$client.close();`;
    const out = execFileSync(process.execPath, ['-e', script, a, JSON.stringify(draft('Bounty_Test', 20, 100))],
        { encoding: 'utf8', env: { ...process.env, LOG_LEVEL: 'silent' } });
    assert.deepEqual(JSON.parse(out.trim()), []);
    assert.equal(read(b).length, 1);
});

test('invalid bounty versions are rejected without changing stored data', () => {
    const id = account(), current = draft('Bounty_Test', 2, 6);
    save(id, current);
    for(const value of [-1, 1.5, '3', null]) assert.throws(() => save(id, { ...current, update_version: value }));
    assert.deepEqual(read(id), [current]);
});
