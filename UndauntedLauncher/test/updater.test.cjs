'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const feed = require('../src/update-feed.cjs');
const { SignedUpdateProvider } = require('../src/update-provider.cjs');
const { createUpdater } = require('../src/updater.cjs');
const { publishRelease } = require('../scripts/publish-updates.cjs');
const keys = crypto.generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const config = { url: 'https://updates.example.test/launcher/', requiresTailscale: false, appId: feed.APP_ID, publicKey };
const bytes = Buffer.from('disposable installer bytes');
const digest = crypto.createHash('sha512').update(bytes).digest('base64');
const release = () => ({ schema: 1, appId: feed.APP_ID, channel: 'stable', version: '1.0.7',
  releaseDate: '2026-10-03T00:00:00Z', releaseNotes: 'Test release',
  files: [{ url: 'Undaunted-Launcher-1.0.7-Setup.exe', sha512: digest, size: bytes.length }] });
const temporary = [];
async function directory() { const value = await fs.mkdtemp(path.join(os.tmpdir(), 'undaunted-updater-')); temporary.push(value); return value; }
after(async () => { for (const dir of temporary) await fs.rm(dir, { recursive: true, force: true }); });
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('both private Tailscale and public HTTPS feeds are valid and HTTP is refused', () => {
  assert.equal(feed.trustedConfig(config).requiresTailscale, false);
  assert.equal(feed.feedConfig({ url: 'https://host.tailnet.ts.net/launcher/', requiresTailscale: true }).requiresTailscale, true);
  for (const url of ['http://100.64.1.2/', 'https://user:pass@example.test/', 'https://example.test/?key=x', 'https://example.test/#x', 'https://example.test/latest.json'])
    assert.throws(() => feed.feedConfig({ url, requiresTailscale: false }));
  assert.throws(() => feed.feedConfig({ url: config.url, requiresTailscale: true }));
});

test('a genuine signed release verifies; modified bytes and another signing key are refused', () => {
  const envelope = feed.signManifest(release(), keys.privateKey);
  assert.deepEqual(feed.verifyManifest(envelope, config), release());
  const changed = { ...envelope, payload: Buffer.from(JSON.stringify({ ...release(), version: '9.0.0' })).toString('base64') };
  assert.throws(() => feed.verifyManifest(changed, config));
  assert.throws(() => feed.verifyManifest({ ...envelope, signature: 'A'.repeat(86) + '==' }, config));
  assert.throws(() => feed.verifyManifest(feed.signManifest(release(), crypto.generateKeyPairSync('ed25519').privateKey), config));
  assert.throws(() => feed.verifyManifest({ payload: envelope.payload }, config));
});

test('even signed releases must have a stable version, correct app and bounded local installer name', () => {
  const bad = [ { ...release(), appId: 'another.app' }, { ...release(), schema: 2 }, { ...release(), channel: 'beta' },
    { ...release(), version: 'v1.0.7' }, { ...release(), version: '1.0.7-beta.1' }, { ...release(), releaseDate: 'invalid' },
    { ...release(), releaseNotes: 'x'.repeat(4001) }, { ...release(), files: [] } ];
  for (const patch of [{ url: '../../malware.exe' }, { url: 'https://evil.test/malware.exe' }, { sha512: 'bad' }, { size: 0 }, { size: 1024 ** 3 }])
    bad.push({ ...release(), files: [{ ...release().files[0], ...patch }] });
  for (const value of bad) assert.throws(() => feed.verifyManifest(feed.signManifest(value, keys.privateKey), config));
  const injected = { ...release(), packages: { x64: { path: 'https://evil.test/a.exe' } }, extraArguments: '/malicious' };
  assert.deepEqual(feed.verifyManifest(feed.signManifest(injected, keys.privateKey), config), release());
});

test('discovery refuses oversized chunked content and follows no redirects', async () => {
  let request;
  const envelope = feed.signManifest(release(), keys.privateKey);
  assert.deepEqual(await feed.fetchManifest(config, async (url, opts) => { request = { url, opts }; return response(envelope); }), envelope);
  assert.equal(request.url.href, config.url + 'latest.json'); assert.equal(request.opts.redirect, 'error');
  await assert.rejects(feed.fetchManifest(config, async () => new Response('x'.repeat(feed.MAX_MANIFEST + 1))), /too large/);
  await assert.rejects(feed.fetchManifest(config, async () => new Response('', { status: 503 })), /unavailable/);
});

class FakeNsis extends EventEmitter {
  constructor(file) { super(); this.file = file; this.installs = 0; this.downloads = 0; }
  setFeedURL(options) { this.options = options; this.provider = new SignedUpdateProvider(options, this, { platform: 'win32' }); }
  async checkForUpdates() { return { updateInfo: await this.provider.getLatestVersion() }; }
  async downloadUpdate(token) {
    this.downloads++; this.emit('download-progress', { percent: 35 });
    if (this.failDownload) throw new Error('interrupted');
    this.installerPath = this.file; return [this.file];
  }
  quitAndInstall(silent, reopen) { assert.equal(silent, true); assert.equal(reopen, true); this.installs++; }
}
async function manager(custom = {}) {
  const dir = await directory(); const resources = path.join(dir, 'resources'), profile = path.join(dir, 'profile');
  await fs.mkdir(resources); await fs.mkdir(profile);
  await fs.writeFile(path.join(resources, 'updates.json'), JSON.stringify(custom.config || config));
  await fs.writeFile(path.join(profile, 'config.json'), JSON.stringify({ server: 'http://100.64.1.2:61000', gameDirectory: 'keep my folder' }));
  await fs.writeFile(path.join(profile, 'session.bin'), 'preserve protected session');
  const file = path.join(dir, 'installer.exe'); await fs.writeFile(file, bytes);
  const engine = new FakeNsis(file), events = []; let tailnetChecks = 0;
  const value = custom.release || release();
  const updater = await createUpdater({ resources, profile, version: '1.0.6', updater: engine,
    fetcher: async () => response(feed.signManifest(value, keys.privateKey)),
    ensureTailnet: async () => { tailnetChecks++; }, isGameRunning: async () => !!custom.running,
    emit: e => events.push(e) });
  return { updater, engine, dir, file, profile, resources, events, tailnetChecks: () => tailnetChecks };
}

test('public feed checks/downloads without Tailscale and preserves account settings and session', async () => {
  const m = await manager();
  assert.equal((await m.updater.check()).phase, 'available'); assert.equal(m.tailnetChecks(), 0);
  assert.equal(m.engine.autoDownload, false); assert.equal(m.engine.autoInstallOnAppQuit, false);
  assert.equal(m.engine.disableWebInstaller, true); assert.equal(m.engine.allowDowngrade, false);
  assert.equal((await m.updater.download()).phase, 'ready'); assert.ok(m.events.some(e => e.percent === 35));
  await m.updater.install(); assert.equal(m.engine.installs, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(m.profile, 'config.json'))).gameDirectory, 'keep my folder');
  assert.equal(await fs.readFile(path.join(m.profile, 'session.bin'), 'utf8'), 'preserve protected session');
  m.updater.dispose();
});

test('private feed requires Tailscale independently of the selected game server', async () => {
  const m = await manager({ config: { ...config, url: 'https://host.tailnet.ts.net/launcher/', requiresTailscale: true } });
  await m.updater.check(); assert.equal(m.tailnetChecks(), 1); m.updater.dispose();
});

test('tampered discovery prevents any download and old releases are never offered', async () => {
  const m = await manager({ release: { ...release(), version: '1.0.5', files: [{ ...release().files[0], url: 'Undaunted-Launcher-1.0.5-Setup.exe' }] } });
  assert.equal((await m.updater.check()).phase, 'current'); await assert.rejects(m.updater.download()); assert.equal(m.engine.downloads, 0); m.updater.dispose();
  const bad = await manager(); bad.engine.options.fetcher = async () => response({ payload: 'bad', signature: 'A'.repeat(86) + '==' });
  assert.equal((await bad.updater.check()).phase, 'error'); assert.equal(bad.engine.downloads, 0); bad.updater.dispose();
});

test('interrupted and corrupt downloads remain uninstalled and can be retried', async () => {
  const m = await manager(); await m.updater.check(); m.engine.failDownload = true;
  assert.equal((await m.updater.download()).phase, 'error'); await assert.rejects(m.updater.install());
  m.engine.failDownload = false; await m.updater.check(); await fs.writeFile(m.file, 'corrupt');
  assert.equal((await m.updater.download()).phase, 'error'); assert.equal(m.engine.installs, 0);
  await fs.writeFile(m.file, bytes); await m.updater.check(); assert.equal((await m.updater.download()).phase, 'ready'); m.updater.dispose();
});

test('installation is deferred for a running game and cached bytes are reverified before install', async () => {
  const running = await manager({ running: true }); await running.updater.check(); await running.updater.download();
  await assert.rejects(running.updater.install(), /Close Dauntless/); assert.equal(running.engine.installs, 0); running.updater.dispose();
  const changed = await manager(); await changed.updater.check(); await changed.updater.download();
  await fs.writeFile(changed.file, Buffer.alloc(bytes.length)); await assert.rejects(changed.updater.install()); assert.equal(changed.engine.installs, 0); changed.updater.dispose();
});

test('only a signed migration can move an installed client to a public HTTPS feed', async () => {
  const nextFeed = { url: 'https://production.example.test/releases/', requiresTailscale: false };
  const m = await manager({ release: { ...release(), nextFeed } });
  await m.updater.check(); await m.updater.download(); await m.updater.install();
  const settings = { resources: m.resources, profile: m.profile, version: '1.0.7', updater: new FakeNsis(m.file),
    fetcher: async () => response(feed.signManifest(release(), keys.privateKey)), ensureTailnet: async () => {}, isGameRunning: async () => false };
  const migrated = await createUpdater(settings); assert.equal(settings.updater.options.url, nextFeed.url); migrated.dispose();
  const stored = JSON.parse(await fs.readFile(path.join(m.profile, 'update-feed-migration.json'), 'utf8'));
  stored.signature = 'A'.repeat(86) + '=='; await fs.writeFile(path.join(m.profile, 'update-feed-migration.json'), JSON.stringify(stored));
  settings.updater = new FakeNsis(m.file); const refused = await createUpdater(settings);
  assert.equal(settings.updater.options.url, config.url); refused.dispose(); m.updater.dispose();
});

test('publisher verifies its trust key and prevents reusing a version for different bytes', async () => {
  const dir = await directory(), installer = path.join(dir, 'Undaunted-Launcher-1.0.7-Setup.exe'), keyFile = path.join(dir, 'private/key.pem');
  await fs.mkdir(path.dirname(keyFile)); await fs.writeFile(keyFile, keys.privateKey.export({ format: 'pem', type: 'pkcs8' })); await fs.writeFile(installer, bytes);
  const options = { installer, version: '1.0.7', output: path.join(dir, 'public'), config, keyFile };
  const published = await publishRelease(options);
  assert.deepEqual(feed.verifyManifest(JSON.parse(await fs.readFile(path.join(options.output, 'latest.json'))), config), published);
  const older = path.join(dir, 'Undaunted-Launcher-1.0.6-Setup.exe'); await fs.writeFile(older, bytes);
  await assert.rejects(publishRelease({ ...options, installer: older, version: '1.0.6' }), /older version/);
  await fs.writeFile(installer, 'different bytes'); await assert.rejects(publishRelease(options), /Increment the version/);
  await assert.rejects(publishRelease({ ...options, output: path.dirname(keyFile) }), /signing key/);
});
