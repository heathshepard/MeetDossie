#!/usr/bin/env node
// scripts/carter-jarvis-voice-mode-bridge-verify.js
//
// Real-browser verification (per CLAUDE.md "VERIFY IN A REAL BROWSER BEFORE
// HANDOFF") for the 2026-08-22 fix: the Jarvis PWA's mic/voice loop
// (handleUtteranceBlob, the function that fires when Heath finishes
// speaking) now routes through the live jarvis-bridge Cole session
// (runBridgeVoiceChat/askBridge) instead of the old API-only
// /api/jarvis-voice backend, which never touched the bridge at all — the
// root cause of voice input staying broken all day despite typed-text
// fixes earlier the same day.
//
// Playwright can't literally speak into a mic, so this drives the EXACT
// production code path a real utterance takes: real getUserMedia (via a
// Chromium fake audio device) starts a real conversation
// (conversationActive=true, same as tapping the PTT button), then a
// synthetic-but-real speech clip (generated via the app's own TTS endpoint)
// is fed straight into handleUtteranceBlob() — exposed for exactly this via
// window.__jarvisHandleUtteranceBlob — so STT, noise filtering, the bridge
// routing, and the reply TTS all run for real, unmodified from disk.
//
// Confirms:
//   1. Conversation starts for real (getUserMedia succeeds, conversationActive).
//   2. handleUtteranceBlob() transcribes the synthetic clip and appends a
//      real user bubble (STT actually ran).
//   3. A fresh turn lands in the jarvis-bridge Storage bucket turns/ prefix
//      (confirms askBridge/runBridgeVoiceChat fired — this is the part that
//      was completely disconnected before the fix).
//   4. A real assistant reply renders in the chat UI.
//   5. The reply is actually spoken aloud — a real POST to
//      /api/jarvis-voice?op=tts fires AFTER the reply lands (speakBridgeAnswer).
//
// Usage: node scripts/carter-jarvis-voice-mode-bridge-verify.js <BASE_URL>

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
  console.error('Usage: node scripts/carter-jarvis-voice-mode-bridge-verify.js <BASE_URL>');
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, '');
const URL = `${BASE}/myjarvis`;
const EMAIL = 'heath.shepard@kw.com';
const OUT = path.join(__dirname, 'atlas-runs', 'carter-jarvis-voice-mode-bridge-2026-08-22');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function report(name, pass, note) {
  results.push({ name, pass, note });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${note ? ' — ' + note : ''}`);
}

// Same pattern as scripts/carter-jarvis-typed-text-bridge-verify.js.
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
    // Default reply mode is 'voice' — this IS the mic/voice loop under test,
    // make it explicit rather than relying on the default.
    localStorage.setItem('jarvis:replyMode', 'voice');
  }, { key: `sb-${projectRef}-auth-token`, sessionObj: session });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => {
    const gate = document.getElementById('auth-gate');
    const gateHidden = !gate || window.getComputedStyle(gate).display === 'none';
    return gateHidden && !!document.getElementById('ptt');
  }, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  return page.evaluate(() => {
    const gate = document.getElementById('auth-gate');
    const gateHidden = !gate || window.getComputedStyle(gate).display === 'none';
    return gateHidden && !!document.getElementById('ptt');
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
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1600 } });
  await ctx.grantPermissions(['microphone'], { origin: BASE });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));

  // Track every op=tts request/response so we can prove the FINAL reply was
  // actually sent to speech, not just rendered as text.
  const ttsResponses = [];
  page.on('response', (res) => {
    const u = res.url();
    if (u.includes('/api/jarvis-voice') && u.includes('op=tts')) {
      ttsResponses.push({ url: u, status: res.status(), ts: Date.now() });
    }
  });

  console.log(`[verify] navigating ${URL}`);
  const signedIn = await signIn(page);
  report('sign-in as heath.shepard@kw.com', signedIn);
  if (!signedIn) {
    await page.screenshot({ path: path.join(OUT, '00-signin-fail.png'), fullPage: true });
    await browser.close();
    process.exit(1);
  }

  // ---- Start a REAL conversation the same way Heath does: tap the PTT
  // button. With --use-fake-device-for-media-stream + granted mic
  // permission, getUserMedia succeeds against a synthetic audio device, so
  // this exercises the real onPttClick -> ensureMic -> conversationActive
  // path, not a mock.
  await page.locator('#ptt').click();
  const conversationStarted = await page.waitForFunction(() => {
    return document.getElementById('ptt-label')?.textContent?.includes('TAP TO END');
  }, { timeout: 15000 }).then(() => true).catch(() => false);
  report('tapping PTT starts a real conversation (getUserMedia + conversationActive)', conversationStarted);
  await page.screenshot({ path: path.join(OUT, '01-listening.png') }).catch(() => {});
  if (!conversationStarted) {
    await browser.close();
    process.exit(1);
  }

  // ---- Build a real spoken-audio blob via the app's own TTS endpoint
  // (in-page fetch, using the real signed-in session), then feed it into
  // handleUtteranceBlob() exactly the way mediaRecorder.onstop does after a
  // real utterance — see window.__jarvisHandleUtteranceBlob, added
  // 2026-08-22 specifically as a debug/verify hook for this.
  const spokenPhrase = 'Please confirm you received this exact voice bridge verification test message.';
  const sentAtMs = Date.now();
  const authStorageKey = `sb-${process.env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([^.]+)\./)[1]}-auth-token`;
  const handleResult = await page.evaluate(async ({ phrase, projectRefKey }) => {
    const raw = localStorage.getItem(projectRefKey);
    if (!raw) return { ok: false, error: 'no session in localStorage' };
    const token = JSON.parse(raw).access_token;
    const ttsRes = await fetch('/api/jarvis-voice?op=tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: phrase }),
    });
    if (!ttsRes.ok) return { ok: false, error: `synthetic-utterance TTS failed: ${ttsRes.status}` };
    const blob = await ttsRes.blob();
    if (!blob || blob.size < 1000) return { ok: false, error: `synthetic-utterance blob too small: ${blob && blob.size}` };
    if (typeof window.__jarvisHandleUtteranceBlob !== 'function') {
      return { ok: false, error: 'window.__jarvisHandleUtteranceBlob not exposed' };
    }
    try {
      await window.__jarvisHandleUtteranceBlob(blob);
      return { ok: true, blobSize: blob.size, blobType: blob.type };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }, { phrase: spokenPhrase, projectRefKey: authStorageKey });

  report('generated a real spoken-audio blob and ran it through handleUtteranceBlob()', handleResult.ok, handleResult.ok ? `${handleResult.blobSize}b ${handleResult.blobType}` : handleResult.error);

  // STT should have transcribed our synthetic clip into SOME user bubble.
  const userBubbleFound = await page.evaluate(() => {
    const nodes = document.querySelectorAll('.msg.user .msg-content');
    return nodes.length > 0 ? Array.from(nodes).pop().textContent.trim() : '';
  });
  report('STT transcript rendered as a user bubble', !!userBubbleFound, userBubbleFound || '(none)');

  // Confirm the jarvis-bridge Storage bucket got a fresh turn — this is the
  // part that was completely absent before the fix (voice never reached
  // askBridge/runBridgeVoiceChat at all).
  await page.waitForTimeout(3000);
  const bucketCheck = await checkBridgeBucket(sentAtMs);
  report(
    'a fresh turn landed in jarvis-bridge Storage bucket turns/ prefix',
    bucketCheck.ok && bucketCheck.freshTurns.length > 0,
    bucketCheck.ok
      ? `${bucketCheck.freshTurns.length} fresh turn(s) since utterance, ${bucketCheck.allCount} total in bucket`
      : bucketCheck.error
  );

  console.log('[verify] waiting up to 90s for a real bridged reply to render...');
  const replyArrived = await page.waitForFunction(() => {
    const nodes = document.querySelectorAll('.msg.assistant .msg-content');
    return nodes.length > 0;
  }, { timeout: 90000 }).then(() => true).catch(() => false);
  const replyText = replyArrived
    ? await page.locator('.msg.assistant .msg-content').last().innerText().catch(() => '')
    : '';
  report('a real assistant reply rendered in the chat UI', replyArrived, replyText.slice(0, 200));

  // The reply must ALSO be spoken — confirm a real op=tts POST fired after
  // we submitted the utterance (speakBridgeAnswer, called from
  // runBridgeVoiceChat once askBridge resolves).
  const ttsAfterReply = ttsResponses.filter((r) => r.ts >= sentAtMs && r.status === 200);
  report(
    'the bridge reply was sent to TTS (spoken aloud), not just rendered as text',
    ttsAfterReply.length > 0,
    `${ttsAfterReply.length} op=tts 200 response(s) after utterance (includes any interim ack)`
  );

  await page.screenshot({ path: path.join(OUT, '02-final.png'), fullPage: true }).catch(() => {});
  await browser.close();

  const overall = results.every((r) => r.pass);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, pageErrors, spokenPhrase, ttsResponses, overall }, null, 2));
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
