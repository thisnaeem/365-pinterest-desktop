'use strict';
/**
 * Self-test harness for the 365 Pinterest desktop app.
 * Dev only — runs when the app is started with --selftest=<scenario>.
 *
 * Scenarios:
 *   probe         — load /sign-in; check the form + buttons; click
 *                   Pinterest (expect redirect to pinterest.com/oauth);
 *                   click Google (record what happens — the live
 *                   endpoint currently 500s, see README); submit the
 *                   email form with wrong credentials (expect a proper
 *                   error, proving the auth path works end-to-end).
 *   persist-set   — plant a marker cookie on 365pinterest.com, quit.
 *   persist-check — read back the marker cookie after a restart.
 *
 * Writes test-output/<scenario>.json + screenshots. Exits the app.
 * Run under xvfb:  xvfb-run -a npx electron . --selftest=probe
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = null; // resolved per-run (packaged apps live in read-only app.asar)

function outDir(app) {
  if (app && app.isPackaged) return path.join(app.getPath('userData'), 'selftest-output');
  return path.join(__dirname, '..', 'test-output');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(predicate, timeoutMs, intervalMs = 500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

function setReactInputValue(el, value) {
  // React tracks input values via its own setter; assign through the
  // native prototype setter and dispatch an input event.
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function shot(wc, name, outDirPath) {
  try {
    const img = await wc.capturePage();
    fs.mkdirSync(outDirPath, { recursive: true });
    fs.writeFileSync(path.join(outDirPath, name), img.toPNG());
    return name;
  } catch (_e) {
    return null;
  }
}

async function run({ scenario, mainWindow, session, app, APP_URL, SESSION_COOKIE }) {
  const OUT_DIR = outDir(app);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const result = { scenario, startedAt: new Date().toISOString(), steps: {} };
  const wc = mainWindow.webContents;

  try {
    if (scenario === 'persist-set') {
      const ses = session.fromPartition('persist:365-pinterest');
      await ses.cookies.set({
        url: APP_URL,
        name: 'desktop-persist-test',
        value: 'persisted-' + Date.now(),
        httpOnly: false,
        secure: true,
        sameSite: 'lax',
        expirationDate: Math.floor(Date.now() / 1000) + 86400,
      });
      const cookies = await ses.cookies.get({ url: APP_URL });
      result.steps.markerSet = cookies.some((c) => c.name === 'desktop-persist-test');
      result.steps.cookiesOnDomain = cookies.map((c) => c.name);
    } else if (scenario === 'persist-check') {
      const ses = session.fromPartition('persist:365-pinterest');
      const cookies = await ses.cookies.get({ url: APP_URL });
      result.steps.markerFound = cookies.some((c) => c.name === 'desktop-persist-test');
      result.steps.cookiesOnDomain = cookies.map((c) => c.name);
      result.steps.sessionCookiePresent = cookies.some((c) => c.name === SESSION_COOKIE);
    } else if (scenario === 'probe') {
      // 1. Load the sign-in page.
      await mainWindow.loadURL(`${APP_URL}/sign-in`).catch(() => {});
      await waitFor(async () => {
        try { return (await wc.executeJavaScript(`document.readyState`, true)) === 'complete'; } catch (_e) { return false; }
      }, 30000);
      await sleep(5000);
      result.steps.signInPage = {
        url: wc.getURL(),
        title: await wc.getTitle(),
      };
      await shot(wc, 'probe-01-signin.png', OUT_DIR);

      const form = await wc.executeJavaScript(`(function () {
        var email = document.querySelector('input[type="email"]');
        var pass = document.querySelector('input[type="password"]');
        var btns = Array.from(document.querySelectorAll('button')).map(function (b) { return (b.innerText || '').trim(); });
        return {
          hasEmailInput: !!email,
          hasPasswordInput: !!pass,
          buttons: btns,
          bodyText: (document.body.innerText || '').slice(0, 600),
        };
      })()`, true);
      result.steps.signInForm = form;

      // 2. Pinterest button -> expect redirect to pinterest.com/oauth.
      // Click up to 3 times: if React has not hydrated yet, an early
      // click lands on a button with no handler attached and does nothing.
      let pinterestClicked = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        pinterestClicked = await wc.executeJavaScript(`(function () {
          var b = Array.from(document.querySelectorAll('button')).find(function (x) { return /pinterest/i.test(x.innerText || ''); });
          if (!b) return false;
          b.click();
          return true;
        })()`, true);
        await sleep(4000);
        if (wc.getURL().includes('pinterest.com/oauth') || !wc.getURL().includes('/sign-in')) break;
      }
      result.steps.pinterestClicked = pinterestClicked;
      const pinterestLanded = await waitFor(async () => {
        const url = wc.getURL();
        return url.includes('pinterest.com/oauth') ? url : null;
      }, 30000);
      await sleep(2500);
      result.steps.pinterestLandedUrl = pinterestLanded || wc.getURL();
      result.steps.pinterestPageTitle = await wc.getTitle();
      await shot(wc, 'probe-02-pinterest-oauth.png', OUT_DIR);

      // 3. Back to sign-in, then Google button -> record what happens.
      try {
      await mainWindow.loadURL(`${APP_URL}/sign-in`).catch(() => {});
      await waitFor(async () => {
        try { return (await wc.executeJavaScript(`document.readyState`, true)) === 'complete'; } catch (_e) { return false; }
      }, 30000);
      await sleep(2000);
      const googleClicked = await wc.executeJavaScript(`(function () {
        var b = Array.from(document.querySelectorAll('button')).find(function (x) { return /google/i.test(x.innerText || ''); });
        if (!b) return false;
        b.click();
        return true;
      })()`, true);
      result.steps.googleClicked = googleClicked;
      await sleep(6000);
      result.steps.googleAfterClick = {
        url: wc.getURL(),
        title: await wc.getTitle(),
        bodySnippet: (await wc.executeJavaScript(`(document.body.innerText || '').slice(0, 400)`, true)) || '',
      };
      await shot(wc, 'probe-03-google.png', OUT_DIR);
      } catch (e) { result.steps.googleError = String((e && e.message) || e); }

      try {
      // 4. Email+password with deliberately wrong credentials.
      await mainWindow.loadURL(`${APP_URL}/sign-in`).catch(() => {});
      await waitFor(async () => {
        try { return (await wc.executeJavaScript(`document.readyState`, true)) === 'complete'; } catch (_e) { return false; }
      }, 30000);
      await sleep(2000);
      const submitted = await wc.executeJavaScript(`(function () {
        var email = document.querySelector('input[type="email"]');
        var pass = document.querySelector('input[type="password"]');
        if (!email || !pass) return false;
        (${setReactInputValue.toString()})(email, 'desktop-test@example.com');
        (${setReactInputValue.toString()})(pass, 'WrongPass123!');
        var form = email.closest('form');
        var submit = form ? form.querySelector('button[type="submit"]') : null;
        if (submit) { submit.click(); return true; }
        return false;
      })()`, true);
      result.steps.wrongCredsSubmitted = submitted;
      await sleep(5000);
      result.steps.wrongCredsResult = {
        url: wc.getURL(),
        bodySnippet: (await wc.executeJavaScript(`(document.body.innerText || '').slice(0, 600)`, true)) || '',
      };
      await shot(wc, 'probe-04-wrong-creds.png', OUT_DIR);
      } catch (e) { result.steps.wrongCredsError = String((e && e.message) || e); }
    } else {
      result.error = `Unknown scenario: ${scenario}`;
    }
  } catch (e) {
    result.error = String((e && e.message) || e);
  }

  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT_DIR, `${scenario}.json`), JSON.stringify(result, null, 2));
  console.log(`[selftest] ${scenario} ->`, JSON.stringify(result, null, 2));
  app.quit();
}

module.exports = { run };
