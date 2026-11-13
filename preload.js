'use strict';
/**
 * 365 Pinterest — preload (sandboxed, context-isolated).
 *
 * The renderer gets a narrow, promise-based bridge. It never sees the API
 * key, never touches the network, and never gets Node APIs. All API traffic
 * goes through the main process.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  isDesktopApp: true,

  getInfo: () => ipcRenderer.invoke('app:getInfo'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  getUpdateState: () => ipcRenderer.invoke('app:getUpdateState'),
  checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
  downloadUpdate: () => ipcRenderer.invoke('app:downloadUpdate'),
  installUpdate: () => ipcRenderer.invoke('app:installUpdate'),
  onUpdateEvent: (cb) => ipcRenderer.on('update-event', (_event, payload) => cb(payload)),

  onNav: (cb) => ipcRenderer.on('nav', (_event, screen) => cb(screen)),
  onRefresh: (cb) => ipcRenderer.on('refresh', () => cb()),
  onToggleTheme: (cb) => ipcRenderer.on('toggle-theme', () => cb()),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  hasKey: () => ipcRenderer.invoke('auth:hasKey'),
  validateKey: (key) => ipcRenderer.invoke('auth:validate', key),
  clearKey: () => ipcRenderer.invoke('auth:clear'),
  signInEmail: (email, password) => ipcRenderer.invoke('auth:signInEmail', email, password),
  signInPinterest: () => ipcRenderer.invoke('auth:signInPinterest'),
  signOut: () => ipcRenderer.invoke('auth:signOut'),
  getUser: () => ipcRenderer.invoke('auth:getUser'),

  getAccount: (accountId) => ipcRenderer.invoke('api:account', accountId || null),
  listBoards: (accountId) => ipcRenderer.invoke('api:boards', accountId || null),
  createBoard: (payload) => ipcRenderer.invoke('api:boardsCreate', payload),
  listPins: (filters) => ipcRenderer.invoke('api:pins', filters || {}),
  createPin: (payload) => ipcRenderer.invoke('api:pinCreate', payload),
  schedulePin: (pinId, scheduledFor) => ipcRenderer.invoke('api:pinSchedule', pinId, scheduledFor),
  cancelPin: (pinId) => ipcRenderer.invoke('api:pinCancel', pinId),
  getQueue: (accountId) => ipcRenderer.invoke('api:queue', accountId || null),
  getAnalytics: (accountId) => ipcRenderer.invoke('api:analytics', accountId || null),

  pickImage: () => ipcRenderer.invoke('dialog:pickImage'),
});
