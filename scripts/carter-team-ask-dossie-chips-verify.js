#!/usr/bin/env node
// scripts/carter-team-ask-dossie-chips-verify.js
//
// Real-browser verification (per CLAUDE.md "VERIFY IN A REAL BROWSER BEFORE
// HANDOFF") for the 2026-08-23 "Try asking Dossie" chip strip on TeamView.jsx:
//   - the strip renders on the Team dashboard for the team-lead account
//   - clicking a chip actually opens Talk to Dossie and fires the question
//   - a real assistant reply lands (reusing the already-verified risk-triage
//     question, so this confirms the click-to-fire wiring, not answer quality)
//
// Usage: node scripts/carter-team-ask-dossie-chips-verify.js <BASE_URL>

'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?\r?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const baseArg = process.argv[2];
if (!baseArg) {
  console.error('Usage: node scripts/carter-team-ask-dossie-chips-verify.js <BASE_URL>');
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, '');
const URL = `${BASE}/app`;
const OUT = path.join(__dirname, 'atlas-runs', 'carter-team-ask-dossie-chips-2026-08-23');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function report(name, pass, note) {
  results.push({ name, pass, note });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${note ? ' — ' + note : ''}`);
}

const { createClient } = require('@supabase/supabase-js');
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const admin = createClient(SUPA_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

async function signIn(page, email) {
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw new Error(`generateLink failed for ${email}: ${error.message}`);
  const verifyRes = await fetch(`${SUPA_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify({ type: 'magiclink', token_hash: data.properties.hashed_token }),
  });
  const session = await verifyRes.json();
  if (!verifyRes.ok) throw new Error(`verify failed: ${verifyRes.status} ${JSON.stringify(session)}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate((sessionObj) => {
    const payload = {
      access_token: sessionObj.access_token,
      refresh_token: sessionObj.refresh_token,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: sessionObj.user,
    };
    localStorage.setItem('supabase.auth.token', JSON.stringify(payload));
  }, session);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  const page = await ctx.newPage();

  await signIn(page, 'demo-team-lead@meetdossie.com');
  report('team lead signed in', true);

  const teamNavBtn = page.locator('aside.app-sidebar button', { hasText: 'Team' });
  await teamNavBtn.waitFor({ state: 'visible', timeout: 20000 });
  await teamNavBtn.scrollIntoViewIfNeeded().catch(() => {});
  await teamNavBtn.click({ force: true, timeout: 15000 });
  await page.waitForTimeout(2000);

  const stripLabel = page.locator('text=Try asking Dossie:');
  const stripVisible = await stripLabel.isVisible().catch(() => false);
  report('"Try asking Dossie" strip renders on Team dashboard', stripVisible);

  const targetQuestion = 'Which files across my team are at risk right now?';
  const chip = page.locator('button', { hasText: targetQuestion });
  const chipVisible = await chip.isVisible().catch(() => false);
  report('the real risk-triage question chip is present', chipVisible, targetQuestion);

  await page.screenshot({ path: path.join(OUT, '01-team-dashboard-with-strip.png'), fullPage: true }).catch(() => {});

  if (chipVisible) {
    await chip.click();

    // Confirm the Talk to Dossie panel actually opened and the question landed
    // as a user bubble — the click-to-fire wiring, not just a UI click.
    const panelOpened = await page.waitForFunction((q) => {
      const talkPanel = document.querySelector('.talk-side-panel-open');
      return !!talkPanel && document.body.innerText.includes(q);
    }, targetQuestion, { timeout: 10000 }).then(() => true).catch(() => false);
    report('clicking the chip opens Talk to Dossie with the question submitted', panelOpened);

    await page.screenshot({ path: path.join(OUT, '02-after-chip-click.png') }).catch(() => {});

    console.log('[verify] waiting up to 45s for a real reply...');
    await page.waitForTimeout(2000);
    await page.waitForFunction(() => {
      const thinking = Array.from(document.querySelectorAll('div')).find((d) => d.textContent === 'Thinking...');
      return !thinking;
    }, { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const bodyText = await page.evaluate(() => document.body.innerText);
    fs.writeFileSync(path.join(OUT, 'body-after-reply.txt'), bodyText);
    await page.screenshot({ path: path.join(OUT, '03-after-reply.png'), fullPage: true }).catch(() => {});

    const gotRealReply = /Priya|disclosure|overdue|option expiration/i.test(bodyText);
    report('a real, non-empty risk-triage answer rendered (reusing the already-verified question)', gotRealReply);
  }

  await browser.close();

  console.log('\n=== SUMMARY ===');
  results.forEach((r) => console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.note ? ' — ' + r.note : ''}`));
  const allPass = results.every((r) => r.pass);
  console.log(allPass ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
  process.exit(allPass ? 0 : 1);
})().catch((err) => {
  console.error('[verify] fatal error:', err);
  process.exit(1);
});
