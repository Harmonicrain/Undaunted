'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { trustedConfig, signManifest, verifyManifest, verifyInstaller, compareVersions } = require('./lib/update-feed.cjs');
async function hashFile(file) {
  const hash = crypto.createHash('sha512');
  for await (const chunk of require('node:fs').createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}
async function publishRelease({ installer, version, output, config, keyFile, notes = '', nextFeed }) {
  config = trustedConfig(config);
  const file = { url: path.basename(installer), sha512: await hashFile(installer), size: (await fs.stat(installer)).size };
  const payload = { schema: 1, appId: config.appId, channel: 'stable', version,
    releaseDate: new Date().toISOString(), releaseNotes: notes, files: [file], ...(nextFeed ? { nextFeed } : {}) };
  const envelope = signManifest(payload, await fs.readFile(keyFile));
  verifyManifest(envelope, config); // Also refuses a signing key different from the packaged trust key.
  const targetDir = path.resolve(output); const privateFile = path.resolve(keyFile);
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (normalize(privateFile) === normalize(targetDir) || normalize(privateFile).startsWith(normalize(targetDir) + path.sep)) throw new Error('The signing key cannot be inside the public folder.');
  await fs.mkdir(targetDir, { recursive: true });
  try {
    const previous = verifyManifest(JSON.parse(await fs.readFile(path.join(targetDir, 'latest.json'), 'utf8')), config);
    if (compareVersions(version, previous.version)<0) throw new Error('Cannot publish an older version over the latest release.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const target = path.join(targetDir, file.url);
  try { if (await hashFile(target) !== file.sha512) throw new Error('A different installer already uses this version. Increment the version.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.copyFile(installer, target + '.tmp'); await verifyInstaller(target + '.tmp', file);
  await fs.rename(target + '.tmp', target);
  try { await fs.copyFile(installer + '.blockmap', target + '.blockmap.tmp'); await fs.rename(target + '.blockmap.tmp', target + '.blockmap'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; } // Full downloads still work.
  // Publish discovery last, after the complete installer is in place.
  await fs.writeFile(path.join(targetDir, 'latest.json.tmp'), JSON.stringify(envelope));
  await fs.rename(path.join(targetDir, 'latest.json.tmp'), path.join(targetDir, 'latest.json'));
  return payload;
}
module.exports = { publishRelease, hashFile };
