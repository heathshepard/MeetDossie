#!/usr/bin/env node
/**
 * edit.js — the orchestrator. One command, raw footage + a brief JSON in,
 * a finished 1080x1920 H.264 reel out.
 *
 * Chain: transcribe (ElevenLabs scribe_v1) -> cutlist (silence/um/false-start
 * removal, optional open-on / end-after line) -> trim+concat render ->
 * face-tracked auto-frame crop -> optional matte + refined composite over a
 * backdrop -> reassemble -> optional last-frame hold + brand end card ->
 * burn captions (libass) -> voice cleanup (+ optional de-room, sync nudge)
 * + music -> final encode -> quality gate.
 *
 * Background separation (matte.js) is off unless --matte or brief.matte —
 * it's the slowest stage (real measured throughput in
 * Media/video-engine-proto/matte-test/matte-report.json) and the edge quality
 * has known failure modes on fast hand motion. When on, it composites AFTER
 * the crop using the face-crop output as input frames, then
 * refine-composite.js (temporal median + erode + feather + despill) puts the
 * subject over brief.backdrop ("navy" | "workspace" | <png path>).
 *
 * Every knob the reviewer (review.js) turns is a brief field, so produce.js
 * can feed review notes straight back in. scripts/video-engine/fix-registry.js
 * is the contract; EVERY field listed there must be read somewhere below, and
 * `node scripts/video-engine/fix-registry.js` fails if one isn't.
 *   cut:      silenceThreshold, padStart, padEnd, minKeep,
 *             startAtLine, endAfterLine, dropLines
 *   shots:    shotPlan, minShotSec, maxShotSec, punchFactor, maxScaleRatio,
 *             punchZoomMax, openOnFace, openWide, jlCutSec
 *   framing:  zoom, smooth, sampleEvery, headroom, matte, backdrop,
 *             matteErode, matteFeather, vignette
 *   captions: hookLine, cta, emphasisWords, captionSize, captionMarginV,
 *             captionBox, captionStyle, captionCoverage
 *   audio:    musicMood, musicVolume, deroom, audioOffsetMs, loudnessTarget,
 *             compressorRatio, denoiseStrength, deess, presenceDb
 *   ending:   ending ("caption" | "card"), endHoldSec, endCardSec,
 *             cardTagline, blackFrameGuard
 *   b-roll:   brollInserts = [{ atSec, path, durationSec }] (post-cut seconds)
 *
 * SHOT PLAN (2026-09-22) — the fix for the defect that produced
 * dossie_trial_06.mp4: 35.7 s with its first picture change at 27.0 s.
 * edit.js could not change the picture at all; it rendered one continuous
 * framing and review.js's §4 findings had nothing to drive. Stage 4b now
 * builds a shot plan from the transcript's sentence/clause boundaries and
 * face-track-crop.js hard-cuts the framing between shots. It removes no time
 * and touches no audio, so it cannot clip a word or move lip sync.
 *
 * --reuse: skip any stage whose inputs (files + the brief fields it reads)
 * are unchanged since the last run in this workdir. A second round that only
 * changes padding re-cuts and re-crops; one that only changes the backdrop
 * re-composites from the saved alpha/fgr without touching the model.
 *
 * Usage:
 *   node scripts/video-engine/edit.js --src <raw.mp4> --brief <brief.json> --out <final.mp4>
 *     [--matte] [--backdrop <png>] [--workdir <dir>] [--reuse]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

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

const ROOT = path.join(__dirname, '..', '..');
function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}
function node(scriptRel, args) { run('node', [path.join(__dirname, scriptRel), ...args]); }

function ffprobeJson(file, entries) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'json', file], { cwd: ROOT }).toString();
  return JSON.parse(out);
}
function fileKey(f) {
  if (!fs.existsSync(f)) return 'missing';
  const st = fs.statSync(f);
  return `${st.size}:${Math.round(st.mtimeMs)}`;
}
function dirKey(d) {
  if (!fs.existsSync(d)) return 'missing';
  const files = fs.readdirSync(d).filter(f => /\.png$/i.test(f)).sort();
  if (!files.length) return 'empty';
  return `${files.length}:${fileKey(path.join(d, files[0]))}:${fileKey(path.join(d, files[files.length - 1]))}`;
}
function esc(p) { return p.replace(/\\/g, '/').replace(/:/g, '\\:'); }

function loadEnvLocal() {
  const envPath = path.join(ROOT, '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) {
      let val = m[2].trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      process.env[m[1]] = val;
    }
  }
}

/**
 * Stage 0 — ElevenLabs Audio Isolation on the FULL take, before any cutting.
 *
 * Heath's named rejection on the early cuts was hollow open-room phone-mic
 * audio, and plain afftdn/arnndn does not remove a room. Isolation does.
 *
 * Three constraints shape this:
 *  1. The API's minimum input is 4.6 s (HTTP 400 below it), so this runs on
 *     the whole take exactly once. Per-clip isolation would blow up the
 *     moment a cut came in short, and would also hand every segment its own
 *     noise profile — audible as the floor shifting at each splice.
 *  2. The isolated audio is muxed back onto the ORIGINAL video at the
 *     original timeline before anything else runs, so render-cutlist.js
 *     still trims picture and sound from identical timestamps of a single
 *     file. Isolation therefore cannot introduce the lip-sync drift Heath
 *     flagged on trial 01 — the streams are never separately edited.
 *  3. §6 counts "overprocessed / hollow / underwater" as a failure in its
 *     own right, so this A/Bs the result and KEEPS THE ORIGINAL if isolation
 *     did not actually improve it. Measured, not assumed.
 *
 * Returns { src, report } — src is whichever take won.
 */
async function isolationPrePass(src, workDir, brief, chanFixMono) {
  const p = (n) => path.join(workDir, n);
  const report = { attempted: false, used: false, reason: null, metrics: null };
  if (brief.audioIsolation === false) { report.reason = 'brief.audioIsolation === false'; return { src, report }; }
  loadEnvLocal();
  const AC = require('./audio-chain.js');
  const key = process.env.ELEVENLABS_API_KEY;
  const isolatedMp4 = p('source-isolated.mp4');
  const decisionPath = p('isolation-report.json');
  if (fs.existsSync(isolatedMp4) && fs.existsSync(decisionPath)) {
    const prev = JSON.parse(fs.readFileSync(decisionPath, 'utf8'));
    if (prev.srcKey === fileKey(src)) {
      console.log(`[edit] isolation: reusing previous decision (${prev.used ? 'isolated' : 'original'} audio) — ${prev.reason}`);
      return { src: prev.used ? isolatedMp4 : src, report: prev };
    }
  }
  report.attempted = true;
  report.srcKey = fileKey(src);
  try {
    const perm = await AC.detectIsolationPermission(key);
    if (perm.status !== 'ok') {
      report.reason = `isolation unavailable (${perm.status}${perm.reason ? `: ${perm.reason}` : ''}) — keeping the original audio and relying on the de-room EQ chain`;
      console.warn(`[edit] ${report.reason}`);
      fs.writeFileSync(decisionPath, JSON.stringify(report, null, 2));
      return { src, report };
    }
    const preWav = p('pre-isolation.wav');
    // FOLD, don't downmix. `-ac 1` alone on a one-lav-into-one-input
    // recording averages the live channel with a silent one: -6 dB of the
    // only signal in the file, handed to Audio Isolation as its input.
    const foldArgs = chanFixMono ? ['-af', chanFixMono] : [];
    run('ffmpeg', ['-y', '-i', src, '-vn', ...foldArgs, '-ac', '1', '-ar', '44100', preWav, '-hide_banner', '-loglevel', 'error']);
    const isoMp3 = p('isolated.mp3');
    console.log('[edit] isolation: sending the full take to ElevenLabs Audio Isolation (one call)...');
    await AC.isolateAudio(key, preWav, isoMp3);

    // Length guard: the muxed timeline must match the source to the frame,
    // or every downstream timestamp is wrong.
    const dur = (f) => parseFloat(ffprobeJson(f, 'format=duration').format.duration);
    const srcDur = dur(preWav), isoDur = dur(isoMp3);
    report.srcDurationSec = +srcDur.toFixed(3); report.isolatedDurationSec = +isoDur.toFixed(3);
    if (Math.abs(isoDur - srcDur) > 0.10) {
      report.reason = `isolated audio is ${(isoDur - srcDur).toFixed(3)}s off the source length — refusing to mux it (that difference is exactly how lip sync drifts)`;
      console.warn(`[edit] ${report.reason}`);
      fs.writeFileSync(decisionPath, JSON.stringify(report, null, 2));
      return { src, report };
    }

    // A/B on the real measurements the reviewer grades: room boxiness
    // (200-500 Hz over 1-4 kHz) and HF balance (4-7.8 kHz over 1-4 kHz).
    // Isolation wins only if it takes boxiness DOWN without collapsing the
    // highs — collapsing the highs is what "underwater" sounds like.
    const A = require('./review-lib/audio.js');
    const tw = JSON.parse(fs.readFileSync(p('transcript.json'), 'utf8')).words.filter(w => w.type === 'word');
    const before = { boxiness: A.boxiness(preWav, tw), hf: A.deliveryChain(preWav, tw).hfBalanceDb };
    const after = { boxiness: A.boxiness(isoMp3, tw), hf: A.deliveryChain(isoMp3, tw).hfBalanceDb };
    report.metrics = { before, after };
    const boxImproved = before.boxiness != null && after.boxiness != null && after.boxiness < before.boxiness - 0.3;
    const hfCollapsed = before.hf != null && after.hf != null && after.hf < before.hf - 6;
    console.log(`[edit] isolation A/B — boxiness ${before.boxiness} -> ${after.boxiness} dB, HF balance ${before.hf} -> ${after.hf} dB`);
    if (!boxImproved || hfCollapsed) {
      report.reason = hfCollapsed
        ? `isolation collapsed the highs (HF ${before.hf} -> ${after.hf} dB) — that is the "underwater" failure §6 names; keeping the original`
        : `isolation did not reduce room boxiness (${before.boxiness} -> ${after.boxiness} dB); keeping the original rather than adding artifacts for nothing`;
      console.warn(`[edit] ${report.reason}`);
      fs.writeFileSync(decisionPath, JSON.stringify(report, null, 2));
      return { src, report };
    }
    // Mux the isolated audio back onto the untouched video, same timeline.
    run('ffmpeg', ['-y', '-i', src, '-i', isoMp3, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', isolatedMp4, '-hide_banner', '-loglevel', 'error']);
    report.used = true;
    report.reason = `isolation improved room boxiness ${before.boxiness} -> ${after.boxiness} dB with HF balance ${before.hf} -> ${after.hf} dB`;
    console.log(`[edit] isolation: USING the isolated take — ${report.reason}`);
    fs.writeFileSync(decisionPath, JSON.stringify(report, null, 2));
    return { src: isolatedMp4, report };
  } catch (e) {
    report.reason = `isolation errored (${e.message.slice(0, 200)}) — keeping the original audio`;
    console.warn(`[edit] ${report.reason}`);
    fs.writeFileSync(decisionPath, JSON.stringify(report, null, 2));
    return { src, report };
  }
}

async function main() {
  const args = parseArgs();
  const src = args.src, briefPath = args.brief, finalOut = args.out;
  // ALWAYS absolute — ffmpeg's concat demuxer resolves relative entries in a
  // list file relative to the LIST FILE's own directory, not cwd, so a
  // relative workDir silently double-joins itself (".tmp/x/.tmp/x/file.mp4")
  // the moment any concat step runs. Cost one real failed run to catch.
  const workDir = path.resolve(ROOT, args.workdir || path.join('.tmp', `edit-${Date.now()}`));
  const reuse = !!args.reuse;
  // Caps frame count on 4K60 phone footage to something the local ONNX/JS
  // pipeline can actually finish; 30 is the delivery frame rate anyway.
  const workFps = parseInt(args.workFps || '30', 10);
  if (!src || !briefPath || !finalOut) {
    console.error('Usage: edit.js --src <raw.mp4> --brief <brief.json> --out <final.mp4> [--matte] [--backdrop <png>] [--workdir <dir>] [--reuse]');
    process.exit(1);
  }
  const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  const useMatte = !!args.matte || !!brief.matte;
  fs.mkdirSync(workDir, { recursive: true });
  // The output directory is not guaranteed to exist (a fresh worktree has no
  // Media/finished-videos). ffmpeg's "No such file or directory" for an
  // OUTPUT path reads like a missing input and cost a full render to diagnose.
  fs.mkdirSync(path.dirname(path.resolve(ROOT, finalOut)), { recursive: true });
  const p = (name) => path.join(workDir, name);

  // Stage cache: run fn() unless --reuse and the recorded input key matches.
  const stage = (name, key, outputs, fn) => {
    const stampPath = p(`${name}.stamp`);
    const have = outputs.every(o => fs.existsSync(o));
    if (reuse && have && fs.existsSync(stampPath) && fs.readFileSync(stampPath, 'utf8') === key) {
      console.log(`\n[edit] ${name}: unchanged, reusing`);
      return;
    }
    if (fs.existsSync(stampPath)) fs.unlinkSync(stampPath);
    fn();
    fs.writeFileSync(stampPath, key);
  };
  const pick = (...keys) => JSON.stringify(keys.map(k => brief[k] === undefined ? null : brief[k]));

  console.log(`=== Dossie local video engine ===\nsrc: ${src}\nbrief: ${briefPath}\nworkdir: ${workDir}\nmatte: ${useMatte}\nreuse: ${reuse}`);

  // 0a. SOURCE AUDIO DIAGNOSIS — before a single sample is touched.
  //     Two facts the rest of the chain cannot afford to guess at: is a
  //     channel dead, and is the take clipping. See audio-diagnose.js for
  //     why each one silently ruins the audio if it goes unhandled.
  //     ALWAYS printed, never cached — a caller that skips this and reads
  //     the JSON later still gets it, but the loud version is the point.
  const AUDIODIAG = require('./audio-diagnose.js');
  const audioDiag = AUDIODIAG.diagnose(src);
  console.log(AUDIODIAG.report(audioDiag));
  fs.writeFileSync(p('audio-diagnosis.json'), JSON.stringify(audioDiag, null, 2));
  // The fold, if one is needed. Applied at EVERY point audio is extracted or
  // re-encoded, because a dead channel that survives to the deliverable
  // means the voice plays out of one speaker.
  const chanFix = audioDiag.filters.channelFix;          // stereo fold, or null
  const chanFixMono = audioDiag.filters.channelFixMono;  // mono fold, or null

  // 0b. RECORDING PRESET — which physical setup was this shot from.
  //     brief.recordingPreset: a name | 'none' to disable | absent = auto.
  const RP = require('./recording-preset.js');
  const presetRes = await RP.resolvePreset({ src, explicit: brief.recordingPreset });
  console.log(`[edit] recording preset: ${presetRes.reason}`);
  fs.writeFileSync(p('recording-preset.json'), JSON.stringify({
    name: presetRes.name, how: presetRes.how, confidence: presetRes.confidence,
    reason: presetRes.reason, evidence: presetRes.evidence,
  }, null, 2));

  // 1. Extract 16kHz mono audio + transcribe.
  //    The fold matters here too: transcribing a (L+R)/2 downmix of a
  //    one-sided recording hands the model a signal 6 dB quieter than the
  //    one that was recorded, for no reason at all.
  stage('transcript', fileKey(src) + String(chanFixMono), [p('transcript.json')], () => {
    const af = chanFixMono ? ['-af', chanFixMono] : [];
    run('ffmpeg', ['-y', '-i', src, '-vn', ...af, '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', p('audio-16k.wav'), '-hide_banner', '-loglevel', 'error']);
    node('transcribe.js', ['--audio', p('audio-16k.wav'), '--out', p('transcript.json')]);
  });

  // 1a. ElevenLabs Audio Isolation on the FULL take (see isolationPrePass).
  //     Runs AFTER transcription (it uses the word timings to A/B the result)
  //     and BEFORE the cut, because the API needs >= 4.6 s of input and
  //     because muxing it back at the original timeline is what keeps picture
  //     and sound locked together through render-cutlist.js.
  const { src: workSrc, report: isoReport } = await isolationPrePass(src, workDir, brief, chanFixMono);
  fs.writeFileSync(p('isolation-report.json'), JSON.stringify(isoReport, null, 2));

  // 1b. Hook line — the one decision the standard gives no rule for. Auto-
  //     picked from the transcript when the brief doesn't name one, so a
  //     brief with only brand + CTA still produces a real §2 opening.
  if (!brief.hookLine) {
    const { pickHook } = require('./pick-hook.js');
    const hookPick = pickHook(JSON.parse(fs.readFileSync(p('transcript.json'), 'utf8')), brief.emphasisWords);
    brief.hookLine = hookPick.hookLine;
    fs.writeFileSync(p('hook-pick.json'), JSON.stringify(hookPick, null, 2));
    console.log(`[edit] auto-picked hook (no brief.hookLine): "${brief.hookLine}"`);
  }
  // Resolved brief (hookLine filled in either way) is what downstream stages read.
  const resolvedBriefPath = p('brief-resolved.json');
  fs.writeFileSync(resolvedBriefPath, JSON.stringify(brief, null, 2));

  // 2. Cut list (silence / filler / false-start removal + editorial bounds).
  const CUT_KEYS = ['silenceThreshold', 'padStart', 'padEnd', 'minKeep', 'startAtLine', 'endAfterLine', 'dropLines'];
  stage('cutlist', fileKey(p('transcript.json')) + pick(...CUT_KEYS), [p('cutlist.json')], () => {
    const cArgs = ['--transcript', p('transcript.json'), '--out', p('cutlist.json')];
    for (const k of CUT_KEYS) {
      let v = brief[k];
      if (v == null || v === '') continue;
      if (k === 'dropLines' && Array.isArray(v)) v = v.join('||');
      cArgs.push(`--${k}`, String(v));
    }
    node('cutlist.js', cArgs);
  });

  // 3. Trim + concat render. The intermediate is scaled so its long edge is
  //    1.5x the output's (2880 px): the face crop still has headroom to punch
  //    in, and a 4K60 phone take otherwise re-encodes at ~2 fps here.
  const srcProbe = ffprobeJson(workSrc, 'stream=width,height,codec_type:stream_side_data=rotation');
  const srcV = srcProbe.streams.find(s => s.codec_type === 'video') || srcProbe.streams[0];
  const srcRot = (srcV.side_data_list || []).find(d => d.rotation != null);
  const swap = srcRot && Math.abs(srcRot.rotation % 180) === 90;
  const dispW = swap ? srcV.height : srcV.width, dispH = swap ? srcV.width : srcV.height;
  const longEdge = Math.max(dispW, dispH);
  const scaleF = Math.min(1, 2880 / longEdge);
  const interW = Math.round(dispW * scaleF / 2) * 2, interH = Math.round(dispH * scaleF / 2) * 2;
  stage('trimmed', fileKey(workSrc) + fileKey(p('cutlist.json')) + `${interW}x${interH}@${workFps}`, [p('trimmed.mp4')], () => {
    node('render-cutlist.js', ['--src', workSrc, '--cutlist', p('cutlist.json'), '--out', p('trimmed.mp4'), '--scale', `${interW}:${interH}`, '--preset', 'veryfast', '--fps', String(workFps)]);
  });

  // 4. Face-tracked auto-frame crop.
  const trimmedMeta = ffprobeJson(p('trimmed.mp4'), 'format=duration:stream=width,height,r_frame_rate');
  const fps = trimmedMeta.streams[0].r_frame_rate.split('/').reduce((a, b) => a / b);
  stage('frames', fileKey(p('trimmed.mp4')), [p('frames')], () => {
    fs.rmSync(p('frames'), { recursive: true, force: true });
    fs.mkdirSync(p('frames'), { recursive: true });
    run('ffmpeg', ['-y', '-i', p('trimmed.mp4'), p('frames/f%05d.png'), '-hide_banner', '-loglevel', 'error']);
  });
  // 4b. SHOT PLAN — the picture's edit. See the file header and shot-plan.js.
  //     Cuts come from the transcript's sentence/clause boundaries, so they
  //     land on meaning; nothing here removes time or touches audio.
  // RECORDING-PRESET SHOT RANGE. When a preset is active its shotRange — not
  // the engine's generic defaults — sets the wide/punch band, because the
  // generic defaults were written for arm's-length footage. The default
  // punchZoomMax of 1.6 is BELOW the kitchen-island preset's own verified
  // baseline of 1.6095, so leaving them in place would clamp the preset's
  // wide shot to something tighter than the framing Heath actually approved
  // and silently undo the whole preset. Explicit brief fields still win over
  // the preset — a reviewer fix must be able to override a config default.
  //
  // PRECEDENCE: reviewer override > preset > brief default > engine default.
  // The brief carries GENERIC defaults for framing (zoom 1.05, punchZoomMax
  // 1.6) written for arm's-length footage. Letting those beat the preset
  // would make the preset a no-op on the only brief that exists — the
  // kitchen-island baseline of 1.6095 is above the brief's own 1.6 cap. But
  // a value produce.js wrote in response to a review finding MUST still win,
  // or the loop cannot fix a framing complaint. The two are otherwise
  // indistinguishable once written to the same file, so produce.js records
  // every key it patches in brief._reviewerOverrides and this honours it.
  const presetShot = (presetRes.preset && presetRes.preset.shotRange) || null;
  const reviewerOverrides = new Set(Array.isArray(brief._reviewerOverrides) ? brief._reviewerOverrides : []);
  const dflt = (key, briefVal, presetVal, engineVal) => {
    if (reviewerOverrides.has(key) && briefVal != null) return briefVal;
    if (presetVal != null) return presetVal;
    if (briefVal != null) return briefVal;
    return engineVal;
  };
  const baseZoom = dflt('zoom', brief.zoom, presetShot && presetShot.wideZoom, 1.05);
  const punchFactor = dflt('punchFactor', brief.punchFactor, presetShot && presetShot.punchFactor, 1.18);
  const maxScaleRatioV = dflt('maxScaleRatio', brief.maxScaleRatio, presetShot && presetShot.maxScaleRatio, 1.3);
  const punchZoomMaxV = dflt('punchZoomMax', brief.punchZoomMax, presetShot && presetShot.punchZoomMax, 1.6);
  if (presetShot) console.log(`[edit] shot range from preset "${presetRes.name}": wide ${baseZoom}, punch x${punchFactor} (cap ${punchZoomMaxV}, max scale ratio ${maxScaleRatioV}).`);

  const SHOT_KEYS = ['shotPlan', 'minShotSec', 'maxShotSec', 'punchFactor', 'maxScaleRatio', 'punchZoomMax', 'openWide', 'jlCutSec', 'zoom'];
  const wantShotPlan = brief.shotPlan !== false; // ON by default — §4 is not optional
  if (wantShotPlan) {
    stage('shotplan', fileKey(p('cutlist.json')) + fileKey(p('transcript.json')) + pick(...SHOT_KEYS) + `preset:${presetRes.name}`, [p('shot-plan.json')], () => {
      const sArgs = ['--transcript', p('transcript.json'), '--cutlist', p('cutlist.json'), '--out', p('shot-plan.json'),
        '--baseZoom', String(baseZoom),
        '--minShotSec', String(brief.minShotSec != null ? brief.minShotSec : 1.8),
        '--maxShotSec', String(brief.maxShotSec != null ? brief.maxShotSec : 5.0),
        '--punchFactor', String(punchFactor),
        '--maxScaleRatio', String(maxScaleRatioV),
        '--punchZoomMax', String(punchZoomMaxV),
        '--openWide', String(brief.openWide === false ? 0 : 1),
        '--jlCutSec', String(brief.jlCutSec != null ? brief.jlCutSec : 0.14)];
      node('shot-plan.js', sArgs);
    });
  } else {
    console.warn('[edit] brief.shotPlan === false — rendering ONE continuous framing. This is the dossie_trial_06 failure mode (§4); only do it deliberately.');
    if (fs.existsSync(p('shot-plan.json'))) fs.unlinkSync(p('shot-plan.json'));
  }

  const CROP_KEYS = ['zoom', 'smooth', 'sampleEvery', 'headroom', 'punchZoomMax', 'maxScaleRatio', 'openOnFace'];
  // The preset payload handed to the tracker: the normalized rect (the only
  // resolution-independent form — these frames are downsampled from the
  // source), where the face sits inside it, and the tracking policy.
  const presetPayload = presetRes.preset ? JSON.stringify({
    name: presetRes.name,
    baselineCropNormalized: presetRes.preset.baselineCropNormalized,
    baselineZoom: presetRes.preset.baselineZoom,
    faceAnchor: presetRes.preset.faceAnchor,
    tracking: presetRes.preset.tracking,
  }) : null;
  stage('cropped', dirKey(p('frames')) + pick(...CROP_KEYS) + fileKey(p('shot-plan.json')) + `preset:${presetRes.name}`, [p('cropped/cropped')], () => {
    fs.rmSync(p('cropped'), { recursive: true, force: true });
    const presetSmooth = presetRes.preset && presetRes.preset.tracking && presetRes.preset.tracking.smooth;
    const fArgs = [
      '--frames', p('frames'), '--out', p('cropped'),
      '--zoom', String(dflt('zoom', brief.zoom, presetShot && presetShot.wideZoom, 1.2)),
      '--smooth', String(dflt('smooth', brief.smooth, presetSmooth, 0.18)),
      '--sampleEvery', String(brief.sampleEvery || 4), '--headroom', String(brief.headroom || 0),
      '--fps', String(Math.round(fps)),
      '--punchZoomMax', String(punchZoomMaxV),
      '--maxScaleRatio', String(maxScaleRatioV),
    ];
    if (presetPayload) fArgs.push('--presetBaseline', presetPayload);
    if (wantShotPlan && fs.existsSync(p('shot-plan.json'))) fArgs.push('--shotPlan', p('shot-plan.json'));
    if (brief.openOnFace) fArgs.push('--openOnFace', '1');
    node('face-track-crop.js', fArgs);
  });

  let videoFramesDir = p('cropped/cropped');

  // 5. Optional background separation + refined composite over the backdrop.
  if (useMatte) {
    let backdrop = args.backdrop || brief.backdrop || 'navy';
    if (backdrop === 'navy') { backdrop = p('navy-backdrop.png'); if (!fs.existsSync(backdrop)) node('gen-navy-backdrop.js', [backdrop]); }
    else if (backdrop === 'workspace') { backdrop = p('workspace-backdrop.png'); if (!fs.existsSync(backdrop)) node('gen-workspace-backdrop.js', [backdrop]); }
    else if (!fs.existsSync(backdrop)) throw new Error(`backdrop not found: ${backdrop}`);
    // The model pass is the expensive part; its alpha/fgr only depend on the cropped frames.
    stage('matte', dirKey(videoFramesDir), [p('matte/alpha'), p('matte/fgr')], () => {
      fs.rmSync(p('matte'), { recursive: true, force: true });
      node('matte.js', ['--frames', videoFramesDir, '--out', p('matte'), '--backdrop', backdrop]);
    });
    stage('refined', dirKey(p('matte/alpha')) + fileKey(backdrop) + pick('matteErode', 'matteFeather'), [p('matte/refined')], () => {
      fs.rmSync(p('matte/refined'), { recursive: true, force: true });
      node('refine-composite.js', ['--alpha', p('matte/alpha'), '--fgr', p('matte/fgr'), '--backdrop', backdrop, '--out', p('matte/refined'),
        '--erode', String(brief.matteErode != null ? brief.matteErode : 2), '--feather', String(brief.matteFeather != null ? brief.matteFeather : 2)]);
    });
    videoFramesDir = p('matte/refined');
  }

  // 6. Reassemble cropped(+matted) frames with the trimmed audio.
  stage('reassembled', dirKey(videoFramesDir) + fileKey(p('trimmed.mp4')), [p('reassembled.mp4')], () => {
    run('ffmpeg', ['-y', '-framerate', String(Math.round(fps)), '-i', path.join(videoFramesDir, 'f%05d.png'),
      '-i', p('trimmed.mp4'), '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', p('reassembled.mp4'), '-hide_banner', '-loglevel', 'error']);
  });

  // 7. Captions (ASS, burned in via libass — no drawtext in this ffmpeg build).
  //    --cropPath makes the vertical placement face-aware; --brief is the
  //    RESOLVED brief so an auto-picked hookLine actually reaches the card.
  const capArgs = ['--transcript', p('transcript.json'), '--cutlist', p('cutlist.json'), '--brief', resolvedBriefPath, '--out', p('captions.ass')];
  if (fs.existsSync(p('cropped/crop-path.json'))) capArgs.push('--cropPath', p('cropped/crop-path.json'));
  node('captions.js', capArgs);

  // 8. B-roll inserts (simple hard-cut splice at post-cut timeline seconds).
  let withBroll = p('reassembled.mp4');
  if (Array.isArray(brief.brollInserts) && brief.brollInserts.length) {
    // Build a concat list alternating main-video segments and b-roll clips.
    const dur = parseFloat(ffprobeJson(p('reassembled.mp4'), 'format=duration').format.duration);
    const inserts = [...brief.brollInserts].sort((a, b) => a.atSec - b.atSec);
    const segList = p('broll-segments.txt');
    const lines = [];
    let cursor = 0;
    inserts.forEach((ins, i) => {
      const mainSeg = p(`broll-main-${i}.mp4`);
      run('ffmpeg', ['-y', '-i', p('reassembled.mp4'), '-ss', String(cursor), '-to', String(ins.atSec),
        '-c:v', 'libx264', '-crf', '18', '-c:a', 'aac', mainSeg, '-hide_banner', '-loglevel', 'error']);
      lines.push(`file '${mainSeg}'`);
      const brollClip = p(`broll-clip-${i}.mp4`);
      run('ffmpeg', ['-y', '-i', ins.path, '-t', String(ins.durationSec), '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
        '-an', '-c:v', 'libx264', '-crf', '18', brollClip, '-hide_banner', '-loglevel', 'error']);
      // Give the b-roll silent audio track matching duration so concat audio streams line up.
      const brollWithAudio = p(`broll-clip-audio-${i}.mp4`);
      run('ffmpeg', ['-y', '-i', brollClip, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest',
        '-c:v', 'copy', '-c:a', 'aac', brollWithAudio, '-hide_banner', '-loglevel', 'error']);
      lines.push(`file '${brollWithAudio}'`);
      cursor = ins.atSec;
    });
    const tailSeg = p('broll-tail.mp4');
    run('ffmpeg', ['-y', '-i', p('reassembled.mp4'), '-ss', String(cursor), '-to', String(dur),
      '-c:v', 'libx264', '-crf', '18', '-c:a', 'aac', tailSeg, '-hide_banner', '-loglevel', 'error']);
    lines.push(`file '${tailSeg}'`);
    fs.writeFileSync(segList, lines.join('\n'));
    run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', segList, '-c', 'copy', p('with-broll.mp4'), '-hide_banner', '-loglevel', 'error']);
    withBroll = p('with-broll.mp4');
  }

  // 8b. Ending: hold the last frame, then a brand end card (navy + CTA).
  //     The voice always gets its full release before anything visual changes.
  let mainForFinal = withBroll;
  const endHoldSec = brief.endHoldSec != null ? +brief.endHoldSec : 0;
  const useCard = brief.ending === 'card';
  if (endHoldSec > 0 || useCard) {
    const fpsR = Math.round(fps);
    const enc = ['-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-r', String(fpsR), '-c:a', 'aac', '-ar', '48000', '-ac', '2'];
    const held = p('main-held.mp4');
    const vf = endHoldSec > 0 ? `tpad=stop_mode=clone:stop_duration=${endHoldSec}` : 'null';
    const af = endHoldSec > 0 ? `apad=pad_dur=${endHoldSec}` : 'anull';
    run('ffmpeg', ['-y', '-i', withBroll, '-vf', vf, '-af', af, ...enc, held, '-hide_banner', '-loglevel', 'error']);
    mainForFinal = held;
    if (useCard) {
      const cardSec = brief.endCardSec != null ? +brief.endCardSec : 2.4;
      const cardAss = p('end-card.ass');
      const cta = (brief.cta || 'Follow along as we build Dossie.').replace(/\n/g, '\\N');
      const tagline = brief.cardTagline || 'Your deals. Her job.';
      fs.writeFileSync(cardAss, `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Brand,Cormorant Garamond,54,&H006B83E8,&H000000FF,&H001A1A2E,&H00000000,0,0,0,0,100,100,6,0,1,0,0,8,90,90,700,1
Style: CTA,Cormorant Garamond,92,&H00FFFFFF,&H000000FF,&H001A1A2E,&H00000000,1,0,0,0,100,100,0,0,1,0,0,5,110,110,0,1
Style: Tag,Cormorant Garamond,44,&H00E0E6F5,&H000000FF,&H001A1A2E,&H00000000,0,1,0,0,100,100,1,0,1,0,0,2,90,90,640,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:${String(Math.floor(cardSec)).padStart(2, '0')}.${String(Math.round((cardSec % 1) * 100)).padStart(2, '0')},Brand,,0,0,0,,{\\fad(250,0)}DOSSIE
Dialogue: 0,0:00:00.00,0:00:${String(Math.floor(cardSec)).padStart(2, '0')}.${String(Math.round((cardSec % 1) * 100)).padStart(2, '0')},CTA,,0,0,0,,{\\fad(300,0)}${cta}
Dialogue: 0,0:00:00.00,0:00:${String(Math.floor(cardSec)).padStart(2, '0')}.${String(Math.round((cardSec % 1) * 100)).padStart(2, '0')},Tag,,0,0,0,,{\\fad(450,0)}${tagline}
`);
      const card = p('end-card.mp4');
      run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=0x1A1A2E:s=1080x1920:r=${fpsR}:d=${cardSec}`, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
        '-vf', `ass=${esc(cardAss)}:fontsdir=${esc(path.join(ROOT, 'public', 'fonts'))}`, '-t', String(cardSec), ...enc, card, '-hide_banner', '-loglevel', 'error']);
      const list = p('with-card.txt');
      fs.writeFileSync(list, `file '${held}'\nfile '${card}'\n`);
      run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', p('with-card.mp4'), '-hide_banner', '-loglevel', 'error']);
      mainForFinal = p('with-card.mp4');
    }
  }

  // 9. Music (ducked under voice) + captions + final scale in one pass.
  const musicMood = brief.musicMood;
  const musicVolume = brief.musicVolume != null ? brief.musicVolume : 0.12;
  const manifestPath = path.join(ROOT, 'Media/Music/manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : [];
  if (musicMood && !manifest.length) console.warn(`WARNING: ${manifestPath} not found — run scripts/video-engine/fetch-pixabay-music.js; rendering without music.`);
  const track = musicMood ? manifest.find(m => m.mood === musicMood) : null;
  if (musicMood && manifest.length && !track) console.warn(`WARNING: no track with mood "${musicMood}" in the music manifest; rendering without music.`);

  const vf = `ass=${esc(p('captions.ass'))}:fontsdir=${esc(path.join(ROOT, 'public', 'fonts'))},scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2`;
  // Voice cleanup: RNNoise (arnndn) beats afftdn by ~16dB of noise floor on
  // measured real footage — see Media/video-engine-proto/audio-cleanup/verdict.json.
  const rnnoiseModel = require('./model-path.js').resolveModel('rnnoise-mp.rnnn', args.rnnoiseModel);
  const denoiseAvailable = fs.existsSync(rnnoiseModel);
  if (!denoiseAvailable) console.warn(`WARNING: RNNoise model not found at ${rnnoiseModel} — skipping voice denoise. Run scripts/video-engine/download-models.sh.`);
  const voiceSteps = [];
  // DEAD-CHANNEL FOLD — first in the chain, before anything measures level.
  // This is the delivery-critical one: without it the finished reel plays
  // the voice out of the left speaker only, and loudnorm measures a stereo
  // pair that is half silence and over-boosts to compensate. `pan` with c0
  // is correct whether the upstream audio is still stereo (isolation off) or
  // already mono (isolation on), so it is safe to apply either way.
  if (chanFix) {
    voiceSteps.push(chanFix);
    console.log(`[edit] audio: folding the live channel to both sides (${chanFix}) — dead channel detected in the source.`);
  }
  // CLIP REPAIR — soft-limit the clipped corners. Defaults ON because it
  // genuinely reduces harshness, but it is NOT a fix and is never presented
  // as one: audioDiag.findings still carries the clipping finding, review.js
  // still reports it, and Heath still gets told to lower his transmitter
  // gain. Set brief.declip = false to render the clipping untouched.
  const wantDeclip = brief.declip !== false;
  let declipApplied = false;
  if (audioDiag.clipping.clipping && wantDeclip && audioDiag.filters.clipRepair) {
    voiceSteps.push(audioDiag.filters.clipRepair);
    declipApplied = true;
    console.log(`[edit] audio: soft-limiting a CLIPPED source (${audioDiag.filters.clipRepair}). This rounds the corners; it does NOT restore the ${audioDiag.clipping.samplesAtFullScale} samples recorded at full scale. The clipping finding stands.`);
  }
  // Sync nudge from the reviewer: positive = voice later (adelay), negative = voice earlier (atrim).
  const offsetMs = brief.audioOffsetMs != null ? Math.round(+brief.audioOffsetMs) : 0;
  if (offsetMs > 0) voiceSteps.push(`adelay=${offsetMs}|${offsetMs}`);
  else if (offsetMs < 0) voiceSteps.push(`atrim=start=${(-offsetMs / 1000).toFixed(3)},asetpts=PTS-STARTPTS`);
  // brief.denoiseStrength (0..1) is the knob for review.js's "voice sounds
  // underwater / highs gone" finding. RNNoise is all-or-nothing and is what
  // eats the highs, so backing off swaps it for a gentler spectral gate
  // rather than trying to wet/dry-mix it (a wet/dry mix needs labelled pads,
  // which cannot live inside a comma-joined -af chain).
  //   >= 0.66 -> arnndn (default, strongest, measured ~16 dB better than afftdn)
  //   0 < s < 0.66 -> afftdn scaled 3-12 dB of reduction, keeps HF intact
  //   0 -> no denoise at all
  // AUTO (the default): if Audio Isolation already ran and won the A/B, the
  // noise removal is DONE. Running RNNoise on top of it is a second denoiser
  // on already-denoised audio, which is how you get the hollow/underwater
  // artifact §6 fails a video for. Only the EQ / gate / loudnorm below stay.
  // An explicit brief.denoiseStrength (i.e. the reviewer asked for a value)
  // always wins over this.
  const denoiseAuto = brief.denoiseStrength == null;
  const denoiseStrength = denoiseAuto
    ? (isoReport.used ? 0 : 1)
    : Math.max(0, Math.min(1, +brief.denoiseStrength));
  if (denoiseAuto && isoReport.used) console.log('[edit] denoise AUTO -> 0: Audio Isolation already removed the room; stacking RNNoise on top is the overprocessed/underwater failure mode.');
  if (denoiseStrength >= 0.66 && denoiseAvailable) voiceSteps.push(`arnndn=m=${esc(rnnoiseModel)}`);
  else if (denoiseStrength > 0) {
    const nr = (3 + denoiseStrength * 9).toFixed(1);
    voiceSteps.push(`afftdn=nr=${nr}:nf=-28`);
    console.log(`[edit] denoiseStrength ${denoiseStrength} -> afftdn nr=${nr} dB instead of RNNoise (reviewer asked for less denoise).`);
  } else if (!denoiseAuto) {
    console.log('[edit] brief.denoiseStrength = 0 — no denoise at all (the reviewer heard the voice as muffled and asked for less).');
  }
  // De-room (reviewer: "hollow/boxy"): tame the 250-450 Hz box a small room
  // adds, lift presence, and gate the tails between words. Measured on
  // trial 01 -> 02: 200-500 Hz vs 1-4 kHz went from +4.9 dB to +2.0 dB.
  // presenceDb is the knob for "harsh/metallic" — the reviewer lowers it.
  const presenceDb = brief.presenceDb != null ? +brief.presenceDb : 3;
  if (brief.deroom) voiceSteps.push('highpass=f=80', 'equalizer=f=330:t=q:w=1.3:g=-4', `equalizer=f=3200:t=q:w=1.1:g=${presenceDb}`, 'agate=threshold=0.018:ratio=1.7:attack=6:release=140:range=0.35');
  // brief.deess — knob for "voice sounds harsh/metallic; add de-essing".
  // A narrow 6.5 kHz dynamic dip; deliberately gentle, §6 says preserve his
  // natural voice, not sculpt it.
  if (brief.deess) voiceSteps.push('equalizer=f=6500:t=q:w=2.0:g=-4');
  // brief.compressorRatio — knob for "voice is squashed (over-compressed)".
  // 'off' | 'light' | 'normal'. There is no compressor in the default chain,
  // so 'light'/'normal' ADD a gentle one and 'off' guarantees none; the
  // reviewer's squashed finding sets 'light'.
  const comp = brief.compressorRatio;
  if (comp === 'light') voiceSteps.push('acompressor=threshold=0.15:ratio=2:attack=20:release=250:makeup=1.2');
  else if (comp === 'normal') voiceSteps.push('acompressor=threshold=0.1:ratio=3:attack=15:release=200:makeup=1.5');
  const voiceChainStr = voiceSteps.length ? voiceSteps.join(',') : 'anull';
  const loudTarget = brief.loudnessTarget != null ? +brief.loudnessTarget : -16;
  // ffmpeg's loudnorm runs its internal analysis at 192 kHz and, left alone,
  // hands the encoder whatever rate it feels like — trial_07 came out 96 kHz
  // AAC, which is a non-standard deliverable for Reels/TikTok/Shorts. Pin it
  // back to 48 kHz stereo right after the filter, and again on the encoder.
  const loudnorm = `loudnorm=I=${loudTarget}:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo`;
  const AUDIO_OUT = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'];

  if (track) {
    const musicPath = path.join(ROOT, 'Media/Music', track.file);
    run('ffmpeg', ['-y', '-i', mainForFinal, '-stream_loop', '-1', '-i', musicPath,
      '-filter_complex', `[0:v]${vf}[vout];[0:a]${voiceChainStr}[voice];[1:a]volume=${musicVolume}[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=2,${loudnorm}[aout]`,
      '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-crf', '19', '-preset', 'medium', '-pix_fmt', 'yuv420p',
      ...AUDIO_OUT, '-movflags', '+faststart', finalOut, '-hide_banner', '-loglevel', 'error']);
  } else {
    run('ffmpeg', ['-y', '-i', mainForFinal,
      '-vf', vf, '-af', `${voiceChainStr},${loudnorm}`,
      '-c:v', 'libx264', '-crf', '19', '-preset', 'medium', '-pix_fmt', 'yuv420p',
      ...AUDIO_OUT, '-movflags', '+faststart', finalOut, '-hide_banner', '-loglevel', 'error']);
  }

  // 10. Quality gate.
  const meta = ffprobeJson(finalOut, 'format=duration:stream=width,height,codec_name');
  const vStream = meta.streams.find(s => s.width);
  const durOk = parseFloat(meta.format.duration) > 3;
  const resOk = vStream && vStream.width === 1080 && vStream.height === 1920;
  const cropMeta = fs.existsSync(p('cropped/crop-path.json')) ? JSON.parse(fs.readFileSync(p('cropped/crop-path.json'), 'utf8')) : null;
  const gate = {
    durationSec: parseFloat(meta.format.duration),
    resolution: vStream ? `${vStream.width}x${vStream.height}` : null,
    resolutionOk: !!resOk,
    durationOk: durOk,
    hasAudioTrack: meta.streams.some(s => s.codec_name === 'aac'),
    // §4 evidence, straight from the renderer rather than re-detected.
    shotPlanApplied: cropMeta ? !!cropMeta.shotPlanApplied : false,
    pictureCuts: cropMeta ? cropMeta.pictureCuts : 0,
    pictureCutSecs: cropMeta ? cropMeta.shotBoundarySecs : [],
    // Heath called the oval "scary". It is off and there is no path that
    // turns it on; this asserts that rather than assuming it.
    vignette: brief.vignette === true ? 'REQUESTED-BUT-REFUSED' : false,
    // Which physical setup this was shot from, and how that was decided.
    recordingPreset: { name: presetRes.name, how: presetRes.how, confidence: presetRes.confidence },
    presetTracking: cropMeta && cropMeta.recordingPreset ? {
      faceHome: cropMeta.recordingPreset.faceHome,
      excursionClampedFrames: cropMeta.frames ? cropMeta.frames.filter(f => f.excursionClamped).length : null,
    } : null,
    // SOURCE AUDIO — carried into the gate so it reaches review.js and the
    // produce.js loop rather than scrolling past in a build log. The
    // clipping entry in particular must survive to the review output: it is
    // an action for Heath at the NEXT shoot and no render can fix it.
    sourceAudio: {
      deadChannels: audioDiag.channels.deadChannels,
      channelFoldApplied: !!chanFix,
      clipping: audioDiag.clipping.clipping,
      clippingSeverity: audioDiag.clipping.severity,
      truePeakDb: audioDiag.clipping.truePeakDb,
      samplesAtFullScale: audioDiag.clipping.samplesAtFullScale,
      declipApplied,
      findings: audioDiag.findings,
    },
  };
  // NEVER-SILENT: re-print the source audio findings at the END of the run.
  // Printing them only at stage 0 buries them under several minutes of
  // ffmpeg output, which is functionally the same as not reporting them.
  for (const f of audioDiag.findings) console.warn(`\n*** SOURCE AUDIO [${f.severity.toUpperCase()}] ${f.id}: ${f.message}\n`);
  if (brief.vignette === true) console.warn('WARNING: brief.vignette=true ignored — Heath rejected the oval vignette outright (trial-cut note 5). oval-vignette.js is not in the render path.');
  // brief.blackFrameGuard — knob for review.js's "accidental black frame"
  // finding. Measures the output directly instead of trusting the concat.
  if (brief.blackFrameGuard) {
    try {
      const bd = execFileSync('ffmpeg', ['-v', 'info', '-i', finalOut, '-vf', 'blackdetect=d=0.05:pix_th=0.10', '-an', '-f', 'null', '-'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      const txt = bd.toString();
      const hits = [...txt.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map(m => ({ start: +m[1], end: +m[2] }));
      gate.blackFrames = hits;
      gate.blackFrameOk = hits.length === 0;
    } catch (e) {
      const txt = (e.stderr || Buffer.from('')).toString();
      const hits = [...txt.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map(m => ({ start: +m[1], end: +m[2] }));
      gate.blackFrames = hits;
      gate.blackFrameOk = hits.length === 0;
    }
  }
  gate.pass = gate.resolutionOk && gate.durationOk && gate.hasAudioTrack && gate.blackFrameOk !== false;
  fs.writeFileSync(p('quality-gate.json'), JSON.stringify(gate, null, 2));
  console.log('\n=== QUALITY GATE ===');
  console.log(JSON.stringify(gate, null, 2));
  console.log(`\nFinal output: ${finalOut}`);
  if (!gate.pass) { console.error('QUALITY GATE FAILED'); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
