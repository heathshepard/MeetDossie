#!/usr/bin/env node
/**
 * Signed-in verification of the one-day date shift, on a real dossier.
 * READ-ONLY: signs in, opens a dossier, reads what is rendered. Writes nothing.
 *
 *   node scripts/carter-verify-dates-signedin.js <preview-url>
 *
 * The audit measured the bug on 205 Kendall Falls: the deal field showed
 * "CLOSING DATE 9/19/2025" (formatDisplayDate — always correct) while the TREC
 * deadline panel showed "September 18, 2025" (formatDateLong — UTC-parsed, then
 * rendered local, so one day early). This asserts they now agree ON SCREEN.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || '').replace(/\/$/, '');
if (!BASE) { console.error('Usage: node scripts/carter-verify-dates-signedin.js <preview-url>'); process.exit(1); }

function loadEnv() {
  const raw = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').replace(/^﻿/, '');
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return env;
}
const env = loadEnv();
const OUT = path.join(__dirname, '..', '.tmp', 'carter-verify');
fs.mkdirSync(OUT, { recursive: true });

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const results = [];
const check = (n, p, d) => { results.push({ n, p: !!p }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n        ${d}` : ''}`); };

(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();

  try {
    // ---- login screen: wait for it to actually RENDER, not a fixed sleep ----
    await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => /Welcome back to Dossie/i.test(document.body.innerText),
      { timeout: 60000 },
    );
    const loginText = await page.innerText('body');
    fs.writeFileSync(path.join(OUT, 'login.txt'), loginText);
    check('login screen shows a way to create an account',
      /New to Dossie/i.test(loginText) && /Create an account/i.test(loginText),
      loginText.replace(/\s+/g, ' ').slice(0, 220));

    const href = await page.locator('a[href="/signup"]').first().getAttribute('href').catch(() => null);
    check('the account link points at /signup', href === '/signup', `href=${href}`);

    // ---- sign in for real ----
    // AuthGate renders email + password fields directly — there is no
    // Magic Link / Password tab pair (that is the unreachable dossie-app.jsx
    // screen). Fill both and submit.
    await page.fill('input[type="email"]', 'demo@meetdossie.com');
    await page.fill('input[type="password"]', env.DEMO_PASSWORD);
    await page.locator('button', { hasText: /^Sign In$/i }).first().click();

    await page.waitForFunction(
      () => !/Welcome back to Dossie/i.test(document.body.innerText),
      { timeout: 90000 },
    );
    // Wait for the pipeline to actually have content.
    await page.waitForFunction(
      () => /Kendall Falls/i.test(document.body.innerText),
      { timeout: 90000 },
    );
    check('signed in and pipeline loaded', true);

    // ---- open the dossier and wait for the deadline panel ----
    // The app lands on the Morning Brief, and "205 KENDALL FALLS" also appears
    // inside the Dossie Asks paragraph there (not clickable). Go to Pipeline
    // first, then click the actual card heading.
    await page.locator('text=Pipeline').first().click();
    await page.waitForFunction(
      () => /Kendall Falls/i.test(document.body.innerText),
      { timeout: 60000 },
    );
    const card = page.getByText(/^205 Kendall Falls$/i).first();
    await card.scrollIntoViewIfNeeded();
    await card.click({ timeout: 30000 });
    await page.waitForFunction(
      () => /¶|Paragraph|TREC deadlines/i.test(document.body.innerText),
      { timeout: 90000 },
    );
    const detail = await page.innerText('body');
    fs.writeFileSync(path.join(OUT, 'dossier-detail.txt'), detail);
    check('dossier detail rendered with TREC paragraph citations',
      /¶/.test(detail), `citations found: ${(detail.match(/¶\s*\w+/g) || []).slice(0, 6).join(', ')}`);

    // ---- the actual assertion ----
    const slash = new Set(
      [...detail.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)].map((m) => `${+m[1]}/${+m[2]}/${m[3]}`),
    );
    const long = [...detail.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/gi)]
      .map((m) => ({ raw: m[0], key: `${MONTHS.indexOf(m[1].toLowerCase()) + 1}/${+m[2]}/${m[3]}` }));

    console.log(`\n        slash-format dates on screen : ${[...slash].join(', ') || '(none)'}`);
    console.log(`        long-format dates on screen  : ${long.map((l) => l.raw).join(', ') || '(none)'}\n`);

    // Off-by-one signature: a long date whose NEXT day appears as a slash date,
    // while the long date itself does not.
    const offByOne = long.filter((l) => {
      const [m, d, y] = l.key.split('/').map(Number);
      const nx = new Date(Date.UTC(y, m - 1, d + 1));
      return slash.has(`${nx.getUTCMonth() + 1}/${nx.getUTCDate()}/${nx.getUTCFullYear()}`) && !slash.has(l.key);
    });
    check('no long-form date sits one day behind a slash date on the same screen',
      offByOne.length === 0,
      offByOne.length ? `off by one: ${offByOne.map((o) => o.raw).join(', ')}` : 'none');

    const agreeing = long.filter((l) => slash.has(l.key));
    check('at least one long-form date exactly matches a slash date (surfaces agree)',
      agreeing.length > 0,
      agreeing.map((a) => a.raw).join(', ') || 'no co-rendered pair to compare');

  } catch (err) {
    check('script completed', false, err.message.split('\n')[0]);
    try { fs.writeFileSync(path.join(OUT, 'error-body.txt'), await page.innerText('body')); } catch {}
  } finally {
    await browser.close();
  }

  const bad = results.filter((r) => !r.p).length;
  console.log(`\n${results.length - bad}/${results.length} checks passed. Artifacts: ${OUT}`);
  process.exit(bad ? 1 : 0);
})();
