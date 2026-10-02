'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const game = require('../src/game.cjs');
const directories = [];
async function temporary() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'undaunted-launcher-')); directories.push(dir); return dir; }
after(async () => { for (const dir of directories) await fs.rm(dir, { recursive: true, force: true }); });
test('launch arguments use a one-time code, correct 1.12 identifiers and no shell commands', () => {
  const user = { userId: 'UID-' + crypto.randomUUID(), username: 'TestSlayer' };
  const code = 'ULX_' + crypto.randomBytes(32).toString('hex');
  const args = game.launchArgs('http://192.168.1.100:61000', user, code);
  assert.ok(args.includes('-AUTH_PASSWORD=' + code));
  assert.ok(args.includes('-UndauntedMetagame=192.168.1.100:61000'));
  assert.ok(args.includes('-epicuserid=' + user.userId));
  assert.ok(args.includes('-NoEAC'));
  assert.throws(() => game.launchArgs('http://192.168.1.100:61000', { ...user, username: 'Bad -flag' }, code));
  assert.throws(() => game.launchArgs('http://192.168.1.100:61000', user, 'UUK_' + 'a'.repeat(48)));
});
test('update notes keep only bounded text, whatever the server sends', () => {
  const long = 'x'.repeat(5000);
  const notes = game.patchNotesText({ date: '2026-10-02T00:00:00Z', notes: [
    { title: 'New Features', sections: [{ title: 'Launcher', description: 'Sign in here.', url: 'javascript:alert(1)',
      changes: [{ comment: 'Start', list: ['One', 2, '', long] }] }] },
    { title: 'Empty', sections: [{ title: '', description: '' }] },
    { title: '<b>html</b>', sections: 'not a list' }
  ] });
  assert.equal(notes.categories.length, 1);
  const section = notes.categories[0].sections[0];
  assert.deepEqual(Object.keys(section), ['title', 'description', 'changes']);
  assert.deepEqual(section.changes[0].list.slice(0, 1), ['One']);
  assert.equal(section.changes[0].list.length, 2);
  assert.equal(section.changes[0].list[1].length, 400);
  assert.deepEqual(game.patchNotesText(null), { date: '', categories: [] });
});
test('language is passed as -culture only for languages the client ships', () => {
  const user = { userId: 'UID-11111111-2222-3333-4444-555555555555', username: 'Slayer' };
  const code = 'ULX_' + 'a'.repeat(64);
  assert.ok(game.launchArgs('http://127.0.0.1:61000', user, code, 'fr').includes('-culture=fr'));
  assert.ok(game.launchArgs('http://127.0.0.1:61000', user, code, 'pt-BR').includes('-culture=pt-BR'));
  for (const bad of ['', undefined, 'xx', 'fr -server', 'toString']) {
    assert.ok(!game.launchArgs('http://127.0.0.1:61000', user, code, bad).some(arg => arg.startsWith('-culture')));
  }
});
test('display settings change only their own keys in the Archon section', () => {
  const original = ['[ScalabilityGroups]', 'sg.ShadowQuality=3', '', '[/Script/Archon.ArchonGameUserSettings]',
    'MasterVolume=1.000000', 'bUseVSync=False', 'ResolutionSizeX=1920', 'ResolutionSizeY=1080',
    'FullscreenMode=1', 'LastConfirmedFullscreenMode=1', 'PreferredFullscreenMode=1', 'Version=5',
    'FrameRateLimit=90.000000', 'LastGPUBenchmarkSteps=100.000000', 'LastGPUBenchmarkSteps=100.000000', '',
    '[/Script/Engine.GameUserSettings]', 'bUseDesiredScreenHeight=False', ''].join('\r\n');
  assert.deepEqual(game.readDisplaySettings(original), { mode: 1, width: 1920, height: 1080, fps: 90, vsync: false });
  const updated = game.updateDisplaySettings(original, { mode: 2, width: 2560, height: 1440, fps: 0, vsync: true });
  assert.deepEqual(game.readDisplaySettings(updated), { mode: 2, width: 2560, height: 1440, fps: 0, vsync: true });
  assert.ok(updated.includes('\r\n') && !/[^\r]\n/.test(updated));
  for (const kept of ['sg.ShadowQuality=3', 'MasterVolume=1.000000', 'Version=5', 'bUseDesiredScreenHeight=False']) assert.ok(updated.includes(kept));
  assert.equal(updated.split('LastGPUBenchmarkSteps=').length - 1, 2);
  assert.ok(updated.includes('LastUserConfirmedResolutionSizeY=1440\r\n\r\n[/Script/Engine'));
  assert.throws(() => game.updateDisplaySettings(original, { mode: 7, width: 2560, height: 1440, fps: 60, vsync: true }));
  assert.throws(() => game.updateDisplaySettings(original, { mode: 1, width: 2560, height: 1440, fps: 59, vsync: true }));
  assert.throws(() => game.updateDisplaySettings('[ScalabilityGroups]\n', { mode: 1, width: 1920, height: 1080, fps: 60, vsync: false }));
});
test('public account connections require HTTPS and reject credentials, paths and non-HTTP schemes', () => {
  for (const value of ['https://example.org', 'http://127.0.0.1:61000', 'http://10.0.0.1:61000', 'http://172.16.1.2:61000', 'http://100.64.1.2:61000', 'http://100.127.255.254:61000']) assert.equal(game.serverOrigin(value), value);
  for (const value of ['http://example.org', 'http://8.8.8.8', 'http://100.63.255.255', 'http://100.128.0.1', 'https://user:pass@example.org', 'https://example.org/api', 'file:///test', 'https://example.org/?token=abc']) assert.throws(() => game.serverOrigin(value));
  assert.equal(game.isTailscaleAddress('http://100.64.1.2:61000'), true);
  assert.equal(game.isTailscaleAddress('http://192.168.1.2:61000'), false);
});
test('game folder discovery accepts installation roots but rejects wrong executable versions', async () => {
  const folder = await temporary();
  const binaries = path.join(folder, 'Dauntless/Archon/Binaries/Win64');
  await fs.mkdir(binaries, { recursive: true });
  await fs.writeFile(path.join(binaries, game.EXE), 'not the supported executable');
  assert.equal(await game.locateGame(folder), binaries);
  await assert.rejects(game.verifyGame(binaries), /different Dauntless build/);
});
test('a corrupt runtime bundle fails verification before any installed DLL can be replaced', async () => {
  const resources = await temporary();
  const folder = await temporary();
  const files = {};
  for (const file of game.RUNTIME_FILES) {
    await fs.writeFile(path.join(resources, file), 'verified ' + file);
    files[file] = await game.hashFile(path.join(resources, file));
    await fs.writeFile(path.join(folder, file), 'existing ' + file);
  }
  await fs.writeFile(path.join(resources, 'runtime.json'), JSON.stringify({ files }));
  assert.equal(await game.runtimeStatus(folder, resources), false);
  await fs.writeFile(path.join(resources, 'winmm.dll'), 'tampered');
  await assert.rejects(game.verifyResources(resources), /damaged/);
  assert.equal(await fs.readFile(path.join(folder, 'winmm.dll'), 'utf8'), 'existing winmm.dll');
});
test('runtime installation replaces both files and preserves the old DLLs', {
  skip: !process.env.UNDAUNTED_LAUNCHER_TEST_GAME_DIR
}, async () => {
  const resources = await temporary();
  const folder = await temporary();
  // Read the verified executable, but only copy/repair files in a disposable folder.
  await fs.copyFile(path.join(process.env.UNDAUNTED_LAUNCHER_TEST_GAME_DIR, game.EXE), path.join(folder, game.EXE));
  const files = {};
  for (const file of game.RUNTIME_FILES) {
    await fs.writeFile(path.join(resources, file), 'new test runtime ' + file);
    files[file] = await game.hashFile(path.join(resources, file));
    await fs.writeFile(path.join(folder, file), 'old test runtime ' + file);
  }
  await fs.writeFile(path.join(resources, 'runtime.json'), JSON.stringify({ files }));
  await game.installRuntime(folder, resources);
  assert.equal(await game.runtimeStatus(folder, resources), true);
  const entries = await fs.readdir(folder);
  for (const file of game.RUNTIME_FILES) {
    const backups = entries.filter(entry => entry.startsWith(file + '.launcher-') && entry.endsWith('.bak'));
    assert.equal(backups.length, 1);
    assert.equal(await fs.readFile(path.join(folder, backups[0]), 'utf8'), 'old test runtime ' + file);
  }
  assert.equal(entries.some(entry => entry.endsWith('.tmp')), false);
});
