'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const call = (name, value) => ipcRenderer.invoke('launcher:' + name, value);
contextBridge.exposeInMainWorld('launcher', Object.freeze({
  state: () => call('state'),
  server: value => call('server', value),
  login: value => call('login', value),
  register: value => call('register', value),
  claim: value => call('claim', value),
  importAccount: () => call('importAccount'),
  logout: () => call('logout'),
  selectGame: () => call('selectGame'),
  repair: () => call('repair'),
  play: () => call('play'),
  patchNotes: () => call('patchNotes'),
  settings: () => call('settings'),
  saveSettings: value => call('saveSettings', value)
}));
