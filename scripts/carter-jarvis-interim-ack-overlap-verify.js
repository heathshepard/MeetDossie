#!/usr/bin/env node
// scripts/carter-jarvis-interim-ack-overlap-verify.js
//
// Real-browser verification (per CLAUDE.md "VERIFY IN A REAL BROWSER BEFORE
// HANDOFF") for the 2026-08-22 fix to a bug Heath reported live: the spoken
// interim ack ("On it, give me a sec" — speakInterimAck) could still be
// mid-playback when the real final answer's own audio (speakBridgeAnswer)
// started, producing genuine audible overlap of two independent <audio>
// elements with zero coordination between them.
//
// The live-bridge round trip that normally produces this race is not
// timing-controllable from outside (how long Cole's session takes to answer
// is not something this script can force), so this drives the exact
// interim-ack and final-answer AUDIO functions directly via debug hooks
// (window.__jarvisSpeakInterimAck / window.__jarvisSpeakBridgeAnswer,
// added 2026-08-22 for exactly this) with a controlled artificial delay on
// the interim ack's own TTS fetch — forcing it to still be in flight when
// the final answer's playback starts, which is precisely the race condition
// Heath hit. Real fetch, real Audio elements, real ElevenLabs bytes; only
// the TIMING is synthetic.
//
// Two modes, auto-detected per URL:
//   - POST-FIX (hooks present): calls the real, currently-shipped
//     speakInterimAck/speakBridgeAnswer through their debug hooks — proves
//     the actual fix.
//   - PRE-FIX (hooks absent, e.g. a preview deployed before this fix):
//     reproduces the literal pre-fix behavior inline — independent fetch ->
//     blob -> `new Audio()` -> `.play()` for both interim and final, with
//     ZERO coordination, matching git blob 436362fe's speakInterimAck /
//     speakBridgeAnswer verbatim — to prove this harness actually detects
//     the overlap it's designed to catch, not just rubber-stamp a pass.
//
// A `window.Audio` wrapper installed before either function runs logs every
// created instance's play/pause/ended timestamps; overlap is computed from
// that real event log, not inferred from network timing alone.
//
// Usage:
//   node scripts/carter-jarvis-interim-ack-overlap-verify.js <BASE_URL> [--expect=none|overlap]
//   --expect=none    (default) PASS means no overlap detected — use against
//                     a post-fix deployment.
//   --expect=overlap PASS means overlap WAS detected — use against a
//                     pre-fix deployment to prove the harness catches the bug.

'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?\r?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const args = process.argv.slice(2);
const baseArg = args.find((a) => !a.startsWith('--'));
const expectArg = (args.find((a) => a.startsWith('--expect=')) || '--expect=none').split('=')[1];
if (!baseArg || !['none', 'overlap'].includes(expectArg)) {
  console.error('Usage: node scripts/carter-jarvis-interim-ack-overlap-verify.js <BASE_URL> [--expect=none|overlap]');
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, '');
const URL = `${BASE}/myjarvis`;
const EMAIL = 'heath.shepard@kw.com';
const OUT = path.join(__dirname, 'atlas-runs', 'carter-jarvis-interim-ack-overlap-2026-08-22');
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
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1600 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));

  console.log(`[verify] navigating ${URL} (expect=${expectArg})`);
  const signedIn = await signIn(page);
  report('sign-in as heath.shepard@kw.com', signedIn);
  if (!signedIn) {
    await page.screenshot({ path: path.join(OUT, '00-signin-fail.png'), fullPage: true });
    await browser.close();
    process.exit(1);
  }

  const hasHooks = await page.evaluate(
    () => typeof window.__jarvisSpeakInterimAck === 'function' && typeof window.__jarvisSpeakBridgeAnswer === 'function'
  );
  const mode = hasHooks ? 'post-fix (real shipped functions via debug hooks)' : 'pre-fix (literal git-blob-436362fe reproduction)';
  console.log(`[verify] mode: ${mode}`);

  const INTERIM_MARKER = '__INTERIM_ACK_OVERLAP_TEST__';
  const INTERIM_DELAY_MS = 4000; // hold the interim ack's TTS fetch "in flight" this long
  const GAP_MS = 500; // real-world gap between the interim ack firing and the final answer landing
  const interimText = `One sec, sir — still working on it. ${INTERIM_MARKER}`;
  const finalText = 'Here is the complete final answer for the overlap verification test. '.repeat(4);

  // Install: (1) an Audio wrapper that logs every create/play/pause/ended
  // event with a timestamp so overlap can be computed from real playback
  // state, and (2) a fetch wrapper that artificially delays resolution of
  // ONLY the interim-marked op=tts call — real network request fires
  // immediately, we just hold the resolved Response back — so the race is
  // deterministic regardless of actual ElevenLabs/network latency.
  await page.evaluate(({ marker, delayMs }) => {
    window.__audioEvents = [];
    let nextId = 1;
    const OrigAudio = window.Audio;
    function WrappedAudio(src) {
      const instance = src !== undefined ? new OrigAudio(src) : new OrigAudio();
      const id = nextId++;
      window.__audioEvents.push({ id, event: 'created', ts: performance.now() });
      const origPlay = instance.play.bind(instance);
      instance.play = function () {
        window.__audioEvents.push({ id, event: 'play', ts: performance.now() });
        return origPlay().catch((err) => {
          window.__audioEvents.push({ id, event: 'play-rejected', ts: performance.now(), error: String(err) });
          throw err;
        });
      };
      const origPause = instance.pause.bind(instance);
      instance.pause = function () {
        window.__audioEvents.push({ id, event: 'pause', ts: performance.now() });
        return origPause();
      };
      instance.addEventListener('ended', () => window.__audioEvents.push({ id, event: 'ended', ts: performance.now() }));
      return instance;
    }
    window.Audio = WrappedAudio;

    const origFetch = window.fetch.bind(window);
    window.fetch = async (url, opts) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/jarvis-voice') && urlStr.includes('op=tts')) {
        let bodyText = '';
        try { bodyText = JSON.parse(opts.body).text || ''; } catch {}
        const res = await origFetch(url, opts);
        if (bodyText.includes(marker)) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
        return res;
      }
      return origFetch(url, opts);
    };
  }, { marker: INTERIM_MARKER, delayMs: INTERIM_DELAY_MS });

  const raceRun = await page.evaluate(
    async ({ interimText, finalText, gapMs, hasHooks, authKey }) => {
      const log = [];
      const t0 = performance.now();
      try {
        if (hasHooks) {
          // POST-FIX: exercise the real, currently-shipped functions —
          // fire-and-forget for the interim ack, exactly how
          // runBridgeVoiceChat's onInterim callback calls it.
          window.__jarvisSpeakInterimAck(interimText);
          log.push({ ts: performance.now() - t0, event: 'called real speakInterimAck' });
          await new Promise((r) => setTimeout(r, gapMs));
          await window.__jarvisSpeakBridgeAnswer(finalText);
          log.push({ ts: performance.now() - t0, event: 'real speakBridgeAnswer resolved' });
        } else {
          // PRE-FIX reproduction — verbatim behavior of git blob 436362fe's
          // speakInterimAck/speakBridgeAnswer: independent fetch -> blob ->
          // `new Audio()` -> `.play()` for each, no shared state, no stop
          // call. Auth header built the same way the existing
          // carter-jarvis-*-bridge-verify scripts already do (session pulled
          // from localStorage), since the module-scoped getAuthHeader()
          // isn't reachable from outside the page's module script.
          const raw = localStorage.getItem(authKey);
          const token = raw ? `Bearer ${JSON.parse(raw).access_token}` : '';

          async function oldSpeakInterimAck(text) {
            try {
              const ttsRes = await fetch(`/api/jarvis-voice?op=tts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: token },
                body: JSON.stringify({ text }),
              });
              if (!ttsRes.ok) return;
              const audioBlob = await ttsRes.blob();
              const audioUrl = URL.createObjectURL(audioBlob);
              const audio = new Audio(audioUrl);
              audio.onended = () => URL.revokeObjectURL(audioUrl);
              audio.onerror = () => URL.revokeObjectURL(audioUrl);
              await audio.play();
            } catch (err) { /* fire-and-forget, same as production */ }
          }
          async function oldSpeakBridgeAnswer(text) {
            const ttsRes = await fetch(`/api/jarvis-voice?op=tts`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: token },
              body: JSON.stringify({ text }),
            });
            if (!ttsRes.ok) throw new Error(`TTS failed (${ttsRes.status})`);
            const audioBlob = await ttsRes.blob();
            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);
            audio.onended = () => URL.revokeObjectURL(audioUrl);
            await audio.play();
          }

          oldSpeakInterimAck(interimText);
          log.push({ ts: performance.now() - t0, event: 'called pre-fix speakInterimAck' });
          await new Promise((r) => setTimeout(r, gapMs));
          await oldSpeakBridgeAnswer(finalText);
          log.push({ ts: performance.now() - t0, event: 'pre-fix speakBridgeAnswer resolved' });
        }
        // Wait long enough for the delayed interim fetch to resolve either way.
        await new Promise((r) => setTimeout(r, 3000));
        return { ok: true, log };
      } catch (err) {
        return { ok: false, error: String(err && err.message ? err.message : err), log };
      }
    },
    {
      interimText,
      finalText,
      gapMs: GAP_MS,
      hasHooks,
      authKey: `sb-${process.env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([^.]+)\./)[1]}-auth-token`,
    }
  );
  report('race scenario ran without throwing', raceRun.ok, raceRun.ok ? '' : raceRun.error);

  const audioEvents = await page.evaluate(() => window.__audioEvents || []);
  fs.writeFileSync(path.join(OUT, `audio-events-${hasHooks ? 'postfix' : 'prefix'}.json`), JSON.stringify({ audioEvents, raceRun }, null, 2));

  // Build play intervals per Audio instance id: [play_ts, pause/ended_ts-or-open].
  const byId = {};
  for (const ev of audioEvents) {
    byId[ev.id] = byId[ev.id] || { id: ev.id, events: [] };
    byId[ev.id].events.push(ev);
  }
  const instances = Object.values(byId);
  const playedInstances = instances.filter((inst) => inst.events.some((e) => e.event === 'play'));
  report(
    'how many Audio instances actually reached play()',
    true,
    `${playedInstances.length} of ${instances.length} created instance(s)`
  );

  function playInterval(inst) {
    const playEv = inst.events.find((e) => e.event === 'play');
    const endEv = inst.events.find((e) => e.event === 'pause' || e.event === 'ended');
    return { start: playEv.ts, end: endEv ? endEv.ts : Infinity };
  }
  let overlapDetected = false;
  let overlapNote = '';
  for (let i = 0; i < playedInstances.length; i++) {
    for (let j = i + 1; j < playedInstances.length; j++) {
      const a = playInterval(playedInstances[i]);
      const b = playInterval(playedInstances[j]);
      const overlaps = a.start < b.end && b.start < a.end;
      if (overlaps) {
        overlapDetected = true;
        overlapNote = `instance ${playedInstances[i].id} [${a.start.toFixed(0)}-${a.end === Infinity ? 'open' : a.end.toFixed(0)}] overlaps instance ${playedInstances[j].id} [${b.start.toFixed(0)}-${b.end === Infinity ? 'open' : b.end.toFixed(0)}]`;
      }
    }
  }

  if (expectArg === 'overlap') {
    report('pre-fix reproduction: genuine audio overlap detected (proves this harness catches the bug)', overlapDetected, overlapNote || 'no overlap found — harness or race timing needs adjustment');
  } else {
    report('no interim-ack/final-answer audio overlap detected', !overlapDetected, overlapNote || `${playedInstances.length} instance(s) played, no overlapping intervals`);
    if (hasHooks) {
      // Stronger post-fix assertion: the interim ack (created first) should
      // never even reach play() once superseded — confirms the in-flight
      // guard, not just "didn't audibly overlap by luck."
      const interimNeverPlayed = playedInstances.length <= 1;
      report('interim ack audio never started playing after being superseded by the real answer', interimNeverPlayed, `${playedInstances.length} instance(s) reached play()`);
    }
  }

  await page.screenshot({ path: path.join(OUT, `final-${hasHooks ? 'postfix' : 'prefix'}.png`), fullPage: true }).catch(() => {});
  await browser.close();

  const overall = results.every((r) => r.pass);
  fs.writeFileSync(path.join(OUT, `results-${hasHooks ? 'postfix' : 'prefix'}.json`), JSON.stringify({ mode, expectArg, results, pageErrors, overall }, null, 2));
  console.log('\n========== SUMMARY ==========');
  console.log(`Mode: ${mode}`);
  results.forEach((r) => console.log(`${r.pass ? 'PASS' : 'FAIL'} — ${r.name}${r.note ? ' :: ' + r.note : ''}`));
  console.log(`Page errors: ${pageErrors.length}`);
  pageErrors.forEach((e) => console.log('  ' + e));
  console.log(`OVERALL: ${overall ? 'PASS' : 'FAIL'}`);
  console.log(`Artifacts: ${OUT}`);
  process.exit(overall ? 0 : 1);
})().catch((e) => {
  console.error('[verify] CRASH', e.stack || e);
  process.exit(1);
});
