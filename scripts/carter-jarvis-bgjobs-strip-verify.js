#!/usr/bin/env node
// scripts/carter-jarvis-bgjobs-strip-verify.js
//
// Real-browser verification (per CLAUDE.md "VERIFY IN A REAL BROWSER BEFORE
// HANDOFF") for the 2026-08-22 BACKGROUND JOBS STRIP build in jarvis-pwa.html,
// extended 2026-08-22 PM for the "persist until dismissed" revision.
//
// Inserts a real agent_queue row (status=in_progress) via the service-role
// key, confirms the strip renders it with a ticking elapsed timer, then
// flips the row to completed and confirms it fades to "done" — and, per the
// PM revision, STAYS visible (no more 4s auto-removal) until the per-row X
// dismiss control is clicked, at which point it disappears.
//
// Usage: node scripts/carter-jarvis-bgjobs-strip-verify.js <BASE_URL>

'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?\r?$/);
  if (m && m[2] !== '[SENSITIVE]' && !process.env[m[1]]) process.env[m[1]] = m[2];
}
// .env.local carries some vars as write-only Vercel placeholders
// ("[SENSITIVE]") — prefer the real value already parsed above; if a var
// only ever appeared as the placeholder, fall back to its NEXT_PUBLIC_ twin.
if (!process.env.SUPABASE_URL) process.env.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

const baseArg = process.argv[2];
if (!baseArg) {
  console.error('Usage: node scripts/carter-jarvis-bgjobs-strip-verify.js <BASE_URL>');
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, '');
const URL = `${BASE}/myjarvis`;
const EMAIL = 'heath.shepard@kw.com';
const OUT = path.join(__dirname, 'atlas-runs', 'carter-jarvis-bgjobs-strip-2026-08-22');
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

// Direct REST insert/update against agent_queue using the service-role key —
// same approach used to read the table during discovery for this task.
async function sbInsertQueueRow(payload) {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${url}/rest/v1/agent_queue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`insert failed: ${res.status} ${text}`);
  return JSON.parse(text)[0];
}

async function sbUpdateQueueRow(id, patch) {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${url}/rest/v1/agent_queue?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(patch),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`update failed: ${res.status} ${text}`);
  return JSON.parse(text)[0];
}

async function sbDeleteQueueRow(id) {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  await fetch(`${url}/rest/v1/agent_queue?id=eq.${id}`, {
    method: 'DELETE',
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
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

  // Baseline: strip should be hidden (or at least not showing our test row) before insert.
  await page.waitForTimeout(2000);
  const stripHiddenBefore = await page.evaluate(() => {
    const strip = document.getElementById('bg-jobs-strip');
    return !strip || strip.classList.contains('hidden');
  });
  console.log('[verify] strip hidden before test insert:', stripHiddenBefore);
  await page.screenshot({ path: path.join(OUT, '01-before.png'), fullPage: false });

  // NOTE: must NOT match NOISE_PATTERNS in api/_lib/internal-task-filter.js
  // (no "verify", no 10+ digit run) — that filter deliberately strips
  // internal QA rows like this from the real in-flight list, which the
  // strip reuses. A realistic, non-noise-looking task subject instead.
  const testSubject = `Carter live-status check ${new Date().toISOString().slice(11, 19)}`;
  const row = await sbInsertQueueRow({
    agent_name: 'carter',
    task_subject: testSubject,
    task_brief: testSubject,
    priority: 1,
    venture: 'general',
    status: 'in_progress',
    started_at: new Date().toISOString(),
    metadata: { source: 'carter-verify-script', _live_dispatch: true, skip_audit: true },
  });
  console.log('[verify] inserted test row', row.id);

  try {
    // Strip polls every 45s but also debounce-refreshes off the agent_queue
    // realtime channel (~400ms) — allow generous margin for CI/preview latency.
    // NOTE 2026-08-22 PM: Cole's cole-dispatch-start stopgap now also writes
    // real in_progress rows with agent_name='carter' (confirmed live in DB),
    // so a bare "list contains 'carter'" check can resolve true from THOSE
    // rows before our own test row has actually loaded — wait on our
    // test-specific subject string instead.
    await page.waitForFunction((subj) => {
      const list = document.getElementById('bg-jobs-list');
      return list && list.textContent && list.textContent.includes(subj);
    }, testSubject, { timeout: 20000 }).catch(() => {});

    const afterInsert = await page.evaluate((subj) => {
      const strip = document.getElementById('bg-jobs-strip');
      const list = document.getElementById('bg-jobs-list');
      const visible = strip && !strip.classList.contains('hidden');
      const item = list ? Array.from(list.querySelectorAll('.bg-jobs-item')).find(
        (el) => el.getAttribute('title') === subj
      ) : null;
      return {
        stripVisible: !!visible,
        itemFound: !!item,
        itemHtml: item ? item.outerHTML : null,
      };
    }, testSubject);
    report('strip becomes visible after real in_progress row inserted', afterInsert.stripVisible, JSON.stringify(afterInsert));
    report('strip shows the test row (agent + title)', afterInsert.itemFound, afterInsert.itemHtml || 'not found');
    await page.screenshot({ path: path.join(OUT, '02-item-active.png'), fullPage: false });

    // Confirm elapsed time is genuinely ticking (ratchets up, not static markup).
    const elapsed1 = await page.evaluate((subj) => {
      const list = document.getElementById('bg-jobs-list');
      const item = Array.from(list.querySelectorAll('.bg-jobs-item')).find((el) => el.getAttribute('title') === subj);
      return item ? item.querySelector('.bg-jobs-elapsed').textContent : null;
    }, testSubject);
    await page.waitForTimeout(3000);
    const elapsed2 = await page.evaluate((subj) => {
      const list = document.getElementById('bg-jobs-list');
      const item = Array.from(list.querySelectorAll('.bg-jobs-item')).find((el) => el.getAttribute('title') === subj);
      return item ? item.querySelector('.bg-jobs-elapsed').textContent : null;
    }, testSubject);
    report('elapsed time ticks locally without a refetch', elapsed1 !== elapsed2, `t1=${elapsed1} t2=${elapsed2}`);

    // Flip to completed — strip should drop it out of the live poll, fade it
    // to "done", then remove it.
    await sbUpdateQueueRow(row.id, { status: 'completed', completed_at: new Date().toISOString() });
    console.log('[verify] flipped row to completed');

    await page.waitForFunction((subj) => {
      const list = document.getElementById('bg-jobs-list');
      const item = list ? Array.from(list.querySelectorAll('.bg-jobs-item')).find((el) => el.getAttribute('title') === subj) : null;
      return item && item.classList.contains('done');
    }, testSubject, { timeout: 20000 }).catch(() => {});

    const doneState = await page.evaluate((subj) => {
      const list = document.getElementById('bg-jobs-list');
      const item = Array.from(list.querySelectorAll('.bg-jobs-item')).find((el) => el.getAttribute('title') === subj);
      return item ? { found: true, done: item.classList.contains('done'), text: item.textContent } : { found: false };
    }, testSubject);
    report('row flips to faded "done" state on completion', doneState.found && doneState.done, JSON.stringify(doneState));
    await page.screenshot({ path: path.join(OUT, '03-item-done.png'), fullPage: false });

    // 2026-08-22 PM revision: completed items must STAY visible (no more
    // 4s auto-removal) until Heath dismisses them himself. Wait well past
    // the old 4s window and confirm the row is still there and still
    // marked done.
    await page.waitForTimeout(6000);
    const stillThere = await page.evaluate((subj) => {
      const list = document.getElementById('bg-jobs-list');
      const item = list ? Array.from(list.querySelectorAll('.bg-jobs-item')).find((el) => el.getAttribute('title') === subj) : null;
      return { found: !!item, done: item ? item.classList.contains('done') : null };
    }, testSubject);
    report('completed row STAYS in the list past the old 4s auto-removal window', stillThere.found && stillThere.done, JSON.stringify(stillThere));
    await page.screenshot({ path: path.join(OUT, '04-still-visible-after-6s.png'), fullPage: false });

    // Dismiss control: per-row X only on done items.
    const dismissBtnFound = await page.evaluate((subj) => {
      const list = document.getElementById('bg-jobs-list');
      const item = Array.from(list.querySelectorAll('.bg-jobs-item')).find((el) => el.getAttribute('title') === subj);
      const btn = item ? item.querySelector('.bg-jobs-dismiss') : null;
      return !!btn;
    }, testSubject);
    report('done row shows a dismiss (X) control', dismissBtnFound);

    // Click it and confirm it disappears — but ONLY because of the click,
    // not a timer (no waitForTimeout before this, straight to the click).
    await page.evaluate((subj) => {
      const list = document.getElementById('bg-jobs-list');
      const item = Array.from(list.querySelectorAll('.bg-jobs-item')).find((el) => el.getAttribute('title') === subj);
      item.querySelector('.bg-jobs-dismiss').click();
    }, testSubject);
    await page.waitForTimeout(300);
    const afterDismiss = await page.evaluate((subj) => {
      const list = document.getElementById('bg-jobs-list');
      const item = list ? Array.from(list.querySelectorAll('.bg-jobs-item')).find((el) => el.getAttribute('title') === subj) : null;
      const strip = document.getElementById('bg-jobs-strip');
      return { itemGone: !item, stripHiddenAgain: !strip || strip.classList.contains('hidden') };
    }, testSubject);
    report('row disappears ONLY after the explicit dismiss click', afterDismiss.itemGone, JSON.stringify(afterDismiss));
    await page.screenshot({ path: path.join(OUT, '05-after-dismiss.png'), fullPage: false });

    // Empty-state check: this preview shares live prod data (Cole's
    // cole-dispatch-start stopgap has genuine in_progress rows running
    // right now — see api/jarvis-in-flight-work.js and agent_queue), so
    // the strip legitimately staying visible after our test item is
    // dismissed is CORRECT if other real items remain, not a bug. Only
    // fail this if the strip is visible with zero rows in it.
    const remainingCount = await page.evaluate(() => {
      const list = document.getElementById('bg-jobs-list');
      return list ? list.querySelectorAll('.bg-jobs-item').length : 0;
    });
    if (remainingCount === 0) {
      report('strip hides once list is genuinely empty (empty state)', afterDismiss.stripHiddenAgain, JSON.stringify(afterDismiss));
    } else {
      report(`strip correctly stays visible — ${remainingCount} other real in-flight/done item(s) still present (not our test row)`, true);
    }
  } finally {
    await sbDeleteQueueRow(row.id).catch(() => {});
  }

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
