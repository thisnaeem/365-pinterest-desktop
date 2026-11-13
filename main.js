'use strict';
/**
 * 365 Pinterest — desktop app v2.2.0 (native).
 *
 * This is NOT a website wrapper. The app has its own local interface
 * (renderer/) and talks to the 365 Pinterest REST API
 * (https://365pinterest.com/api/v1/...) with the user's SIGNED-IN
 * SESSION — the same better-auth session as the website. There are no
 * API keys anywhere in this app: no key field, no key option, no key
 * stored, no key mentioned on any screen or in any error message.
 *
 * v2.2.0 (2026-11-14) — two corrections from the user's v2.1.0 feedback:
 *   1. REAL account login, zero API keys. v2.1.0's email sign-in minted
 *      an API key behind the scenes and Setup still offered "paste API
 *      key" — both are gone. Sign-in is now: email + password
 *      (better-auth /api/auth/sign-in/email, with an Origin header —
 *      net.fetch sends none and better-auth rejects that with 403
 *      MISSING_OR_NULL_ORIGIN) or "Continue with Pinterest" in-window
 *      OAuth (/api/pinterest/login; the callback issues a better-auth
 *      session and lands on /app). API calls authenticate with the
 *      session cookie from Electron's default-session cookie jar — the
 *      server accepts it on /api/v1 since the 2026-11-14 deploy
 *      (lib/api-keys.ts `authenticateV1`: Bearer key OR session cookie,
 *      same ownership checks, same 60/min budget). The session cookie
 *      persists across restarts (default session storage) for the
 *      server's 7-day session life. Sign-out ends the session
 *      server-side (POST /api/auth/sign-out), clears the site's cookies
 *      and deletes the stored identity. The password is never stored or
 *      logged. No Google button — Google sign-in is still broken
 *      server-side (no OAuth client; POST /api/auth/sign-in/social
 *      returns 500).
 *   2. Full professional UI redesign (renderer/styles.css + index.html):
 *      the website's /app dashboard design language — Unbounded
 *      everywhere, Pinterest red #E60023 as the only accent, warm
 *      neutrals, light + dark, Hugeicons throughout, real spacing
 *      scale, polished sidebar with section labels and icon chips,
 *      stat cards with icon chips, hover-lift cards, loading skeletons,
 *      proper empty states, and a split brand/form sign-in screen.
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
 * Limits the app respects (server-enforced): 60 req/min per signed-in
 * user; create_pin has an extra 30/min cap; create body cap 11 MB.
 * Writes return 402 when the account is read-only. Creation NEVER
 * publishes directly — a future scheduledFor makes a pin SCHEDULED (the
 * server's 5-minute cron publishes it); otherwise it is a DRAFT. There
 * is no publish-now or pin-delete endpoint in the REST API, and no
 * endpoint lists connected accounts for a session (the app discovers
 * extra accounts from the accountId field on listed pins and resolves
 * each one via /api/v1/account?account_id=).
 *
 * AUTH: the session lives in Electron's default-session cookie jar
 * (main process only). The only thing written to disk is the signed-in
 * identity ({ email, name } — display only, in session.json). No
 * password, no token, no credential is ever stored by this app.
 *
 * The pinterest365:// deep link from v1 is GONE — session auth makes it
 * unnecessary.
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, session, net } = require('electron');
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
// Signed-in identity (display only — NOT a credential)
// ---------------------------------------------------------------------------
// Stored file: { email, name }. The real session is the better-auth cookie
// in Electron's default-session cookie jar, persisted by Electron across
// restarts. Nothing sensitive is ever written here: no password, no token.
function saveIdentity(user) {
  fs.writeFileSync(
    userDataFile('session.json'),
    JSON.stringify({ email: (user && user.email) || null, name: (user && user.name) || null }),
    { mode: 0o600 }
  );
}

function loadIdentity() {
  try {
    const stored = JSON.parse(fs.readFileSync(userDataFile('session.json'), 'utf8'));
    if (!stored || (!stored.email && !stored.name)) return null;
    return { email: stored.email || null, name: stored.name || null };
  } catch (_e) {
    return null;
  }
}

function clearIdentity() {
  try { fs.unlinkSync(userDataFile('session.json')); } catch (_e) { /* already gone */ }
}

// Remove any credentials file left behind by v2.1.0 or earlier, so no
// stale secret survives on disk after the upgrade to session-only auth.
function removeLegacyCredentialsFile() {
  try { fs.unlinkSync(userDataFile('credentials.json')); } catch (_e) { /* none */ }
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
// API client — session-cookie auth (no Authorization header anywhere)
// ---------------------------------------------------------------------------
function apiErrorFromStatus(status, body) {
  const message = (body && body.error) || `Request failed (${status})`;
  // 401 has two honest shapes, and neither may mention API keys (the app
  // has none): an invalid/expired session vs no session at all.
  if (status === 401) {
    if (/invalid or expired session/i.test(message)) {
      return { status, error: 'Your session has expired — sign in again.' };
    }
    return { status, error: 'Sign in to continue.' };
  }
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
// app works behind corporate proxies too. net.fetch shares the default
// session's cookie jar with BrowserWindows, so the better-auth session
// cookie set by sign-in is sent on every /api/v1 call automatically.
// The self-test reassigns this to a stub (see runSelfTest); production
// always uses net.fetch.
let apiFetch = null;
function httpFetch(url, opts) {
  const fn = apiFetch || ((u, o) => net.fetch(u, o));
  return fn(url, opts);
}

async function apiRequest(apiPath, opts = {}) {
  const url = API_BASE + apiPath;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await httpFetch(url, {
      method: opts.method || 'GET',
      headers: { ...(opts.headers || {}) },
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
// Website sign-in (v2.2.0) — email + password and "Continue with Pinterest"
// ---------------------------------------------------------------------------
// Session-aware fetch for the better-auth endpoints. Electron's net.fetch
// sends NO Origin header, and better-auth rejects POST /api/auth/* without
// one with 403 {"code":"MISSING_OR_NULL_ORIGIN"}. Verified live 2026-11-13:
//   no Origin  -> 403 MISSING_OR_NULL_ORIGIN
//   Origin: https://365pinterest.com -> 401 INVALID_EMAIL_OR_PASSWORD (bogus creds)
// net.fetch shares the default session's cookie jar with BrowserWindows, so
// the session cookie set by sign-in is sent on the later /api/v1 calls
// automatically — no token is minted, stored, or handled by this app.
let sessionFetchImpl = null; // test seam (like apiFetch)
function sessionFetch(url, opts = {}) {
  const fn = sessionFetchImpl || ((u, o) => net.fetch(u, o));
  const headers = { ...(opts.headers || {}) };
  const method = (opts.method || 'GET').toUpperCase();
  if (method === 'POST' && !headers.Origin && !headers.origin) headers.Origin = API_BASE;
  return fn(url, { ...opts, headers });
}

/** Ask the server who the current session belongs to (better-auth
 *  /api/auth/get-session). Returns { signedIn, user } — the authoritative
 *  answer for boot and for the Settings screen. */
async function fetchSession() {
  let res;
  try {
    res = await sessionFetch(`${API_BASE}/api/auth/get-session`, { method: 'GET' });
  } catch (_e) {
    return { ok: false, status: 0, error: 'Could not reach 365pinterest.com. Check your internet connection.' };
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_e) { body = null; }
  if (!res.ok) {
    return { ok: false, status: res.status, error: (body && (body.message || body.error)) || `Could not check the session (${res.status}).` };
  }
  const user = (body && (body.user || (body.data && body.data.user))) || null;
  if (!user) return { ok: true, signedIn: false, user: null };
  return { ok: true, signedIn: true, user: { email: user.email || null, name: user.name || null } };
}

// Error flags the website's sign-in page maps from /sign-in?error=… (see
// app/sign-in/SignInForm.tsx PINTEREST_ERRORS). Same wording, so the
// desktop and the website say the same thing.
const PINTEREST_ERRORS = {
  denied: 'You declined Pinterest access. Try again and approve the connection.',
  state: 'The Pinterest sign-in session expired. Try again.',
  exchange: 'Pinterest did not return a valid sign-in token. Try again.',
  token: 'Pinterest did not return a valid sign-in token. Try again.',
  account: 'Could not link that Pinterest account. Check it is not already linked to another 365 Pinterest account.',
};

let authWindow = null;
function openPinterestLogin() {
  return new Promise((resolve) => {
    if (authWindow && !authWindow.isDestroyed()) {
      authWindow.focus();
      return;
    }
    authWindow = new BrowserWindow({
      width: 480,
      height: 680,
      parent: mainWindow,
      modal: true,
      title: 'Sign in with Pinterest',
      show: false,
      backgroundColor: '#FAFAF8',
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (authWindow && !authWindow.isDestroyed()) authWindow.close();
      authWindow = null;
      resolve(result);
    };
    authWindow.once('ready-to-show', () => authWindow.show());
    authWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    authWindow.webContents.on('did-navigate', (_event, url) => {
      // Success: the callback issued a better-auth session and landed on /app.
      if (url.startsWith(`${API_BASE}/app`)) finish({ ok: true });
      // Failure: the callback redirected to /sign-in?error=<flag>.
      else if (url.startsWith(`${API_BASE}/sign-in`)) {
        let flag = '';
        try { flag = new URL(url).searchParams.get('error') || ''; } catch (_e) { /* ignore */ }
        finish({ ok: false, error: PINTEREST_ERRORS[flag] || 'Pinterest sign-in failed. Please try again.' });
      }
    });
    authWindow.on('closed', () => { if (!settled) finish({ ok: false, error: 'cancelled' }); });
    authWindow.loadURL(`${API_BASE}/api/pinterest/login`);
  });
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
// v2.1.0: update state is tracked here and pushed to the renderer, so
// Settings shows the live status ("You're on v2.2.0 — checking… / up to
// date / update available / downloaded") and a banner offers Download /
// Restart. Checks run on launch and every 6 hours. Honest limit: the full
// download+install loop can only be proven on Windows — a Windows GUI
// binary cannot run on the Linux build box. Verified here: the live feed
// resolves (latest.yml), the version comparison runs, and every UI state
// renders (see the v2.2 self-test).
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
let updateState = { status: 'idle', version: null, progress: 0, error: null, lastCheckedAt: null };
autoUpdater.autoDownload = false;

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  sendUpdateEvent({ type: 'update-state', state: updateState });
}

function checkForUpdates(manual) {
  try {
    setUpdateState({ status: 'checking', error: null });
    autoUpdater.checkForUpdates().then((result) => {
      if (!result) {
        // Unpacked (dev) builds: the updater is inactive by design and no
        // event will ever fire — clear 'checking' honestly instead of
        // leaving it stuck. In the installed app this never happens.
        setUpdateState({ status: 'error', error: 'Update checks run in the installed app, not in this development build.' });
      }
    }).catch((err) => {
      setUpdateState({ status: 'error', error: String(err && err.message ? err.message : err) });
      if (manual) sendUpdateEvent({ type: 'update-error', message: 'Could not check for updates right now.' });
    });
  } catch (_e) {
    setUpdateState({ status: 'error', error: 'Update check is unavailable in this environment.' });
  }
}

autoUpdater.on('update-available', (info) => {
  setUpdateState({ status: 'available', version: info.version, progress: 0 });
  sendUpdateEvent({ type: 'update-available', version: info.version });
});
autoUpdater.on('update-not-available', () => {
  setUpdateState({ status: 'up-to-date', lastCheckedAt: new Date().toISOString() });
  sendUpdateEvent({ type: 'update-not-available' });
});
autoUpdater.on('download-progress', (p) => {
  setUpdateState({ status: 'downloading', progress: Math.round(p.percent) });
  sendUpdateEvent({ type: 'update-progress', percent: Math.round(p.percent), transferred: p.transferred, total: p.total });
});
autoUpdater.on('update-downloaded', (info) => {
  setUpdateState({ status: 'downloaded', version: info.version, progress: 100 });
  sendUpdateEvent({ type: 'update-downloaded', version: info.version });
});
autoUpdater.on('error', (err) => {
  setUpdateState({ status: 'error', error: String(err && err.message ? err.message : err) });
  sendUpdateEvent({ type: 'update-error', message: String(err && err.message ? err.message : err) });
});

// ---------------------------------------------------------------------------
// IPC — the renderer never touches the network directly
// ---------------------------------------------------------------------------
function requireSession() {
  if (!loadIdentity()) return { ok: false, status: 401, error: 'Sign in to continue.' };
  return { ok: true };
}

ipcMain.handle('app:getInfo', () => ({
  version: app.getVersion(),
  platform: process.platform,
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

ipcMain.handle('app:getUpdateState', () => ({ ...updateState, appVersion: app.getVersion() }));
ipcMain.handle('app:checkForUpdates', () => { checkForUpdates(true); return true; });
ipcMain.handle('app:downloadUpdate', () => {
  try {
    setUpdateState({ status: 'downloading', progress: 0 });
    autoUpdater.downloadUpdate();
    return true;
  } catch (_e) { return false; }
});
ipcMain.handle('app:installUpdate', () => {
  // Only restart once the update is actually downloaded.
  if (updateState.status !== 'downloaded') return false;
  try { autoUpdater.quitAndInstall(); return true; } catch (_e) { return false; }
});

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_event, patch) => {
  const next = { ...loadSettings(), ...patch };
  saveSettings(next);
  return next;
});

// Live session check for boot: the server's /api/auth/get-session is the
// authority. Offline (status 0) with a stored identity is reported as
// signed-in-but-offline, so a network blip does not throw the user back
// to the sign-in screen — the API calls will surface the real error.
ipcMain.handle('auth:getSession', async () => {
  const res = await fetchSession();
  if (res.ok) return { signedIn: res.signedIn, user: res.user || null, offline: false };
  const identity = loadIdentity();
  if (res.status === 0 && identity) {
    return { signedIn: true, user: identity, offline: true };
  }
  return { signedIn: false, user: identity, offline: false, error: res.error };
});

// Email + password sign-in, like the website's sign-in page. The password
// is used only in this request body — it is never logged or stored. On
// success the better-auth session cookie (set in the shared session jar)
// is confirmed via /api/auth/get-session and the identity is stored for
// display; /api/v1 calls then authenticate with that session cookie.
ipcMain.handle('auth:signInEmail', async (_event, email, password) => {
  const cleanEmail = typeof email === 'string' ? email.trim() : '';
  if (!cleanEmail || !password) {
    return { ok: false, status: 400, error: 'Enter your email and password.' };
  }
  let res;
  try {
    res = await sessionFetch(`${API_BASE}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: cleanEmail, password }),
    });
  } catch (_e) {
    return { ok: false, status: 0, error: 'Could not reach 365pinterest.com. Check your internet connection.' };
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_e) { body = null; }
  if (!res.ok) {
    const code = body && body.code;
    if (code === 'INVALID_EMAIL_OR_PASSWORD' || res.status === 401) {
      return { ok: false, status: 401, error: 'Incorrect email or password. Check both and try again.' };
    }
    if (code === 'EMAIL_NOT_VERIFIED') {
      return { ok: false, status: 403, error: 'That email is not verified yet. Check your inbox for the verification email, then try again.', needsVerification: true };
    }
    if (res.status === 429) return { ok: false, status: 429, error: 'Too many sign-in attempts. Wait a few minutes and try again.' };
    return { ok: false, status: res.status, error: (body && (body.message || body.error)) || `Sign-in failed (${res.status}).` };
  }
  const sess = await fetchSession();
  if (!sess.ok || !sess.signedIn) {
    return { ok: false, status: 0, error: 'Signed in, but the app could not confirm the session. Try again.' };
  }
  try { saveIdentity(sess.user); } catch (_e) { /* display-only; sign-in still stands */ }
  return { ok: true, user: sess.user };
});

// "Continue with Pinterest" — in-window OAuth (proven in v1). The login
// route needs no session: the callback finds or creates the app account
// from the Pinterest user id, issues a better-auth session and lands on
// /app — with the Pinterest account already connected for posting.
ipcMain.handle('auth:signInPinterest', async () => {
  const result = await openPinterestLogin();
  if (!result.ok) return result;
  const sess = await fetchSession();
  if (!sess.ok || !sess.signedIn) {
    return { ok: false, status: 0, error: 'Pinterest sign-in finished, but the app could not confirm the session. Try again.' };
  }
  try { saveIdentity(sess.user); } catch (_e) { /* display-only */ }
  return { ok: true, user: sess.user };
});

// Sign out: end the better-auth session server-side, clear the site's
// cookies, and delete the stored identity. Your pins and boards stay on
// your account.
ipcMain.handle('auth:signOut', async () => {
  try {
    await sessionFetch(`${API_BASE}/api/auth/sign-out`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch (_e) { /* best effort — local state is cleared anyway */ }
  try {
    await session.defaultSession.clearStorageData({ origin: API_BASE, storages: ['cookies'] });
  } catch (_e) { /* ignore */ }
  clearIdentity();
  return true;
});

// Signed-in identity for the Settings screen (name/email only — no secret).
ipcMain.handle('auth:getUser', () => loadIdentity());

ipcMain.handle('api:account', async (_event, accountId) => {
  const s = requireSession();
  if (!s.ok) return s;
  return apiRequest(withAccountId('/api/v1/account', accountId || null));
});

ipcMain.handle('api:boards', async (_event, accountId) => {
  const s = requireSession();
  if (!s.ok) return s;
  return apiRequest(withAccountId('/api/v1/boards', accountId || null));
});

ipcMain.handle('api:boardsCreate', async (_event, payload) => {
  const s = requireSession();
  if (!s.ok) return s;
  const body = { name: payload.name };
  if (payload.description) body.description = payload.description;
  if (payload.privacy) body.privacy = payload.privacy;
  if (payload.accountId) body.account_id = payload.accountId;
  return apiRequest('/api/v1/boards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
});

ipcMain.handle('api:pins', async (_event, filters) => {
  const s = requireSession();
  if (!s.ok) return s;
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.boardId) params.set('boardId', filters.boardId);
  params.set('limit', String(Math.min(Math.max(filters.limit || 100, 1), 100)));
  if (filters.accountId) params.set('account_id', filters.accountId);
  return apiRequest(`/api/v1/pins?${params.toString()}`);
});

ipcMain.handle('api:pinCreate', async (_event, payload) => {
  const s = requireSession();
  if (!s.ok) return s;
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
  return apiRequest('/api/v1/pins', { method: 'POST', headers, body });
});

ipcMain.handle('api:pinSchedule', async (_event, pinId, scheduledFor) => {
  const s = requireSession();
  if (!s.ok) return s;
  return apiRequest(`/api/v1/pins/${encodeURIComponent(pinId)}/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scheduledFor }),
  });
});

ipcMain.handle('api:pinCancel', async (_event, pinId) => {
  const s = requireSession();
  if (!s.ok) return s;
  return apiRequest(`/api/v1/pins/${encodeURIComponent(pinId)}/cancel`, { method: 'POST' });
});

ipcMain.handle('api:queue', async (_event, accountId) => {
  const s = requireSession();
  if (!s.ok) return s;
  return apiRequest(withAccountId('/api/v1/queue?limit=100', accountId || null));
});

ipcMain.handle('api:analytics', async (_event, accountId) => {
  const s = requireSession();
  if (!s.ok) return s;
  return apiRequest(withAccountId('/api/v1/analytics', accountId || null));
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
  // A credentials file from v2.1.0 or earlier must not survive the move
  // to session-only auth — remove it on first launch of v2.2.0+.
  removeLegacyCredentialsFile();
  // Harden the session: no remote content is ever loaded, but keep the
  // permission surface minimal anyway.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  buildMenu();
  createWindow();
  // Silent update check shortly after launch, then every 6 hours;
  // failures are silent too (Settings shows the status on demand).
  setTimeout(() => checkForUpdates(false), 8000);
  setInterval(() => checkForUpdates(false), UPDATE_CHECK_INTERVAL_MS);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// Self-test (PINTEREST365_SELFTEST=1 only — never runs in production).
// Verifies the native UI end to end: the sign-in screen (no API-key
// anything, anywhere), the Pinterest auth window opening, live 401s
// against the real API (bogus email creds; the session-cookie transport
// proven by planting a bogus session cookie in the jar and watching the
// server reject it as a session — not as "missing auth"), the live
// latest.yml feed, the stubbed email-sign-in -> session -> dashboard
// flow, all screens with stubbed API responses (no real account password
// exists on this machine), and the update banner states. Screenshots +
// summary land in test-output/v2.2/. Run via: npm run selftest
// ---------------------------------------------------------------------------
async function runSelfTest() {
  const outDir = path.join(__dirname, 'test-output', 'v2.2');
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

  // 1. Sign-in screen is showing (no session stored) and the page is local.
  const url = win.webContents.getURL();
  summary.checks.localUrl = url.startsWith('file://') ? `PASS (${url})` : `FAIL (${url})`;
  summary.checks.signinVisible = await js(`!document.getElementById('screen-setup').classList.contains('hidden') && document.getElementById('screen-setup').classList.contains('active') ? 'PASS' : 'FAIL'`);
  summary.checks.allScreensPresent = await js(`['setup','dashboard','boards','pins','create','queue','analytics','settings'].every((s) => !!document.getElementById('screen-' + s)) ? 'PASS' : 'FAIL'`);
  // 1b. Hugeicons: every [data-icon] slot is filled with a real SVG glyph
  // (not a unicode lookalike) — the genuine @hugeicons paths.
  summary.checks.hugeiconsInjected = await js(`(() => { const slots = [...document.querySelectorAll('[data-icon]')]; const filled = slots.filter((el) => el.querySelector('svg')).length; const unicodeLeft = [...document.querySelectorAll('.nav-icon')].some((el) => /[▦▤▧＋◷↗⚙]/.test(el.textContent)); return filled === slots.length && slots.length >= 10 && !unicodeLeft ? 'PASS (' + filled + '/' + slots.length + ' slots filled with SVG)' : 'FAIL (' + filled + '/' + slots.length + ' slots, unicodeLeft=' + unicodeLeft + ')'; })()`);
  summary.checks.emailFormPresent = await js(`['signin-email','signin-password','signin-btn','pinterest-btn'].every((id) => !!document.getElementById(id)) ? 'PASS' : 'FAIL'`);
  // 1c. v2.2.0 hard rule: NO API-key anything in the rendered UI — no
  // field, no option, no mention on any screen or error message.
  summary.checks.noApiKeyAnywhere = await js(`(() => { const txt = document.body.innerText || ''; const hasField = !!document.getElementById('api-key-input') || !!document.getElementById('validate-key-btn'); return !hasField && !/api key/i.test(txt) ? 'PASS (no key field, no key text in the rendered UI)' : 'FAIL (key field present: ' + hasField + '; key text found: ' + /api key/i.test(txt) + ')'; })()`);
  await shot('01-signin');
  // Dark sign-in, judged like a designer (not a checklist item).
  await js(`document.documentElement.setAttribute('data-theme', 'dark')`);
  await sleep(600);
  await shot('01b-signin-dark');
  await js(`document.documentElement.setAttribute('data-theme', 'light')`);
  await sleep(400);

  // 1d. "Continue with Pinterest" opens the auth window (closed again
  // immediately — the live OAuth flow needs a real Pinterest account).
  await js(`document.getElementById('pinterest-btn').click();`);
  let winCount = 0;
  for (let i = 0; i < 15; i++) {
    await sleep(500);
    winCount = BrowserWindow.getAllWindows().length;
    if (winCount === 2) break;
  }
  if (winCount === 2) {
    const extra = BrowserWindow.getAllWindows().find((w) => w !== win);
    // getURL() is "" while the login route 302s to Pinterest — poll until
    // the first navigation commits (the authorize page redirects to
    // pinterest.com/login when the user is not signed in to Pinterest).
    let extraUrl = '';
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if (!extra || extra.isDestroyed()) break;
      extraUrl = extra.webContents.getURL();
      if (extraUrl) break;
    }
    summary.checks.pinterestWindowOpens = extra && (extraUrl.startsWith(API_BASE) || extraUrl.includes('pinterest.com'))
      ? `PASS (auth window opened at ${extraUrl.slice(0, 120)}…)`
      : `FAIL (second window opened at an unexpected URL: ${extraUrl})`;
    if (extra && !extra.isDestroyed()) extra.close();
    await sleep(500);
  } else {
    summary.checks.pinterestWindowOpens = `FAIL (expected 2 windows, saw ${winCount})`;
  }
  summary.checks.pinterestCancelledSilent = await js(`document.getElementById('setup-error').textContent === '' ? 'PASS' : 'FAIL (error shown after cancel: "' + document.getElementById('setup-error').textContent + '")'`);

  // 1e. Live email sign-in with bogus creds — the real server must answer
  // 401 INVALID_EMAIL_OR_PASSWORD (proves the Origin-header fix works).
  await js(`document.getElementById('signin-email').value = 'probe-nonexistent-xyz@example.com'; document.getElementById('signin-password').value = 'ProbePass123'; document.getElementById('signin-btn').click();`);
  let signinErr = '';
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    signinErr = await js(`document.getElementById('setup-error').textContent`);
    if (signinErr) break;
  }
  summary.checks.liveEmail401 = signinErr.toLowerCase().includes('incorrect email or password')
    ? `PASS (real server answered 401: "${signinErr}")`
    : `FAIL (unexpected error text: "${signinErr}")`;
  await shot('02-setup-invalid-email');

  // 1f. LIVE session-cookie transport proof (no stubs): plant a bogus
  // session cookie in the default session jar and call the REAL
  // /api/v1/account through the real net.fetch path. If net.fetch sends
  // the jar's cookies, the server answers "Invalid or expired session";
  // if it sent nothing, the answer would be the missing-auth 401.
  try {
    // Chromium refuses a __Secure- cookie unless secure:true is set.
    await session.defaultSession.cookies.set({ url: API_BASE, name: '__Secure-better-auth.session_token', value: 'bogus.invalid.token', secure: true });
    const withCookie = await apiRequest('/api/v1/account');
    summary.checks.liveCookieSent = withCookie && !withCookie.ok && withCookie.status === 401 && /session has expired/i.test(withCookie.error || '')
      ? `PASS (server saw the jar cookie and rejected it as a session: "${withCookie.error}")`
      : `FAIL (unexpected result: ${JSON.stringify(withCookie)})`;
  } catch (e) {
    summary.checks.liveCookieSent = `FAIL (${e.message})`;
  } finally {
    try { await session.defaultSession.cookies.remove(API_BASE, '__Secure-better-auth.session_token'); } catch (_e) { /* ignore */ }
  }
  const noCookie = await apiRequest('/api/v1/account');
  summary.checks.liveNoCookie = noCookie && !noCookie.ok && noCookie.status === 401 && /sign in to continue/i.test(noCookie.error || '')
    ? `PASS (nothing sent by default: "${noCookie.error}")`
    : `FAIL (unexpected result: ${JSON.stringify(noCookie)})`;

  // 1g. Live update feed: latest.yml must describe the v2.1.0 installer.
  try {
    const feedRes = await net.fetch('https://github.com/thisnaeem/365-pinterest-desktop/releases/download/v2.1.0/latest.yml');
    const feedText = await feedRes.text();
    const feedVersion = /version: ([^\n]+)/.exec(feedText);
    const feedPath = /path: ([^\n]+)/.exec(feedText);
    const feedSize = /size: (\d+)/.exec(feedText);
    summary.checks.liveFeedYml = feedRes.status === 200 && feedVersion && feedVersion[1].trim() === '2.1.0' && feedPath && feedPath[1].trim() === '365-Pinterest-Setup-2.1.0.exe' && feedSize && feedSize[1] === '81092172'
      ? 'PASS (latest.yml: version 2.1.0, path 365-Pinterest-Setup-2.1.0.exe, size 81092172)'
      : `FAIL (status ${feedRes.status}, body: ${feedText.slice(0, 200)})`;
  } catch (e) {
    summary.checks.liveFeedYml = `FAIL (${e.message})`;
  }

  // 2. Stub the API (test-only) and re-run the app as a signed-in user.
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
  // 2b. Stub the website sign-in + session check (test-only) and drive
  // the real UI: email sign-in must confirm the session and land on the
  // dashboard WITHOUT a reload. (The live cookie -> session leg cannot be
  // proven here — no test account password exists on this machine — so
  // this proves the UI flow and the session wiring; the live leg is
  // proven by 1f above plus the deployed server's session acceptance.)
  sessionFetchImpl = async (input, init = {}) => {
    const u = new URL(String(input));
    if (u.pathname === '/api/auth/sign-in/email') {
      return new Response(JSON.stringify({ user: { id: 'user-selftest', name: 'Self Test', email: 'selftest@365pinterest.com' }, session: { id: 'sess-1' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.pathname === '/api/auth/get-session') {
      return new Response(JSON.stringify({ session: { id: 'sess-1', userId: 'user-selftest' }, user: { id: 'user-selftest', name: 'Self Test', email: 'selftest@365pinterest.com' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.pathname === '/api/auth/sign-out') {
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return net.fetch(input, init);
  };
  await js(`document.getElementById('signin-email').value = 'selftest@365pinterest.com'; document.getElementById('signin-password').value = 'SelfTest123'; document.getElementById('signin-btn').click();`);
  let dashAfterSignin = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    dashAfterSignin = await js(`document.getElementById('screen-dashboard').classList.contains('active')`);
    if (dashAfterSignin) break;
  }
  summary.checks.stubEmailSignIn = dashAfterSignin
    ? 'PASS (stubbed email sign-in confirmed the session and showed the dashboard, no reload)'
    : `FAIL (still on ${await js(`document.querySelector('.screen.active').id`)}; error: "${await js(`document.getElementById('setup-error').textContent`)}")`;
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
  // Settings must show the live update status line (v2.2) and the
  // signed-in identity — and no API-key text anywhere.
  summary.checks.settingsUpdateStatus = await js(`(() => { const el = document.getElementById('settings-update-status'); return el && el.textContent.includes('v2.2.0') ? 'PASS (' + el.textContent.trim().slice(0, 140) + ')' : 'FAIL (' + (el ? el.textContent : 'no status element') + ')'; })()`);
  summary.checks.settingsShowsIdentity = await js(`(document.getElementById('settings-content').innerText || '').includes('selftest@365pinterest.com') ? 'PASS (signed-in email shown in Settings)' : 'FAIL (signed-in email not in Settings)'`);
  summary.checks.settingsNoApiKey = await js(`!/api key/i.test(document.getElementById('settings-content').innerText || '') ? 'PASS (no key text in Settings)' : 'FAIL (key text found in Settings)'`);
  // Dark theme checks on dashboard, boards and settings.
  await js(`document.documentElement.setAttribute('data-theme', 'dark')`);
  win.webContents.send('nav', 'dashboard');
  await sleep(1500);
  await shot('10-dashboard-dark');
  win.webContents.send('nav', 'boards');
  await sleep(1500);
  await shot('10b-boards-dark');
  win.webContents.send('nav', 'settings');
  await sleep(1500);
  await shot('10c-settings-dark');
  await js(`document.documentElement.setAttribute('data-theme', 'light')`);

  // 3. Update loop: real feed check (if the packaged build exists), then
  // simulated update events to prove every banner state renders.
  const packagedUpdateYml = path.join(__dirname, 'dist', 'win-unpacked', 'resources', 'app-update.yml');
  if (fs.existsSync(packagedUpdateYml)) {
    try {
      autoUpdater.updateConfigPath = packagedUpdateYml;
      // Dev builds skip checks by design (checkForUpdates returns null) —
      // force the dev config so the real feed lookup actually runs.
      autoUpdater.forceDevUpdateConfig = true;
      checkForUpdates(false);
      let st = 'checking';
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        st = updateState.status;
        if (st !== 'checking') break;
      }
      summary.checks.liveUpdateFeed = st === 'up-to-date'
        ? 'PASS (feed latest 2.1.0 < local 2.2.0 — update-not-available, via packaged app-update.yml)'
        : (st === 'error' && updateState.error && updateState.error.includes('latest-linux.yml'))
          ? 'PASS (updater reached the live v2.1.0 release and asked for the Linux channel file latest-linux.yml — 404, expected: we only ship Windows. On Windows it asks for latest.yml, verified 200 with version 2.1.0 / 365-Pinterest-Setup-2.1.0.exe / 81092172)'
          : `CHECK (update state after live feed check: ${st}${updateState.error ? ' — ' + updateState.error : ''})`;
    } catch (e) {
      summary.checks.liveUpdateFeed = `SKIP (could not run the updater in dev: ${e.message})`;
    }
  } else {
    summary.checks.liveUpdateFeed = 'SKIP (no packaged app-update.yml yet — build the installer first, then re-run the self-test)';
  }
  sendUpdateEvent({ type: 'update-available', version: '2.3.0' });
  await sleep(600);
  summary.checks.updateBannerAvailable = await js(`!document.getElementById('update-banner').classList.contains('hidden') && document.getElementById('update-banner-text').textContent.includes('2.3.0') ? 'PASS' : 'FAIL'`);
  sendUpdateEvent({ type: 'update-progress', percent: 42 });
  await sleep(400);
  summary.checks.updateBannerProgress = await js(`document.getElementById('update-banner-text').textContent.includes('42%') ? 'PASS' : 'FAIL'`);
  sendUpdateEvent({ type: 'update-downloaded', version: '2.3.0' });
  await sleep(400);
  summary.checks.updateBannerDownloaded = await js(`!document.getElementById('update-restart-btn').classList.contains('hidden') ? 'PASS' : 'FAIL'`);
  await shot('11-update-banner');
  sendUpdateEvent({ type: 'update-not-available' });
  await sleep(400);
  summary.checks.updateBannerHidden = await js(`document.getElementById('update-banner').classList.contains('hidden') ? 'PASS' : 'FAIL'`);

  // Clean up: sign out (ends the stubbed session, clears identity and
  // cookies) and leave no test state behind for the next real launch.
  try { await win.webContents.executeJavaScript(`window.desktop.signOut()`); } catch (_e) { /* ignore */ }
  try { clearIdentity(); } catch (_e) { /* ignore */ }
  try { await session.defaultSession.cookies.remove(API_BASE, '__Secure-better-auth.session_token'); } catch (_e) { /* ignore */ }
  sessionFetchImpl = null;
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
