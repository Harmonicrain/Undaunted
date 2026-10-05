'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { feedConfig, APP_ID } = require('../src/update-feed.cjs');
function option(name) { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; }
async function main() {
  const root = path.resolve(__dirname, '../..');
  let local = {}; try { local = JSON.parse(await fs.readFile(path.join(root, 'tools/local112.json'), 'utf8')); } catch {}
  const dataRoot = option('--data-root') || process.env.UNDAUNTED112_DATA_ROOT || local.dataRoot;
  if (!dataRoot) throw new Error('Configure a data root or pass --data-root.');
  const url = option('--feed');
  if (!url) throw new Error('Pass --feed with the HTTPS update folder address.');
  const mode = option('--tailscale');
  if (mode && !['true', 'false'].includes(mode)) throw new Error('--tailscale must be true or false.');
  const feed = feedConfig({ url, requiresTailscale: mode ? mode === 'true' : new URL(url).hostname.endsWith('.ts.net') });
  const keyFile = path.resolve(option('--key-file') || path.join(dataRoot, 'data/launcher-update-private/signing-key.pem'));
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const within = (child, parent) => normalize(child) === normalize(parent) || normalize(child).startsWith(normalize(parent) + path.sep);
  const publishDir = path.resolve(option('--output') || path.join(dataRoot, 'data/launcher-updates'));
  if (within(keyFile, root)) throw new Error('Keep the signing key outside the source repository.');
  if (within(keyFile, publishDir) || within(publishDir, path.dirname(keyFile))) throw new Error('Keep public releases and signing keys in separate directories.');
  await fs.mkdir(path.dirname(keyFile), { recursive: true });
  let privateKey;
  try { privateKey = crypto.createPrivateKey(await fs.readFile(keyFile)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Existing signing key is unreadable. Do not replace it; restore its backup.');
    const keys = crypto.generateKeyPairSync('ed25519'); privateKey = keys.privateKey;
    await fs.writeFile(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 release key is required.');
  if (process.platform === 'win32') {
    const account = execFileSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true }).trim();
    execFileSync('icacls.exe', [keyFile, '/inheritance:r', '/grant:r', `${account}:(F)`, 'SYSTEM:(F)'], { windowsHide: true, stdio: 'ignore' });
  }
  const resources = path.resolve(__dirname, '../resources'); await fs.mkdir(resources, { recursive: true });
  await fs.writeFile(path.join(resources, 'updates.json'), JSON.stringify({ ...feed, appId: APP_ID,
    publicKey: crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) }, null, 2));
  await fs.mkdir(publishDir, { recursive: true });
  await fs.writeFile(path.resolve(__dirname, '../release.local.json'), JSON.stringify({ keyFile, publishDir }, null, 2));
  console.log(`Configured ${feed.requiresTailscale ? 'private Tailscale' : 'public HTTPS'} updates. Signing key retained outside the repository; never publish it.`);
}
main().catch(() => { console.error('Update configuration failed. Check the HTTPS address, data root and private-key permissions.'); process.exitCode = 1; });
