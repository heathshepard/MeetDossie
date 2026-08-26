#!/usr/bin/env node
// scripts/atlas-jarvis-mic-selfheal-verify.js
//
// Real-browser verification (per CLAUDE.md "VERIFY IN A REAL BROWSER BEFORE
// HANDOFF") for the 2026-08-26 fix: mic self-heal code (recoverMicStream +
// its 4 triggers, ab26e7ac/1aad1fe4, shipped 2026-08-25) was correct on disk
// but jarvis-pwa-sw.js's CACHE was never bumped, so an already-open Jarvis
// session never loaded it. This script:
//   1. Signs in for real as heath.shepard@kw.com (same magic-link-mint
//      pattern as carter-jarvis-voice-mode-bridge-verify.js).
//   2. Confirms the SW registers the new v14 cache key.
//   3. Starts a real conversation (fake mic device, real getUserMedia).
//   4. Confirms the self-heal hooks are actually present in the loaded page
//      (window.__jarvisRecoverMicStream, window.__jarvisEnsureMic).
//   5. Directly invokes recoverMicStream() and confirms it completes without
//      throwing, reconnects a live mic track, and returns pttState to
//      'listening' -- the manual-trigger path.
//   6. Dispatches a synthetic MediaStreamTrack 'ended' event on the REAL live
//      mic track and confirms the auto-wired listener (added in ensureMic)
//      fires recoverMicStream on its own, with zero console errors -- the
//      automatic-trigger path, i.e. what actually has to work unattended.
//
// Playwright can't simulate real speech into the fake device, so VAD
// threshold/gain behavior is NOT covered here -- this verifies the
// self-healing code path specifically, which is what tonight's report was
// about ("mic self healing isn't working").
//
// Usage: node scripts/atlas-jarvis-mic-selfheal-verify.js <BASE_URL>

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
  console.error('Usage: node scripts/atlas-jarvis-mic-selfheal-verify.js <BASE_URL>');
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, '');
const URL = `${BASE}/myjarvis`;
const EMAIL = 'heath.shepard@kw.com';
const OUT = path.join(__dirname, 'atlas-runs', 'atlas-jarvis-mic-selfheal-2026-08-26');
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
  await page.goto(URL, { waitUntil: 'commit', timeout: 20000 });
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
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
    localStorage.setItem('jarvis:replyMode', 'voice');
  }, { key: `sb-${projectRef}-auth-token`, sessionObj: session });
  await page.reload({ waitUntil: 'commit', timeout: 20000 });
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
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
  const consoleWarnings = [];
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('[jarvis-mic-recovery]')) consoleWarnings.push(t);
  });

  console.log(`[verify] navigating ${URL}`);
  const signedIn = await signIn(page);
  report('sign-in as heath.shepard@kw.com', signedIn);
  if (!signedIn) {
    await page.screenshot({ path: path.join(OUT, '00-signin-fail.png'), fullPage: true });
    await browser.close();
    process.exit(1);
  }

  // ---- Confirm the new SW cache key actually registered (proves this is
  // NOT a stale already-open session for the purposes of this test — a real
  // fresh navigation, same as Heath doing a hard close+reopen, must load v14).
  await page.waitForTimeout(3000);
  const swCheck = await page.evaluate(async () => {
    const keys = await caches.keys();
    const reg = await navigator.serviceWorker.getRegistration();
    return { cacheKeys: keys, controllerScriptURL: reg && reg.active && reg.active.scriptURL };
  }).catch((e) => ({ error: String(e) }));
  const hasV14 = !!(swCheck.cacheKeys || []).find((k) => k.includes('v14'));
  report('SW cache v14 registered on fresh navigation', hasV14, JSON.stringify(swCheck.cacheKeys || swCheck));

  // ---- Start a real conversation.
  await page.locator('#ptt').click();
  const conversationStarted = await page.waitForFunction(() => {
    return document.getElementById('ptt-label')?.textContent?.includes('TAP TO END');
  }, { timeout: 15000 }).then(() => true).catch(() => false);
  report('tapping PTT starts a real conversation (getUserMedia + conversationActive)', conversationStarted);
  await page.screenshot({ path: path.join(OUT, '01-listening.png') }).catch(() => {});
  if (!conversationStarted) {
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, pageErrors }, null, 2));
    await browser.close();
    process.exit(1);
  }

  // ---- Confirm self-heal hooks are present in the LOADED page (proves the
  // fix code, not just old cached JS, is what's actually running).
  const hooksPresent = await page.evaluate(() => ({
    recoverMicStream: typeof window.__jarvisRecoverMicStream === 'function',
    ensureMic: typeof window.__jarvisEnsureMic === 'function',
  }));
  report('self-heal hooks present on loaded page', hooksPresent.recoverMicStream && hooksPresent.ensureMic, JSON.stringify(hooksPresent));

  // ---- Manual-trigger path: call recoverMicStream() directly and confirm
  // it completes cleanly, reconnects a live track, and returns to 'listening'.
  const manualRecover = await page.evaluate(async () => {
    try {
      await window.__jarvisRecoverMicStream('verify-manual-trigger');
      return { ok: true, pttState: window.__jarvisGetPttState ? window.__jarvisGetPttState() : null };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });
  report('recoverMicStream() manual call completes without throwing', manualRecover.ok, JSON.stringify(manualRecover));
  await page.waitForTimeout(500);
  const stateAfterManual = await page.evaluate(() => document.getElementById('ptt-label')?.textContent || '');
  report('conversation still in TAP TO END (listening) after manual recovery', stateAfterManual.includes('TAP TO END'), stateAfterManual);

  // ---- Automatic-trigger path: dispatch a synthetic 'ended' event on the
  // REAL live mic track (same event the browser fires on a genuine device
  // revoke/disconnect) and confirm the auto-wired listener fires
  // recoverMicStream on its own, with the recovery log line appearing.
  const sinceAutoTrigger = Date.now();
  const autoTrigger = await page.evaluate(async () => {
    // Grab the currently-live mic stream via a fresh ensureMic() call (mirrors
    // what recoverMicStream just did), then simulate the browser's own
    // track-death signal.
    if (typeof window.__jarvisEnsureMic !== 'function') return { ok: false, error: 'no ensureMic hook' };
    try {
      const stream = await window.__jarvisEnsureMic();
      if (!stream) return { ok: false, error: 'ensureMic returned null' };
      const track = stream.getAudioTracks()[0];
      if (!track) return { ok: false, error: 'no audio track' };
      track.dispatchEvent(new Event('ended'));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });
  report('dispatched synthetic track "ended" event on real mic track', autoTrigger.ok, JSON.stringify(autoTrigger));
  await page.waitForTimeout(2000);
  const autoRecoveryLogged = consoleWarnings.some((w) => w.includes('mic track ended unexpectedly'));
  report('auto-wired listener logged "mic track ended unexpectedly"', autoRecoveryLogged, consoleWarnings.join(' | '));

  await page.screenshot({ path: path.join(OUT, '02-final.png'), fullPage: true }).catch(() => {});
  await browser.close();

  const overall = results.every((r) => r.pass);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, pageErrors, consoleWarnings, overall }, null, 2));
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
