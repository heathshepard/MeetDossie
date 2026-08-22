#!/usr/bin/env node
// scripts/carter-jarvis-barge-in-verify.js
//
// Real-browser verification (per CLAUDE.md "VERIFY IN A REAL BROWSER BEFORE
// HANDOFF") for the 2026-08-22 true-barge-in feature: while Jarvis is
// speaking, real sustained speech picked up by the mic should stop the
// current TTS playback and resume listening — same effect as the existing
// manual tap-to-interrupt, but without requiring the tap.
//
// This can't be tested with an actual physical mic/speaker from a headless
// sandbox, so it drives Chromium's fake-audio-capture device
// (--use-file-for-fake-audio-capture=<wav>) as the "microphone" — a REAL
// getUserMedia stream, REAL Web Audio analyser, REAL RMS math running
// through the actual shipped code (startVadLoop's barge-in branch), just
// with a synthetic input signal instead of a physical one. Three runs:
//
//   A. fake-speech.wav (loud, sustained tone) + barge-in ON (default)
//      -> EXPECT an early interrupt: the currently-playing TTS <audio> gets
//         paused well before its natural duration, and the
//         '[jarvis-barge-in]' console log fires.
//   B. fake-speech.wav (same loud tone) + ?bargein=0 (kill switch)
//      -> EXPECT NO early interrupt — proves the safety-valve toggle
//         actually gates the feature.
//   C. fake-silence.wav (true silence) + barge-in ON
//      -> EXPECT NO early interrupt — proves this is genuinely audio-level
//         gated (being in 'speaking' state with barge-in enabled does NOT
//         alone cause a self-trigger; a real signal above threshold is
//         required).
//
// EXPLICIT LIMITATION (report this, don't bury it): this does NOT prove
// Jarvis won't hear its OWN TTS played back through a real speaker into a
// real mic (acoustic self-echo) — that requires physical speaker->mic
// loopback hardware this sandbox doesn't have. See the BARGE_IN comment
// block in jarvis-pwa.html for the mitigations shipped specifically because
// that risk can't be verified here (Capacitor-native disabled outright,
// stricter threshold, instant kill switch).
//
// Usage: node scripts/carter-jarvis-barge-in-verify.js <BASE_URL>

'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?\r?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const BASE = (process.argv[2] || '').replace(/\/$/, '');
if (!BASE) {
  console.error('Usage: node scripts/carter-jarvis-barge-in-verify.js <BASE_URL>');
  process.exit(2);
}
const JARVIS_URL = `${BASE}/myjarvis`;
const EMAIL = 'heath.shepard@kw.com';
const SCRATCH = '/tmp/claude-1000/-mnt-c-Users-Heath-Projects-MeetDossie/cfa4d869-fe7b-4066-8212-1d7d43963f46/scratchpad';
const SPEECH_WAV = path.join(SCRATCH, 'fake-speech.wav');
const SILENCE_WAV = path.join(SCRATCH, 'fake-silence.wav');
const OUT = path.join(__dirname, 'atlas-runs', 'carter-jarvis-barge-in-2026-08-22');
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

async function signIn(page, urlWithQuery) {
  const session = await mintHeathSession();
  const projectRef = process.env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([^.]+)\./)[1];
  await page.goto(urlWithQuery, { waitUntil: 'commit', timeout: 20000 });
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
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    const gate = document.getElementById('auth-gate');
    const gateHidden = !gate || window.getComputedStyle(gate).display === 'none';
    return gateHidden && !!document.getElementById('ptt');
  });
}

// Runs one scenario in its own browser (fake-audio-capture is a launch-time
// flag, can't change per-page) and returns { pauseEvent, bargeInLogSeen, sawError }.
async function runScenario(name, { wavPath, queryString, observeMs }) {
  console.log(`\n[verify] === scenario ${name} === wav=${path.basename(wavPath)} query=${queryString || '(none)'}`);
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wavPath}`,
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1600 } });
  await ctx.grantPermissions(['microphone'], { origin: BASE }).catch((e) => console.warn('grantPermissions failed (non-fatal):', e.message));
  const page = await ctx.newPage();
  const consoleLines = [];
  page.on('console', (msg) => consoleLines.push(msg.text()));
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));

  const url = `${JARVIS_URL}${queryString ? '?' + queryString : ''}`;
  const signedIn = await signIn(page, url);
  if (!signedIn) {
    await page.screenshot({ path: path.join(OUT, `${name}-signin-fail.png`), fullPage: true });
    await browser.close();
    return { ok: false, error: 'sign-in failed' };
  }

  const hasHooks = await page.evaluate(
    () => typeof window.__jarvisSpeakBridgeAnswer === 'function'
      && typeof window.__jarvisEnsureMic === 'function'
      && typeof window.__jarvisStartVadLoop === 'function'
      && typeof window.__jarvisGetPttState === 'function'
  );
  if (!hasHooks) {
    await browser.close();
    return { ok: false, error: 'debug hooks missing on this deployment — barge-in build not live yet' };
  }

  // Wrap Audio the same way the interim-ack-overlap harness does, so a
  // pause() triggered by the real bridgeVoiceInterrupt closure (set inside
  // speakBridgeAnswer) shows up as a real, timestamped event — not inferred.
  await page.evaluate(() => {
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
        return origPlay();
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
  });

  // Long enough that ElevenLabs TTS playback runs well past our observation
  // window on its own — any pause() we see inside the window can only be
  // the barge-in interrupt, not natural completion.
  const longText = 'This is a long test answer for the barge-in verification harness. '.repeat(30);

  const runResult = await page.evaluate(async (text) => {
    const log = [];
    const t0 = performance.now();
    try {
      // speakBridgeAnswer resolves once playback STARTS (audio.play()), not
      // once it ends — this returns quickly, pttState is 'speaking' after.
      await window.__jarvisSpeakBridgeAnswer(text);
      log.push({ ts: performance.now() - t0, event: 'speakBridgeAnswer resolved (playback started)', pttState: window.__jarvisGetPttState() });

      const stream = await window.__jarvisEnsureMic();
      log.push({ ts: performance.now() - t0, event: 'ensureMic resolved', gotStream: !!stream });
      if (!stream) return { ok: false, error: 'ensureMic returned null', log };

      window.__jarvisStartVadLoop(stream);
      log.push({ ts: performance.now() - t0, event: 'startVadLoop called' });

      return { ok: true, log };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err), log };
    }
  }, longText);

  if (!runResult.ok) {
    await browser.close();
    return { ok: false, error: runResult.error, log: runResult.log };
  }

  // Observe for `observeMs` — poll pttState + audio events.
  const samples = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt < observeMs) {
    await page.waitForTimeout(300);
    const pttState = await page.evaluate(() => window.__jarvisGetPttState());
    samples.push({ tMs: Date.now() - startedAt, pttState });
  }

  const audioEvents = await page.evaluate(() => window.__audioEvents || []);
  const pauseEvent = audioEvents.find((e) => e.event === 'pause');
  const bargeInLogSeen = consoleLines.some((l) => l.includes('[jarvis-barge-in] real speech detected'));

  fs.writeFileSync(
    path.join(OUT, `${name}-detail.json`),
    JSON.stringify({ runResult, samples, audioEvents, bargeInLogSeen, pageErrors }, null, 2)
  );
  await page.screenshot({ path: path.join(OUT, `${name}-final.png`), fullPage: true }).catch(() => {});
  await browser.close();

  return {
    ok: true,
    pauseEvent,
    pauseWithinMs: pauseEvent ? pauseEvent.ts : null,
    bargeInLogSeen,
    finalPttState: samples.length ? samples[samples.length - 1].pttState : null,
    pageErrors,
  };
}

(async () => {
  // Scenario A — barge-in should fire.
  const a = await runScenario('A-speech-enabled', { wavPath: SPEECH_WAV, queryString: '', observeMs: 6000 });
  if (!a.ok) {
    report('scenario A ran without setup error', false, a.error);
  } else {
    report('scenario A ran without setup error', true);
    report('A: barge-in interrupted the playing TTS audio (pause() observed)', !!a.pauseEvent, a.pauseEvent ? `paused at t=${a.pauseWithinMs.toFixed(0)}ms` : 'no pause event seen');
    report('A: [jarvis-barge-in] log fired', a.bargeInLogSeen);
    report('A: no page errors', a.pageErrors.length === 0, a.pageErrors.join(' | '));
  }

  // Scenario B — same loud signal, kill switch on. Must NOT interrupt.
  const b = await runScenario('B-speech-disabled', { wavPath: SPEECH_WAV, queryString: 'bargein=0', observeMs: 6000 });
  if (!b.ok) {
    report('scenario B ran without setup error', false, b.error);
  } else {
    report('scenario B ran without setup error', true);
    report('B: kill switch (?bargein=0) suppressed the interrupt (no pause() observed)', !b.pauseEvent, b.pauseEvent ? `unexpected pause at t=${b.pauseWithinMs.toFixed(0)}ms` : 'no early pause — correct');
    report('B: no [jarvis-barge-in] log (correctly gated off)', !b.bargeInLogSeen);
  }

  // Scenario C — barge-in on, but the "mic" is genuine silence. Must NOT interrupt.
  const c = await runScenario('C-silence-enabled', { wavPath: SILENCE_WAV, queryString: '', observeMs: 6000 });
  if (!c.ok) {
    report('scenario C ran without setup error', false, c.error);
  } else {
    report('scenario C ran without setup error', true);
    report('C: silence did not falsely trigger an interrupt (no pause() observed)', !c.pauseEvent, c.pauseEvent ? `unexpected pause at t=${c.pauseWithinMs.toFixed(0)}ms` : 'no early pause — correct');
    report('C: no [jarvis-barge-in] log on silence', !c.bargeInLogSeen);
  }

  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, a, b, c }, null, 2));
  console.log('\n========== SUMMARY ==========');
  results.forEach((r) => console.log(`${r.pass ? 'PASS' : 'FAIL'} — ${r.name}${r.note ? ' :: ' + r.note : ''}`));
  const overall = results.every((r) => r.pass);
  console.log(`OVERALL: ${overall ? 'PASS' : 'FAIL'}`);
  console.log(`Artifacts: ${OUT}`);
  console.log('\nNOTE: this proves the barge-in DETECTION+INTERRUPT logic and its kill');
  console.log('switch on real getUserMedia/analyser/Audio-element code paths, using a');
  console.log('synthetic fake-microphone signal. It does NOT prove Jarvis will never');
  console.log('hear its own TTS through a real speaker on a real device (acoustic');
  console.log('self-echo) — that needs Heath testing on his actual phone/browser.');
  process.exit(overall ? 0 : 1);
})().catch((e) => {
  console.error('[verify] CRASH', e.stack || e);
  process.exit(1);
});
