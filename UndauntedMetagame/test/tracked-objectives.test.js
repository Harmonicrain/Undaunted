"use strict";
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Harness = require('./harness');
let context, server, url, sign;

before(async () => {
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(keys.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
    process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(keys.publicKey.export({ type: 'spki', format: 'pem' })).toString('base64');
    context = Harness.CreateDisposableDatabase();
    sign = require('../dist/controllers/auth').SignMetagameJWTForUid;
    const app = require('express')();
    app.use(require('express').json());
    app.use(require('../dist/routes/client112').client112Router);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    await new Promise(resolve => server.close(resolve));
    context.Db.$client.close(); context.Cleanup();
});

const snapshot = () => ({ current_set: 'CHALLENGES_SET',
    omitted_quests: ['11111111-2222-3333-4444-555555555555'],
    tracked_quests: ['AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'],
    tracked_craftables: ['WP_SWORD_BEGINNER', 'AR_HEAD_BEGINNER'] });
const empty = () => ({ current_set: 'quest_slayer_links', omitted_quests: [], tracked_quests: [], tracked_craftables: [] });
async function request(actor, target, body) {
    const response = await fetch(`${url}/progression/tracked_objectives/${target}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${sign(actor)}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    return { status: response.status, body: text.startsWith('{') ? JSON.parse(text) : text };
}

test('a new account gets the existing baseline without creating a saved row', async () => {
    const a = Harness.SeedAccount(context);
    const result = await request(a.UserId, a.UserId);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.payload, { ...empty(), phx_account_id: a.UserId });
    assert.equal(context.Db.$client.prepare('SELECT COUNT(*) AS n FROM trackedobjectives WHERE userId = ?').get(a.UserId).n, 0);
});

test('native snapshots survive fresh logins and a separate process reading the database', async () => {
    const a = Harness.SeedAccount(context);
    const data = { ...snapshot(), phx_account_id: a.UserId };
    const saved = await request(a.UserId, a.UserId, data);
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { code: null, message: 'OK', payload: null });
    assert.deepEqual((await request(a.UserId, a.UserId)).body.payload, data);
    // A fresh process has neither the original controller nor its DB connection.
    const script = `const {GetTrackedObjectives}=require('./dist/controllers/trackedObjectives');
        console.log(JSON.stringify(GetTrackedObjectives(process.argv[1]))); require('./dist/db').GetDb().$client.close();`;
    const reopened = execFileSync(process.execPath, ['-e', script, a.UserId], { encoding: 'utf8', env: { ...process.env, LOG_LEVEL: 'silent' } });
    assert.deepEqual(JSON.parse(reopened.trim()), data);
});

test('unpinning and changing category replace the old snapshot, including empty lists', async () => {
    const a = Harness.SeedAccount(context);
    await request(a.UserId, a.UserId, snapshot());
    const cleared = { ...empty(), current_set: '' };
    assert.equal((await request(a.UserId, a.UserId, cleared)).status, 200);
    assert.deepEqual((await request(a.UserId, a.UserId)).body.payload, { ...cleared, phx_account_id: a.UserId });
});

test('accounts are isolated and unauthenticated or cross-account requests cannot read or write pins', async () => {
    const a = Harness.SeedAccount(context), b = Harness.SeedAccount(context);
    await request(a.UserId, a.UserId, snapshot());
    assert.deepEqual((await request(b.UserId, b.UserId)).body.payload, { ...empty(), phx_account_id: b.UserId });
    for(const body of [undefined, snapshot()]) {
        assert.equal((await request(a.UserId, b.UserId, body)).status, 403);
        assert.equal((await request(null, a.UserId, body)).status, 401);
    }
    assert.equal((await request(a.UserId, a.UserId, { ...snapshot(), phx_account_id: b.UserId })).status, 400);
    assert.deepEqual((await request(a.UserId, a.UserId)).body.payload, { ...snapshot(), phx_account_id: a.UserId });
});

test('malformed or partial saves fail without erasing existing preferences', async () => {
    const a = Harness.SeedAccount(context);
    await request(a.UserId, a.UserId, snapshot());
    for(const bad of [{}, [], { current_set: 'HUNT_PASS_SET' },
        { ...snapshot(), tracked_quests: [42] }, { ...snapshot(), omitted_quests: null },
        { ...snapshot(), tracked_craftables: {} }, { ...snapshot(), current_set: 1 }]) {
        assert.equal((await request(a.UserId, a.UserId, bad)).status, 400);
    }
    assert.deepEqual((await request(a.UserId, a.UserId)).body.payload, { ...snapshot(), phx_account_id: a.UserId });
});
