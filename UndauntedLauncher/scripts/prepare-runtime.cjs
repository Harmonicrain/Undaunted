'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const game = require('../src/game.cjs');
function option(name) { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; }
async function main() {
  const root = path.resolve(__dirname, '../..');
  let local = {};
  try { local = JSON.parse(await fs.readFile(path.join(root, 'tools/local112.json'), 'utf8')); } catch { /* flags required */ }
  const directory = option('--game-directory') || process.env.UNDAUNTED112_GAME_DIR || local.gameDirectory;
  if (!directory) throw new Error('Set --game-directory or configure tools/local112.json.');
  const folder = await game.locateGame(directory);
  await game.verifyGame(folder);
  const resources = path.resolve(__dirname, '../resources');
  await fs.mkdir(resources, { recursive: true });
  const files = {};
  for (const file of game.RUNTIME_FILES) {
    await fs.copyFile(path.join(folder, file), path.join(resources, file));
    files[file] = await game.hashFile(path.join(resources, file));
  }
  let server = option('--server');
  if (!server) {
    // Read only the non-secret connection fields, never print the environment file.
    const metagame = await fs.readFile(path.join(root, 'UndauntedMetagame/.env'), 'utf8');
    const deploy = await fs.readFile(path.join(root, 'UndauntedDeployServer/.env'), 'utf8');
    const port = /^PORT\s*=\s*(\d+)\s*$/m.exec(metagame)?.[1];
    const host = /^MY_IP\s*=\s*([^\s]+)\s*$/m.exec(deploy)?.[1];
    if (!port || !host) throw new Error('Pass --server with the launcher API address.');
    server = `http://${host}:${port}`;
  }
  await fs.writeFile(path.join(resources, 'runtime.json'), JSON.stringify({ gameVersion: '1.12.0', files }, null, 2));
  await fs.writeFile(path.join(resources, 'server.json'), JSON.stringify({ server: game.serverOrigin(server) }, null, 2));
  for (const file of ['LICENSE.txt', 'NOTICE.md', 'ADDITIONAL_TERMS.md']) await fs.copyFile(path.join(root, file), path.resolve(__dirname, '..', file));
  console.log('Prepared verified 1.12 runtime files and launcher server settings. No credentials included.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
