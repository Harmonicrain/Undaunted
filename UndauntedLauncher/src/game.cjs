'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const EXE = 'Dauntless-Win64-Shipping.exe';
const EXE_HASH = 'ee30d1821b4020ff1bcaa89a63fa6ef3515efb622f2969546b91bf018a379f43';
const RUNTIME_FILES = ['winmm.dll', 'UndauntedInternalServer.dll'];
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function locateGame(folder) {
  for (const suffix of ['', 'Binaries/Win64', 'Archon/Binaries/Win64', 'Dauntless/Archon/Binaries/Win64']) {
    const candidate = path.resolve(folder, suffix, EXE);
    try { if ((await fsp.stat(candidate)).isFile()) return path.dirname(candidate); } catch { /* next */ }
  }
  throw new Error('Select the Dauntless 1.12.0 folder containing Archon, or its Binaries\\Win64 folder.');
}
async function verifyGame(folder) {
  if (await hashFile(path.join(folder, EXE)) !== EXE_HASH) {
    throw new Error('This is a different Dauntless build. Select the supported 1.12.0 installation (CL392819).');
  }
}
async function verifyResources(resources) {
  const manifest = JSON.parse(await fsp.readFile(path.join(resources, 'runtime.json'), 'utf8'));
  for (const file of RUNTIME_FILES) {
    if (!/^[0-9a-f]{64}$/.test(manifest.files?.[file]) || await hashFile(path.join(resources, file)) !== manifest.files[file]) {
      throw new Error('The launcher runtime bundle is damaged. Reinstall the launcher.');
    }
  }
  return manifest;
}
async function runtimeStatus(folder, resources) {
  const manifest = await verifyResources(resources);
  for (const file of RUNTIME_FILES) {
    try { if (await hashFile(path.join(folder, file)) === manifest.files[file]) continue; } catch { /* needs repair */ }
    return false;
  }
  return true;
}
async function installRuntime(folder, resources) {
  await verifyGame(folder);
  const manifest = await verifyResources(resources);
  const tag = crypto.randomBytes(8).toString('hex');
  const prepared = [];
  const backups = [];
  const installed = [];
  try {
    // Prepare both files before replacing either. Keep previous DLLs for repair/rollback.
    for (const file of RUNTIME_FILES) {
      const temp = path.join(folder, `${file}.${tag}.tmp`);
      prepared.push(temp);
      await fsp.copyFile(path.join(resources, file), temp, fs.constants.COPYFILE_EXCL);
      if (await hashFile(temp) !== manifest.files[file]) throw new Error('Runtime verification failed.');
    }
    for (let i = 0; i < RUNTIME_FILES.length; i++) {
      const dest = path.join(folder, RUNTIME_FILES[i]);
      const backup = `${dest}.launcher-${tag}.bak`;
      try { await fsp.rename(dest, backup); backups.push([dest, backup]); }
      catch (err) { if (err.code !== 'ENOENT') throw err; }
      await fsp.rename(prepared[i], dest); installed.push(dest);
    }
  } catch {
    for (const file of installed.reverse()) await fsp.unlink(file).catch(() => {});
    for (const [dest, backup] of backups.reverse()) await fsp.rename(backup, dest).catch(() => {});
    throw new Error('Could not install the runtime. Close Dauntless and check that you can write to the game folder.');
  } finally {
    for (const temp of prepared) await fsp.unlink(temp).catch(() => {});
  }
}
function serverOrigin(value) {
  if (typeof value !== 'string' || value.length > 256) throw new Error('Enter a valid server address.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Include http:// or https:// in the server address.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use a server address without a path, credentials or query.');
  }
  const host = url.hostname;
  const numbers = host.split('.').map(Number);
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host) && numbers.every(n => n >= 0 && n <= 255);
  const privateNetwork = host === 'localhost' || host === '[::1]' || (ipv4 &&
    (numbers[0] === 127 || numbers[0] === 10 || (numbers[0] === 192 && numbers[1] === 168) ||
     (numbers[0] === 172 && numbers[1] >= 16 && numbers[1] <= 31) ||
     (numbers[0] === 100 && numbers[1] >= 64 && numbers[1] <= 127)));
  if (url.protocol === 'http:' && !privateNetwork) throw new Error('Public account servers must use HTTPS.');
  return url.origin;
}
function isTailscaleAddress(origin) {
  const parts = new URL(origin).hostname.split('.').map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}
// The languages the 1.12.0 client ships (Content/Localization/Game). Its options
// screen has no language choice; the game picks one at startup from -culture=.
const LANGUAGES = Object.freeze({ en: 'English', fr: 'Français', es: 'Español', it: 'Italiano',
  'pt-BR': 'Português (Brasil)', de: 'Deutsch', ja: '日本語', ru: 'Русский' });
function launchArgs(origin, user, exchangeCode, language) {
  const url = new URL(serverOrigin(origin));
  if (!/^UID-[0-9a-f-]{36}$/.test(user?.userId) || !/^[A-Za-z0-9_-]{3,16}$/.test(user?.username) ||
      !/^ULX_[0-9a-f]{64}$/.test(exchangeCode)) throw new Error('The server returned invalid launch details.');
  return ['-EpicPortal', '-NoEAC', '-AUTH_TYPE=exchangecode', `-AUTH_LOGIN=${user.userId}`,
    `-AUTH_PASSWORD=${exchangeCode}`, '-epicapp=Archon', '-epicenv=Prod', `-epicusername=${user.username}`,
    `-epicuserid=${user.userId}`, `-epicaccountid=${user.userId}`, '-epicsandboxid=jackal',
    '-epicdeploymentid=53565ba467df4edbb6f5a3d939a8b4f2', `-UndauntedMetagame=${url.host}`,
    ...(Object.hasOwn(LANGUAGES, language) ? [`-culture=${language}`] : [])];
}

// Display settings live in the client's GameUserSettings.ini, in the Archon
// section, under the keys its own video options write. Only those keys change;
// everything else in the file (including Version, which makes the game reset
// the file when missing) is kept as it is.
const SETTINGS_SECTION = '[/Script/Archon.ArchonGameUserSettings]';
const WINDOW_MODES = Object.freeze({ 0: 'Fullscreen', 1: 'Borderless window', 2: 'Windowed' }); // EWindowMode
const FRAME_RATES = Object.freeze([30, 60, 90, 120, 144, 165, 240, 0]); // 0 is unlimited
function settingsSection(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === SETTINGS_SECTION);
  if (start < 0) return { lines, start, end: -1 };
  let end = lines.findIndex((line, index) => index > start && line.trim().startsWith('['));
  if (end < 0) end = lines.length;
  return { lines, start, end };
}
function readDisplaySettings(text) {
  const { lines, start, end } = settingsSection(text);
  if (start < 0) return undefined;
  const values = {};
  for (const line of lines.slice(start + 1, end)) {
    const at = line.indexOf('=');
    if (at > 0) values[line.slice(0, at).trim()] ??= line.slice(at + 1).trim();
  }
  const number = key => Number.parseFloat(values[key]);
  return {
    mode: Number.isInteger(number('FullscreenMode')) ? number('FullscreenMode') : 1,
    width: Math.round(number('ResolutionSizeX')) || 1920,
    height: Math.round(number('ResolutionSizeY')) || 1080,
    fps: Number.isFinite(number('FrameRateLimit')) ? Math.round(number('FrameRateLimit')) : 0,
    vsync: /^true$/i.test(values.bUseVSync || '')
  };
}
function validDisplaySettings(value) {
  const mode = Number(value?.mode), width = Number(value?.width), height = Number(value?.height), fps = Number(value?.fps);
  if (!Object.hasOwn(WINDOW_MODES, mode) || !Number.isInteger(width) || !Number.isInteger(height) ||
      width < 640 || width > 7680 || height < 480 || height > 4320 || !FRAME_RATES.includes(fps) || typeof value?.vsync !== 'boolean') {
    throw new Error('Those display settings are not valid.');
  }
  return { mode, width, height, fps, vsync: value.vsync };
}
function updateDisplaySettings(text, value) {
  const settings = validDisplaySettings(value);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const { lines, start, end } = settingsSection(text);
  if (start < 0) throw new Error('The game settings file has no Archon section; start Dauntless once first.');
  const wanted = {
    FullscreenMode: settings.mode, LastConfirmedFullscreenMode: settings.mode, PreferredFullscreenMode: settings.mode,
    ResolutionSizeX: settings.width, ResolutionSizeY: settings.height,
    LastUserConfirmedResolutionSizeX: settings.width, LastUserConfirmedResolutionSizeY: settings.height,
    FrameRateLimit: settings.fps.toFixed(6), bUseVSync: settings.vsync ? 'True' : 'False'
  };
  const seen = new Set();
  const section = lines.slice(start + 1, end).map(line => {
    const at = line.indexOf('=');
    const key = at > 0 ? line.slice(0, at).trim() : '';
    if (!Object.hasOwn(wanted, key) || seen.has(key)) return line;
    seen.add(key);
    return `${key}=${wanted[key]}`;
  });
  // Keys the file lacks go after the last setting, before the section's blank line.
  let insertAt = section.length;
  while (insertAt > 0 && section[insertAt - 1].trim() === '') insertAt--;
  section.splice(insertAt, 0, ...Object.keys(wanted).filter(key => !seen.has(key)).map(key => `${key}=${wanted[key]}`));
  return [...lines.slice(0, start + 1), ...section, ...lines.slice(end)].join(eol);
}
// The update notes the game's title screen shows (GET /patchnotes/:language/:buildId),
// reduced to plain text with length limits for the launcher's "What's new" card.
function patchNotesText(payload) {
  const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
  const list = (value, limit) => Array.isArray(value) ? value.slice(0, limit) : [];
  return {
    date: text(payload?.date, 40),
    title: text(payload?.title, 80),
    version: text(payload?.release_version, 40),
    description: text(payload?.description, 300),
    categories: list(payload?.notes, 12).map(category => ({
      title: text(category?.title, 80),
      sections: list(category?.sections, 20).map(section => ({
        title: text(section?.title, 120),
        description: text(section?.description, 1000),
        changes: list(section?.changes, 10).map(change => ({
          comment: text(change?.comment, 120),
          list: list(change?.list, 30).map(item => text(item, 400)).filter(Boolean)
        }))
      })).filter(section => section.title || section.description)
    })).filter(category => category.sections.length > 0)
  };
}
module.exports = { EXE, EXE_HASH, RUNTIME_FILES, hashFile, locateGame, verifyGame, verifyResources,
  runtimeStatus, installRuntime, serverOrigin, isTailscaleAddress, launchArgs, patchNotesText,
  LANGUAGES, WINDOW_MODES, FRAME_RATES, readDisplaySettings, validDisplaySettings, updateDisplaySettings };
