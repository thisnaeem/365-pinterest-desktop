'use strict';
/**
 * 365 Pinterest — desktop app (Electron).
 *
 * Wraps the live web app at https://365pinterest.com in a persistent,
 * properly-identified Chromium window. There is no local UI of its own:
 * the whole product is the website.
 *
 * AUTH DESIGN (this is the part that has to be right):
 * - The app uses ONE persistent session partition (`persist:365-pinterest`).
 *   Cookies + localStorage live in the OS user-data dir and survive restarts,
 *   so a signed-in user stays signed in — same as a normal browser.
 * - The window sends a plain Chrome user-agent (no `Electron/` token).
 *   Google and Pinterest both reject/flag embedded-webview UAs; with a
 *   normal Chrome UA the OAuth pages load as they do in Chrome.
 * - Email+password sign-in works in-window (better-auth, no provider).
 * - Pinterest sign-in (`/api/pinterest/login` -> www.pinterest.com/oauth)
 *   also runs in-window — Pinterest allows webview sign-in.
 * - Google sign-in runs in-window too, BUT the live site's Google provider
 *   is currently not configured server-side (POST /api/auth/sign-in/social
 *   returns 500 — the Google client id/secret are not set in the Worker
 *   and the callback is not registered in Google Cloud Console). Until
 *   that server-side step is done, Google sign-in fails on the WEB as
 *   well; the desktop app cannot fix it. Once fixed, the in-window flow
 *   works. If Google ever blocks the in-window flow anyway, the app
 *   detects the "browser or app may not be secure" page and offers to
 *   finish sign-in in the system browser; the session then comes back
 *   through the `pinterest365://auth?token=...` deep link (see
 *   server-handoff-route/ — that server route is prepared but NOT
 *   deployed; it is only needed if in-window Google is ever blocked).
 * - All other external links (Polar checkout, docs, blog, social) open in
 *   the user's real browser via shell.openExternal — never inside the app.
 * - No DevTools in packaged builds. No node access in the renderer.
 */
const { app, BrowserWindow, shell, Menu, dialog, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_URL = 'https://365pinterest.com';
const APP_HOST = '365pinterest.com';
const PROTOCOL = 'pinterest365';
const PARTITION = 'persist:365-pinterest';
// better-auth's session cookie name (verified against better-auth dist).
const SESSION_COOKIE = 'better-auth.session_token';

// Hosts the app is allowed to navigate to inside its own window:
// the app itself plus the two OAuth providers it signs in with.
const IN_APP_HOSTS = new Set([
  '365pinterest.com',
  'www.pinterest.com',
  'api.pinterest.com',
  'pinterest.com',
  'accounts.google.com',
  'www.google.com',
]);

let mainWindow = null;
let loadRetries = 0;

function chromeUserAgent() {
  const platform =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64';
  // Deliberately a plain Chrome UA: no Electron/ token, so OAuth providers
  // treat this window as a normal browser.
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`;
}

function isInAppUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === `${PROTOCOL}:`) return true;
    if (u.hostname === APP_HOST || u.hostname.endsWith(`.${APP_HOST}`)) return true;
    return IN_APP_HOSTS.has(u.hostname);
  } catch (_e) {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    title: '365 Pinterest',
    backgroundColor: '#FAFAF8',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged, // no DevTools in production builds
      partition: PARTITION,
      userAgent: chromeUserAgent(),
    },
  });

  const wc = mainWindow.webContents;

  // --- Navigation policy -------------------------------------------------
  // Anything outside the app / OAuth providers opens in the system browser.
  wc.on('will-navigate', (event, url) => {
    if (!isInAppUrl(url)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  wc.setWindowOpenHandler(({ url }) => {
    if (isInAppUrl(url)) {
      // OAuth popups (Google/Pinterest consent) stay in-app, same session.
      return { action: 'allow', overrideBrowserWindowOptions: { width: 560, height: 720, title: '365 Pinterest — Sign in' } };
    }
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  // --- Load failure: retry a few times, then tell the user ---------------
  wc.on('did-fail-load', (_event, _code, description, validatedURL, isMainFrame) => {
    if (!isMainFrame || validatedURL.startsWith(`${PROTOCOL}:`)) return;
    // Only auto-retry failures on OUR OWN host. OAuth provider pages
    // (Pinterest/Google) must keep their error visible — silently
    // bouncing the user back to the homepage would hide the real problem
    // and break the sign-in flow.
    let failedHost = '';
    try { failedHost = new URL(validatedURL).hostname; } catch (_e) { /* ignore */ }
    if (failedHost !== APP_HOST && !failedHost.endsWith(`.${APP_HOST}`)) return;
    if (loadRetries < 3) {
      loadRetries += 1;
      setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(APP_URL).catch(() => {}); }, 2000);
      return;
    }
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '365 Pinterest',
      message: 'Could not reach 365pinterest.com',
      detail: `The site did not load (${description}). Check your internet connection, then choose Retry.`,
      buttons: ['Retry', 'Quit'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0 && mainWindow && !mainWindow.isDestroyed()) {
        loadRetries = 0;
        mainWindow.loadURL(APP_URL).catch(() => {});
      } else {
        app.quit();
      }
    }).catch(() => {});
  });

  wc.on('did-finish-load', () => { loadRetries = 0; });

  // --- Google embedded-browser block detection ---------------------------
  // If Google ever refuses the in-window flow, its page says so plainly.
  // Offer the system-browser route instead of leaving a dead error page.
  wc.on('did-finish-load', () => {
    let url = '';
    try { url = wc.getURL(); } catch (_e) { /* ignore */ }
    let host = '';
    try { host = new URL(url).hostname; } catch (_e) { /* ignore */ }
    if (host !== 'accounts.google.com') return;
    wc.executeJavaScript(
      `(function () { var t = (document.body && document.body.innerText) || ''; return t.slice(0, 2000); })()`,
      true
    ).then((text) => {
      if (!text) return;
      const blocked = /browser or app may not be secure|couldn't sign you in|This browser or app may not be secure/i.test(text);
      if (!blocked || !mainWindow || mainWindow.isDestroyed()) return;
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Google sign-in',
        message: 'Google blocked sign-in inside the desktop app',
        detail: 'Google does not allow sign-in from this window. You can finish signing in in your normal browser instead — the app will pick up your session when the server handoff is set up (see README: "System-browser sign-in").',
        buttons: ['Open sign-in in browser', 'Stay here'],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) shell.openExternal(`${APP_URL}/sign-in`).catch(() => {});
      }).catch(() => {});
    }).catch(() => {});
  });

  mainWindow.loadURL(APP_URL).catch(() => {});
  mainWindow.on('closed', () => { mainWindow = null; });
}

// --- Deep link: pinterest365://auth?token=<better-auth session token> ----
// Used by the system-browser sign-in fallback: the web app (once the
// server handoff route is deployed) redirects here after a successful
// sign-in, and the app plants the session cookie in its own partition,
// which signs the user in exactly as if they had signed in in-window.
async function handleDeepLink(url) {
  let parsed;
  try { parsed = new URL(url); } catch (_e) { return; }
  if (parsed.protocol !== `${PROTOCOL}:` || parsed.hostname !== 'auth') return;
  const token = parsed.searchParams.get('token');
  if (!token || token.length < 20 || token.length > 512) return;
  try {
    const ses = session.fromPartition(PARTITION);
    await ses.cookies.set({
      url: APP_URL,
      name: SESSION_COOKIE,
      value: token,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      expirationDate: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days, matches server session
    });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(`${APP_URL}/app`).catch(() => {});
      mainWindow.focus();
    }
  } catch (_e) {
    // A bad/expired token just leaves the user signed out; the sign-in
    // page explains itself. Never crash on a deep link.
  }
}

// --- Menus ---------------------------------------------------------------
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: '365 Pinterest',
      submenu: [
        { label: 'About 365 Pinterest', click: () => dialog.showMessageBox(mainWindow, { type: 'info', title: '365 Pinterest', message: '365 Pinterest', detail: `Version ${app.getVersion()}\nPinterest automation — schedule pins, manage boards, write AI blogs and auto-pin them.\n\n© 2025 Anjum Labs` }) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open 365 Pinterest', accelerator: 'CmdOrCtrl+Home', click: () => { if (mainWindow) mainWindow.loadURL(APP_URL).catch(() => {}); } },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        // DevTools only in dev builds — never in production.
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }]),
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Visit 365pinterest.com', click: () => shell.openExternal(APP_URL).catch(() => {}) },
        { label: 'Support — hello@365pinterest.com', click: () => shell.openExternal('mailto:hello@365pinterest.com').catch(() => {}) },
        ...(!isMac ? [{ type: 'separator' }, { label: `About 365 Pinterest (${app.getVersion()})`, click: () => dialog.showMessageBox(mainWindow, { type: 'info', title: '365 Pinterest', message: '365 Pinterest', detail: `Version ${app.getVersion()}\nPinterest automation — schedule pins, manage boards, write AI blogs and auto-pin them.\n\n© 2025 Anjum Labs` }) }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- Auto-update (electron-updater + GitHub Releases) --------------------
// Same pattern as Screen Recorder Pro. Only active in packaged builds,
// and only once the GitHub repo `thisnaeem/365-pinterest-desktop` exists
// with a published release — until then checkForUpdates finds nothing
// and fails silently. A new release must carry a bumped version in
// package.json for an update to be found.
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (_e) { autoUpdater = null; }

function sendUpdateEvent(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-event', payload);
}

function setupAutoUpdate() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => sendUpdateEvent({ type: 'checking' }));
  autoUpdater.on('update-available', (info) => sendUpdateEvent({ type: 'available', version: info && info.version }));
  autoUpdater.on('update-not-available', () => sendUpdateEvent({ type: 'not-available', version: app.getVersion() }));
  autoUpdater.on('download-progress', (p) => sendUpdateEvent({ type: 'progress', percent: Math.round(p && p.percent ? p.percent : 0) }));
  autoUpdater.on('update-downloaded', (info) => sendUpdateEvent({ type: 'downloaded', version: info && info.version }));
  autoUpdater.on('error', (err) => sendUpdateEvent({ type: 'error', message: err && err.message ? String(err.message).slice(0, 200) : 'Update check failed' }));
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 6 * 60 * 60 * 1000);
}

ipcMain.handle('get-app-version', async () => app.getVersion());
ipcMain.handle('check-for-updates', async () => {
  if (!autoUpdater || !app.isPackaged) return { status: 'dev', version: app.getVersion() };
  const result = await autoUpdater.checkForUpdates().catch((e) => ({ error: String(e && e.message ? e.message : e) }));
  return { status: 'checked', version: app.getVersion(), updateInfo: result && result.updateInfo ? result.updateInfo.version : null };
});
ipcMain.handle('download-update', async () => {
  if (!autoUpdater || !app.isPackaged) return { status: 'dev' };
  await autoUpdater.downloadUpdate().catch(() => {});
  return { status: 'downloading' };
});
ipcMain.handle('install-update', async () => {
  if (!autoUpdater) return { status: 'unavailable' };
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { status: 'installing' };
});

// --- Self-test harness (dev only) ----------------------------------------
// Run with:  xvfb-run -a npx electron . --selftest=<scenario>
// Scenarios: probe | persist-set | persist-check
// Results are written to test-output/<scenario>.json (+ screenshots).
// The harness is loaded lazily so production builds carry no test code
// paths that can run without the flag.
async function runSelfTest(scenario) {
  const selftest = require('./scripts/selftest');
  await selftest.run({ scenario, mainWindow, session, app, APP_URL, SESSION_COOKIE, PARTITION });
}

function parseSelfTestArg() {
  const arg = process.argv.find((a) => a.startsWith('--selftest='));
  return arg ? arg.slice('--selftest='.length) : null;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const deepLink = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (deepLink) handleDeepLink(deepLink).catch(() => {});
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    try { app.setAsDefaultProtocolClient(PROTOCOL); } catch (_e) { /* dev runs may not register; packaged builds do */ }
    buildMenu();
    createWindow();
    setupAutoUpdate();

    // Cold start via deep link (e.g. user clicked pinterest365:// while closed).
    const deepLink = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (deepLink) handleDeepLink(deepLink).catch(() => {});

    const scenario = parseSelfTestArg();
    if (scenario) runSelfTest(scenario).catch((e) => { console.error('[selftest] failed:', e); app.quit(); });
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url).catch(() => {});
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}
