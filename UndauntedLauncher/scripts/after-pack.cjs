'use strict';
// electron-builder afterPack hook: gives the packaged launcher the game's icon
// (src/art/icon.ico, written by scripts/extract-art.py) before the installer is
// built.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const icon = path.join(__dirname, '..', 'src', 'art', 'icon.ico');
  if (!fs.existsSync(icon)) throw new Error('src/art/icon.ico is missing: run scripts/extract-art.py before packaging.');
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const result = spawnSync('python', [path.join(__dirname, 'set-exe-icon.py'), exe, icon], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Could not set the launcher icon.');
};
