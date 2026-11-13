'use strict';
/**
 * 365 Pinterest — preload (sandboxed, context-isolated).
 *
 * The site needs nothing from the desktop shell except the app version
 * and update status. Nothing else is exposed; no Node APIs leak into
 * the page.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  isDesktopApp: true,
  getVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateEvent: (cb) => ipcRenderer.on('update-event', (_event, payload) => cb(payload)),
});
