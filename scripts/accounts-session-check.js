#!/usr/bin/env node
'use strict';

// scripts/accounts-session-check.js
//
// Read-only health check for the Accounts browser profile (see
// scripts/_lib/accounts-browser.js). For each known site, opens it HEADLESS
// in the Accounts profile and reports SIGNED IN / SIGNED OUT with the
// evidence used, in a pass/fail table modeled on scripts/preflight-check.js.
//
//   node scripts/accounts-session-check.js
//   node scripts/accounts-session-check.js --json
//
// Never logs a credential, cookie value, token, or any other secret — only
// the final URL (public, non-secret) and a short structural signal (e.g.
// "password field present" / "no login redirect"). This is a PUBLIC repo.
//
// Evidence heuristic (same for every site — no site-specific scraping):
//   1. Navigate to the site's base URL.
//   2. If Playwright's own navigation redirected to a URL that looks like a
//      login/auth page (path or host contains login/signin/sign-in/auth/sso)
//      -> SIGNED OUT, evidence = the redirect URL.
//   3. Else if a visible password <input> is present on the landed page
//      -> SIGNED OUT, evidence = "password input detected on <url>".
//   4. Else -> SIGNED IN (best-effort), evidence = "no login redirect / no
//      password field on <url>".
// This is a heuristic, not a guarantee — some sites show a password field
// on their marketing homepage even when a session cookie is already live
// elsewhere on the domain, and some show a personalized "Welcome back"
// shell without ever landing on a true dashboard URL. Treat FAIL/SIGNED OUT
// as authoritative and SIGNED IN here as "likely" — for anything
// higher-stakes, verify by eye via scripts/accounts-login.js headful.
//
// Opens ONE context for the whole run (not one per site) so only a single
// holder ever has the Accounts profile locked at a time, per the one-holder
// rule in PLAYWRIGHT-SETUP.md.

const { launchAccountsContext } = require('./_lib/accounts-browser');

const SITES = [
  { key: 'rbfcu', label: 'RBFCU', url: 'https://www.rbfcu.org' },
  { key: 'toyota', label: 'Toyota Financial', url: 'https://www.toyotafinancial.com' },
  { key: 'allstate', label: 'Allstate', url: 'https://www.allstate.com' },
  { key: 'usaa', label: 'USAA', url: 'https://www.usaa.com' },
];

const TIMEOUT_MS = 25000;
const JSON_MODE = process.argv.includes('--json');
const LOGIN_URL_RE = /\b(login|signin|sign-in|log-in|auth|sso)\b/i;

async function checkSite(context, site) {
  const page = await context.newPage();
  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    // Give any client-side redirect a brief moment to settle.
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    const finalUrl = page.url();

    if (LOGIN_URL_RE.test(finalUrl)) {
      return { status: 'SIGNED OUT', evidence: `redirected to ${finalUrl}` };
    }

    const hasPasswordField = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
    if (hasPasswordField) {
      return { status: 'SIGNED OUT', evidence: `password input detected on ${finalUrl}` };
    }

    return { status: 'SIGNED IN', evidence: `no login redirect / no password field on ${finalUrl}` };
  } catch (e) {
    return { status: 'ERROR', evidence: e.message.split('\n')[0].slice(0, 160) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const t0 = Date.now();
  let context;
  try {
    context = await launchAccountsContext({ headless: true, reason: 'accounts-session-check' });
  } catch (e) {
    if (JSON_MODE) {
      console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
    } else {
      console.error(`[accounts-session-check] could not launch Accounts profile: ${e.message}`);
    }
    process.exit(1);
  }

  const results = [];
  for (const site of SITES) {
    const r = await checkSite(context, site);
    results.push({ key: site.key, label: site.label, url: site.url, ...r });
  }

  await context.close().catch(() => {});

  const failCount = results.filter((r) => r.status !== 'SIGNED IN').length;

  if (JSON_MODE) {
    console.log(JSON.stringify({ ok: true, elapsedMs: Date.now() - t0, results }, null, 2));
  } else {
    const ICON = { 'SIGNED IN': '✅', 'SIGNED OUT': '⚠️ ', ERROR: '❌' };
    const width = Math.max(...results.map((r) => r.label.length));
    console.log('\nACCOUNTS SESSION CHECK');
    console.log('-'.repeat(width + 70));
    for (const r of results) {
      console.log(`${ICON[r.status] || '? '}  ${r.label.padEnd(width)}  ${r.status.padEnd(11)}  ${r.evidence}`);
    }
    console.log('-'.repeat(width + 70));
    console.log(`${results.length - failCount} signed-in / ${failCount} not  ·  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log('');
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('[accounts-session-check] fatal:', (e && e.stack) || e);
  process.exit(1);
});
