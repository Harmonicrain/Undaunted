'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { trustedConfig, verifyInstaller } = require('./update-feed.cjs');

async function createUpdater(options) {
  let config, manifest, installer, active = false, disposed = false, token;
  let status = { phase: 'disabled', message: 'Automatic updates are not configured.', percent: 0 };
  const emit = next => { status = { ...status, ...next }; if (!disposed) options.emit?.({ ...status }); };
  try {
    config = trustedConfig(JSON.parse(await fs.readFile(path.join(options.resources, 'updates.json'), 'utf8')));
    // A migration is accepted only from metadata signed by the packaged key.
    // Store the envelope, not a freely editable URL override, and verify it each launch.
    try {
      const envelope = JSON.parse(await fs.readFile(path.join(options.profile, 'update-feed-migration.json'), 'utf8'));
      const migration = require('./update-feed.cjs').verifyManifest(envelope, config);
      if (require('semver').gte(options.version, migration.version) && migration.nextFeed) config = { ...config, ...migration.nextFeed };
    } catch { /* no verified migration for this installed version */ }
  } catch (error) {
    if (error.code !== 'ENOENT') status.message = 'Update configuration is invalid. Reinstall the launcher to repair it.';
    return { state: () => ({ ...status }), check: async () => ({ ...status }), download: async () => ({ ...status }),
      install: async () => { throw new Error(status.message); }, dispose: () => {} };
  }
  let signedEnvelope;
  const provider = { provider: 'custom', updateProvider: require('./update-provider.cjs').SignedUpdateProvider,
    ...config, fetcher: options.fetcher, beforeCheck: async () => {
      if (config.requiresTailscale) await options.ensureTailnet(config.url);
    }, acceptManifest: (value, envelope) => { manifest = value; signedEnvelope = envelope; } };
  const updater = options.updater || new (require('electron-updater').NsisUpdater)(provider);
  if (options.updater) updater.setFeedURL(provider);
  const updateSession = options.updater ? undefined : require('electron-updater/out/electronHttpExecutor').getNetSession();
  // NSIS may follow installer/blockmap redirects. Keep every download on the
  // configured HTTPS origin, even if the remote server requests a downgrade.
  updateSession?.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const url = new URL(details.url), base = new URL(config.url);
    callback({ cancel: url.protocol !== 'https:' || url.origin !== base.origin || !url.pathname.startsWith(base.pathname) });
  });
  updater.autoDownload = false; updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false; updater.allowPrerelease = false; updater.disableWebInstaller = true;
  updater.logger = { info() {}, warn() {}, error() {}, debug() {} };
  const progress = value => emit({ percent: Math.max(0, Math.min(100, Number(value.percent) || 0)) });
  // Library errors may contain raw feed content or local paths; keep them out of UI/logs.
  const onError = () => { if (!disposed) emit({ phase: 'error', message: 'Update failed. Check your connection and try again.' }); };
  updater.on('download-progress', progress); updater.on('error', onError);
  emit({ phase: 'idle', message: 'Check for launcher updates.', transport: config.requiresTailscale ? 'tailscale' : 'https' });
  function claim() { if (active || disposed) throw new Error('Please wait for the current update operation.'); active = true; }
  async function check() {
    if (status.phase === 'ready') return { ...status };
    claim();
    try {
      manifest = undefined; installer = undefined;
      emit({ phase: 'checking', message: 'Checking for updates…', percent: 0, version: undefined });
      const result = await updater.checkForUpdates();
      if (!result || !manifest) throw new Error('Update checks are available in the installed launcher.');
      if (require('semver').gt(manifest.version, options.version)) emit({ phase: 'available', version: manifest.version, message: `Launcher ${manifest.version} is available.` });
      else emit({ phase: 'current', message: 'Your launcher is up to date.' });
    } catch { emit({ phase: 'error', message: config.requiresTailscale ? 'Could not check for updates. Connect to Tailscale and try again.' : 'Could not check for updates. Check your connection and try again.' }); }
    finally { active = false; }
    return { ...status };
  }
  async function download() {
    if (!manifest || status.phase !== 'available') throw new Error('Check for a new launcher version first.');
    claim();
    try {
      token = new (require('builder-util-runtime').CancellationToken)();
      emit({ phase: 'downloading', message: `Downloading launcher ${manifest.version}…`, percent: 0 });
      const files = await updater.downloadUpdate(token);
      if (disposed) return { ...status };
      if (files.length !== 1 || files[0] !== updater.installerPath) throw new Error('Invalid installer download.');
      await verifyInstaller(files[0], manifest.files[0]); installer = files[0];
      emit({ phase: 'ready', percent: 100, message: `Launcher ${manifest.version} is ready. Restart to update.` });
    } catch { installer = undefined; if (!disposed) emit({ phase: 'error', message: 'Download failed verification or was interrupted. Check for updates and try again.' }); }
    finally { token = undefined; active = false; }
    return { ...status };
  }
  async function install() {
    if (status.phase !== 'ready' || !installer) throw new Error('Download an update first.');
    claim();
    try {
      if (await options.isGameRunning()) throw new Error('Close Dauntless before updating the launcher.');
      if (installer !== updater.installerPath) throw new Error('The downloaded installer changed. Check for updates again.');
      await verifyInstaller(installer, manifest.files[0]);
      if (await options.isGameRunning()) throw new Error('Close Dauntless before updating the launcher.');
      if (manifest.nextFeed && signedEnvelope) {
        const { verifyManifest } = require('./update-feed.cjs');
        const signed = verifyManifest(signedEnvelope, config);
        if (JSON.stringify(signed) !== JSON.stringify(manifest)) throw new Error('Update release changed. Check for updates again.');
        await fs.mkdir(options.profile, { recursive: true });
        const target = path.join(options.profile, 'update-feed-migration.json');
        await fs.writeFile(target + '.tmp', JSON.stringify(signedEnvelope)); await fs.rename(target + '.tmp', target);
      }
      emit({ phase: 'installing', message: 'Restarting the launcher to install the update…' });
      updater.quitAndInstall(true, true);
    } catch (error) {
      const running = error.message === 'Close Dauntless before updating the launcher.';
      if (!running) installer = undefined;
      emit({ phase: running ? 'ready' : 'error', message: running ? error.message : 'Could not install the update. Check for updates again.' });
      throw new Error(status.message);
    } finally { active = false; }
    return { ...status };
  }
  return { state: () => ({ ...status }), check, download, install,
    dispose: () => { disposed = true; token?.cancel(); updateSession?.webRequest.onBeforeRequest(null);
      updater.removeListener('download-progress', progress); updater.removeListener('error', onError); updater.on('error', () => {}); } };
}
module.exports = { createUpdater };
