# 365 Pinterest — Desktop App

Native desktop client for 365 Pinterest — Pinterest automation: schedule
pins, manage boards, write AI blogs and auto-pin them.

- **Site:** https://365pinterest.com
- **Platforms:** Windows (v2.0.0 — Windows only for now)
- **Version:** 2.0.0 · **Company:** Anjum Labs

## v2.0.0 — a real native app, not a website wrapper

v1.0.0 loaded https://365pinterest.com inside an Electron window. v2.0.0
replaces that with its own local interface (`renderer/`) and talks to the
365 Pinterest REST API (`https://365pinterest.com/api/v1/...`) with the
user's API key. Nothing in the app is a web page; the website is only ever
opened in the user's real browser for sign-up, billing and docs.

### Screens

Setup (paste API key, validate) · Dashboard (account, counts, 30-day
totals, recent pins) · Boards (grid + create) · Pins (status/board/search
filters, schedule/reschedule/cancel) · New pin (file upload or image URL,
schedule or draft) · Queue (scheduled pins in publish order) · Analytics
(real 30-day Pinterest totals) · Settings (key, accounts, theme, updates).

### API (verified against the web-app source, `~/workspace/pinterest-365/`)

Auth: `Authorization: Bearer pk_live_…`, 60 requests/minute per key.
Create-pin has an extra 30/minute cap; image uploads cap at 10 MB.

- `GET /api/v1/account` — connection status, username, board count
- `GET /api/v1/boards` · `POST /api/v1/boards` — list / create boards
- `GET /api/v1/pins` — list (status, board, limit filters)
- `POST /api/v1/pins` — JSON with an image URL, or multipart with a `file`
  (JPEG/PNG/WebP ≤ 10 MB — the server uploads it to Cloudinary; no
  Cloudinary keys live in this app). A future `scheduledFor` makes the pin
  SCHEDULED (the server's 5-minute cron publishes it); otherwise DRAFT.
  Creation never publishes directly.
- `POST /api/v1/pins/{id}/schedule` · `POST /api/v1/pins/{id}/cancel`
- `GET /api/v1/queue` — scheduled pins in publish order
- `GET /api/v1/analytics` — last-30-day totals (impressions, saves,
  clicks, outbound clicks)

`account_id` works on every endpoint for multi-account use. The REST API
has no list-accounts endpoint for API keys (that route needs a browser
session), so the app discovers extra accounts from the `accountId` field
on listed pins and resolves each one via `/api/v1/account?account_id=`.

Honest gaps (the API simply does not offer these): no publish-now and no
pin delete via REST; no board cover images (boards have no image field —
the grid uses initials); analytics are 30-day totals only and Pinterest
data lags a day or two. Writes return 402 when the account is read-only.

### Auth + key storage

The API key lives in the main process only and is stored with Electron
`safeStorage` (DPAPI on Windows) in the app's userData directory. The
renderer never sees the key and it is never logged. The v1 deep link
(`pinterest365://`) is gone — API-key auth makes it unnecessary.

## Run (dev)

```bash
npm install
npm start            # native UI; needs an API key from 365pinterest.com
npm run selftest     # UI self-test under xvfb (see below)
```

## Build the Windows installer (local)

```bash
PATH=/tmp/wine-shim:$PATH npm run build:win -- --publish never
```

Windows builds need wine on this Linux box: wine64 + wine32 are installed
with workarounds (libzstd downgrade, `/tmp/wine-shim` with `wine`/`wine64`
shims exec'ing `/usr/lib/wine/wine64`, rcedit-ia32.exe swapped for x64 in
`~/.cache/electron-builder`, `node_modules/app-builder-lib` NsisTarget.js
patched to use the pure-JS UninstallerReader first). Wine and the shim
live outside `~`, so a VM restart means reinstalling them; the
node_modules patch persists. Output: `dist/365-Pinterest-Setup-2.0.0.exe`
(NSIS installer) + `dist/latest.yml` (auto-updater metadata).

The auto-updater still points at the same GitHub repo
(`thisnaeem/365-pinterest-desktop`, release type `release`). Nothing in
this repo publishes automatically — releases are made by hand.

## Self-test

`npm run selftest` launches the real app under Xvfb with
`PINTEREST365_SELFTEST=1` (env-gated code in `main.js`, never runs in
production). It checks:

1. The Setup screen renders and the page is a local file (not the website).
2. A fake API key against the LIVE API returns 401 — proving the client
   reaches the real endpoint and handles auth failure.
3. Every screen (Dashboard, Boards, Pins, New pin, Queue, Analytics,
   Settings, dark theme) renders with stubbed API responses, because no
   real API key exists on this machine — authenticated calls against the
   live server are NOT exercised end to end.

Screenshots + `selftest.json` land in `test-output/v2/`.

## Files

- `main.js` — window, menus, auto-update, API client, key storage (safeStorage), IPC, self-test hook
- `preload.js` — narrow context bridge (API calls go through main; the renderer never sees the key)
- `renderer/` — the native UI: `index.html`, `styles.css`, `app.js`, `icon.png`, `fonts/` (Unbounded, bundled)
- `scripts/selftest.js` — self-test launcher
- `build/icon.png` — the real 365 logo (512×512)

## v1.0.0 (retired wrapper — do not revive)

v1 loaded the website in an Electron window with a persistent session
partition. It is superseded by v2.0.0. The v1.0.0 GitHub release stays
published as-is; v2 ships as a new 2.0.0 release when Naeem says so.
