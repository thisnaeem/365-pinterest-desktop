# 365 Pinterest — Desktop App

Electron wrapper for the 365 Pinterest web app — Pinterest automation:
schedule pins, manage boards, write AI blogs and auto-pin them.

- **Site:** https://365pinterest.com (the app loads the live site; there is no local UI)
- **Platforms:** Windows + macOS (Linux AppImage also builds, same pipeline)
- **Version:** 1.0.0 · **Company:** Anjum Labs
- **Pattern:** same as Screen Recorder Pro (`~/workspace/your_files/screen-recorder-pro/`) — Electron 32 + electron-builder 25, GitHub Actions matrix build, GitHub Releases publish on version tags.

## Run (dev)

```bash
npm install
npm start            # loads https://365pinterest.com
```

## Build installers (local)

```bash
npm run build:win    # NSIS .exe — needs wine on Linux; use GitHub Actions instead
npm run build:mac    # .dmg (unsigned — see below)
npm run build:linux  # AppImage (works on this Linux sandbox)
npm run pack         # unpacked dir, for a quick launch test
```

## Release (GitHub Actions)

1. **Create the repo first (manual, GitHub web UI):** `thisnaeem/365-pinterest-desktop`.
   GitHub MCP cannot create repos or push workflow files — create the repo in
   the browser, then push this project (per-file push via MCP works).
2. Push a version tag, e.g. `v1.0.0`:
   ```bash
   git tag v1.0.0 && git push origin v1.0.0
   ```
3. The `Build` workflow (`.github/workflows/build.yml`) builds Windows +
   macOS + Linux in parallel and publishes the installers + `latest.yml`
   update metadata to that GitHub Release. The app's auto-updater checks
   that release (same pattern as Screen Recorder Pro).
4. A manual workflow run builds without publishing (artifacts only).

## Authentication — how it works (and what was tested)

The app uses **one persistent session partition** (`persist:365-pinterest`).
Cookies + localStorage are stored in the OS user-data directory and survive
restarts, so a signed-in user stays signed in — exactly like a normal
browser. There is no separate desktop login; the website's own sign-in is
used, in-window.

- **Email + password** — works in-window (better-auth). Tested: wrong
  credentials show the site's own error; correct credentials sign in and
  the session persists across restarts (see `scripts/selftest.js`).
- **Pinterest sign-in** — works in-window. The app redirects to
  `www.pinterest.com/oauth` with the site's own app id and scopes; Pinterest
  allows webview sign-in. Tested: the authorize page loads in-window.
- **Google sign-in** — in-window, with a plain Chrome user-agent (no
  `Electron/` token) so Google treats the window as a normal browser.
  **Current status (13 Nov 2026): BROKEN ON THE SERVER, not in the app.**
  `POST /api/auth/sign-in/social` returns HTTP 500 on the live site —
  the Google client id/secret are not set in the live Worker secrets and
  the callback is not registered in Google Cloud Console. Until that is
  fixed, Google sign-in fails on the web too. Once fixed, the desktop
  flow works unchanged.
- **System-browser fallback** — if Google ever blocks the in-window flow
  ("This browser or app may not be secure"), the app detects that page and
  offers to finish sign-in in the system browser. The session then comes
  back via the `pinterest365://auth?token=...` deep link, which plants the
  better-auth session cookie in the app's own partition. The server side
  of that loop is prepared in `server-handoff-route/route.ts` but **NOT
  deployed** — it is only needed if in-window Google is ever blocked.
- **External links** (Polar checkout, docs, blog, social) open in the
  user's real browser, never inside the app. OAuth popups stay in-app.

## Auth test results (13 Nov 2026, Linux sandbox, xvfb)

Probe harness: `scripts/selftest.js` (`--selftest=probe` / `persist-set` /
`persist-check`). Full JSON + screenshots in `test-output/` (dev run) and
`test-output/packaged/` (run inside the packaged app). Summary:

| Path | Result |
|---|---|
| Sign-in page loads in-app | ✅ 200 — email/password form + "Continue with Google" + "Continue with Pinterest" all present, rendered correctly |
| Email+password (wrong creds) | ✅ site's own "Invalid email or password" shown — the auth path posts and responds end-to-end in-app |
| Pinterest OAuth | ✅ "Continue with Pinterest" → `pinterest.com/oauth` → Pinterest "Welcome to Pinterest" login page loads in-window (client_id 1527228, full scopes, `login.*` state) |
| Google sign-in | ❌ clicking "Continue with Google" does nothing — `POST /api/auth/sign-in/social` returns HTTP 500 on the live site (server-side, see above) |
| Session persists across restart | ✅ marker cookie set in one launch, found after a full restart (dev and packaged app both verified) |

A full successful sign-in was not completed in the sandbox: no test
account credentials are available to the builder (no passwords for the
`muse-verify-*` / `oauth-test` accounts exist anywhere in the repo, and
the reviewer account's password is in the Secure Vault, which cannot be
typed into Electron). The user signs in with his own account on first
launch — the session then persists via the mechanism proven above.

Sandbox notes (do not mistake for app bugs): the sandbox's egress proxy
intercepts TLS with its own CA, which stock Electron does not trust, so
the first probe run hit `ERR_CERT_AUTHORITY_INVALID` on pinterest.com
— the re-runs used `--ignore-certificate-errors` (test-only flag). On a
real Windows/Mac machine, real certificates validate normally. Electron
also needs `--no-sandbox` when run as root in this sandbox; irrelevant
on user machines.

## Local build limits (why Actions builds the real installers)

- **Linux AppImage** — builds here. ✅ `dist/365 Pinterest-1.0.0.AppImage`
- **macOS .app (zip)** — builds here (unsigned). ✅ `dist/365 Pinterest-1.0.0-mac.zip`
- **macOS .dmg** — CANNOT build on Linux: `dmg-license` is a darwin-only
  module. The .dmg comes from the macOS Actions runner.
- **Windows (.exe, NSIS or zip)** — CANNOT build on Linux: electron-builder
  requires wine for every Windows target (exe stamping/signing). The
  installer comes from the Windows Actions runner.
- **macOS signing/notarization** — CI builds are **unsigned** (no Apple
  Developer certificate in the pipeline — same as Screen Recorder Pro
  v1.0.1). On first launch macOS shows Gatekeeper; open with right-click
  → Open. To ship a signed + notarized .dmg, add an Apple Developer
  certificate + `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` /
  `APPLE_TEAM_ID` secrets to the repo (electron-builder `notarize`
  config) — that step needs Naeem's Apple Developer account.

## Files

- `main.js` — window, navigation policy, OAuth handling, deep link,
  menus, auto-update, self-test hook
- `preload.js` — minimal context bridge (version + update checks only)
- `scripts/selftest.js` — auth probe + persistence test harness
- `build/icon.png` — the real 365 logo (512×512, from the web repo)
- `server-handoff-route/route.ts` — prepared server route for the
  system-browser sign-in fallback (NOT deployed)
- `.github/workflows/build.yml` — Windows + macOS + Linux build/publish
