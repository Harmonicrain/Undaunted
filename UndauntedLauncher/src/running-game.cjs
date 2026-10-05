'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

async function isGameRunning(folder, trackedChild) {
  if (trackedChild) return true;
  // Command lines are examined only inside PowerShell to distinguish -server
  // worlds from clients. Only a boolean leaves the process; never log its output.
  const script = "$ErrorActionPreference='Stop'; $gameProcesses=@(Get-CimInstance Win32_Process -Filter \"Name='Dauntless-Win64-Shipping.exe'\" | Where-Object { ((-not $env:UNDAUNTED_CHECK_GAME_PATH) -or (-not $_.ExecutablePath) -or $_.ExecutablePath -eq $env:UNDAUNTED_CHECK_GAME_PATH) -and ((-not $_.CommandLine) -or $_.CommandLine -notmatch '(?i)(?:^|\\s)-server(?:\\s|$)') }); Write-Output ($gameProcesses.Count -gt 0)";
  try {
    const { stdout } = await promisify(execFile)(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 1024,
        env: { ...process.env, UNDAUNTED_CHECK_GAME_PATH: folder ? path.join(folder, 'Dauntless-Win64-Shipping.exe') : '' } });
    if (!/^(True|False)\s*$/i.test(stdout)) throw new Error();
    return stdout.trim().toLowerCase() === 'true';
  } catch { throw new Error('Could not confirm Dauntless is closed. Close the game and try again.'); }
}
module.exports = { isGameRunning };
