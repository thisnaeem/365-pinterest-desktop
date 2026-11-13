'use strict';
/**
 * 365 Pinterest — v2.1 self-test launcher.
 *
 * Runs the real app under Xvfb with PINTEREST365_SELFTEST=1. The test
 * itself lives in main.js (env-gated, never runs in production): it checks
 * the Setup screen (Hugeicons + email sign-in form), the Pinterest auth
 * window opening, live 401s against the real API (bogus email creds + fake
 * key), the live latest.yml feed, the stubbed email-sign-in -> key-mint ->
 * dashboard flow, every screen with stubbed API responses, and the update
 * banner states. Screenshots + a JSON summary land in test-output/v2.1/.
 *
 * Usage: npm run selftest   (or: node scripts/selftest.js)
 * Note: this machine runs as root, so Electron needs --no-sandbox here —
 * BOTH for the launcher itself (package.json selftest script passes
 * --no-sandbox to `electron scripts/selftest.js`) and for the app under
 * test (the spawn below). Without it the launcher dies at startup with
 * "Running as root without --no-sandbox" before it can spawn anything.
 * It also needs --ignore-certificate-errors: the sandbox's egress proxy
 * intercepts TLS with its own CA, which stock Electron does not trust.
 * Test-only flag — on a real Windows/Mac machine real certificates
 * validate normally (same note as the v1 probe).
 */
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const electronBin = path.join(root, 'node_modules', '.bin', 'electron');

const env = {
  ...process.env,
  PINTEREST365_SELFTEST: '1',
  ELECTRON_DISABLE_SANDBOX: '1',
};

const result = spawnSync(
  'xvfb-run',
  ['-a', electronBin, '--no-sandbox', '--ignore-certificate-errors', root],
  { env, cwd: root, stdio: 'inherit', timeout: 180000 }
);

if (result.error) {
  // eslint-disable-next-line no-console
  console.error('[selftest] launcher failed:', result.error.message);
  process.exit(1);
}
process.exit(result.status || 0);
