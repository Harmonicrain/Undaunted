'use strict';
(() => {
  const call = async (action, value = null) => {
    try { return await window.__TAURI__.core.invoke('launcher', { action, value }); }
    catch { return { ok: false, message: 'The launcher could not complete this request.' }; }
  };
  const api = {};
  for (const action of ['state', 'server', 'login', 'register', 'claim', 'importAccount', 'logout',
    'selectGame', 'repair', 'play', 'patchNotes', 'discord', 'updateState', 'updateCheck',
    'updateDownload', 'updateInstall', 'settings', 'saveSettings']) api[action] = value => call(action, value);
  api.onUpdate = callback => {
    let closed = false, unlisten;
    window.__TAURI__.event.listen('launcher:updateState', event => { if (!closed) callback(event.payload); })
      .then(stop => { unlisten = stop; if (closed) stop(); });
    return () => { closed = true; unlisten?.(); };
  };
  window.launcher = Object.freeze(api);
})();
