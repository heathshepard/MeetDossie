'use strict';

// scripts/brokerage-mls-keepalive.js
//
// Scheduled-task keep-alive for connectMLS (SABOR/LERA). Opens the shared
// ~/.brokerage-browser-profile headless, navigates to home.jsp, and calls
// ensureSignedIn() from scripts/_lib/connectmls-actions.js. If the
// SmartBar is already up (cookie still trusted), this is a cheap no-op
// that just refreshes the session's last-active timestamp server-side.
// If the app session expired but the IdP-level trusted-device cookie is
// still good, ensureSignedIn() silently completes the SSO refresh with no
// human interaction. If the trusted-device cookie itself has expired,
// ensureSignedIn() throws a clear, actionable error (it does NOT hang and
// does NOT attempt the passkey/WebAuthn flow, which needs Heath's phone) —
// that failure is exactly the signal this task exists to produce early,
// instead of Heath discovering a dead session mid-workday.
//
// Rebuilt 2026-10-02: the previous copy of this file was never committed
// to git (confirmed via `git log --all --diff-filter=A -- scripts/brokerage-
// mls-keepalive.js`, zero hits on any branch) despite a 2026-09-16 commit
// message claiming it was "already-tracked" — it only ever lived on local
// disk and was lost at some point after that, leaving the scheduled task
// (Windows Task Scheduler "Dossie-MLS-KeepAlive", runs every 8h via
// scripts/brokerage-mls-keepalive.cmd) throwing MODULE_NOT_FOUND on every
// run with no alarm, silently, since at least 2026-09-16. See
// scripts/atlas-runs/mls-keepalive.log for the failure history.
//
// Usage:
//   node scripts/brokerage-mls-keepalive.js [--quiet]
//
// Exit codes: 0 = session confirmed alive (or silently refreshed).
//             1 = genuinely expired, needs a human passkey tap
//                 (run a headed login flow, e.g. the pattern in
//                 scripts/_lib/brokerage-browser.js's module header).
//             2 = unexpected error (network, Playwright, etc).

const path = require('path');
const { launchBrokerageContext } = require('./_lib/brokerage-browser');
const { ensureSignedIn } = require('./_lib/connectmls-actions');

const QUIET = process.argv.includes('--quiet');
const log = (...args) => { if (!QUIET) console.log(...args); };

const HOME_URL = 'https://lera.connectmls.com/mls/home/home.jsp';

(async () => {
  const startedAt = new Date().toISOString();
  log(`[mls-keepalive] ${startedAt} starting (reason: scheduled-keepalive)`);

  let context;
  try {
    context = await launchBrokerageContext({ headless: true, reason: 'mls-keepalive' });
    const page = await context.newPage();

    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await ensureSignedIn(page, context, 25000);

    log(`[mls-keepalive] ${new Date().toISOString()} OK — session alive at ${page.url()}`);
    await context.close();
    process.exit(0);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error(`[mls-keepalive] ${new Date().toISOString()} FAILED — ${msg}`);
    try { if (context) await context.close(); } catch {}

    // Distinguish "needs a human passkey tap" from a generic error so a
    // monitor/alert can treat them differently later.
    if (/fully expired|passkey|WebAuthn|re-auth/i.test(msg)) {
      process.exit(1);
    }
    process.exit(2);
  }
})();
