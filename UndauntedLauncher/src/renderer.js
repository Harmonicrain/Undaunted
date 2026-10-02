'use strict';
const $ = id => document.getElementById(id);
// The five season login screens in src/art take turns, starting from a random
// one: the next picture fades in on top while the current one stays solid
// underneath, then the old layer is hidden.
(function rotateArt() {
  const ART_COUNT = 5, HOLD_MS = 12000, FADE_MS = 2600;
  const layers = document.querySelectorAll('.backdrop .art');
  let current = Math.floor(Math.random() * ART_COUNT), front = 0;
  layers[front].dataset.art = String(current + 1);
  layers[front].classList.add('shown', 'top');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  setInterval(() => {
    current = (current + 1) % ART_COUNT;
    const back = 1 - front, old = layers[front];
    layers[back].dataset.art = String(current + 1);
    layers[back].classList.add('shown', 'top');
    old.classList.remove('top');
    setTimeout(() => old.classList.remove('shown'), FADE_MS);
    front = back;
  }, HOLD_MS);
})();
let mode = 'login';
let current;
let busy = false;
let imported = false;
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
function setMode(next) {
  mode = next; imported = false;
  $('imported').textContent = '';
  $('password').value = ''; $('confirm-password').value = ''; $('account-key').value = '';
  $('tab-login').classList.toggle('selected', next === 'login');
  $('tab-register').classList.toggle('selected', next === 'register');
  // The tabs name the sign-in and registration forms; only linking needs a title.
  $('auth-title').hidden = next !== 'claim';
  $('auth-description').textContent = next === 'claim' ? 'Choose the account file or paste the key the server owner gave you, then set a password. Your Slayer and progress stay the same.' : next === 'register' ? 'Pick a Slayer name and a password for this server.' : 'Use the account you made for this server.';
  $('username-label').hidden = next === 'claim'; $('username').required = next !== 'claim';
  $('key-label').hidden = next !== 'claim'; $('import-controls').hidden = next !== 'claim';
  $('confirm-label').hidden = next === 'login'; $('confirm-password').required = next !== 'login';
  $('password-help').hidden = next === 'login'; $('password').minLength = next === 'login' ? 1 : 12;
  $('password').autocomplete = next === 'login' ? 'current-password' : 'new-password';
  $('submit').textContent = next === 'claim' ? 'Link and sign in' : next === 'register' ? 'Create account' : 'Sign in';
  $('claim-mode').hidden = next === 'claim';
  $('invite-label').hidden = next !== 'register' || current?.registrationMode !== 'INVITECODE';
  $('invite-code').required = !$('invite-label').hidden;
  message('');
}
// "What's new": the game's update notes, built as plain text nodes.
let newsLoaded = false;
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
// Each new node gets its place in the stagger (--i drives the animation delay).
function stagger(node, index) { node.style.setProperty('--i', String(index)); return node; }
function showCategory(category) {
  const body = $('news-body');
  body.replaceChildren();
  body.scrollTop = 0;
  let index = 0;
  for (const section of category.sections) {
    const block = element('div', 'news-section');
    if (section.title) block.append(stagger(element('h3', '', section.title), index++));
    if (section.description) block.append(stagger(element('p', '', section.description), index++));
    for (const change of section.changes) {
      if (change.comment) block.append(stagger(element('p', 'news-comment', change.comment), index++));
      if (change.list.length) {
        const items = stagger(element('ul'), index++);
        for (const item of change.list) items.append(element('li', '', item));
        block.append(items);
      }
    }
    body.append(block);
  }
}
let newsNotes;
// Opening rebuilds the tabs and the first tab's notes, so they animate in each time.
function openNews() {
  if (!newsNotes) return;
  const tabs = $('news-tabs');
  tabs.replaceChildren();
  newsNotes.categories.forEach((category, index) => {
    const tab = stagger(element('button', 'news-tab', category.title), index);
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.addEventListener('click', () => {
      for (const other of tabs.children) other.setAttribute('aria-selected', String(other === tab));
      showCategory(category);
    });
    tabs.append(tab);
  });
  const date = new Date(newsNotes.date);
  $('news-date').textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  tabs.firstElementChild?.click();
  $('news').showModal();
  $('news-close').focus();
}
async function loadNews() {
  const response = await window.launcher.patchNotes();
  newsLoaded = response.ok;
  newsNotes = response.ok && response.result.categories.length ? response.result : undefined;
  $('news-open').hidden = !newsNotes;
}
$('news-open').addEventListener('click', openNews);

// Settings: the language passed at launch, and the game's own display settings.
let settingsData;
// The game's options step through values with chevrons instead of a dropdown.
function cycler(container, entries, selected) {
  let index = Math.max(0, entries.findIndex(([value]) => String(value) === String(selected)));
  const label = element('span', 'cycler-value');
  const previous = element('button', 'chevron previous'), next = element('button', 'chevron next');
  previous.type = next.type = 'button';
  previous.setAttribute('aria-label', 'Previous'); next.setAttribute('aria-label', 'Next');
  const show = () => {
    label.textContent = entries[index][1];
    previous.disabled = container.dataset.locked === 'true' || index === 0;
    next.disabled = container.dataset.locked === 'true' || index === entries.length - 1;
  };
  previous.addEventListener('click', () => { if (index > 0) { index--; show(); } });
  next.addEventListener('click', () => { if (index < entries.length - 1) { index++; show(); } });
  container.replaceChildren(previous, label, next);
  container.value = () => entries[index][0];
  container.refresh = show;
  show();
}
function lock(container, locked) { container.dataset.locked = String(locked); container.refresh?.(); }
function settingsMessage(text, error = false) { $('settings-message').textContent = text; $('settings-message').classList.toggle('error', error); }
async function openSettings() {
  const response = await window.launcher.settings();
  if (!response.ok) { message(response.message, true); return; }
  settingsData = response.result;
  const display = settingsData.display;
  cycler($('setting-language'), [['', 'Windows default'], ...Object.entries(settingsData.languages)], settingsData.language);
  $('display-settings').hidden = !display;
  if (display) {
    cycler($('setting-mode'), Object.entries(settingsData.windowModes), display.mode);
    cycler($('setting-resolution'), settingsData.resolutions.map(size => [`${size.width}x${size.height}`, `${size.width} × ${size.height}`]),
      `${display.width}x${display.height}`);
    cycler($('setting-fps'), settingsData.frameRates.map(fps => [fps, fps ? `${fps} FPS` : 'Unlimited']), display.fps);
    $('setting-vsync').setAttribute('aria-checked', String(display.vsync));
    for (const id of ['setting-mode', 'setting-resolution', 'setting-fps']) lock($(id), settingsData.running);
    $('setting-vsync').disabled = settingsData.running;
  }
  $('display-note').textContent = !display ? 'Start Dauntless once to change its display settings here.'
    : settingsData.running ? 'Close Dauntless to change its display settings.'
    : "Display settings are saved to the game's own settings file.";
  settingsMessage('');
  $('game-settings').showModal();
  $('settings-save').focus();
}
$('settings-open').addEventListener('click', openSettings);
$('settings-cancel').addEventListener('click', () => $('game-settings').close());
$('game-settings').addEventListener('click', event => { if (event.target === $('game-settings')) $('game-settings').close(); });
$('setting-vsync').addEventListener('click', () => {
  $('setting-vsync').setAttribute('aria-checked', String($('setting-vsync').getAttribute('aria-checked') !== 'true'));
});
$('settings-save').addEventListener('click', async () => {
  const value = { language: $('setting-language').value() };
  if (settingsData?.display && !settingsData.running) {
    const [width, height] = $('setting-resolution').value().split('x').map(Number);
    value.display = { mode: Number($('setting-mode').value()), width, height, fps: Number($('setting-fps').value()),
      vsync: $('setting-vsync').getAttribute('aria-checked') === 'true' };
  }
  $('settings-save').disabled = true;
  const response = await window.launcher.saveSettings(value);
  $('settings-save').disabled = false;
  if (!response.ok) { settingsMessage(response.message, true); return; }
  $('game-settings').close();
  message('Settings saved.');
});
$('news-close').addEventListener('click', () => $('news').close());
// A click on the backdrop lands on the dialog element itself (its content covers
// the box), so that closes it; Esc closes it natively.
$('news').addEventListener('click', event => { if (event.target === $('news')) $('news').close(); });
function render(state) {
  current = state;
  $('auth').hidden = !!state.user; $('play-panel').hidden = !state.user;
  $('player-name').textContent = state.user?.username || '';
  const tailscale = /^https?:\/\/100\./.test(state.server);
  $('connection').textContent = state.connected
    ? 'Server online' + (tailscale ? ' · Tailscale' : state.server.startsWith('http:') ? ' · Private network' : '')
    : 'Server offline';
  $('connection').classList.toggle('online', state.connected);
  $('connection').classList.toggle('offline', !state.connected);
  $('server-address').value = state.server;
  $('version').textContent = 'Launcher ' + state.version;
  $('game-path').textContent = state.gameDirectory || 'Choose your existing 1.12.0 installation.';
  $('play').textContent = state.running ? 'Game running' : 'Play';
  $('play').disabled = busy || state.running || !state.connected || !state.gameDirectory;
  $('repair').disabled = busy || state.running || !state.gameDirectory;
  $('select-game').disabled = busy || state.running;
  $('tab-register').disabled = busy || state.registrationMode === 'NONE';
  $('registration-note').hidden = state.registrationMode !== 'NONE';
  $('invite-label').hidden = mode !== 'register' || state.registrationMode !== 'INVITECODE';
  $('invite-code').required = !$('invite-label').hidden;
  $('submit').disabled = busy || !state.connected || (mode === 'register' && state.registrationMode === 'NONE');
}
async function run(action, success = '') {
  if (busy) return;
  busy = true;
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  message('Please wait…');
  try {
    const response = await action();
    if (!response.ok) throw new Error(response.message);
    const result = response.result;
    if (result?.server) render(result);
    message(success);
    return result;
  } catch (error) { message(error.message, true); }
  finally {
    busy = false;
    for (const button of document.querySelectorAll('button')) button.disabled = false;
    if (current) render(current);
  }
}
$('tab-login').addEventListener('click', () => setMode('login'));
$('tab-register').addEventListener('click', () => setMode('register'));
$('claim-mode').addEventListener('click', () => setMode('claim'));
$('account-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (mode !== 'login' && $('password').value !== $('confirm-password').value) { message('Your passwords do not match.', true); return; }
  if (mode === 'claim' && !imported && !$('account-key').value) { message('Choose your account file or paste your existing account key.', true); return; }
  const value = { username: $('username').value.trim(), password: $('password').value,
    accountKey: $('account-key').value.trim(), inviteCode: $('invite-code').value.trim() };
  const result = await run(() => window.launcher[mode](value));
  if (result?.user) { $('password').value = ''; $('confirm-password').value = ''; $('account-key').value = ''; imported = false; }
});
$('import-account').addEventListener('click', async () => {
  const result = await run(() => window.launcher.importAccount());
  if (result?.username) { imported = true; $('imported').textContent = 'Account selected: ' + result.username; $('account-key').value = ''; }
});
$('server-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (await run(() => window.launcher.server($('server-address').value))) loadNews();
});
$('logout').addEventListener('click', async () => { const result = await run(() => window.launcher.logout()); if (result) setMode('login'); });
$('select-game').addEventListener('click', () => run(() => window.launcher.selectGame(), 'Game verified and runtime installed.'));
$('repair').addEventListener('click', () => run(() => window.launcher.repair(), 'Runtime repaired.'));
$('play').addEventListener('click', () => run(() => window.launcher.play(), 'Starting Dauntless…'));
run(() => window.launcher.state()).then(() => { if (current?.serverError) message(current.serverError, true); loadNews(); });
setInterval(async () => {
  // Notes that failed to load (server offline at start) are fetched once it is back.
  if (!newsLoaded && current?.connected) loadNews();
  if (busy || !current?.user) return;
  // Poll only while idle; no form values or credentials are read here.
  const response = await window.launcher.state();
  if (response.ok) render(response.result);
}, 15000);
