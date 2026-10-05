'use strict';
// Builds two isolated NSIS apps and exercises a real HTTPS download/install.
// Test-only certificate/debug switches are added to staged source, never the
// distributable launcher. Its registry identity, profile and signing key differ.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { publishRelease } = require('../scripts/publish-updates.cjs');
const source = path.resolve(__dirname, '..');
const root = path.resolve(source, '..');
let fixture, server, browser, cdp, checkpoint = 'preparation', installedPath;
const processes = new Set();
async function run(exe, args, cwd, logFile, env = process.env) {
  const handle = logFile ? await fs.open(logFile, 'w') : undefined;
  const child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: handle ? ['ignore', handle.fd, handle.fd] : 'ignore', shell: false });
  processes.add(child);
  try { await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Installed-update subprocess failed; inspect its artifact log.'))); }); }
  finally { processes.delete(child); if (handle) await handle.close(); }
}
async function until(read, predicate, timeout = 45000) {
  const end = Date.now() + timeout;
  let last, lastError;
  do { try { const value = await read(); last = value; if (predicate(value)) return value; } catch (error) { lastError = error.message; } await new Promise(resolve => setTimeout(resolve, 250)); } while (Date.now() < end);
  if (last?.result?.phase) console.error('Last updater phase: ' + last.result.phase + '; ' + last.result.message);
  if (last?.result?.version) console.error('Last launcher state: ' + JSON.stringify({ version: last.result.version, connected: last.result.connected, signedIn: !!last.result.user }));
  if (lastError) console.error('Last test error: ' + lastError);
  throw new Error('Installed updater did not reach its expected state at: ' + checkpoint);
}
async function connect(port) {
  const tabs = await until(async () => (await fetch(`http://127.0.0.1:${port}/json`)).json(), value => value.some(tab => tab.type === 'page'));
  const socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0; const requests = new Map();
  socket.addEventListener('message', event => {
    const result = JSON.parse(event.data), pending = requests.get(result.id);
    if (pending) { requests.delete(result.id); clearTimeout(pending.timer); result.error ? pending.reject(new Error('Test browser command failed.')) : pending.resolve(result.result); }
  });
  return { close: () => socket.close(), js: async expression => {
    const command = ++id;
    const result = await new Promise((resolve, reject) => {
      requests.set(command, { resolve, reject, timer: setTimeout(() => { requests.delete(command); reject(new Error('Test browser command timed out.')); }, 20000) });
      socket.send(JSON.stringify({ id: command, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    if (result.exceptionDetails) throw new Error('Test renderer evaluation failed.');
    return result.result.value;
  } };
}
async function main() {
  if (process.platform !== 'win32') throw new Error('Installed updater check requires Windows.');
  const stage = process.env.UNDAUNTED_TEST_STAGE;
  if (!stage || !path.resolve(stage).startsWith(path.join(root, 'artifacts') + path.sep)) throw new Error('Provide a checked disposable backend stage.');
  const artifact = path.join(root, 'artifacts', 'launcher-installed-update-' + Date.now());
  const appDir = path.join(artifact, 'app'), feedDir = path.join(artifact, 'feed'), installed = path.join(artifact, 'installed'), profile = path.join(artifact, 'profile');
  installedPath = installed;
  await fs.mkdir(artifact, { recursive: true }); await fs.mkdir(appDir); await fs.mkdir(profile); await fs.mkdir(feedDir);
  for (const name of ['src', 'scripts', 'resources', 'build', 'LICENSE.txt', 'NOTICE.md', 'ADDITIONAL_TERMS.md']) await fs.cp(path.join(source, name), path.join(appDir, name), { recursive: true });
  await fs.cp(path.join(source, 'node_modules'), path.join(appDir, 'node_modules'), { recursive: true, dereference: true });
  const certFile = path.join(artifact, 'test-cert.pem'), tlsKey = path.join(artifact, 'test-tls-key.pem');
  await run(process.env.OPENSSL_EXE || path.join(process.env.ProgramFiles, 'Git/usr/bin/openssl.exe'),
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', tlsKey, '-out', certFile, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], artifact);
  server = https.createServer({ key: await fs.readFile(tlsKey), cert: await fs.readFile(certFile) }, async (req, res) => {
    const name = new URL(req.url, 'https://localhost').pathname.slice(1);
    if (!/^(latest\.json|Undaunted-Launcher-1\.0\.[67]-Setup\.exe(?:\.blockmap)?)$/.test(name)) { res.writeHead(404); res.end(); return; }
    try { const file = path.join(feedDir, name), stat = await fs.stat(file); res.writeHead(200, { 'Content-Length': stat.size, 'Cache-Control': 'no-store' }); require('node:fs').createReadStream(file).pipe(res); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const keys = crypto.generateKeyPairSync('ed25519'), keyFile = path.join(artifact, 'test-signing-key.pem');
  await fs.writeFile(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const config = { appId: 'community.undaunted.launcher112.updater-test', url: `https://localhost:${port}/`, requiresTailscale: false,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) };
  await fs.writeFile(path.join(appDir, 'resources/updates.json'), JSON.stringify(config));
  fixture = spawn(process.execPath, [path.join(source, 'test/server-fixture.cjs')], { cwd: stage, windowsHide: true,
    env: { ...process.env, NODE_PATH: path.join(root, 'UndauntedMetagame/node_modules') }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const backendPort = await new Promise((resolve, reject) => { fixture.once('message', msg => resolve(msg.port)); fixture.once('exit', () => reject(new Error('Disposable backend did not start.'))); });
  await fs.writeFile(path.join(appDir, 'resources/server.json'), JSON.stringify({ server: `http://127.0.0.1:${backendPort}` }));
  await fs.writeFile(path.join(profile, 'config.json'), JSON.stringify({ server: `http://127.0.0.1:${backendPort}`, gameDirectory: 'kept-test-game-folder', language: 'fr' }));
  const debugServer = require('node:net').createServer(); await new Promise(resolve => debugServer.listen(0, '127.0.0.1', resolve));
  const debugPort = debugServer.address().port; await new Promise(resolve => debugServer.close(resolve));
  // These hooks exist only in the copied test app. The real app retains strict TLS.
  const probeFile = path.join(artifact, 'relaunch-probe.json'), closeFile = path.join(artifact, 'close-test-app');
  const probe = `
    setInterval(async () => {
      try {
        if (await fs.stat(${JSON.stringify(closeFile)}).catch(() => false)) { window.close(); return; }
        const state = await window.webContents.executeJavaScript('window.launcher.state()');
        const update = await window.webContents.executeJavaScript('window.launcher.updateState()');
        if (state.ok && state.result.connected && state.result.user) {
          const {version, gameDirectory, user} = state.result;
          await fs.writeFile(${JSON.stringify(probeFile)}, JSON.stringify({version, gameDirectory, userId:user.userId, transport:update.result.transport}));
          if (version === '1.0.7') await fs.writeFile(${JSON.stringify(path.join(artifact, 'upgraded-launcher.png'))}, (await window.webContents.capturePage()).toPNG());
        }
      } catch {}
    }, 500);
  `;
  let mainSource = await fs.readFile(path.join(appDir, 'src/main.cjs'), 'utf8');
  mainSource = mainSource.replace("const game = require('./game.cjs');", `const game = require('./game.cjs');\napp.setPath('userData', ${JSON.stringify(profile)});\napp.commandLine.appendSwitch('remote-debugging-port', '${debugPort}');\napp.commandLine.appendSwitch('ignore-certificate-errors');`)
    .replace('window = await createLauncher();', `window = await createLauncher({ visible: false }); await fs.appendFile(${JSON.stringify(path.join(artifact, 'startup.jsonl'))}, JSON.stringify({ version:app.getVersion(), ready:true })+'\\n'); ${probe}`)
    .replace('}).catch(async () => {', `}).catch(async error => { await fs.appendFile(${JSON.stringify(path.join(artifact, 'startup.jsonl'))}, JSON.stringify({ version:app.getVersion(), errorName:error.name, errorCode:error.code })+'\\n');`);
  await fs.writeFile(path.join(appDir, 'src/main.cjs'), mainSource);
  const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  pkg.name = 'undaunted-updater-test'; pkg.productName = 'Undaunted Updater Test'; pkg.build.appId = config.appId;
  pkg.build.nsis.runAfterFinish = false; pkg.build.nsis.createDesktopShortcut = false; pkg.build.nsis.createStartMenuShortcut = false;
  for (const version of ['1.0.6', '1.0.7']) {
    pkg.version = version; await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify(pkg, null, 2));
    await run(process.execPath, [require.resolve('electron-builder/out/cli/cli.js'), '--win', '--x64', '--publish', 'never',
      '--config.publish.provider=generic', `--config.publish.url=${config.url}`], appDir, path.join(artifact, `build-${version}.log`));
    console.log(`Built isolated updater test ${version}.`);
  }
  await publishRelease({ installer: path.join(appDir, 'release/Undaunted-Launcher-1.0.7-Setup.exe'), version: '1.0.7', output: feedDir, config, keyFile, notes: 'Isolated upgrade check.' });
  await run(path.join(appDir, 'release/Undaunted-Launcher-1.0.6-Setup.exe'), ['/S', `/D=${installed}`], artifact, path.join(artifact, 'install.log'));
  const exe = path.join(installed, 'Undaunted Updater Test.exe');
  checkpoint = 'initial browser';
  browser = spawn(exe, [], { windowsHide: true, env: { ...process.env, NODE_EXTRA_CA_CERTS: certFile }, stdio: 'ignore' });
  cdp = await connect(debugPort);
  console.log('Installed test launcher opened.');
  checkpoint = 'backend connection';
  const state = await until(() => cdp.js('window.launcher.state()'), value => value?.ok && value.result.connected);
  assert.equal(state.result.version, '1.0.6');
  console.log('Disposable backend connected.');
  const registered = await cdp.js("window.launcher.register({username:'UpgradeTest',password:'disposable upgrade test password'})");
  assert.equal(registered.ok, true);
  console.log('Disposable account registered.');
  const identity = registered.result.user.userId;
  const encrypted = await fs.readFile(path.join(profile, 'session.bin')); assert.ok(!encrypted.toString().includes('ULR_'));
  checkpoint = 'download';
  await until(() => cdp.js('window.launcher.updateState()'), value => value?.ok && value.result.phase === 'ready', 120000);
  console.log('Verified installer downloaded.');
  await until(() => cdp.js("document.getElementById('update-action').disabled"), value => value === false);
  await cdp.js("document.getElementById('update-action').click()"); cdp.close(); cdp = undefined;
  checkpoint = 'installed package';
  await until(async () => JSON.parse(require('@electron/asar').extractFile(path.join(installed, 'resources/app.asar'), 'package.json')).version, value => value === '1.0.7', 120000);
  // --force-run should relaunch despite runAfterFinish=false. A test-only probe
  // uses the actual preload/IPC state after reopening; the Windows shell does
  // not reliably retain the original remote-debugging listener on relaunch.
  checkpoint = 'relaunch and session restoration';
  console.log('Package updated; waiting for relaunch.');
  const upgraded = await until(async () => JSON.parse(await fs.readFile(probeFile, 'utf8')), value => value.version === '1.0.7', 120000);
  assert.equal(upgraded.userId, identity); assert.equal(upgraded.gameDirectory, 'kept-test-game-folder');
  const persisted = JSON.parse(await fs.readFile(path.join(profile, 'config.json'))); assert.equal(persisted.language, 'fr');
  assert.equal(upgraded.transport, 'https');
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify({ passed: true, from: '1.0.6', to: '1.0.7', preservedLogin: true, preservedGameFolder: true, preservedLanguage: true, tailscaleRequired: false }, null, 2));
  console.log('Installed updater passed: real HTTPS download, NSIS upgrade/relaunch, encrypted login, game folder and language preserved; no Tailscale required.');
  // Close only the isolated test window, then remove only its own NSIS app.
  await fs.writeFile(closeFile, 'close');
  await new Promise(resolve => setTimeout(resolve, 1000));
  const entries = await fs.readdir(installed), uninstaller = entries.find(name => /^Uninstall.*\.exe$/.test(name));
  if (uninstaller) await run(path.join(installed, uninstaller), ['/S'], artifact, path.join(artifact, 'uninstall.log'));
  console.log(`Installed check artifacts: ${artifact}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (cdp) { try { await cdp.js('window.close()'); } catch {} cdp.close(); }
  if (browser && browser.exitCode === null) browser.kill();
  if (installedPath) await run(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', "Get-Process -Name 'Undaunted Updater Test' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:UNDAUNTED_TEST_EXE } | Stop-Process -Force"], source, undefined, { ...process.env, UNDAUNTED_TEST_EXE: path.join(installedPath, 'Undaunted Updater Test.exe') }).catch(() => {});
  for (const child of processes) child.kill();
  if (fixture?.connected) { fixture.send('close'); await new Promise(resolve => { fixture.once('exit', resolve); setTimeout(resolve, 3000); }); if (fixture.exitCode === null) fixture.kill(); }
  if (server) await new Promise(resolve => server.close(resolve));
});
