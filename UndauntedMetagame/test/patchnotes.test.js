'use strict';
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let directory, server, origin, notes;
const supplied = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../data/1.12/patchnotes/en.json'), 'utf8'));
const fixture = (language = 'en', title = 'Test update') => ({ ...structuredClone(supplied), language, title });
function write(value, name = value.language) {
    fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(value));
}
async function get(language = 'en', build = '392819_rel-1.12.0_shipping') {
    const response = await fetch(`${origin}/patchnotes/${encodeURIComponent(language)}/${encodeURIComponent(build)}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.code, null);
    assert.equal(body.message, 'OK');
    return body.payload;
}

before(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'undaunted-patchnotes-'));
    process.env.PATCH_NOTES_DIR = directory;
    process.env.AUTH_SIGNING_PRIVKEY_B64 = '';
    process.env.AUTH_SIGNING_PUBKEY_B64 = '';
    process.env.LOG_LEVEL = 'silent';
    process.env.MATCHMAKING_MODE = 'DISABLED';
    write(fixture());
    notes = require('../dist/features/patchnotes/patchnotes');
    const app = require('express')();
    app.use(require('../dist/routes/client112').client112Router);
    server = await new Promise(resolve => { const started = app.listen(0, '127.0.0.1', () => resolve(started)); });
    origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    if(server) await new Promise(resolve => server.close(resolve));
    if(directory) fs.rmSync(directory, { recursive: true, force: true });
    delete process.env.PATCH_NOTES_DIR;
});

test('real endpoint serves the verified native categories/sections/changes/list shape without authentication', async () => {
    const payload = await get();
    assert.deepEqual(payload, notes.ParsePatchNotes(fixture(), 'en'));
    assert.equal(payload.notes.length, 4);
    assert.ok(payload.notes.every(category => category.sections.length > 0));
    const section = payload.notes[0].sections[0];
    assert.equal(section.background, '');
    assert.equal(section.cta, '');
    assert.equal(section.url, '');
    assert.ok(section.changes[0].list.every(bullet => typeof bullet === 'string'));
    assert.equal((await get('en', 'another-compatible-build-id')).release_version, '1.12.0');
});

test('regional translations take precedence, then base-language and English fallback', async () => {
    write(fixture('fr', 'Mise a jour'));
    assert.equal((await get('fr-FR')).language, 'fr');
    write(fixture('fr-fr', 'Mise a jour regionale'));
    assert.equal((await get('FR_fr')).title, 'Mise a jour regionale');
    assert.equal((await get('de-DE')).language, 'en');
    fs.unlinkSync(path.join(directory, 'fr-fr.json'));
    fs.unlinkSync(path.join(directory, 'fr.json'));
});

test('language input cannot escape the configured content directory', async () => {
    const expected = await get();
    for(const language of ['../private', '..\\private', 'en/../../private', 'en.json', '%2e%2e', 'a'.repeat(100)]) {
        assert.deepEqual(await get(language), expected);
    }
});

test('editing content updates the next response without restarting the server', async () => {
    const updated = fixture('en', 'Fresh community update');
    updated.notes[0].sections[0].changes[0].list.push('A newly published change.');
    write(updated);
    const result = await get();
    assert.equal(result.title, updated.title);
    assert.equal(result.notes[0].sections[0].changes[0].list.at(-1), 'A newly published change.');
});

test('an incomplete or invalid edit preserves the last good notes and a corrected edit recovers', async () => {
    const previous = await get();
    fs.writeFileSync(path.join(directory, 'en.json'), '{ incomplete');
    assert.deepEqual(await get(), previous);
    write({ ...fixture(), notes: [{ type: 'broken', title: 'Broken', sections: 'wrong shape' }] });
    assert.deepEqual(await get(), previous);
    write(fixture('en', 'Recovered update notes'));
    assert.equal((await get()).title, 'Recovered update notes');
});

test('invalid localized content falls back to English instead of sending malformed client data', async () => {
    write({ ...fixture('pt'), notes: [] });
    assert.equal((await get('pt')).language, 'en');
    write(fixture('de'), 'es'); // The file language must match the selected locale.
    assert.equal((await get('es')).language, 'en');
    fs.writeFileSync(path.join(directory, 'it.json'), ' '.repeat(256 * 1024 + 1));
    assert.equal((await get('it')).language, 'en');
});

test('missing or initially broken English content produces a valid nonempty recovery notice', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'undaunted-patchnotes-empty-'));
    try {
        process.env.PATCH_NOTES_DIR = empty;
        const missing = await get('zz');
        assert.equal(missing.language, 'en');
        assert.equal(missing.notes[0].sections[0].title, 'Update notes');
        fs.writeFileSync(path.join(empty, 'en.json'), '{broken');
        assert.deepEqual(await get('en'), missing);
        write(fixture('en', 'Wrong directory should not be used'));
        assert.deepEqual(await get(), missing);
    } finally {
        process.env.PATCH_NOTES_DIR = directory;
        fs.rmSync(empty, { recursive: true, force: true });
    }
});

test('validation refuses malformed nested data, duplicate categories and invalid metadata', () => {
    const invalid = [
        { ...fixture(), notes: [] },
        { ...fixture(), notes: [supplied.notes[0], supplied.notes[0]] },
        { ...fixture(), date: 'not a timestamp' },
        { ...fixture(), language: '../en' },
        { ...fixture(), title: '' }
    ];
    for(const transform of [
        section => { section.changes = [{ comment: '', list: [123] }]; },
        section => { section.changes = 'wrong'; },
        section => { section.title = 'x'.repeat(201); },
        section => { section.type = ''; }
    ]) {
        const value = fixture(); transform(value.notes[0].sections[0]); invalid.push(value);
    }
    for(const value of invalid) assert.throws(() => notes.ParsePatchNotes(value));
});

test('the default staged content is populated and works without a machine-specific path', async () => {
    delete process.env.PATCH_NOTES_DIR;
    try {
        const payload = await get();
        assert.equal(payload.title, 'Undaunted');
        assert.deepEqual(payload, notes.ParsePatchNotes(supplied, 'en'));
    } finally { process.env.PATCH_NOTES_DIR = directory; }
});
