'use strict';
const { app, shell } = require('electron');
// This test deliberately closes/reopens the only window to check session restore.
app.on('window-all-closed', () => {});
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createLauncher } = require('../src/main.cjs');
const root = path.resolve(__dirname, '../..');
let fixture;
let temp;
let window;
const externalLinks = [];
const originalOpenExternal = shell.openExternal;
shell.openExternal = async url => { externalLinks.push(url); };
const deadline = setTimeout(() => { console.error('Electron smoke timed out.'); if (fixture) fixture.kill(); app.exit(1); }, 60000);
async function run() {
  const stage = process.env.UNDAUNTED_TEST_STAGE;
  if (!stage) throw new Error('Set UNDAUNTED_TEST_STAGE to a tested artifacts/<build>/UndauntedMetagame folder.');
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'undaunted-launcher-smoke-'));
  const resources = path.join(temp, 'resources');
  await fs.mkdir(resources);
  fixture = spawn('node.exe', [path.join(__dirname, 'server-fixture.cjs')], {
    cwd: stage, windowsHide: true,
    env: { ...process.env, NODE_PATH: path.join(root, 'UndauntedMetagame/node_modules') },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Smoke backend did not start.')), 15000);
    fixture.once('message', message => { clearTimeout(timeout); resolve(message.port); });
    fixture.once('exit', () => { clearTimeout(timeout); reject(new Error('Smoke backend failed.')); });
  });
  await fs.writeFile(path.join(resources, 'server.json'), JSON.stringify({ server: `http://127.0.0.1:${port}` }));
  // A disposable copy of the game's settings file; the real one is never touched.
  const settingsFile = path.join(temp, 'GameUserSettings.ini');
  await fs.writeFile(settingsFile, '[/Script/Archon.ArchonGameUserSettings]\r\nFrameRateLimit=90.000000\r\nVersion=5\r\n');
  await app.whenReady();
  window = await createLauncher({ resources, profile: path.join(temp, 'profile'), visible: false, gameSettingsPath: settingsFile });
  const js = source => window.webContents.executeJavaScript(source);
  const painted = () => js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  // Wait for the actual renderer to initialize through the restricted preload.
  for (let tries = 0; tries < 100; tries++) {
    if (await js("document.getElementById('connection').textContent.includes('Private network')")) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(await js("typeof window.launcher.register === 'function' && typeof window.require === 'undefined'"));
  for (let tries = 0; tries < 100; tries++) {
    if (await js("!document.getElementById('news-preview').hidden")) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await js("document.getElementById('news-preview').hidden"), false);
  await js("document.getElementById('news-open').click()");
  assert.equal(await js("document.getElementById('news').open && document.getElementById('news-open').getAttribute('aria-expanded') === 'true'"), true);
  // Chromium pauses painting in hidden windows; inspect the transition's end state.
  await js("document.getElementById('news-preview').getAnimations().forEach(animation => animation.finish())");
  for (let tries = 0; tries < 50; tries++) {
    if (await js("getComputedStyle(document.getElementById('news-preview')).visibility === 'hidden'")) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(await js("document.getElementById('news-preview').inert && getComputedStyle(document.getElementById('news-preview')).visibility === 'hidden' && document.getElementById('news-preview').getBoundingClientRect().top >= innerHeight"), true, 'Expanded preview must slide below the window and become hidden: ' + JSON.stringify(await js("(() => { const card = document.getElementById('news-preview'), style = getComputedStyle(card); return { inert: card.inert, visibility: style.visibility, transform: style.transform, top: card.getBoundingClientRect().top, height: innerHeight }; })()")));
  await js("document.getElementById('news-close').click()");
  for (let tries = 0; tries < 50; tries++) {
    if (await js("document.getElementById('news-open').getAttribute('aria-expanded') === 'false'")) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(await js("!document.getElementById('news').open && document.getElementById('news-open').getAttribute('aria-expanded') === 'false'"), true);
  await js("document.getElementById('news-preview').getAnimations().forEach(animation => animation.finish())");
  assert.equal(await js("!document.getElementById('news-preview').inert && getComputedStyle(document.getElementById('news-preview')).visibility === 'visible' && document.activeElement.id === 'news-open'"), true, 'Close must restore the preview and focus');
  // Native Escape must restore the card just like the Close button.
  await js("document.getElementById('news-open').click()");
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  for (let tries = 0; tries < 50; tries++) {
    if (await js("!document.getElementById('news').open && !document.getElementById('news-preview').inert")) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(await js("!document.getElementById('news').open && !document.getElementById('news-preview').inert && document.getElementById('news-open').getAttribute('aria-expanded') === 'false'"), true, 'Escape must restore the preview');
  await js("document.getElementById('settings-open').click()");
  for (let tries = 0; tries < 100; tries++) {
    if (await js("document.getElementById('game-settings').open")) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(await js("document.getElementById('game-settings').open && document.getElementById('game-settings').contains(document.getElementById('server-form')) && !document.querySelector('.content').contains(document.getElementById('settings'))"), true, 'Server settings must be in the cog dialog');
  await js("document.getElementById('settings').open=true; document.getElementById('server-address').value='ftp://example.invalid'; document.getElementById('server-form').requestSubmit()");
  for (let tries = 0; tries < 100; tries++) {
    if (await js("document.getElementById('settings-message').classList.contains('error')")) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(await js("document.getElementById('game-settings').open && document.getElementById('settings-message').classList.contains('error')"), true, 'Server validation errors must appear in Settings');
  await js(`document.getElementById('server-address').value=${JSON.stringify(`http://127.0.0.1:${port}`)}; document.getElementById('server-form').requestSubmit()`);
  for (let tries = 0; tries < 100; tries++) {
    if (await js("!document.getElementById('game-settings').open")) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(await js("!document.getElementById('game-settings').open && document.getElementById('connection').textContent.includes('Server online')"), true, 'Save and reconnect must still work from Settings');
  await js("document.getElementById('discord-open').click()");
  for (let tries = 0; tries < 50 && !externalLinks.length; tries++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(externalLinks, ['https://discord.gg/zxZfbhMEs7']);
  assert.equal((await js("window.launcher.discord('https://example.invalid')")).ok, true);
  assert.deepEqual(externalLinks, ['https://discord.gg/zxZfbhMEs7', 'https://discord.gg/zxZfbhMEs7']);
  const screenshot = process.env.UNDAUNTED_TEST_SCREENSHOT;
  if (screenshot) await js("Promise.all([document.fonts.ready, ...['play-face.png','play-buckle.png','play-sparkle.png','news-frame.png','button-blue.png'].map(name => new Promise(resolve => { const image = new Image(); image.onload = image.onerror = resolve; image.src = 'art/' + name; }))])");
  if (screenshot) await fs.writeFile(screenshot.replace(/\.png$/, '-login.png'), (await window.webContents.capturePage()).toPNG());
  await js("document.getElementById('tab-register').click(); document.getElementById('username').value='SmokeSlayer'; document.getElementById('password').value='a long smoke password'; document.getElementById('confirm-password').value='a long smoke password'; document.getElementById('account-form').requestSubmit()");
  let registration;
  for (let tries = 0; tries < 100; tries++) {
    const result = await js('window.launcher.state()');
    if (result.ok && result.result.user) { registration = result.result; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(registration.user.username, 'SmokeSlayer');
  const encrypted = await fs.readFile(path.join(temp, 'profile/session.bin'));
  assert.ok(!encrypted.toString().includes('ULR_'));
  assert.ok(!encrypted.toString().includes('a long smoke password'));
  const userId = registration.user.userId;
  const missingGame = await js('window.launcher.play()');
  assert.equal(missingGame.ok, false);
  assert.match(missingGame.message, /Select your Dauntless/);
  // Restart the window to prove the encrypted refresh token restores the identity.
  window.destroy();
  window = await createLauncher({ resources, profile: path.join(temp, 'profile'), visible: false, gameSettingsPath: settingsFile });
  let restored;
  for (let tries = 0; tries < 100; tries++) {
    const result = await js('window.launcher.state()');
    if (result.ok && result.result.user) { restored = result.result; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(restored.user.userId, userId);
  if (screenshot) {
    await js("document.getElementById('auth').hidden=true; document.getElementById('play-panel').hidden=false; document.getElementById('player-name').textContent='John'");
    // Visual preview only; no click and no game launch. Preserve the real state.
    await js("document.getElementById('play').disabled=false");
    await painted();
    await fs.writeFile(screenshot, (await window.webContents.capturePage()).toPNG());
    await js("document.getElementById('news-open').click()");
    await painted();
    await fs.writeFile(screenshot.replace(/\.png$/, '-notes.png'), (await window.webContents.capturePage()).toPNG());
    await js("document.getElementById('news-close').click()");
    await js("document.getElementById('settings-open').click()");
    for (let tries = 0; tries < 100; tries++) {
      if (await js("document.getElementById('game-settings').open")) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await js("document.getElementById('settings').open=true");
    await painted();
    await fs.writeFile(screenshot.replace(/\.png$/, '-settings.png'), (await window.webContents.capturePage()).toPNG());
    await js("document.getElementById('settings-cancel').click()");
    window.setSize(900, 690);
    await js("document.querySelector('.content').scrollTop = document.querySelector('.content').scrollHeight");
    await painted();
    await fs.writeFile(screenshot.replace(/\.png$/, '-small.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(1080, 760);
  }
  assert.equal((await js('window.launcher.logout()')).ok, true);
  assert.equal((await js("window.launcher.login({username:'SmokeSlayer',password:'incorrect'})")).ok, false);
  assert.equal((await js("window.launcher.login({username:'SmokeSlayer',password:'a long smoke password'})")).ok, true);
  const saved = await js("window.launcher.saveSettings({ language: 'fr', display: { mode: 2, width: 1600, height: 900, fps: 60, vsync: true } })");
  assert.equal(saved.ok, true, saved.message);
  assert.equal(saved.result.language, 'fr');
  const settings = await fs.readFile(settingsFile, 'utf8');
  assert.match(settings, /FrameRateLimit=60\.000000\r\n/);
  assert.match(settings, /Version=5/);
  assert.equal((await js("window.launcher.saveSettings({ language: 'xx' })")).ok, false);
  console.log('Electron smoke passed: sandbox, expandable news card, fixed Discord invite, registration, encrypted persistence, session restore, logout and login, game settings. No live server or game was used.');
}
run().then(() => { process.exitCode = 0; }).catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  shell.openExternal = originalOpenExternal;
  if (window && !window.isDestroyed()) window.destroy();
  if (fixture && fixture.connected) {
    fixture.send('close');
    await new Promise(resolve => { fixture.once('exit', resolve); setTimeout(resolve, 3000); });
    if (fixture.exitCode === null) fixture.kill();
  }
  if (temp) await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  app.exit(process.exitCode || 0);
  clearTimeout(deadline);
});
