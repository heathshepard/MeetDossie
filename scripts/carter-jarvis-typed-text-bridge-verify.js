#!/usr/bin/env node
// scripts/carter-jarvis-typed-text-bridge-verify.js
//
// Real-browser verification (per CLAUDE.md "VERIFY IN A REAL BROWSER BEFORE
// HANDOFF") for the 2026-08-21 fix: typed text in the Jarvis PWA now routes
// through the live jarvis-bridge Cole session (runBridgeChat/askBridge)
// instead of the old API-only /api/jarvis-voice?op=chat path
// (runTextOnlyChat), which never touched the bridge at all.
//
// Confirms two things:
//   1. Typing a real message into the chat box (reply mode = text) writes a
//      turn into the jarvis-bridge Storage bucket's turns/ prefix.
//   2. A real assistant reply renders in the chat UI.
//
// Usage: node scripts/carter-jarvis-typed-text-bridge-verify.js <BASE_URL>

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
  console.error('Usage: node scripts/carter-jarvis-typed-text-bridge-verify.js <BASE_URL>');
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, '');
const URL = `${BASE}/myjarvis`;
const EMAIL = 'heath.shepard@kw.com';
const OUT = path.join(__dirname, 'atlas-runs', 'carter-jarvis-typed-text-bridge-2026-08-21');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function report(name, pass, note) {
  results.push({ name, pass, note });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${note ? ' — ' + note : ''}`);
}

// Same pattern as scripts/carter-jarvis-todo-queue-verify.js.
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
    // Force text reply mode — this is the branch that was broken
    // (runTextOnlyChat never touched the bridge). Default is 'voice'.
    localStorage.setItem('jarvis:replyMode', 'text');
  }, { key: `sb-${projectRef}-auth-token`, sessionObj: session });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => {
    const gate = document.getElementById('auth-gate');
    const gateHidden = !gate || window.getComputedStyle(gate).display === 'none';
    return gateHidden && !!document.getElementById('chat-text-input');
  }, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  return page.evaluate(() => {
    const gate = document.getElementById('auth-gate');
    const gateHidden = !gate || window.getComputedStyle(gate).display === 'none';
    return gateHidden && !!document.getElementById('chat-text-input');
  });
}

async function checkBridgeBucket(sinceMs) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${url}/storage/v1/object/list/jarvis-bridge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
    },
    body: JSON.stringify({ prefix: 'turns/', limit: 200, sortBy: { column: 'created_at', order: 'desc' } }),
  });
  const listing = await res.json();
  if (!res.ok || !Array.isArray(listing)) {
    return { ok: false, error: `list failed: ${res.status} ${JSON.stringify(listing)}`, freshTurns: [] };
  }
  const freshTurns = listing.filter((obj) => {
    const created = new Date(obj.created_at || obj.updated_at || 0).getTime();
    return created >= sinceMs - 5000; // small clock-skew buffer
  });
  return { ok: true, freshTurns, allCount: listing.length };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1600 } });
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

  const testMessage = `carter-verify-typed-text-${Date.now()}`;
  const sentAtMs = Date.now();

  const textInput = page.locator('#chat-text-input');
  await textInput.waitFor({ state: 'visible', timeout: 15000 });
  await textInput.click();
  await textInput.fill(testMessage);
  await page.screenshot({ path: path.join(OUT, '01-before-send.png') }).catch(() => {});
  await page.locator('#chat-send-btn').click();

  // Confirm the user bubble rendered with our exact text.
  await page.waitForFunction((msg) => {
    const nodes = document.querySelectorAll('.msg.user .msg-content');
    return Array.from(nodes).some((n) => n.textContent && n.textContent.includes(msg));
  }, testMessage, { timeout: 10000 }).catch(() => {});
  const userBubbleFound = await page.evaluate((msg) => {
    const nodes = document.querySelectorAll('.msg.user .msg-content');
    return Array.from(nodes).some((n) => n.textContent && n.textContent.includes(msg));
  }, testMessage);
  report('typed message rendered as a user bubble', userBubbleFound);

  // Check the jarvis-bridge Storage bucket for a fresh turn written since
  // we clicked send — this is the part that was completely empty before
  // the fix (typed text never reached this bucket at all).
  await page.waitForTimeout(3000); // give the POST a moment to land
  const bucketCheck = await checkBridgeBucket(sentAtMs);
  report(
    'a fresh turn landed in jarvis-bridge Storage bucket turns/ prefix',
    bucketCheck.ok && bucketCheck.freshTurns.length > 0,
    bucketCheck.ok
      ? `${bucketCheck.freshTurns.length} fresh turn(s) since send, ${bucketCheck.allCount} total in bucket`
      : bucketCheck.error
  );

  // Wait for a real assistant reply to render (needs a live session polling
  // the bridge — up to 60s here; the bridge itself allows up to 9 minutes).
  console.log('[verify] waiting up to 60s for a real bridged reply to render...');
  const replyArrived = await page.waitForFunction(() => {
    const nodes = document.querySelectorAll('.msg.assistant .msg-content');
    return nodes.length > 0;
  }, { timeout: 60000 }).then(() => true).catch(() => false);
  const replyText = replyArrived
    ? await page.locator('.msg.assistant .msg-content').first().innerText().catch(() => '')
    : '';
  report('a real assistant reply rendered in the chat UI within 60s', replyArrived, replyText.slice(0, 200));

  await page.screenshot({ path: path.join(OUT, '02-final.png'), fullPage: true }).catch(() => {});
  await browser.close();

  const overall = results.every((r) => r.pass);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, pageErrors, testMessage, overall }, null, 2));
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
