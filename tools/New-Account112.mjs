// Add a player account to the local 1.12 metagame database.
//
//   node tools/New-Account112.mjs <Username> [--same-id-as <account file>] [--data-root <dir>]
//
// The database is UndauntedMetagame/.env's DB_FILENAME, and it is backed up
// under <dataRoot>/data/backups first. The account's login key is written to
// <dataRoot>/data/account-1.12-<Username>.json (Backend = the deploy server's
// MY_IP and the metagame's PORT) and never printed.
//
// --same-id-as reuses the user id from another account file (relative to the
// data root), so a player keeps one identity across servers. The login key is
// always new, so two servers never share a credential.
//
// The data root comes from --data-root, then UNDAUNTED112_DATA_ROOT, then
// tools/local112.json's dataRoot.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tools = dirname(fileURLToPath(import.meta.url));
const repo = resolve(tools, '..');
const metagame = join(repo, 'UndauntedMetagame');
const deploy = join(repo, 'UndauntedDeployServer');

function option(name) {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
}
function readEnv(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}
function localConfig() {
  const file = join(tools, 'local112.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

const username = process.argv[2];
if (!username || !/^[A-Za-z0-9_-]{3,16}$/.test(username)) {
  throw new Error('Usage: node tools/New-Account112.mjs <Username> [--same-id-as <account file>] [--data-root <dir>]');
}
const dataRoot = option('--data-root') ?? process.env.UNDAUNTED112_DATA_ROOT ?? localConfig().dataRoot;
if (!dataRoot) {
  throw new Error('The local data root is not configured: pass --data-root, set UNDAUNTED112_DATA_ROOT, or copy tools/local112.example.json to tools/local112.json.');
}
const sameIdFile = option('--same-id-as');

const metagameEnv = readEnv(join(metagame, '.env'));
const deployEnv = readEnv(join(deploy, '.env'));
if (!metagameEnv.DB_FILENAME) throw new Error('DB_FILENAME is not set in UndauntedMetagame/.env');
if (!metagameEnv.PORT) throw new Error('PORT is not set in UndauntedMetagame/.env');
if (!deployEnv.MY_IP) throw new Error('MY_IP is not set in UndauntedDeployServer/.env');
const dbPath = isAbsolute(metagameEnv.DB_FILENAME) ? metagameEnv.DB_FILENAME : resolve(metagame, metagameEnv.DB_FILENAME);
if (!existsSync(dbPath)) throw new Error(`${dbPath} does not exist; start the metagame once to create it.`);

const accountFile = join(dataRoot, 'data', `account-1.12-${username}.json`);
if (existsSync(accountFile)) throw new Error(`${accountFile} exists; refusing to replace it.`);

let userId = `UID-${randomUUID()}`;
if (sameIdFile) {
  userId = JSON.parse(readFileSync(resolve(dataRoot, sameIdFile), 'utf8')).UserId;
  if (!/^UID-[0-9a-f-]{36}$/.test(userId ?? '')) throw new Error(`${sameIdFile} has no usable UserId`);
}

const Database = createRequire(join(metagame, 'package.json'))('better-sqlite3');
const db = new Database(dbPath);
try {
  if (db.prepare('SELECT 1 FROM users WHERE userId = ? OR name = ?').get(userId, username)) {
    throw new Error(`a 1.12 user with that id or the name ${username} already exists`);
  }

  const backups = join(dataRoot, 'data', 'backups');
  mkdirSync(backups, { recursive: true });
  const backup = join(backups, `metagame-1.12-before-account-${username}-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  await db.backup(backup);

  const userKey = `UUK_${randomBytes(24).toString('hex')}`;
  db.transaction(() => {
    db.prepare('INSERT INTO users (userId, name, notes, isAdmin) VALUES (?, ?, 0, 0)').run(userId, username);
    db.prepare('INSERT INTO userapikeys (userId, keyHash) VALUES (?, ?)').run(userId, createHash('sha256').update(userKey, 'utf8').digest('hex'));
  })();

  mkdirSync(dirname(accountFile), { recursive: true });
  writeFileSync(accountFile, JSON.stringify({ UserId: userId, Username: username, UUK: userKey, Backend: `${deployEnv.MY_IP}:${metagameEnv.PORT}` }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(`1.12 account "${username}" (${userId}) created; key saved to ${accountFile}; backup ${backup}`);
} finally {
  db.close();
}
