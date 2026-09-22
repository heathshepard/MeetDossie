#!/usr/bin/env node
/**
 * audio-chain.js — Heath's note 3 default: audio cleanup chain.
 *
 * Preferred path: ElevenLabs Audio Isolation (POST /v1/audio-isolation),
 * used ONLY when the API key actually has that permission — detected by
 * making the real call and reading the error, never assumed from the key
 * existing. Isolation keys often lack this scope; ElevenLabs returns a
 * distinct 401/403 body for "missing_permissions" vs a bad/expired key,
 * which `detectIsolationPermission` checks for explicitly.
 *
 * Fallback chain (ffmpeg -af, single pass): arnndn (RNNoise) -> 3-band EQ
 * (HPF 80Hz, -4dB@330Hz, +3dB@3.2kHz) -> gentle expander (noise gate below
 * -40dB) -> 2.5:1 compression -> loudnorm to -16 LUFS.
 *
 * Usage:
 *   node scripts/video-engine/audio-chain.js --src <audio or video> --out <wav/mp3> [--rnnoiseModel <path>]
 * Or import { detectIsolationPermission, isolateAudio, buildFallbackFilterChain } as a library.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function loadEnvLocal() {
  const envPath = path.join(__dirname, '..', '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) {
      let val = m[2].trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      process.env[m[1]] = val;
    }
  }
}

function parseArgs() {
  const a = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) {
      const key = a[i].slice(2);
      const val = (a[i + 1] && !a[i + 1].startsWith('--')) ? a[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

/**
 * detectIsolationPermission — makes ONE real call to ElevenLabs Audio
 * Isolation with a tiny throwaway silent WAV, and classifies the result:
 *   - ok: the key has the permission, isolation is usable.
 *   - no_permission: the API explicitly says this key/plan lacks the scope
 *     (status 401/403 with a permission-shaped error body).
 *   - error: something else went wrong (network, bad key, rate limit) —
 *     caller should treat this as "not usable right now" but it is NOT the
 *     same fact as no_permission, so it's reported separately.
 */
async function detectIsolationPermission(apiKey) {
  if (!apiKey || apiKey === '[SENSITIVE]') return { status: 'error', reason: 'no usable ELEVENLABS_API_KEY in this environment' };
  // HARD API CONSTRAINT (confirmed live 2026-09-22): minimum input duration
  // is 4.6 s. Anything shorter comes back HTTP 400 audio_too_short /
  // invalid_audio_duration. The old probe here was 0.1 s, so after the
  // permission was granted this function would have kept reporting
  // status:'error' forever and isolation would have stayed silently off —
  // exactly the class of silent failure that keeps biting. Probe with 5.0 s.
  const sampleRate = 16000;
  const numSamples = Math.round(sampleRate * 5.0);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);

  // Field name is `audio`, not `file` — confirmed via the API's own 422
  // "Field required" body naming it (docs are ambiguous; the live error is
  // the ground truth here, which is the whole point of probing for real
  // instead of assuming).
  const form = new FormData();
  form.append('audio', new Blob([buf]), 'probe.wav');
  try {
    const resp = await fetch('https://api.elevenlabs.io/v1/audio-isolation', {
      method: 'POST', headers: { 'xi-api-key': apiKey }, body: form,
    });
    if (resp.ok) return { status: 'ok' };
    const bodyText = await resp.text();
    const permissionShaped = (resp.status === 401 || resp.status === 403) &&
      /permission|not_allowed|missing_scope|unauthorized/i.test(bodyText);
    if (permissionShaped) return { status: 'no_permission', httpStatus: resp.status, body: bodyText.slice(0, 300) };
    if (/audio_too_short|invalid_audio_duration/i.test(bodyText)) {
      return { status: 'error', httpStatus: resp.status, body: bodyText.slice(0, 300), reason: 'probe payload under the 4.6 s minimum — this is a bug in the probe, not a permission problem' };
    }
    return { status: 'error', httpStatus: resp.status, body: bodyText.slice(0, 300) };
  } catch (e) {
    return { status: 'error', reason: e.message };
  }
}

/** The API's hard floor. Below this it returns 400, not a shorter result. */
const ISOLATION_MIN_SEC = 4.6;

/**
 * isolateAudio — send ONE file to /v1/audio-isolation and write the result.
 *
 * Call this on the WHOLE take, before any cutting. Per-clip isolation fails
 * at runtime the moment a cut lands under ISOLATION_MIN_SEC, and isolating
 * each segment separately would also give each one its own noise profile,
 * which is audible as the floor shifting at every splice.
 */
async function isolateAudio(apiKey, inputWavPath, outPath) {
  const durSec = (() => {
    try { return parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', inputWavPath]).toString().trim()); }
    catch { return null; }
  })();
  if (durSec != null && durSec < ISOLATION_MIN_SEC) {
    throw new Error(`Audio Isolation needs >= ${ISOLATION_MIN_SEC}s of input; got ${durSec.toFixed(2)}s. Isolate the full take before cutting, not a clip.`);
  }
  const buf = fs.readFileSync(inputWavPath);
  const form = new FormData();
  form.append('audio', new Blob([buf]), path.basename(inputWavPath));
  const resp = await fetch('https://api.elevenlabs.io/v1/audio-isolation', {
    method: 'POST', headers: { 'xi-api-key': apiKey }, body: form,
  });
  if (!resp.ok) throw new Error(`Audio Isolation failed ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const arrBuf = await resp.arrayBuffer();
  fs.writeFileSync(outPath, Buffer.from(arrBuf));
}

/**
 * buildFallbackFilterChain — the -af filter STRING for the non-isolation
 * path. Order matters: denoise before EQ/compression, or the noise floor
 * gets amplified along with the voice.
 *   1. arnndn (RNNoise) — voice denoise, only if the model file exists.
 *   2. HPF 80Hz — removes room rumble / handling noise below the voice band.
 *   3. -4dB @ 330Hz — the "boxy" room-resonance band Heath's untreated
 *      rooms keep showing up in (see room-band gate calibration).
 *   4. +3dB @ 3.2kHz — presence lift for clarity on phone speakers.
 *   5. Gentle expander (noise gate) below -40dB — cleans up between-word
 *      silence without pumping.
 *   6. 2.5:1 compression — evens out level without squashing dynamics.
 *   7. loudnorm to -16 LUFS integrated, -1dBTP ceiling.
 */
function buildFallbackFilterChain(rnnoiseModelPath) {
  const parts = [];
  if (rnnoiseModelPath && fs.existsSync(rnnoiseModelPath)) {
    parts.push(`arnndn=m=${rnnoiseModelPath.replace(/:/g, '\\:')}`);
  }
  parts.push('highpass=f=80');
  parts.push('equalizer=f=330:t=q:w=1.2:g=-4');
  parts.push('equalizer=f=3200:t=q:w=1.0:g=3');
  // Expander: compand with a soft knee that leaves anything above -40dB
  // alone and pulls quieter stuff down further (gate-like, not a hard gate).
  parts.push('compand=attacks=0.02:decays=0.15:points=-90/-90|-40/-45|-30/-32|0/0:soft-knee=6');
  // 2.5:1 compressor via acompressor (ratio 2.5, moderate threshold/attack/release).
  parts.push('acompressor=threshold=-20dB:ratio=2.5:attack=8:release=200:makeup=2');
  parts.push('loudnorm=I=-16:TP=-1:LRA=11');
  return parts.join(',');
}

async function main() {
  loadEnvLocal();
  const args = parseArgs();
  const src = args.src, out = args.out;
  if (!src || !out) {
    console.error('Usage: audio-chain.js --src <audio/video> --out <wav>');
    process.exit(1);
  }
  const rnnoiseModel = require('./model-path.js').resolveModel('rnnoise-mp.rnnn', args.rnnoiseModel);
  const key = process.env.ELEVENLABS_API_KEY;

  const perm = await detectIsolationPermission(key);
  console.log('Isolation permission check:', JSON.stringify(perm));

  if (perm.status === 'ok') {
    console.log('Using ElevenLabs Audio Isolation.');
    // Isolation expects a clean audio file — extract mono 44.1k wav first.
    const tmp = out + '.pre-isolation.wav';
    execFileSync('ffmpeg', ['-y', '-i', src, '-vn', '-ac', '1', '-ar', '44100', tmp, '-hide_banner', '-loglevel', 'error']);
    await isolateAudio(key, tmp, out);
    fs.unlinkSync(tmp);
  } else {
    console.log(`Isolation unavailable (${perm.status}) — using fallback filter chain.`);
    const af = buildFallbackFilterChain(rnnoiseModel);
    execFileSync('ffmpeg', ['-y', '-i', src, '-vn', '-af', af, out, '-hide_banner', '-loglevel', 'error']);
  }
  console.log('Wrote', out);
}

module.exports = { detectIsolationPermission, isolateAudio, buildFallbackFilterChain, ISOLATION_MIN_SEC };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
