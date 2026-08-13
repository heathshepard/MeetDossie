#!/usr/bin/env node
// scripts/carter-jarvis-balls-verify.js
//
// Real-browser verification for the "Balls in the Air" board (public.jarvis_balls)
// per CLAUDE.md "VERIFY IN A REAL BROWSER BEFORE HANDOFF":
//   - board renders above the TO-DO panel, seeded rows visible, collapsed by default
//   - court flag reads "Your move" (warm) vs "Waiting on X" (cool) correctly
//   - click expands to show status note + timestamps
//   - a conversational-style update (simulating Jarvis: court flips, last_updated
//     resets) is reflected live via realtime without a manual reload
//   - dismiss (delete) removes a row from the UI
//
// Usage: node scripts/carter-jarvis-balls-verify.js <BASE_URL>

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
  console.error('Usage: node scripts/carter-jarvis-balls-verify.js <BASE_URL>');
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, '');
const URL = `${BASE}/myjarvis`;
const EMAIL = 'heath.shepard@kw.com';
const OUT = path.join(__dirname, 'atlas-runs', 'carter-jarvis-balls-2026-08-12');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function report(name, pass, note) {
  results.push({ name, pass, note });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${note ? ' — ' + note : ''}`);
}

async function mintHeathSession() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const { createClient } = require('@supabase/supabase-js');
  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: EMAIL });
  if (error) throw new Error(`generateLink failed: ${error.message}`);
  const hashedToken = data.properties && data.properties.hashed_token;
  const verifyRes = await fetch(`${url}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashedToken }),
  });
  const verifyData = await verifyRes.json();
  if (!verifyRes.ok) throw new Error(`verify failed: ${verifyRes.status} ${JSON.stringify(verifyData)}`);
  return { access_token: verifyData.access_token, refresh_token: verifyData.refresh_token, user: verifyData.user };
}

async function sbRest(pathAndQuery, opts = {}) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
    ...opts,
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return res;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));

  const session = await mintHeathSession();
  const projectRef = process.env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([^.]+)\./)[1];
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate(({ key, sessionObj }) => {
    localStorage.setItem(key, JSON.stringify({
      access_token: sessionObj.access_token, refresh_token: sessionObj.refresh_token,
      token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: sessionObj.user,
    }));
  }, { key: `sb-${projectRef}-auth-token`, sessionObj: session });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => (document.body.innerText || '').includes('MERGE QUEUE'), { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const signedIn = await page.evaluate(() => {
    const gate = document.getElementById('auth-gate');
    return (document.body.innerText || '').includes('MERGE QUEUE') && (!gate || getComputedStyle(gate).display === 'none');
  });
  report('sign-in', signedIn);
  if (!signedIn) { await browser.close(); process.exit(1); }

  // ---------- BOARD RENDERS, POSITIONED ABOVE TO-DO ----------
  await page.waitForSelector('#jarvis-balls-panel', { timeout: 10000 });
  const order = await page.evaluate(() => Array.from(document.querySelectorAll('.dash-primary > .panel')).map((el) => el.id));
  report('balls panel is first in dash-primary (above TO-DO)', order[0] === 'jarvis-balls-panel', `order=${JSON.stringify(order)}`);

  const rowCount = await page.locator('.jb-item').count();
  report('rows render', rowCount > 0, `found ${rowCount} rows`);
  await page.screenshot({ path: path.join(OUT, '01-board-collapsed.png'), fullPage: true });
  await page.locator('#jarvis-balls-panel').screenshot({ path: path.join(OUT, '01b-board-panel-only.png') }).catch(() => {});

  // Collapsed by default
  const anyExpanded = await page.locator('.jb-item-body:not(.hidden)').count();
  report('rows collapsed by default', anyExpanded === 0, `${anyExpanded} expanded`);

  // Court visual correctness (v2, 2026-08-13 court-and-ball redesign):
  // Nopalito should read "Waiting on John Rodriguez" with the ball sitting
  // on the "them" side (sage); a row in Heath's court should read "Your
  // move" with the ball on the "you" side (coral).
  const nopalitoRow = page.locator('.jb-item', { has: page.locator('.jb-name:text("Nopalito")') });
  const nopalitoStatusText = await nopalitoRow.locator('.jb-court-status').innerText();
  const nopalitoBallClass = await nopalitoRow.locator('.jb-ball').getAttribute('class');
  report('Nopalito reads "Waiting on John Rodriguez", ball on their side',
    /Waiting on John Rodriguez/i.test(nopalitoStatusText) && nopalitoBallClass.includes('at-them'),
    `text="${nopalitoStatusText}" ballClass="${nopalitoBallClass}"`);

  const yourMoveRow = page.locator('.jb-item', { has: page.locator('.jb-court-status:text("Your move")') }).first();
  const ymStatusText = await yourMoveRow.locator('.jb-court-status').innerText();
  const ymBallClass = await yourMoveRow.locator('.jb-ball').getAttribute('class');
  report('A "your move" row shows the ball on the you side, warm color',
    /Your move/i.test(ymStatusText) && ymBallClass.includes('at-you'),
    `text="${ymStatusText}" ballClass="${ymBallClass}"`);

  // ---------- EXPAND ----------
  await nopalitoRow.locator('.jb-item-head').click();
  await page.waitForTimeout(400);
  const expanded = await nopalitoRow.locator('.jb-item-body').evaluate((el) => !el.classList.contains('hidden'));
  const detailText = await nopalitoRow.locator('.jb-status-note').innerText();
  report('click expands to show status note', expanded && /Crockett/i.test(detailText), `detail="${detailText}"`);
  await page.screenshot({ path: path.join(OUT, '02-nopalito-expanded.png'), fullPage: true });
  await nopalitoRow.locator('.jb-item-head').click(); // collapse back
  await page.waitForTimeout(300);

  // ---------- CONVERSATIONAL UPDATE SIMULATION ----------
  // Simulates what Jarvis does when Heath says "I sent that to John" — updates
  // court + status_note directly via the DB (same generic Supabase write path
  // the jarvis-bridge MCP session will use). last_updated should auto-reset
  // via the BEFORE UPDATE trigger, and the UI should reflect it live via
  // realtime, no manual reload.
  const { data: rows } = await (await sbRest(`jarvis_balls?name=ilike.*Nopalito*&select=id`)).json().then((d) => ({ data: d }));
  const nopalitoId = rows[0].id;
  const updRes = await sbRest(`jarvis_balls?id=eq.${nopalitoId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ court: 'you', status_note: 'John confirmed the closing date — now deciding the 1% split.' }),
  });
  const updData = await updRes.json();
  console.log('[verify] conversational-style update applied:', updRes.status, JSON.stringify(updData[0]));

  let flipped = false;
  for (let i = 0; i < 25; i++) {
    const statusNow = await nopalitoRow.locator('.jb-court-status').innerText().catch(() => '');
    if (/Your move/i.test(statusNow)) { flipped = true; break; }
    await page.waitForTimeout(1000);
  }
  const ballClassNow = await nopalitoRow.locator('.jb-ball').getAttribute('class').catch(() => '');
  report('court flip (Jarvis-style update) reflects live in UI', flipped && ballClassNow.includes('at-you'), `ballClass="${ballClassNow}"`);
  const elapsedNow = await nopalitoRow.locator('.jb-elapsed').innerText().catch(() => '');
  report('elapsed timer reset after update', /^0m$/.test(elapsedNow.trim()) || /^\dm$/.test(elapsedNow.trim()), `elapsed="${elapsedNow}"`);
  await page.screenshot({ path: path.join(OUT, '03-after-conversational-update.png'), fullPage: true });

  // ---------- DISMISS ----------
  await nopalitoRow.locator('.jb-del-btn').click();
  await page.waitForTimeout(2000);
  const stillThere = await page.locator('.jb-item', { has: page.locator('.jb-name:text("Nopalito")') }).count();
  report('dismiss removes row from UI', stillThere === 0);

  // Restore Nopalito to its original seeded state for Heath (dismiss above deleted it for real).
  await sbRest('jarvis_balls', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      name: "Nopalito — John's 1%", business_tag: 'brokerage', court: 'John Rodriguez',
      status_note: "Waiting on his answer re: Dr. Crockett's closing timeline (affects the Whytes' 1% commission decision)",
    }),
  });
  console.log('[verify] restored Nopalito row to original seeded state');

  await browser.close();

  const overall = results.every((r) => r.pass);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, pageErrors, overall }, null, 2));
  console.log('\n========== SUMMARY ==========');
  results.forEach((r) => console.log(`${r.pass ? 'PASS' : 'FAIL'} — ${r.name}${r.note ? ' :: ' + r.note : ''}`));
  console.log(`Page errors: ${pageErrors.length}`);
  pageErrors.forEach((e) => console.log('  ' + e));
  console.log(`OVERALL: ${overall ? 'PASS' : 'FAIL'}`);
  process.exit(overall ? 0 : 1);
})().catch((e) => {
  console.error('[verify] CRASH', e.stack || e);
  process.exit(1);
});
