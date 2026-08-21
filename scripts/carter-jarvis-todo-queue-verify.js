#!/usr/bin/env node
// scripts/carter-jarvis-todo-queue-verify.js
//
// Real-browser verification (per CLAUDE.md "VERIFY IN A REAL BROWSER BEFORE
// HANDOFF") for the 2026-08-21 heath_todo "Agent Queue" card fix:
//   - /api/heath-todo-next now returns the full ready backlog (items[]) +
//     a real queue_count, instead of a single task with undefined count.
//   - the WORK ITEMS > Agent Queue card renders one .todo-card per item.
//
// Usage: node scripts/carter-jarvis-todo-queue-verify.js <BASE_URL>

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
  console.error('Usage: node scripts/carter-jarvis-todo-queue-verify.js <BASE_URL>');
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, '');
const URL = `${BASE}/myjarvis`;
const EMAIL = 'heath.shepard@kw.com';
const OUT = path.join(__dirname, 'atlas-runs', 'carter-jarvis-todo-queue-2026-08-21');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function report(name, pass, note) {
  results.push({ name, pass, note });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${note ? ' — ' + note : ''}`);
}

// Same pattern as scripts/carter-jarvis-todo-panels-verify.js — mints a real
// Supabase session for heath.shepard@kw.com via the service-role admin API
// (magic-link generate + redeem). Real auth token, not a bypass.
async function mintHeathSession() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const { createClient } = require('@supabase/supabase-js');
  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: EMAIL });
  if (error) throw new Error(`generateLink failed: ${error.message}`);
  const hashedToken = data.properties && data.properties.hashed_token;
  if (!hashedToken) throw new Error('generateLink returned no hashed_token');
  const verifyRes = await fetch(`${url}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashedToken }),
  });
  const verifyData = await verifyRes.json();
  if (!verifyRes.ok) throw new Error(`verify failed: ${verifyRes.status} ${JSON.stringify(verifyData)}`);
  return { access_token: verifyData.access_token, refresh_token: verifyData.refresh_token, user: verifyData.user };
}

async function signIn(page) {
  const session = await mintHeathSession();
  const projectRef = process.env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([^.]+)\./)[1];
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate(({ key, sessionObj }) => {
    const payload = {
      access_token: sessionObj.access_token,
      refresh_token: sessionObj.refresh_token,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: sessionObj.user,
    };
    localStorage.setItem(key, JSON.stringify(payload));
  }, { key: `sb-${projectRef}-auth-token`, sessionObj: session });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => {
    const t = document.body.innerText || '';
    return t.includes('MERGE QUEUE') && !document.querySelector('input[type="password"]');
  }, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  return page.evaluate(() => {
    const gate = document.getElementById('auth-gate');
    const gateHidden = !gate || window.getComputedStyle(gate).display === 'none';
    return (document.body.innerText || '').includes('MERGE QUEUE') && gateHidden;
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 2400 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));

  console.log(`[verify] navigating ${URL}`);
  const signedIn = await signIn(page);
  report('sign-in as heath.shepard@kw.com', signedIn);
  if (!signedIn) {
    await page.screenshot({ path: path.join(OUT, '00-signin-fail.png'), fullPage: true });
    await browser.close();
    process.exit(1);
  }

  // Give the Agent Queue card's own loadTodo() fetch time to resolve.
  await page.waitForSelector('#todo-body', { timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => {
    const body = document.getElementById('todo-body');
    return body && !body.textContent.includes('Loading');
  }, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);

  // Scroll the Agent Queue subsection into view for the screenshot.
  await page.locator('#todo-body').scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: path.join(OUT, '01-agent-queue-card.png') }).catch(() => {});

  const cardCount = await page.locator('#todo-body .todo-card').count();
  report('Agent Queue card renders more than one .todo-card', cardCount > 1, `rendered ${cardCount} cards`);

  const metaText = (await page.locator('#todo-meta').innerText().catch(() => '')).trim();
  const metaMatch = metaText.match(/(\d+)\s*queued/i);
  const metaCount = metaMatch ? Number(metaMatch[1]) : null;
  report('queue_count label is populated (not blank)', !!metaText && metaText !== '—', `meta="${metaText}"`);
  report('queue_count matches rendered card count', metaCount === cardCount, `meta count=${metaCount}, rendered cards=${cardCount}`);

  // Confirm at least one of the freshly-seeded rust/decision items is visible
  // by title text, proving this is real DB data, not a stale/cached render.
  const bodyText = await page.locator('#todo-body').innerText().catch(() => '');
  const seededTitleFound = bodyText.includes('virtual mailbox') || bodyText.includes('Google Play') || bodyText.includes('scrub home address');
  report('at least one freshly-seeded heath_todo row visible in the list', seededTitleFound, `body snippet: ${bodyText.slice(0, 300).replace(/\n/g, ' | ')}`);

  await page.screenshot({ path: path.join(OUT, '02-final-fullpage.png'), fullPage: true }).catch(() => {});
  await browser.close();

  const overall = results.every((r) => r.pass);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, pageErrors, overall }, null, 2));
  console.log('\n========== SUMMARY ==========');
  results.forEach((r) => console.log(`${r.pass ? 'PASS' : 'FAIL'} — ${r.name}${r.note ? ' :: ' + r.note : ''}`));
  console.log(`Page errors: ${pageErrors.length}`);
  pageErrors.forEach((e) => console.log('  ' + e));
  console.log(`OVERALL: ${overall ? 'PASS' : 'FAIL'}`);
  console.log(`Screenshots: ${OUT}`);
  process.exit(overall ? 0 : 1);
})().catch((e) => {
  console.error('[verify] CRASH', e.stack || e);
  process.exit(1);
});
