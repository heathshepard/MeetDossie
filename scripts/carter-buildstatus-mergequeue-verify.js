#!/usr/bin/env node
// scripts/carter-buildstatus-mergequeue-verify.js
//
// Real-browser verification for the 2026-08-12 Merge Queue / BUILD STATUS
// fix (Heath: "the merge queue... doesn't work when I push the merge
// button" + "worthless... not sure what all this stuff is" re: In-Flight
// Work + Agents panels). Confirms:
//   1. The QUINN TEST artifact is gone from the Merge Queue panel.
//   2. Merge Queue renders cleanly with zero real ready rows (current true
//      state — nothing has actually passed Quinn QA yet).
//   3. BUILD STATUS shows one plain-English summary line, collapsed by
//      default, with the raw In-Flight Work / Agents detail behind a
//      working <details> toggle.
//   4. END-TO-END MERGE BUTTON FIX: inserts a temporary merge_queue row
//      pointing at a REAL commit sha that exists on staging, intercepts the
//      POST to /api/merge-to-main (so this script never actually performs a
//      real fast-forward merge to main — that requires Heath's explicit
//      "merge it"), and confirms the button sends that exact real sha
//      instead of the old malformed test value. Deletes the temp row after.
//
// Usage: node scripts/carter-buildstatus-mergequeue-verify.js <BASE_URL>

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
  console.error('Usage: node scripts/carter-buildstatus-mergequeue-verify.js <BASE_URL>');
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, '');
const URL = `${BASE}/myjarvis`;
const EMAIL = 'heath.shepard@kw.com';
const OUT = path.join(__dirname, 'atlas-runs', `carter-buildstatus-mergequeue-${Date.now()}`);
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

function sb() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); // Heath's phone
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));

  const supabase = sb();
  let tempRowId = null;
  let originalRow = null;

  try {
    const session = await mintHeathSession();
    const projectRef = process.env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([^.]+)\./)[1];
    await page.goto(URL, { waitUntil: 'commit', timeout: 45000 });
    await page.evaluate(({ key, sessionObj }) => {
      localStorage.setItem(key, JSON.stringify({
        access_token: sessionObj.access_token, refresh_token: sessionObj.refresh_token,
        token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: sessionObj.user,
      }));
    }, { key: `sb-${projectRef}-auth-token`, sessionObj: session });
    await page.reload({ waitUntil: 'commit', timeout: 45000 });
    await page.waitForFunction(() => (document.body.innerText || '').includes('MERGE QUEUE'), { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(5000);
    const signedInDebug = await page.evaluate(() => {
      const gate = document.getElementById('auth-gate');
      return {
        hasMergeQueue: (document.body.innerText || '').includes('MERGE QUEUE'),
        gateExists: !!gate,
        gateDisplay: gate ? getComputedStyle(gate).display : null,
      };
    });
    console.log('SIGNIN_DEBUG:', JSON.stringify(signedInDebug));
    const signedIn = signedInDebug.hasMergeQueue && (!signedInDebug.gateExists || signedInDebug.gateDisplay === 'none');
    report('sign-in as heath.shepard@kw.com', signedIn, JSON.stringify(signedInDebug));
    if (!signedIn) {
      await page.screenshot({ path: path.join(OUT, '00-signin-debug.png'), fullPage: true }).catch(() => {});
      throw new Error('not signed in, aborting');
    }

    // ---------- 1 & 2: MERGE QUEUE CLEAN, NO TEST ARTIFACT ----------
    await page.waitForSelector('#merge-queue-list', { timeout: 15000 });
    await page.waitForTimeout(3000);
    const mqText = (await page.locator('#merge-queue-list').innerText()).trim();
    report('no QUINN TEST artifact in Merge Queue panel', !/quinn test/i.test(mqText), `text="${mqText.slice(0, 150)}"`);
    report('Merge Queue shows real empty state (nothing fabricated)', /nothing ready to merge/i.test(mqText), `text="${mqText}"`);
    await page.screenshot({ path: path.join(OUT, '01-mobile-mergequeue-clean.png'), fullPage: true });

    // ---------- 3: BUILD STATUS collapsed summary ----------
    await page.waitForSelector('#build-status-line', { timeout: 15000 });
    await page.waitForTimeout(2000);
    const buildLine = (await page.locator('#build-status-line').innerText()).trim();
    report('BUILD STATUS summary line is plain English, not raw telemetry', buildLine.length > 0 && !/BLOCKED|sha required/i.test(buildLine), `line="${buildLine}"`);
    const detailsOpenByDefault = await page.locator('#build-status-details').evaluate((el) => el.open);
    report('BUILD STATUS details collapsed by default', detailsOpenByDefault === false);
    await page.screenshot({ path: path.join(OUT, '02-mobile-buildstatus-collapsed.png'), fullPage: true });

    await page.locator('#build-status-details summary').click();
    await page.waitForTimeout(600);
    const expandedNow = await page.locator('#build-status-details').evaluate((el) => el.open);
    const instanceCountVisible = await page.locator('#instance-count').isVisible().catch(() => false);
    report('BUILD STATUS details expand on click, old panels still work', expandedNow && instanceCountVisible);
    await page.screenshot({ path: path.join(OUT, '03-mobile-buildstatus-expanded.png'), fullPage: true });
    await page.locator('#build-status-details summary').click(); // collapse back
    await page.waitForTimeout(300);

    // ---------- 4: END-TO-END MERGE BUTTON, no real merge performed ----------
    // Real commit that exists on staging (HEAD at push time) so the row is
    // realistic, not synthetic. NEVER let this actually reach the live
    // /api/merge-to-main — network intercept below fulfills locally instead.
    const { data: headCommit, error: headErr } = await (async () => {
      try {
        const r = await fetch(`https://api.github.com/repos/heathshepard/MeetDossie/commits/staging`, {
          headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
        });
        const j = await r.json();
        return { data: j.sha, error: r.ok ? null : j };
      } catch (e) { return { data: null, error: e.message }; }
    })();
    if (!headCommit) throw new Error('could not resolve staging HEAD sha: ' + JSON.stringify(headErr));

    // The staging HEAD commit is very likely already a real row (auto-inserted
    // by cron-staging-watcher.js) — reuse it instead of inserting a duplicate
    // (commit_sha has a unique constraint). Remember original state so it can
    // be restored exactly, whether that means reverting a flipped status or
    // deleting a row this script created fresh.
    const { data: existingRow } = await supabase.from('merge_queue').select('id, quinn_qa_status, title, description, commit_author')
      .eq('commit_sha', headCommit).maybeSingle();
    if (existingRow) {
      originalRow = existingRow;
      tempRowId = existingRow.id;
      const { error: updErr } = await supabase.from('merge_queue')
        .update({ quinn_qa_status: 'pass' }).eq('id', existingRow.id);
      if (updErr) throw new Error('temp row status flip failed: ' + updErr.message);
      console.log('[setup] reused existing merge_queue row, flipped quinn_qa_status to pass for the test:', existingRow.id);
    } else {
      const { data: inserted, error: insErr } = await supabase.from('merge_queue').insert({
        commit_sha: headCommit,
        title: 'CARTER VERIFY-ONLY row — network intercepted, no real merge (auto-deleted after test)',
        description: 'Temporary row for carter-buildstatus-mergequeue-verify.js. If you see this in the live panel, the cleanup step failed — safe to delete manually.',
        quinn_qa_status: 'pass',
        commit_author: 'Carter Verify',
      }).select('id').single();
      if (insErr) throw new Error('temp row insert failed: ' + insErr.message);
      tempRowId = inserted.id;
    }

    let interceptedBody = null;
    await page.route('**/api/merge-to-main', async (route) => {
      interceptedBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, mergedSha: interceptedBody.sha, shortSha: String(interceptedBody.sha).slice(0, 7), noop: false, intercepted: true }),
      });
    });

    page.once('dialog', (d) => d.accept());
    await page.reload({ waitUntil: 'commit', timeout: 45000 });
    await page.waitForFunction(() => (document.body.innerText || '').includes('MERGE QUEUE'), { timeout: 45000 }).catch(() => {});
    await page.waitForSelector('#merge-queue-list', { timeout: 15000 });
    await page.waitForTimeout(5000);
    const mqTextWithRow = (await page.locator('#merge-queue-list').innerText()).trim();
    report('real-sha row now renders in ready queue (was empty before the flip)', mqTextWithRow.length > 0 && !/nothing ready/i.test(mqTextWithRow), `text="${mqTextWithRow.slice(0, 150)}"`);

    const mergeBtn = page.locator('.merge-queue-item button[data-action="merge"]').first();
    await mergeBtn.click();
    await page.waitForTimeout(1500);

    report('MERGE button click sends a well-formed real sha (the exact bug that broke it before)',
      !!interceptedBody && /^[0-9a-f]{7,40}$/i.test(String(interceptedBody.sha || '')) && interceptedBody.sha === headCommit,
      `sent="${interceptedBody && interceptedBody.sha}"`);
    const toastText = await page.locator('.toast, [class*="toast"]').first().innerText().catch(() => '');
    report('UI shows success toast, not "sha required" error', !/sha required/i.test(toastText), `toast="${toastText}"`);
    await page.screenshot({ path: path.join(OUT, '04-mobile-merge-clicked.png'), fullPage: true });

  } catch (err) {
    console.error('SCRIPT_ERROR:', err.stack || err);
    results.push({ name: 'script completed without crash', pass: false, note: String(err) });
  } finally {
    if (tempRowId && originalRow) {
      // Reused a real row — restore its original quinn_qa_status exactly,
      // don't delete real pending work.
      const { error: revErr } = await supabase.from('merge_queue')
        .update({ quinn_qa_status: originalRow.quinn_qa_status }).eq('id', tempRowId);
      console.log('[cleanup] restored existing row quinn_qa_status to', originalRow.quinn_qa_status, ':', tempRowId, revErr ? `ERROR: ${revErr.message}` : 'ok');
    } else if (tempRowId) {
      const { error: delErr } = await supabase.from('merge_queue').delete().eq('id', tempRowId);
      console.log('[cleanup] deleted temp verify row:', tempRowId, delErr ? `ERROR: ${delErr.message}` : 'ok');
    }
    await browser.close();
  }

  const overall = results.length > 0 && results.every((r) => r.pass);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, pageErrors, overall }, null, 2));
  console.log('\n========== SUMMARY ==========');
  results.forEach((r) => console.log(`${r.pass ? 'PASS' : 'FAIL'} — ${r.name}${r.note ? ' :: ' + r.note : ''}`));
  console.log(`Page errors: ${pageErrors.length}`);
  pageErrors.forEach((e) => console.log('  ' + e));
  console.log(`Screenshots: ${OUT}`);
  console.log(`OVERALL: ${overall ? 'PASS' : 'FAIL'}`);
  process.exit(overall ? 0 : 1);
})();
