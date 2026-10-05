'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { publishRelease } = require('./publish-updates.cjs');
const { trustedConfig } = require('../src/update-feed.cjs');
const directory = path.resolve(__dirname, '..');
function run(exe, args, env = process.env) {
  const result = spawnSync(exe, args, { cwd: directory, env, windowsHide: true, stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) throw new Error('Release check or packaging failed. No update feed was published.');
}
async function main() {
  const local = JSON.parse(await fs.readFile(path.join(directory, 'release.local.json'), 'utf8'));
  const config = trustedConfig(JSON.parse(await fs.readFile(path.join(directory, 'resources/updates.json'), 'utf8')));
  const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  const tests = (await fs.readdir(path.join(directory, 'test'))).filter(name => name.endsWith('.test.cjs')).map(name => path.join(directory, 'test', name));
  run(process.execPath, ['--test', ...tests]);
  const artifacts = path.resolve(directory, '../artifacts'); let stage = process.env.UNDAUNTED_TEST_STAGE;
  if (!stage) {
    const candidates = [];
    for (const name of await fs.readdir(artifacts)) {
      try {
        const manifest = JSON.parse((await fs.readFile(path.join(artifacts, name, 'manifest.json'), 'utf8')).replace(/^\uFEFF/, ''));
        if (manifest.testsPassed && Number.isFinite(Date.parse(manifest.createdUtc))) candidates.push({ name, date: Date.parse(manifest.createdUtc) });
      } catch {}
    }
    candidates.sort((a, b) => b.date - a.date);
    if (candidates.length) stage = path.join(artifacts, candidates[0].name, 'UndauntedMetagame');
  }
  if (!stage) throw new Error('Provide a checked backend stage for the disposable launcher smoke test.');
  run(require('electron'), [path.join(directory, 'test/smoke.cjs')], { ...process.env, UNDAUNTED_TEST_STAGE: stage });
  run(process.execPath, [path.join(directory, 'scripts/prepare-runtime.cjs')]);
  run(process.execPath, [require.resolve('electron-builder/out/cli/cli.js'), '--win', '--x64', '--publish', 'never',
    '--config.publish.provider=generic', `--config.publish.url=${config.url}`]);
  const at = process.argv.indexOf('--notes-file');
  const notes = at >= 0 ? await fs.readFile(process.argv[at + 1], 'utf8') : 'Undaunted Launcher update.';
  const migrationAt = process.argv.indexOf('--next-feed');
  const nextFeed = migrationAt >= 0 ? JSON.parse(await fs.readFile(process.argv[migrationAt + 1], 'utf8')) : undefined;
  await publishRelease({ installer: path.join(directory, 'release', `Undaunted-Launcher-${pkg.version}-Setup.exe`),
    version: pkg.version, output: local.publishDir, config, keyFile: local.keyFile, notes, nextFeed });
  console.log(`Launcher ${pkg.version} tested, packaged and published to the update folder. No game servers were restarted.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
