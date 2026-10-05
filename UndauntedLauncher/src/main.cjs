'use strict';
const { app, BrowserWindow, dialog, ipcMain, safeStorage, screen, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const game = require('./game.cjs');

async function createLauncher(options = {}) {
  const resources = options.resources || (app.isPackaged ? path.join(process.resourcesPath, 'launcher') : path.join(__dirname, '../resources'));
  const profile = options.profile || app.getPath('userData');
  const configPath = path.join(profile, 'config.json');
  const tokenPath = path.join(profile, 'session.bin');
  const defaults = JSON.parse(await fs.readFile(path.join(resources, 'server.json'), 'utf8'));
  let config = { server: game.serverOrigin(defaults.server), gameDirectory: '' };
  try { const stored = JSON.parse(await fs.readFile(configPath, 'utf8')); config = { ...config, ...stored, server: game.serverOrigin(stored.server || defaults.server) }; } catch { /* first run */ }
  let session;
  let importedKey;
  let child;
  let operation = false;
  let tailnetCheckedAt = 0;
  let tailnetCheckedOrigin = '';
  const index = path.join(__dirname, 'index.html');
  const trustedUrl = pathToFileURL(index).href;
  const window = new BrowserWindow({ width: 1080, height: 760, minWidth: 900, minHeight: 690,
    show: options.visible !== false, backgroundColor: '#0c151d', autoHideMenuBar: true,
    icon: path.join(__dirname, 'art', 'icon.ico'), // the game's icon, from scripts/extract-art.py
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== trustedUrl) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  async function saveConfig() {
    await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(configPath + '.tmp', JSON.stringify(config));
    await fs.rename(configPath + '.tmp', configPath);
  }
  async function storeSession(next) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows could not protect your login session. Please try again.');
    await fs.mkdir(profile, { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify({ server: config.server, refreshToken: next.refreshToken }));
    await fs.writeFile(tokenPath + '.tmp', encrypted);
    await fs.rename(tokenPath + '.tmp', tokenPath);
    session = next;
  }
  async function forget() { session = undefined; await fs.unlink(tokenPath).catch(() => {}); }
  async function ensureTailnet(origin = config.server, required = game.isTailscaleAddress(origin)) {
    if (required &&
        (tailnetCheckedOrigin !== origin || Date.now() - tailnetCheckedAt > 30000)) {
      try {
        const executable = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
        const { stdout } = await promisify(execFile)(executable, ['status', '--json'], { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
        const status = JSON.parse(stdout);
        const host = new URL(origin).hostname;
        const known = [status.Self, ...Object.values(status.Peer || {})].some(peer =>
          peer?.TailscaleIPs?.includes(host) || peer?.DNSName?.replace(/\.$/, '').toLowerCase() === host);
        if (status.BackendState !== 'Running' || !known) throw new Error();
        tailnetCheckedAt = Date.now(); tailnetCheckedOrigin = origin;
      } catch { throw new Error('Connect to Tailscale and accept the server sharing invitation before using this address.'); }
    }
  }
  const updater = await require('./updater.cjs').createUpdater({ resources, profile, version: app.getVersion(),
    ensureTailnet: url => ensureTailnet(url, true),
    isGameRunning: () => require('./running-game.cjs').isGameRunning(config.gameDirectory, child),
    emit: value => { if (!window.isDestroyed()) window.webContents.send('launcher:updateState', value); } });
  // The same update notes the game's title screen shows; only bounded text is
  // passed on, and the renderer shows it as plain text.
  async function patchNotes() {
    await ensureTailnet();
    let response;
    try { response = await fetch(config.server + '/patchnotes/en/392819', { redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch { throw new Error('Could not load the update notes.'); }
    if (!response.ok) throw new Error('This server has no update notes.');
    let data;
    try { data = await response.json(); } catch { throw new Error('This server has no update notes.'); }
    return game.patchNotesText(data?.payload);
  }
  // The client's own settings file. Dauntless rewrites it when it exits, so it is
  // only changed while the game is closed.
  const gameSettingsPath = options.gameSettingsPath || path.join(process.env.LOCALAPPDATA || app.getPath('appData'),
    'Archon', 'Saved', 'Config', 'WindowsClient', 'GameUserSettings.ini');
  function resolutions(current) {
    const display = screen.getPrimaryDisplay();
    const nativeWidth = Math.round(display.size.width * display.scaleFactor);
    const nativeHeight = Math.round(display.size.height * display.scaleFactor);
    const common = [[1280, 720], [1366, 768], [1600, 900], [1920, 1080], [2560, 1080], [2560, 1440], [3440, 1440], [3840, 2160]]
      .filter(([width, height]) => width <= nativeWidth && height <= nativeHeight);
    const all = [...common, [nativeWidth, nativeHeight], ...(current ? [[current.width, current.height]] : [])];
    return [...new Map(all.map(([width, height]) => [`${width}x${height}`, { width, height }])).values()]
      .sort((a, b) => a.width - b.width || a.height - b.height);
  }
  async function gameSettings() {
    let display;
    try { display = game.readDisplaySettings(await fs.readFile(gameSettingsPath, 'utf8')); } catch { /* never started */ }
    return { language: config.language || '', languages: game.LANGUAGES, display, windowModes: game.WINDOW_MODES,
      frameRates: game.FRAME_RATES, resolutions: resolutions(display), running: !!child };
  }
  async function saveGameSettings(value) {
    const language = value?.language || '';
    if (language && !Object.hasOwn(game.LANGUAGES, language)) throw new Error('Choose one of the listed languages.');
    if (value?.display) {
      if (child) throw new Error('Close Dauntless before changing its display settings.');
      let text;
      try { text = await fs.readFile(gameSettingsPath, 'utf8'); }
      catch { throw new Error('Start Dauntless once before changing its display settings.'); }
      const updated = game.updateDisplaySettings(text, value.display);
      const backup = gameSettingsPath + '.launcher-backup';
      await fs.copyFile(gameSettingsPath, backup, fs.constants.COPYFILE_EXCL).catch(() => {}); // keeps the first original
      await fs.writeFile(gameSettingsPath + '.tmp', updated);
      await fs.rename(gameSettingsPath + '.tmp', gameSettingsPath);
    }
    config.language = language; await saveConfig();
    return gameSettings();
  }
  async function request(route, body, authenticated = false) {
    await ensureTailnet();
    if (authenticated && (!session || session.expiresAt <= Date.now() + 5000)) await restore();
    if (authenticated && !session) throw new Error('Please sign in again.');
    let response;
    try {
      response = await fetch(config.server + '/launcher/v1/' + route, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer ' + session.accessToken } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch { throw new Error('Could not reach the server. Check your connection and server address.'); }
    let data;
    try { data = await response.json(); } catch { throw new Error('This server does not support the 1.12 launcher yet.'); }
    if (!response.ok) {
      const error = new Error(typeof data.message === 'string' ? data.message.slice(0, 240) : 'The server could not complete this request.');
      error.status = response.status; throw error;
    }
    return data;
  }
  function validateSession(value) {
    if (!/^ULA_[0-9a-f]{64}$/.test(value?.accessToken) || !/^ULR_[0-9a-f]{64}$/.test(value?.refreshToken) ||
        !Number.isFinite(value.expiresIn) || value.expiresIn <= 0 || !value.user?.userId || !value.user?.username) {
      throw new Error('The server returned an invalid session.');
    }
    value.expiresAt = Date.now() + value.expiresIn * 1000;
    return value;
  }
  async function restore() {
    let refreshToken = session?.refreshToken;
    if (!refreshToken) {
      try {
        const stored = JSON.parse(safeStorage.decryptString(await fs.readFile(tokenPath)));
        if (stored.server !== config.server) { await forget(); return; }
        refreshToken = stored.refreshToken;
      } catch { await forget(); return; }
    }
    try { await storeSession(validateSession(await request('refresh', { refreshToken }))); }
    catch (error) { if (error.status === 401) await forget(); throw error; }
  }
  async function state() {
    let serverStatus;
    let serverError = '';
    try { serverStatus = await request('status'); } catch (error) { serverError = error.message; }
    if (!session && !serverError) { try { await restore(); } catch (error) { serverError = error.message; } }
    return { server: config.server, registrationMode: serverStatus?.registrationMode || 'NONE',
      connected: !!serverStatus, serverError, user: session?.user, gameDirectory: config.gameDirectory,
      running: !!child, version: app.getVersion(), hasImportedAccount: !!importedKey };
  }
  const actions = {
    state,
    server: async value => {
      const origin = game.serverOrigin(value);
      if (origin !== config.server) {
        if (session) await request('logout', { refreshToken: session.refreshToken }).catch(() => {});
        await forget(); importedKey = undefined; config.server = origin; await saveConfig();
      }
      return state();
    },
    login: async value => { await storeSession(validateSession(await request('login', { username: value?.username, password: value?.password }))); return state(); },
    register: async value => { await storeSession(validateSession(await request('register', { username: value?.username, password: value?.password, inviteCode: value?.inviteCode }))); return state(); },
    claim: async value => {
      await storeSession(validateSession(await request('claim', { accountKey: value?.accountKey || importedKey, password: value?.password })));
      importedKey = undefined; return state();
    },
    importAccount: async () => {
      const result = await dialog.showOpenDialog(window, { title: 'Choose your existing account file', properties: ['openFile'], filters: [{ name: 'Account file', extensions: ['json'] }] });
      if (result.canceled) return { canceled: true };
      try {
        const file = result.filePaths[0];
        if ((await fs.stat(file)).size > 8192) throw new Error();
        const account = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!/^UUK_[0-9a-f]{48}$/.test(account.UUK)) throw new Error();
        importedKey = account.UUK;
        return { username: typeof account.Username === 'string' ? account.Username.slice(0, 16) : 'Existing player' };
      } catch { throw new Error('Choose the account JSON file supplied by the server owner.'); }
    },
    logout: async () => { if (session) await request('logout', { refreshToken: session.refreshToken }); await forget(); importedKey = undefined; return state(); },
    selectGame: async () => {
      if (child) throw new Error('Close Dauntless before changing the game folder.');
      const result = await dialog.showOpenDialog(window, { title: 'Select your Dauntless 1.12.0 folder', properties: ['openDirectory'] });
      if (result.canceled) return state();
      const folder = await game.locateGame(result.filePaths[0]);
      await game.verifyGame(folder); config.gameDirectory = folder; await saveConfig();
      await game.installRuntime(folder, resources); return state();
    },
    repair: async () => {
      if (child) throw new Error('Close Dauntless before repairing the runtime.');
      if (!config.gameDirectory) throw new Error('Select the game folder first.');
      await game.installRuntime(config.gameDirectory, resources); return state();
    },
    play: async () => {
      if (child) throw new Error('Dauntless is already running.');
      if (!config.gameDirectory) throw new Error('Select your Dauntless 1.12.0 folder first.');
      await game.verifyGame(config.gameDirectory);
      if (!await game.runtimeStatus(config.gameDirectory, resources)) await game.installRuntime(config.gameDirectory, resources);
      const details = await request('exchange', {}, true);
      const args = game.launchArgs(config.server, details.user, details.exchangeCode, config.language);
      const process = spawn(path.join(config.gameDirectory, game.EXE), args, {
        cwd: config.gameDirectory, shell: false, detached: true, stdio: 'ignore', windowsHide: false
      });
      await new Promise((resolve, reject) => {
        process.once('spawn', resolve);
        process.once('error', () => reject(new Error('Dauntless could not start. Check your installation.')));
      });
      child = process;
      process.once('exit', () => { if (child === process) child = undefined; });
      process.unref(); return state();
    },
    settings: gameSettings,
    saveSettings: saveGameSettings,
    updateInstall: () => updater.install()
  };
  const trusted = event => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame.url === trustedUrl;
  for (const [name, action] of Object.entries(actions)) ipcMain.handle('launcher:' + name, async (event, value) => {
    if (!trusted(event)) return { ok: false, message: 'Invalid launcher request.' };
    if (operation) return { ok: false, message: 'Please wait for the current operation.' };
    operation = true;
    try { return { ok: true, result: await action(value) }; }
    catch (error) { return { ok: false, message: error.message || 'The operation could not be completed.' }; }
    finally { operation = false; }
  });
  // Independent of account operations. External navigation is limited to our
  // fixed invite; the renderer cannot supply a URL to the OS shell.
  const reads = { patchNotes, discord: () => shell.openExternal('https://discord.gg/zxZfbhMEs7'),
    updateState: () => updater.state(), updateCheck: () => updater.check(), updateDownload: () => updater.download() };
  for (const [name, read] of Object.entries(reads)) ipcMain.handle('launcher:' + name, async event => {
    if (!trusted(event)) return { ok: false, message: 'Invalid launcher request.' };
    try { return { ok: true, result: await read() }; }
    catch (error) { return { ok: false, message: error.message || 'The operation could not be completed.' }; }
  });
  window.on('closed', () => {
    updater.dispose();
    for (const name of [...Object.keys(actions), ...Object.keys(reads)]) ipcMain.removeHandler('launcher:' + name);
    importedKey = undefined; session = undefined;
  });
  await window.loadFile(index);
  if (app.isPackaged) updater.check().then(value => { if (value.phase === 'available') return updater.download(); }).catch(() => {});
  return window;
}
module.exports = { createLauncher };
if (require.main === module) {
  if (!app.requestSingleInstanceLock()) app.quit();
  else {
    let window;
    app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
    app.whenReady().then(async () => { window = await createLauncher(); }).catch(async () => {
      await dialog.showMessageBox({ type: 'error', message: 'The launcher bundle is incomplete. Reinstall the launcher or prepare its runtime resources.' }); app.quit();
    });
    app.on('window-all-closed', () => app.quit());
  }
}
