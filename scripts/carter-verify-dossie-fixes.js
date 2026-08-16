#!/usr/bin/env node
/**
 * Real-browser verification of the fixes in this branch, as a signed-in user.
 * Per CLAUDE.md section 17: a 200 is not verification.
 *
 *   node scripts/carter-verify-dossie-fixes.js <preview-url>
 *
 * READ-ONLY. This script signs in, reads what is rendered, and asserts.
 * It never submits the signup form, never clicks send/merge/sign, and never
 * writes to the database. The only form interaction is typing an invalid invite
 * code to confirm it is REJECTED (which creates nothing).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || '').replace(/\/$/, '');
if (!BASE) {
  console.error('Usage: node scripts/carter-verify-dossie-fixes.js <preview-url>');
  process.exit(1);
}

function loadEnv() {
  const p = path.join(__dirname, '..', '.env.local');
  const raw = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return env;
}
const env = loadEnv();

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

const SHOT_DIR = path.join(__dirname, '..', '.tmp', 'carter-verify');
fs.mkdirSync(SHOT_DIR, { recursive: true });

// Screenshots are evidence, not assertions. A capture failure on a very tall
// animated page must never fail the run or mask a real result.
async function shot(page, name) {
  try {
    await page.screenshot({ path: path.join(SHOT_DIR, name), animations: 'disabled', timeout: 15000 });
  } catch (err) {
    console.log(`        (screenshot ${name} skipped: ${err.message.split('\n')[0]})`);
  }
}

(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });

  // Service workers have served stale bundles here before; kill that variable.
  await context.addInitScript(() => {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.getRegistrations?.().then((rs) => rs.forEach((r) => r.unregister()));
    }
  });

  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  try {
    // ---------------------------------------------------------------------
    // 1. /signup renders as a real page
    // ---------------------------------------------------------------------
    await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const signupBody = await page.innerText('body');
    check('/signup renders (was 404)',
      /Create my account/i.test(signupBody),
      `title="${await page.title()}"`);
    check('/signup offers the invite-code path',
      /invite code/i.test(signupBody));
    check('/signup offers a request-access path for people without a code',
      /request access/i.test(signupBody));
    await shot(page, '01-signup.png');

    // ?code= prefill — so Heath can hand out one link
    await page.goto(`${BASE}/signup?code=PREFILL-CHECK`, { waitUntil: 'domcontentloaded' });
    const prefilled = await page.inputValue('#access_code');
    check('/signup?code= prefills the invite field', prefilled === 'PREFILL-CHECK', `got "${prefilled}"`);

    // ---------------------------------------------------------------------
    // 2. /founding no longer dead-ends at the login screen
    // ---------------------------------------------------------------------
    await page.goto(`${BASE}/founding`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    check('/founding now lands on signup (was a 308 loop back to login)',
      /\/signup/.test(page.url()) && /Create my account/i.test(await page.innerText('body')),
      `final url = ${page.url()}`);

    // ---------------------------------------------------------------------
    // 3. Invalid invite code is REJECTED (creates nothing)
    // ---------------------------------------------------------------------
    await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
    await page.fill('#access_code', 'DEFINITELY-NOT-A-REAL-CODE');
    await page.fill('#name', 'Verification Bot');
    // Unroutable reserved domain — cannot reach a real person even if something
    // slipped through and tried to email it.
    await page.fill('#email', 'carter-verify@example.invalid');
    await page.fill('#phone', '2100000000');
    await page.fill('#city', 'San Antonio');
    await page.click('#submit-btn');
    await page.waitForTimeout(6000);
    const afterBad = await page.innerText('body');
    check('invalid invite code is rejected, no account created',
      /isn't valid|is not valid|Too many attempts/i.test(afterBad),
      afterBad.replace(/\s+/g, ' ').slice(0, 160));
    await shot(page, '02-bad-code.png');

    // ---------------------------------------------------------------------
    // 4. Login screen now offers a way to sign up
    // ---------------------------------------------------------------------
    await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    const loginBody = await page.innerText('body');
    check('login screen offers account creation (it offered nothing before)',
      /create an account/i.test(loginBody) && /new to dossie/i.test(loginBody));
    await shot(page, '03-login.png');

    // ---------------------------------------------------------------------
    // 5. Sign in for real and check the DATE FIX on screen
    // ---------------------------------------------------------------------
    const demoPw = env.DEMO_PASSWORD;
    if (!demoPw) {
      check('signed-in date verification', false, 'DEMO_PASSWORD not in .env.local — cannot sign in');
    } else {
      const pwTab = page.locator('button', { hasText: /^Password$/ });
      if (await pwTab.count()) await pwTab.first().click();
      await page.waitForTimeout(500);
      await page.fill('input[type="email"]', 'demo@meetdossie.com');
      await page.fill('input[type="password"]', demoPw);
      await page.locator('button', { hasText: /^Sign In$/ }).first().click();

      await page.waitForTimeout(15000);
      const shell = await page.innerText('body');
      const signedIn = !/Welcome back to Dossie/i.test(shell);
      check('signed in as demo@meetdossie.com', signedIn,
        signedIn ? '' : shell.replace(/\s+/g, ' ').slice(0, 200));
      await shot(page, '04-signed-in.png');

      // The dossier-level date assertions live in
      // scripts/carter-verify-dates-signedin.js, which navigates via Pipeline
      // and waits on the deadline panel. Duplicating a weaker version of that
      // check here only produced a flaky failure.
    }

    // ---------------------------------------------------------------------
    // 6. No new console errors
    // ---------------------------------------------------------------------
    const realErrors = consoleErrors.filter((e) =>
      !/favicon|manifest|posthog|Failed to load resource: the server responded with a status of 4/i.test(e));
    check('no unexpected console errors', realErrors.length === 0,
      realErrors.slice(0, 3).join(' | '));

  } catch (err) {
    check('script completed without throwing', false, err.message);
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  console.log(`Artifacts: ${SHOT_DIR}`);
  process.exit(failed.length ? 1 : 0);
})();
