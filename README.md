# 365 Pinterest — Desktop App

Native desktop client for 365 Pinterest — Pinterest automation: schedule
pins, manage boards, write AI blogs and auto-pin them.

- **Site:** https://365pinterest.com
- **Platforms:** Windows (v2.2.0 — Windows only for now)
- **Version:** 2.2.0 · **Company:** Anjum Labs

## v2.2.0 — a real account login + a professional redesign

v2.1.0 was rejected by Naeem: its email sign-in still minted an API key
behind the scenes, Setup still offered "paste API key", and the UI read as
amateur. v2.2.0 fixes both properly:

1. **Real account login, zero API keys.** Sign in with email + password
   (the same better-auth session as the website) or "Continue with
   Pinterest" (in-window OAuth). The desktop app authenticates its
   `/api/v1` calls with the signed-in session cookie — the server
   accepts session auth on `/api/v1` since the 2026-11-14 deploy
   (`authenticateV1` in `~/workspace/pinterest-365/lib/api-keys.ts`:
   Bearer key OR session cookie, same ownership checks, same 60/min
   budget). No key field, no key option, no key stored, no key mentioned
   on any screen or in any error message. Sign-out ends the session
   server-side, clears the site's cookies and deletes the stored
   identity. No Google button — Google sign-in is still broken
   server-side (no OAuth client; POST `/api/auth/sign-in/social`
   returns 500).
2. **Professional UI redesign.** The website's `/app` dashboard design
   language: Unbounded everywhere, Pinterest red #E60023 as the only
   accent, warm neutrals, light + dark, Hugeicons throughout, real
   spacing scale, polished sidebar (section label, icon chips, New pin
   button), stat cards with icon chips, hover-lift cards, loading
   skeletons, proper empty states, and a split brand/form sign-in
   screen. Auto-update (visible status + banner) and all v2 screens
   and API behaviours are kept.

### Screens

Sign in (email + password or Continue with Pinterest) · Dashboard
(account, counts, 30-day totals, recent pins) · Boards (grid + create) ·
Pins (status/board/search filters, schedule/reschedule/cancel) · New pin
(file upload or image URL, schedule or draft) · Queue (scheduled pins in
publish order) · Analytics (real 30-day Pinterest totals) · Settings
(account, Pinterest accounts, theme, updates).

### API (verified against the web-app source, `~/workspace/pinterest-365/`)

Auth: the signed-in better-auth session cookie (60 requests/minute per
user). Create-pin has an extra 30/minute cap; image uploads cap at 10 MB.

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
has no list-accounts endpoint for sessions (that route needs a browser
session), so the app discovers extra accounts from the `accountId` field
on listed pins and resolves each one via `/api/v1/account?account_id=`.

Honest gaps (the API simply does not offer these): no publish-now and no
pin delete via REST; no board cover images (boards have no image field —
the grid uses initials); analytics are 30-day totals only and Pinterest
data lags a day or two. Writes return 402 when the account is read-only.

### Auth + session storage

The session lives in Electron's default-session cookie jar (main process
only) and persists across restarts for the server's 7-day session life.
The only thing written to disk is the signed-in identity
(`session.json`: `{ email, name }` — display only). No password, no
token, no credential of any kind is stored by this app. On first launch
of v2.2.0+, any `credentials.json` left by v2.1.0 or earlier is deleted.

## Run (dev)

```bash
npm install
npm start            # native UI; sign in with a 365 Pinterest account
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
node_modules patch persists. Output: `dist/365 Pinterest Setup 2.2.0.exe`
(NSIS installer) + `dist/latest.yml` (auto-updater metadata). The
release asset is renamed with hyphens (`365-Pinterest-Setup-2.2.0.exe`)
when it is uploaded to GitHub by hand — never from this box.

The auto-updater still points at the same GitHub repo
(`thisnaeem/365-pinterest-desktop`, release type `release`). Nothing in
this repo publishes automatically — releases are made by hand.

## Self-test

`npm run selftest` launches the real app under Xvfb with
`PINTEREST365_SELFTEST=1` (env-gated code in `main.js`, never runs in
production). It checks:

1. The sign-in screen renders and the page is a local file (not the website) — and that NO API-key field, option or mention exists anywhere in the rendered UI.
2. Live 401s against the real API: bogus email creds (proves the Origin-header fix), plus the session-cookie transport — a bogus session cookie planted in the jar is rejected by the live server *as a session*, and with no cookie the server answers the missing-auth 401 (proves nothing is sent by default).
3. The live `latest.yml` feed (v2.1.0) and every screen (Dashboard, Boards, Pins, New pin, Queue, Analytics, Settings, dark theme) with stubbed API responses and a stubbed email-sign-in → session → dashboard flow, because no real account password exists on this machine — a full live session sign-in is NOT exercised end to end (the user proves it on Windows with a real account).

Screenshots + `selftest.json` land in `test-output/v2.2/`.

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
