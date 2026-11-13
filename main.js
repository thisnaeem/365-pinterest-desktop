'use strict';
/**
 * 365 Pinterest — desktop app v2.0.0 (native).
 *
 * This is NOT a website wrapper. The app has its own local interface
 * (renderer/) and talks to the 365 Pinterest REST API
 * (https://365pinterest.com/api/v1/...) with the user's API key:
 *
 *   Authorization: Bearer pk_live_...
 *
 * API surface (verified against ~/workspace/pinterest-365 source):
 *   GET  /api/v1/account?account_id=        { connected, needsReconnect, username, pinterestUserId, scopes, boardCount }
 *   GET  /api/v1/boards?account_id=         { boards: [{ id, pinterestBoardId, name, description, privacy, pinCount }], cached }
 *   POST /api/v1/boards                     { name<=180, description?<=500, privacy? PUBLIC|PROTECTED|SECRET } -> 201 { board }
 *   GET  /api/v1/pins?status=&boardId=&limit=&account_id=
 *                                            { pins, total, limit }  (pin: id, accountId, boardId, title,
 *                                            description, imageUrl, destinationUrl, status, pinterestPinId,
 *                                            pinterestUrl, scheduledFor, publishedAt, error, createdAt, updatedAt)
 *   POST /api/v1/pins  JSON                 { title<=100, description?<=800, destinationUrl?,
 *                                            boardId|pinterestBoardId, imageUrl (https + .jpg/.jpeg/.png/.webp),
 *                                            scheduledFor? (ISO, future, <=1yr) } -> 201 { pin }
 *   POST /api/v1/pins  multipart            same fields + `file` (JPEG/PNG/WebP, <=10 MB) — the server
 *                                            uploads the file to Cloudinary. No Cloudinary keys in this app.
 *   POST /api/v1/pins/{id}/schedule         { scheduledFor } -> { pin } (409 if PUBLISHED/POSTING)
 *   POST /api/v1/pins/{id}/cancel           -> { pin } DRAFT (409 if not SCHEDULED)
 *   GET  /api/v1/queue?limit=&account_id=   { queue: [...pin + boardName], total }
 *   GET  /api/v1/analytics?account_id=      { connected, startDate, endDate,
 *                                            totals: { impressions, saves, clicks, outboundClicks } } (last 30 days)
 *
 * Limits the app respects (server-enforced): 60 req/min per key; create_pin
 * has an extra 30/min cap; create body cap 11 MB. Writes return 402 when the
 * account is read-only. Creation NEVER publishes directly — a future
 * scheduledFor makes a pin SCHEDULED (the server's 5-minute cron publishes
 * it); otherwise it is a DRAFT. There is no publish-now or pin-delete
 * endpoint in the REST API, and no API-key endpoint lists connected
 * accounts (that route needs a browser session) — the app discovers extra
 * accounts from the accountId field on listed pins and resolves each one
 * via /api/v1/account?account_id=.
 *
 * AUTH: the API key lives in the MAIN process only. It is stored with
 * Electron safeStorage (DPAPI on Windows) in the app userData dir; the
 * renderer never sees the key. It is never logged.
 *
 * The pinterest365:// deep link from v1 is GONE — API-key auth makes it
 * unnecessary.
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, safeStorage, session, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

const API_BASE = 'https://365pinterest.com';
const SITE_URL = 'https://365pinterest.com';
const DEVELOPERS_URL = 'https://365pinterest.com/developers';
const BILLING_URL = 'https://365pinterest.com/app/billing';

let mainWindow = null;

function userDataFile(name) {
  return path.join(app.getPath('userData'), name);
}

// ---------------------------------------------------------------------------
// API key storage (main process only)
// ---------------------------------------------------------------------------
function keyStorageMethod() {
  try {
    if (safeStorage.isEncryptionAvailable()) return 'safeStorage';
  } catch (_e) { /* fall through */ }
  return 'safeStorage-plaintext';
}

function saveApiKey(key) {
  const method = keyStorageMethod();
  if (method === 'safeStorage-plaintext') {
    try { safeStorage.setUsePlainTextEncryption(true); } catch (_e) { /* ignore */ }
  }
  const encrypted = safeStorage.encryptString(key);
  if (!encrypted || encrypted.length === 0) {
    throw new Error('Could not encrypt the API key on this computer.');
  }
  fs.writeFileSync(
    userDataFile('credentials.json'),
    JSON.stringify({ method, data: encrypted.toString('base64') }),
    { mode: 0o600 }
  );
  return method;
}

function loadApiKey() {
  try {
    const raw = fs.readFileSync(userDataFile('credentials.json'), 'utf8');
    const stored = JSON.parse(raw);
    if (!stored.data) return null;
    if (stored.method === 'safeStorage-plaintext') {
      try { safeStorage.setUsePlainTextEncryption(true); } catch (_e) { /* ignore */ }
    }
    const decrypted = safeStorage.decryptString(Buffer.from(stored.data, 'base64'));
    return decrypted || null;
  } catch (_e) {
    return null;
  }
}

function clearApiKey() {
  try { fs.unlinkSync(userDataFile('credentials.json')); } catch (_e) { /* already gone */ }
}

function getKeyMethod() {
  try {
    const raw = fs.readFileSync(userDataFile('credentials.json'), 'utf8');
    return JSON.parse(raw).method || 'unknown';
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Settings (theme, selected Pinterest account id)
// ---------------------------------------------------------------------------
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(userDataFile('settings.json'), 'utf8'));
  } catch (_e) {
    return { theme: 'light', accountId: null };
  }
}

function saveSettings(settings) {
  fs.writeFileSync(userDataFile('settings.json'), JSON.stringify(settings), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------
function apiErrorFromStatus(status, body) {
  const message = (body && body.error) || `Request failed (${status})`;
  if (status === 401) return { status, error: 'Invalid API key. Check the key in Settings and try again.' };
  if (status === 402) return { status, error: 'This account is read-only — posting needs an active Pro trial or subscription.', upgradeUrl: BILLING_URL };
  if (status === 404) return { status, error: message };
  if (status === 409) return { status, error: message };
  if (status === 429) return { status, error: 'Rate limit reached (60 requests/minute). Wait a moment and try again.' };
  if (status === 413) return { status, error: 'That file is too large (10 MB maximum).' };
  if (status === 503) return { status, error: 'The image service is unavailable right now. Try again later.' };
  if (status >= 500) return { status, error: 'The 365 Pinterest server had a problem. Try again in a moment.' };
  return { status, error: message };
}

// HTTP layer: Electron's net.fetch (Chromium network stack) — unlike
// Node's fetch it honours the system proxy and certificate store, so the
// app works behind corporate proxies too. The self-test reassigns this to
// a stub (see runSelfTest); production always uses net.fetch.
let apiFetch = null;
function httpFetch(url, opts) {
  const fn = apiFetch || ((u, o) => net.fetch(u, o));
  return fn(url, opts);
}

async function apiRequest(apiKey, apiPath, opts = {}) {
  const url = API_BASE + apiPath;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await httpFetch(url, {
      method: opts.method || 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(opts.headers || {}),
      },
      body: opts.body,
      signal: controller.signal,
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_e) { body = null; }
    if (!res.ok) {
      return { ok: false, ...apiErrorFromStatus(res.status, body) };
    }
    return { ok: true, status: res.status, data: body };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { ok: false, status: 0, error: 'The request timed out. Check your internet connection.' };
    }
    return { ok: false, status: 0, error: 'Could not reach 365pinterest.com. Check your internet connection.' };
  } finally {
    clearTimeout(timer);
  }
}

function withAccountId(apiPath, accountId) {
  if (!accountId) return apiPath;
  const sep = apiPath.includes('?') ? '&' : '?';
  return `${apiPath}${sep}account_id=${encodeURIComponent(accountId)}`;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    title: '365 Pinterest',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
    show: false,
    backgroundColor: '#FAFAF8',
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // The app is a native client, not a browser: nothing navigates away.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
}

function sendUpdateEvent(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-event', payload);
  }
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------
function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New pin', accelerator: 'CmdOrCtrl+N', click: () => mainWindow && mainWindow.webContents.send('nav', 'create') },
        { label: 'Refresh', accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.webContents.send('refresh') },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle dark theme', accelerator: 'CmdOrCtrl+D', click: () => mainWindow && mainWindow.webContents.send('toggle-theme') },
        { label: 'Dashboard', accelerator: 'CmdOrCtrl+1', click: () => mainWindow && mainWindow.webContents.send('nav', 'dashboard') },
        { label: 'Boards', accelerator: 'CmdOrCtrl+2', click: () => mainWindow && mainWindow.webContents.send('nav', 'boards') },
        { label: 'Pins', accelerator: 'CmdOrCtrl+3', click: () => mainWindow && mainWindow.webContents.send('nav', 'pins') },
        { label: 'Queue', accelerator: 'CmdOrCtrl+4', click: () => mainWindow && mainWindow.webContents.send('nav', 'queue') },
        { label: 'Analytics', accelerator: 'CmdOrCtrl+5', click: () => mainWindow && mainWindow.webContents.send('nav', 'analytics') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About 365 Pinterest',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: 'About 365 Pinterest',
              message: '365 Pinterest',
              detail: `Version ${app.getVersion()}\n\nPinterest automation: schedule pins, manage boards, write AI blogs and auto-pin them.\n\nA year of Pinterest, scheduled in a day.\n\n© ${new Date().getFullYear()} Anjum Labs`,
              buttons: ['OK'],
            });
          },
        },
        { label: 'Open 365pinterest.com', click: () => shell.openExternal(SITE_URL) },
        { label: 'API documentation', click: () => shell.openExternal(DEVELOPERS_URL) },
        { type: 'separator' },
        { label: 'Check for updates', click: () => checkForUpdates(true) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Auto-updater (same repo as v1; never publishes from this app)
// ---------------------------------------------------------------------------
function checkForUpdates(manual) {
  try {
    autoUpdater.autoDownload = false;
    autoUpdater.checkForUpdates().catch(() => {
      if (manual) sendUpdateEvent({ type: 'update-error', message: 'Could not check for updates right now.' });
    });
  } catch (_e) { /* updater unavailable in dev */ }
}

autoUpdater.on('update-available', (info) => sendUpdateEvent({ type: 'update-available', version: info.version }));
autoUpdater.on('update-not-available', () => sendUpdateEvent({ type: 'update-not-available' }));
autoUpdater.on('update-downloaded', (info) => sendUpdateEvent({ type: 'update-downloaded', version: info.version }));
autoUpdater.on('error', (err) => sendUpdateEvent({ type: 'update-error', message: String(err && err.message ? err.message : err) }));

// ---------------------------------------------------------------------------
// IPC — the renderer never touches the API key or the network directly
// ---------------------------------------------------------------------------
function requireKey() {
  const key = loadApiKey();
  if (!key) return { ok: false, status: 401, error: 'No API key saved. Add one in Setup first.' };
  return { ok: true, key };
}

ipcMain.handle('app:getInfo', () => ({
  version: app.getVersion(),
  platform: process.platform,
  keyMethod: getKeyMethod(),
}));

ipcMain.handle('app:openExternal', (_event, url) => {
  const allowed = [SITE_URL, DEVELOPERS_URL, BILLING_URL, 'https://www.pinterest.com'];
  try {
    const u = new URL(url);
    if (allowed.some((base) => url === base || url.startsWith(base + '/'))) {
      shell.openExternal(url);
      return true;
    }
  } catch (_e) { /* invalid url */ }
  return false;
});

ipcMain.handle('app:checkForUpdates', () => { checkForUpdates(true); return true; });
ipcMain.handle('app:downloadUpdate', () => { try { autoUpdater.downloadUpdate(); return true; } catch (_e) { return false; } });
ipcMain.handle('app:installUpdate', () => { try { autoUpdater.quitAndInstall(); return true; } catch (_e) { return false; } });

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_event, patch) => {
  const next = { ...loadSettings(), ...patch };
  saveSettings(next);
  return next;
});

ipcMain.handle('auth:hasKey', () => !!loadApiKey());

ipcMain.handle('auth:validate', async (_event, key) => {
  const clean = typeof key === 'string' ? key.trim() : '';
  if (!clean.startsWith('pk_live_') || clean.length < 20) {
    return { ok: false, status: 400, error: 'That does not look like an API key. Keys start with pk_live_ — create one on 365pinterest.com.' };
  }
  const res = await apiRequest(clean, '/api/v1/account');
  if (!res.ok) return res;
  try {
    saveApiKey(clean);
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
  return { ok: true, data: res.data, keyMethod: getKeyMethod() };
});

ipcMain.handle('auth:clear', () => { clearApiKey(); return true; });

ipcMain.handle('api:account', async (_event, accountId) => {
  const k = requireKey();
  if (!k.ok) return k;
  return apiRequest(k.key, withAccountId('/api/v1/account', accountId || null));
});

ipcMain.handle('api:boards', async (_event, accountId) => {
  const k = requireKey();
  if (!k.ok) return k;
  return apiRequest(k.key, withAccountId('/api/v1/boards', accountId || null));
});

ipcMain.handle('api:boardsCreate', async (_event, payload) => {
  const k = requireKey();
  if (!k.ok) return k;
  const body = { name: payload.name };
  if (payload.description) body.description = payload.description;
  if (payload.privacy) body.privacy = payload.privacy;
  if (payload.accountId) body.account_id = payload.accountId;
  return apiRequest(k.key, '/api/v1/boards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
});

ipcMain.handle('api:pins', async (_event, filters) => {
  const k = requireKey();
  if (!k.ok) return k;
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.boardId) params.set('boardId', filters.boardId);
  params.set('limit', String(Math.min(Math.max(filters.limit || 100, 1), 100)));
  if (filters.accountId) params.set('account_id', filters.accountId);
  return apiRequest(k.key, `/api/v1/pins?${params.toString()}`);
});

ipcMain.handle('api:pinCreate', async (_event, payload) => {
  const k = requireKey();
  if (!k.ok) return k;
  const fields = payload.fields || {};
  let body;
  let headers = {};
  if (payload.imagePath) {
    // Multipart upload — the server stores the file via its own Cloudinary.
    let buf;
    try {
      buf = await fs.promises.readFile(payload.imagePath);
    } catch (_e) {
      return { ok: false, status: 0, error: 'Could not read that image file.' };
    }
    if (buf.length > 10 * 1024 * 1024) {
      return { ok: false, status: 413, error: 'That file is too large (10 MB maximum).' };
    }
    const ext = path.extname(payload.imagePath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    const form = new FormData();
    form.append('title', fields.title);
    if (fields.description) form.append('description', fields.description);
    if (fields.destinationUrl) form.append('destinationUrl', fields.destinationUrl);
    if (fields.boardId) form.append('boardId', fields.boardId);
    if (fields.pinterestBoardId) form.append('pinterestBoardId', fields.pinterestBoardId);
    if (fields.scheduledFor) form.append('scheduledFor', fields.scheduledFor);
    if (fields.accountId) form.append('account_id', fields.accountId);
    form.append('file', new Blob([buf], { type: mime }), path.basename(payload.imagePath));
    body = form;
  } else {
    headers = { 'Content-Type': 'application/json' };
    body = JSON.stringify({
      title: fields.title,
      description: fields.description || undefined,
      destinationUrl: fields.destinationUrl || undefined,
      boardId: fields.boardId || undefined,
      pinterestBoardId: fields.pinterestBoardId || undefined,
      imageUrl: fields.imageUrl || undefined,
      scheduledFor: fields.scheduledFor || undefined,
      account_id: fields.accountId || undefined,
    });
  }
  return apiRequest(k.key, '/api/v1/pins', { method: 'POST', headers, body });
});

ipcMain.handle('api:pinSchedule', async (_event, pinId, scheduledFor) => {
  const k = requireKey();
  if (!k.ok) return k;
  return apiRequest(k.key, `/api/v1/pins/${encodeURIComponent(pinId)}/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scheduledFor }),
  });
});

ipcMain.handle('api:pinCancel', async (_event, pinId) => {
  const k = requireKey();
  if (!k.ok) return k;
  return apiRequest(k.key, `/api/v1/pins/${encodeURIComponent(pinId)}/cancel`, { method: 'POST' });
});

ipcMain.handle('api:queue', async (_event, accountId) => {
  const k = requireKey();
  if (!k.ok) return k;
  return apiRequest(k.key, withAccountId('/api/v1/queue?limit=100', accountId || null));
});

ipcMain.handle('api:analytics', async (_event, accountId) => {
  const k = requireKey();
  if (!k.ok) return k;
  return apiRequest(k.key, withAccountId('/api/v1/analytics', accountId || null));
});

ipcMain.handle('dialog:pickImage', async () => {
  if (!mainWindow) return null;
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a pin image',
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths || res.filePaths.length === 0) return null;
  const filePath = res.filePaths[0];
  try {
    const buf = await fs.promises.readFile(filePath);
    if (buf.length > 10 * 1024 * 1024) {
      return { path: filePath, name: path.basename(filePath), size: buf.length, tooLarge: true, dataUrl: null };
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return {
      path: filePath,
      name: path.basename(filePath),
      size: buf.length,
      mime,
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
    };
  } catch (_e) {
    return null;
  }
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  // Harden the session: no remote content is ever loaded, but keep the
  // permission surface minimal anyway.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  buildMenu();
  createWindow();
  // Silent update check shortly after launch; failures are silent too.
  setTimeout(() => checkForUpdates(false), 8000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// Self-test (PINTEREST365_SELFTEST=1 only — never runs in production).
// Verifies the native UI end to end: live 401 against the real API with a
// fake key, then all screens rendered with stubbed API responses (no real
// API key exists on this machine). Screenshots + summary land in
// test-output/v2/. Run via: npm run selftest
// ---------------------------------------------------------------------------
async function runSelfTest() {
  const outDir = path.join(__dirname, 'test-output', 'v2');
  fs.mkdirSync(outDir, { recursive: true });
  const summary = { startedAt: new Date().toISOString(), checks: {}, screenshots: {} };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const win = mainWindow;
  if (!win) { summary.error = 'no window'; fs.writeFileSync(path.join(outDir, 'selftest.json'), JSON.stringify(summary, null, 2)); app.quit(); return; }
  await sleep(2500);
  async function shot(name) {
    try {
      const img = await win.webContents.capturePage();
      const file = path.join(outDir, `${name}.png`);
      fs.writeFileSync(file, img.toPNG());
      summary.screenshots[name] = file;
      return true;
    } catch (e) { summary.checks[`shot:${name}`] = `FAILED: ${e.message}`; return false; }
  }
  function js(code) { return win.webContents.executeJavaScript(code); }

  // 1. Setup screen is showing (no key stored) and the page is local.
  const url = win.webContents.getURL();
  summary.checks.localUrl = url.startsWith('file://') ? `PASS (${url})` : `FAIL (${url})`;
  summary.checks.setupVisible = await js(`!document.getElementById('screen-setup').classList.contains('hidden') && document.getElementById('screen-setup').classList.contains('active') ? 'PASS' : 'FAIL'`);
  summary.checks.allScreensPresent = await js(`['setup','dashboard','boards','pins','create','queue','analytics','settings'].every((s) => !!document.getElementById('screen-' + s)) ? 'PASS' : 'FAIL'`);
  await shot('01-setup');

  // 2. Live API check with a fake key — the real server must answer 401.
  const fakeKey = 'pk_live_' + '0'.repeat(32);
  await js(`document.getElementById('api-key-input').value = '${fakeKey}'; document.getElementById('validate-key-btn').click();`);
  let errText = '';
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    errText = await js(`document.getElementById('setup-error').textContent`);
    if (errText) break;
  }
  summary.checks.live401 = errText.toLowerCase().includes('invalid api key')
    ? `PASS (real server answered 401: "${errText}")`
    : `FAIL (unexpected error text: "${errText}")`;
  await shot('02-setup-invalid-key');

  // 3. Stub the API (test-only) and re-run the app as a signed-in user.
  const stubPins = [
    { id: 'pin-1', accountId: 'acc-1', boardId: 'board-1', title: 'Golden hour over the hills', description: 'Warm light, long shadows.', imageUrl: 'https://365pinterest.com/pins/golden-hour-ai-art.jpg', destinationUrl: 'https://example.com/golden-hour', status: 'SCHEDULED', pinterestPinId: null, pinterestUrl: null, scheduledFor: new Date(Date.now() + 2 * 3600 * 1000).toISOString(), publishedAt: null, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    { id: 'pin-2', accountId: 'acc-1', boardId: 'board-1', title: 'Minimal desk setup', description: null, imageUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg', destinationUrl: null, status: 'DRAFT', pinterestPinId: null, pinterestUrl: null, scheduledFor: null, publishedAt: null, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    { id: 'pin-3', accountId: 'acc-1', boardId: 'board-2', title: 'Cozy reading nook', description: 'Soft light and plants.', imageUrl: 'https://365pinterest.com/logo.png', destinationUrl: 'https://example.com/nook', status: 'PUBLISHED', pinterestPinId: '841680617907538692', pinterestUrl: 'https://www.pinterest.com/pin/841680617907538692', scheduledFor: null, publishedAt: new Date(Date.now() - 86400000).toISOString(), error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    { id: 'pin-4', accountId: 'acc-1', boardId: 'board-3', title: 'Weeknight pasta', description: 'Ready in 20 minutes.', imageUrl: 'https://365pinterest.com/icon-512.png', destinationUrl: 'https://example.com/pasta', status: 'SCHEDULED', pinterestPinId: null, pinterestUrl: null, scheduledFor: new Date(Date.now() + 26 * 3600 * 1000).toISOString(), publishedAt: null, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    { id: 'pin-5', accountId: 'acc-2', boardId: 'board-1', title: 'Second account pin', description: null, imageUrl: 'https://res.cloudinary.com/demo/image/upload/w_400,h_600,c_fill/sample.jpg', destinationUrl: null, status: 'PUBLISHED', pinterestPinId: '123456789012345678', pinterestUrl: 'https://www.pinterest.com/pin/123456789012345678', scheduledFor: null, publishedAt: new Date(Date.now() - 2 * 86400000).toISOString(), error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    { id: 'pin-6', accountId: 'acc-1', boardId: 'board-2', title: 'Broken image test', description: null, imageUrl: 'https://365pinterest.com/logo.png', destinationUrl: null, status: 'FAILED', pinterestPinId: null, pinterestUrl: null, scheduledFor: null, publishedAt: null, error: 'Pinterest rejected the image', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  ];
  const stubBoards = [
    { id: 'board-1', pinterestBoardId: '1001', name: 'AI Art Inspiration', description: 'Images and ideas for AI-generated art.', privacy: 'PUBLIC', pinCount: 42 },
    { id: 'board-2', pinterestBoardId: '1002', name: 'Home Decor Ideas', description: null, privacy: 'PUBLIC', pinCount: 18 },
    { id: 'board-3', pinterestBoardId: '1003', name: 'Recipes to Try', description: 'Weeknight dinners.', privacy: 'SECRET', pinCount: 7 },
  ];
  const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  apiFetch = async (input, init = {}) => {
    const u = new URL(String(input));
    const p = u.pathname;
    const q = u.searchParams;
    if (p === '/api/v1/account') {
      const id = q.get('account_id');
      if (id === 'acc-2') return jsonRes({ connected: true, needsReconnect: false, username: 'secondaccount', pinterestUserId: '999888777', scopes: ['boards:read', 'pins:read', 'pins:write'], boardCount: 5 });
      return jsonRes({ connected: true, needsReconnect: false, username: 'selftest-user', pinterestUserId: '123456789', scopes: ['boards:read', 'pins:read', 'pins:write'], boardCount: 3 });
    }
    if (p === '/api/v1/boards') {
      if ((init.method || 'GET') === 'POST') return jsonRes({ board: { id: 'board-9', pinterestBoardId: '1009', name: 'New Test Board', description: null, privacy: 'PUBLIC', pinCount: 0 } }, 201);
      return jsonRes({ boards: stubBoards, cached: true });
    }
    if (p === '/api/v1/pins') {
      let pins = stubPins;
      if (q.get('status')) pins = pins.filter((x) => x.status === q.get('status'));
      if (q.get('boardId')) pins = pins.filter((x) => x.boardId === q.get('boardId'));
      if ((init.method || 'GET') === 'POST') {
        return jsonRes({ pin: { ...stubPins[1], id: 'pin-new', status: 'DRAFT', title: 'Self-test pin' } }, 201);
      }
      return jsonRes({ pins, total: pins.length, limit: 100 });
    }
    if (p === '/api/v1/queue') {
      const q2 = stubPins.filter((x) => x.status === 'SCHEDULED').map((x) => ({ ...x, boardName: (stubBoards.find((b) => b.id === x.boardId) || {}).name || '' }));
      return jsonRes({ queue: q2, total: q2.length });
    }
    if (p === '/api/v1/analytics') {
      return jsonRes({ connected: true, startDate: '2026-10-15', endDate: '2026-11-13', totals: { impressions: 12480, saves: 312, clicks: 486, outboundClicks: 201 } });
    }
    if (p.startsWith('/api/v1/pins/') && p.endsWith('/schedule')) return jsonRes({ pin: { ...stubPins[1], status: 'SCHEDULED', scheduledFor: new Date(Date.now() + 3600 * 1000).toISOString() } });
    if (p.startsWith('/api/v1/pins/') && p.endsWith('/cancel')) return jsonRes({ pin: { ...stubPins[0], status: 'DRAFT', scheduledFor: null } });
    return net.fetch(input, init);
  };
  try { saveApiKey(fakeKey); } catch (e) { summary.checks.saveKey = `FAIL: ${e.message}`; }
  win.reload();
  await sleep(4000);
  summary.checks.dashboardVisible = await js(`document.getElementById('screen-dashboard').classList.contains('active') ? 'PASS' : 'FAIL (still on ' + document.querySelector('.screen.active').id + ')'`);
  summary.checks.dashboardStats = await js(`document.querySelectorAll('#screen-dashboard .stat-value').length >= 4 ? 'PASS' : 'FAIL'`);
  await shot('03-dashboard');
  for (const [screen, file] of [['boards', '04-boards'], ['pins', '05-pins'], ['create', '06-create'], ['queue', '07-queue'], ['analytics', '08-analytics'], ['settings', '09-settings']]) {
    win.webContents.send('nav', screen);
    await sleep(2500);
    const active = await js(`document.getElementById('screen-${screen}').classList.contains('active') ? 'PASS' : 'FAIL'`);
    summary.checks[`screen:${screen}`] = active;
    await shot(file);
  }
  // Dark theme check on the dashboard.
  await js(`document.documentElement.setAttribute('data-theme', 'dark')`);
  win.webContents.send('nav', 'dashboard');
  await sleep(1500);
  await shot('10-dashboard-dark');
  apiFetch = null;
  summary.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, 'selftest.json'), JSON.stringify(summary, null, 2));
  // eslint-disable-next-line no-console
  console.log('[selftest]', JSON.stringify(summary, null, 2));
  app.quit();
}

if (process.env.PINTEREST365_SELFTEST) {
  app.whenReady().then(() => setTimeout(runSelfTest, 1000));
}
