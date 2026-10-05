'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const semver = require('semver');
const APP_ID = 'community.undaunted.launcher112';
const MAX_MANIFEST = 64 * 1024;

function feedConfig(value) {
  if (!value || typeof value.url !== 'string' || value.url.length > 2048 || typeof value.requiresTailscale !== 'boolean') throw new Error('Invalid update configuration.');
  const url = new URL(value.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) throw new Error('Updates require an HTTPS folder address.');
  if (value.requiresTailscale && !url.hostname.endsWith('.ts.net')) throw new Error('Private updates require a Tailscale HTTPS name.');
  return { url: url.href, requiresTailscale: value.requiresTailscale };
}
function trustedConfig(value) {
  const feed = feedConfig(value);
  const key = crypto.createPublicKey(value.publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Invalid update verification key.');
  return { ...feed, publicKey: value.publicKey, appId: value.appId || APP_ID };
}
function verifyManifest(envelope, config) {
  if (!envelope || typeof envelope.payload !== 'string' || envelope.payload.length > MAX_MANIFEST ||
      typeof envelope.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)) throw new Error('The update release signature is invalid.');
  const bytes = Buffer.from(envelope.payload, 'base64');
  if (bytes.toString('base64') !== envelope.payload || !crypto.verify(null, bytes, config.publicKey, Buffer.from(envelope.signature, 'base64'))) throw new Error('The update release signature is invalid.');
  const value = JSON.parse(bytes.toString('utf8'));
  if (value.schema !== 1 || value.appId !== config.appId || value.channel !== 'stable' ||
      typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version) || semver.valid(value.version) !== value.version ||
      typeof value.releaseDate !== 'string' || !Number.isFinite(Date.parse(value.releaseDate)) ||
      typeof value.releaseNotes !== 'string' || value.releaseNotes.length > 4000 ||
      !Array.isArray(value.files) || value.files.length !== 1) throw new Error('The signed update release is not compatible with this launcher.');
  const file = value.files[0];
  if (file.url !== `Undaunted-Launcher-${value.version}-Setup.exe` || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512) ||
      !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 512 * 1024 * 1024) throw new Error('Invalid signed installer details.');
  // Return only fields consumed by the NSIS updater. Never pass through remote
  // web-installer packages, executable arguments, paths or arbitrary URLs.
  return { schema: 1, appId: value.appId, channel: 'stable', version: value.version,
    releaseDate: value.releaseDate, releaseNotes: value.releaseNotes,
    files: [{ url: file.url, sha512: file.sha512, size: file.size }],
    ...(value.nextFeed ? { nextFeed: feedConfig(value.nextFeed) } : {}) };
}
function signManifest(value, privateKey) {
  const bytes = Buffer.from(JSON.stringify(value));
  return { payload: bytes.toString('base64'), signature: crypto.sign(null, bytes, privateKey).toString('base64') };
}
async function fetchManifest(feed, fetcher = fetch) {
  const response = await fetcher(new URL('latest.json', feed.url), { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Cache-Control': 'no-cache' } });
  if (!response.ok) throw new Error('The update server is unavailable.');
  if (Number(response.headers.get('content-length')) > MAX_MANIFEST) throw new Error('The update release is too large.');
  const chunks = []; let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_MANIFEST) throw new Error('The update release is too large.');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}
async function verifyInstaller(file, info) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== info.size) throw new Error('The downloaded installer failed verification.');
  const hash = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  if (hash.digest('base64') !== info.sha512) throw new Error('The downloaded installer failed verification.');
}
module.exports = { APP_ID, MAX_MANIFEST, feedConfig, trustedConfig, verifyManifest, signManifest, fetchManifest, verifyInstaller };
