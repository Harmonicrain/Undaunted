'use strict';
// Injected only into copied installer-test source, never the production launcher.
(async () => {
  let lastControl = '', busy = false;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  while (!window.launcher) await pause(100);
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const state = await window.launcher.state(), update = await window.launcher.updateState();
      const s = state.result || {}, u = update.result || {};
      const version = String(s.version || '').split(' · ')[0];
      const control = await window.__TAURI__.core.invoke('upgrade_probe', { report: {
        version, displayVersion: s.version, userId: s.user?.userId, connected: s.connected,
        gameDirectory: s.gameDirectory, phase: u.phase, message: u.message,
        updateVersion: u.version, button: document.getElementById('update-action')?.textContent,
        visibleMessage: document.getElementById('update-message')?.textContent,
      } });
      if (control.version === version && control.id !== lastControl) {
        lastControl = control.id;
        if (control.action === 'check') document.getElementById('update-check').click();
        if (control.action === 'download' || control.action === 'install') document.getElementById('update-action').click();
        if (control.action === 'capture') await window.__TAURI__.core.invoke('test_step', {name: control.name, passed: true});
        if (control.action === 'close') await window.__TAURI__.core.invoke('upgrade_probe', {report:{close:true}});
      }
    } catch {}
    finally { busy = false; }
  }, 650);
})();
