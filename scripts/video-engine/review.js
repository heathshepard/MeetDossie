#!/usr/bin/env node
/**
 * review.js — the critic. Watches, listens and reads a finished reel and
 * grades it against docs/DOSSIE-CREATIVE-DIRECTOR-STANDARD.md by section:
 *
 *   qc        the §17 QC table — HOOK / CLARITY / PACING / VISUALS / HUMAN /
 *             AUDIO / CAPTIONS / STORY / PAYOFF / CTA / TECHNICAL, each 1-5
 *             with a written reason and the sections it leans on
 *   proud     the §22 bar — "would we be proud to put this in front of
 *             thousands of real estate agents?" A technically correct video
 *             that fails this is a FAIL
 *   weakest   §18 self-critique — the three weakest moments, each attributed
 *             to source footage / editing / audio / captions / pacing /
 *             storytelling / missing B-roll
 *   source    §19 — is the raw take good enough (hook, audio, delivery,
 *             B-roll)? If not, the verdict is RESHOOT, not "fix in the edit"
 *   verdict   PASS | FAIL | RESHOOT, plus a fix list phrased as instructions
 *             the editor (edit.js via produce.js) can act on, each with the
 *             brief patch that applies it
 *
 * It does not sample six stills and call it a review. Measured (deterministic,
 * review-lib/audio.js + video.js):
 *   - re-transcribes the OUTPUT audio (ElevenLabs scribe_v1, word timings) and
 *     diffs it against the intended words: a missing kept word is an automatic
 *     fail; hyphen fragments ("put-") are chopped words
 *   - hard energy steps inside speech (a splice on a phoneme), the last word's
 *     integrity (hard stop / shorter than the same word in the source take),
 *     lead-in and tail padding, dead air left in the cut
 *   - loudness / true peak, room boxiness (200-500 Hz vs 1-4 kHz), crest
 *     factor (over-compression), HF balance (muffled / harsh), music bed level
 *   - A/V sync against the source take (audio xcorr + face-motion xcorr) at
 *     half-frame resolution — when --src is given
 *   - scene cuts, longest static stretch, face size / headroom / clipped head /
 *     scale jumps, black frames (RFB-320 face boxes on 1 fps samples + every
 *     cut boundary)
 * Asked of Claude vision (review-lib/vision.js, through the CRON_SECRET proxy
 * api/verify-video-vision.js): the hook and a stronger opener, visuals /
 * room / cutout edge, a 16-tile face grid for eye contact and script reading,
 * captions at phone scale, the ending, story / payoff / §19 source, and the
 * §22 + §18 synthesis.
 *
 * Usage:
 *   node scripts/video-engine/review.js --video <final.mp4> [--src <raw.mp4>]
 *     [--transcript <source scribe json>] [--cutlist <cutlist json>]
 *     [--brief <brief json>] [--out <review.json>] [--workdir <dir>]
 *     [--no-vision] [--label <name>]
 *
 * Exit 0 on PASS, 2 on FAIL, 3 on RESHOOT, 1 on error. Calibrated against
 * Heath's own notes on Media/finished-videos/dossie_trial_01..05.mp4 — run
 * scripts/video-engine/review-calibration.js after any prompt/threshold change.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const A = require('./review-lib/audio.js');
const V = require('./review-lib/video.js');
const VIS = require('./review-lib/vision.js');

const ROOT = path.join(__dirname, '..', '..');

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

// ── Thresholds (calibrated on trials 01-05 vs Heath's notes; see file header) ──
const T = {
  lufsMin: -19, lufsMax: -12.5, truePeakMax: -0.5,
  boxinessHollowDb: 4.5,          // trial 01 = 4.8 (Heath: hollow room); 02 = 2.0, 03-05 = 3.8; raw take = 5.5
  crestSquashedDb: 9,             // trials sit 12.7-13.1; under 9 = excessively compressed (§6)
  hfMuffledDb: -28, hfHarshDb: -6, // trials -11..-13
  musicUnderVoiceDb: 14,          // bed within 14 dB of the voice = music competing (§6/§7)
  syncWarnMs: 60, syncFailMs: 90, // half-frame resolution ~17 ms; trials 02-05 measure +17..+50 unremarked, 01 -17..-33
  faceTight: 0.40, faceTooTight: 0.50, punchInMax: 0.62, faceTooLoose: 0.14, // face box (hairline-chin) / frame height; p25 = wide shot
  clippedTop: 0.08,               // forehead within 8% of the top edge = hair cut off (04: .06-.11)
  scaleJump: 1.45,
  longestStretchWarnSec: 7, longestStretchFailSec: 12,
  leadInMinSec: 0.15, tailMinSec: 0.3, // §17 TECHNICAL padding
  blackLuma: 10,
  eyeContactFailShare: 0.45,      // under 45% of face tiles on the lens = reading / looking away (§5)
};

function sentencesOf(words) {
  const out = []; let cur = [];
  for (const w of words) { cur.push(w); if (/[.!?]$/.test(w.text.trim())) { out.push(cur); cur = []; } }
  if (cur.length) out.push(cur);
  return out.map(s => ({ text: s.map(w => w.text).join(' '), start: s[0].start, end: s[s.length - 1].end, words: s }));
}
const num = (v) => (Number.isFinite(+v) ? +v : null);
const clamp = (s) => Math.max(1, Math.min(5, Math.round(s)));

/**
 * The reviewer used to say "put the hook line on screen (brief.hookLine)" and
 * attach no patch — a note with no value in it is a note produce.js can't
 * act on. These two helpers produce the actual value, so "no headline" and
 * "no emphasis words" became real editor knobs instead of prose.
 */
function autoHookLine(sentences, brief) {
  if (brief.hookLine) return brief.hookLine;
  const { pickHook } = require('./pick-hook.js');
  try {
    const fake = { words: sentences.flatMap(s => s.words).map(w => ({ ...w, type: 'word' })) };
    const line = pickHook(fake, brief.emphasisWords).hookLine;
    // Two short lines read better on a phone than one long one (§8).
    const w = line.replace(/\s+/g, ' ').trim().split(' ');
    return w.length > 6 ? `${w.slice(0, Math.ceil(w.length / 2)).join(' ')}\\N${w.slice(Math.ceil(w.length / 2)).join(' ')}` : line;
  } catch { return sentences.length ? sentences[0].text.slice(0, 60) : null; }
}
const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'it', 'that', "that's", 'this', 'you', 'your', "you're", 'i', "i'm", 'we', "we're", 'me', 'my', 'all', 'so', 'what', 'have', 'has', 'be', 'do', 'with', 'at', 'as', 'not', 'they', 'them', 'he', 'she', 'his', 'her', 'from', 'by', 'up', 'out', 'if', 'about', 'one', 'how', 'many', 'times', 'somehow', 'supposed', 'going', 'show', 'take', 'put', 'built', 'goal', 'simple', 'started', 'building', 'specifically', 'across', 'without', 'keep', 'track', 'everything', 'then', 'there']);
function autoEmphasisWords(outT, brief) {
  const existing = (brief.emphasisWords || []).map(String);
  const freq = new Map();
  for (const w of (outT.words || []).filter(x => x.type === 'word')) {
    const k = w.text.toLowerCase().replace(/[^a-z']/g, '');
    if (!k || k.length < 4 || STOPWORDS.has(k)) continue;
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  const picked = [...freq.entries()].sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length)).slice(0, 10).map(e => e[0]);
  return [...new Set([...existing, ...picked])];
}

async function main() {
  const args = parseArgs();
  const video = args.video;
  if (!video || !fs.existsSync(video)) { console.error('Usage: review.js --video <final.mp4> [--src raw] [--transcript json] [--cutlist json] [--brief json] [--out json]'); process.exit(1); }
  const label = args.label || path.basename(video, path.extname(video));
  const workDir = args.workdir || path.join(ROOT, '.tmp', `review-${label}`);
  fs.mkdirSync(workDir, { recursive: true });
  const p = (n) => path.join(workDir, n);
  const useVision = !args['no-vision'];
  const brief = args.brief && fs.existsSync(args.brief) ? JSON.parse(fs.readFileSync(args.brief, 'utf8')) : {};
  const cutlist = args.cutlist && fs.existsSync(args.cutlist) ? JSON.parse(fs.readFileSync(args.cutlist, 'utf8')) : null;
  const srcTranscript = args.transcript && fs.existsSync(args.transcript) ? JSON.parse(fs.readFileSync(args.transcript, 'utf8')) : null;
  const srcWords = srcTranscript ? srcTranscript.words.filter(w => w.type === 'word') : null;
  const src = args.src && fs.existsSync(args.src) ? args.src : null;

  const log = (...m) => console.error(`[review ${label}]`, ...m);
  const meta = V.ffprobe(video);
  log(`${meta.width}x${meta.height} ${meta.durationSec.toFixed(2)}s fps ${meta.fps && meta.fps.toFixed(2)}`);

  // ── 1. Output audio -> transcript (what the viewer actually hears) ──
  const wav = p('output-16k.wav');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', wav]);
  const tPath = p('output-transcript.json');
  const stamp = `${fs.statSync(video).size}:${fs.statSync(video).mtimeMs}`;
  if (!fs.existsSync(tPath) || !fs.existsSync(p('transcript.stamp')) || fs.readFileSync(p('transcript.stamp'), 'utf8') !== stamp) {
    execFileSync('node', [path.join(__dirname, 'transcribe.js'), '--audio', wav, '--out', tPath], { stdio: ['ignore', 'ignore', 'inherit'] });
    fs.writeFileSync(p('transcript.stamp'), stamp);
  }
  const outT = JSON.parse(fs.readFileSync(tPath, 'utf8'));
  const words = outT.words.filter(w => w.type === 'word');
  const sentences = sentencesOf(words);

  // ── 2. Measured audio ──
  const pcm = A.decodePcm(video);
  const loud = A.measureLoudness(video);
  const lv = A.levels(pcm, words);
  const room = A.roomTail(pcm, words);
  const box = A.boxiness(video, words);
  const chain = A.deliveryChain(video, words);
  const drops = A.hardDrops(pcm, words, lv.speechMedianDb);
  const ending = A.ending(pcm, words, meta.durationSec, srcWords);
  const diff = srcWords ? A.wordDiff(words, srcWords, cutlist && cutlist.keepSegments) : null;
  const midDrops = drops.filter(d => !(ending.stepAtSec != null && Math.abs(d.atSec - ending.stepAtSec) < 0.15));
  const leadIn = words.length ? +words[0].start.toFixed(2) : null;

  // ── 3. Measured picture ──
  const cuts = V.sceneCuts(video, 0.08);
  const sampleTimes = [];
  for (let t = 0.5; t < meta.durationSec - 0.2; t += 1) sampleTimes.push(+t.toFixed(2));
  for (const c of cuts) { sampleTimes.push(+Math.max(0, c - 0.08).toFixed(2)); sampleTimes.push(+Math.min(meta.durationSec - 0.2, c + 0.08).toFixed(2)); }
  sampleTimes.sort((a, b) => a - b);
  const samples = V.sampleFrames(video, sampleTimes, p('frames'), 540);
  const session = await V.faceSession(require('./model-path.js').resolveModel('version-RFB-320.onnx'));
  const faces = await V.faceMetrics(session, samples);
  const talking = faces.filter(f => f.found && f.faceH >= 0.08);
  const faceHs = talking.map(f => f.faceH).sort((x, y) => x - y);
  const faceHMedian = faceHs.length ? faceHs[faceHs.length >> 1] : null;
  const faceHP25 = faceHs.length ? faceHs[Math.floor(faceHs.length * 0.25)] : null;
  const faceHMax = faceHs.length ? faceHs[faceHs.length - 1] : null;
  const clippedAt = talking.filter(f => f.top <= T.clippedTop && f.faceH > 0.3).map(f => f.t);
  const scaleJumps = [];
  for (const c of cuts) {
    const before = faces.find(f => f.found && Math.abs(f.t - (c - 0.08)) < 0.02), after = faces.find(f => f.found && Math.abs(f.t - (c + 0.08)) < 0.02);
    if (before && after && before.faceH > 0.08 && after.faceH > 0.08) {
      const r = Math.max(before.faceH, after.faceH) / Math.min(before.faceH, after.faceH);
      if (r >= T.scaleJump) scaleJumps.push({ atSec: c, ratio: +r.toFixed(2) });
    }
  }
  const bounds = [0, ...cuts, meta.durationSec];
  let longest = { start: 0, len: 0 };
  for (let i = 0; i < bounds.length - 1; i++) { const len = bounds[i + 1] - bounds[i]; if (len > longest.len) longest = { start: +bounds[i].toFixed(2), len: +len.toFixed(2) }; }
  const faceAt0 = faces.find(f => f.t <= 0.6);
  const brollSec = faces.filter(f => !f.found).length; // 1 fps samples with no face ≈ seconds of cutaway / card
  const blackFrames = [0.03, ...cuts.map(c => c + 0.03), meta.durationSec - 0.15].map(t => ({ t: +t.toFixed(2), luma: V.frameLuma(video, t) })).filter(x => x.luma != null && x.luma < T.blackLuma);

  // ── 4. Sync against the source (only with --src) ──
  let sync = null;
  if (src) {
    const probes = V.syncProbeTimes(meta.durationSec, cuts, 2.0, 8);
    sync = await V.syncAgainstSource(video, src, session, probes, { cuts });
    log(`sync median ${sync.medianOffsetMs} ms over ${sync.measured} probes`);
  }

  // ── 5. Vision passes ──
  const vision = { hook: null, framing: null, gaze: null, edge: null, captions: null, ending: null, story: null, verdict: null, errors: [] };
  const tryAsk = async (name, files, prompt) => { try { vision[name] = await VIS.ask(files, prompt); } catch (e) { vision.errors.push(`${name}: ${e.message}`); } };
  const firstSentence = sentences[0] ? sentences[0].text : '';
  const stepSheet = meta.durationSec / 18;
  const sheetTimes = Array.from({ length: 18 }, (_, i) => +(stepSheet * i + stepSheet / 2).toFixed(2));
  const sheetFrames = V.sampleFrames(video, sheetTimes, p('frames'), 540, 'g');
  const sheets = [];
  for (let i = 0; i < 2; i++) sheets.push(await V.contactSheet(sheetFrames.slice(i * 9, i * 9 + 9).map(f => f.file), p(`sheet-${i}.jpg`), { cols: 3, tileW: 300 }));
  const faceFacts = `face box (hairline to chin) is ${faceHP25 != null ? Math.round(faceHP25 * 100) : '?'}% of frame height in the wide shots (tightest punch-in ${faceHMax != null ? Math.round(faceHMax * 100) : '?'}%); ${clippedAt.length ? `forehead within ${Math.round(T.clippedTop * 100)}% of the top edge at ${clippedAt.slice(0, 4).join(', ')}s` : 'no clipped head measured'}; ${scaleJumps.length ? `scale jumps of ${scaleJumps.map(j => j.ratio + 'x@' + j.atSec + 's').join(', ')}` : 'no scale jumps at cuts'}; ${cuts.length} visual cuts, longest static stretch ${longest.len}s; ~${brollSec}s of non-face frames (b-roll / cards).`;
  let gazeGrid = null;
  if (useVision) {
    const candidates = (srcWords ? sentencesOf(srcWords) : sentences).map(s => s.text).filter(t => t.split(' ').length >= 5 && t !== firstSentence).slice(0, 6);
    const hookFrames = V.sampleFrames(video, [0.0, 1.0, 2.0, 3.0], p('frames'), 480, 'h').map(f => f.file);
    await tryAsk('hook', hookFrames, VIS.hookPrompt({ transcriptOpening: outT.text.slice(0, 220), candidateLines: candidates, spokenOpener: firstSentence }));
    await tryAsk('framing', sheets, VIS.framingPrompt({ sheetLayout: `each sheet is 3 columns x 3 rows read left-to-right then top-to-bottom, sheet 1 covers 0-${(meta.durationSec / 2).toFixed(0)}s and sheet 2 the rest, one tile every ${stepSheet.toFixed(1)}s`, faceFacts }));
    gazeGrid = await V.faceGrid(video, faces, p('face-grid.jpg'), { cols: 4, tileW: 220, max: 16 });
    if (gazeGrid) await tryAsk('gaze', [gazeGrid.file], VIS.gazePrompt({ n: gazeGrid.times.length, times: `${(meta.durationSec / gazeGrid.times.length).toFixed(1)}s` }));
    const edgeCandidates = talking.filter(f => f.faceH >= 0.15).slice(0, 40);
    const edgePicks = [0.2, 0.5, 0.8].map(fr => edgeCandidates[Math.floor(fr * (edgeCandidates.length - 1))]).filter(Boolean);
    const edgeFiles = [];
    for (const f of edgePicks) {
      const size = Math.round(Math.min(1, f.faceW * 1.6) * meta.width);
      const cx = Math.round(f.cx * meta.width), cy = Math.round(f.top * meta.height + size * 0.08);
      const x = Math.max(0, Math.min(meta.width - size, cx - size / 2)), y = Math.max(0, Math.min(meta.height - size, cy - size / 2));
      const out = p(`frames/edge-${f.t.toFixed(2).replace('.', '_')}.jpg`);
      if (!fs.existsSync(out)) execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(f.t), '-i', video, '-frames:v', '1', '-vf', `crop=${size}:${size}:${x}:${y},scale=560:560`, '-q:v', '3', out]);
      if (fs.existsSync(out)) edgeFiles.push(out);
    }
    if (edgeFiles.length) await tryAsk('edge', edgeFiles, VIS.edgePrompt({ n: edgeFiles.length }));
    const capTimes = [0.2, 0.4, 0.6, 0.8].map(f => { const target = meta.durationSec * f; const w = words.reduce((best, x) => Math.abs((x.start + x.end) / 2 - target) < Math.abs((best.start + best.end) / 2 - target) ? x : best, words[0]); return +((w.start + w.end) / 2).toFixed(2); });
    const capFrames = V.sampleFrames(video, capTimes, p('frames'), 405, 'c').map(f => f.file);
    if (capFrames.length) await tryAsk('captions', capFrames, VIS.captionsPrompt({ n: capFrames.length, emphasisWords: (brief.emphasisWords || []).join(', ') }));
    const endTimes = [meta.durationSec - 2.0, meta.durationSec - 1.0, meta.durationSec - 0.4, meta.durationSec - 0.15].map(t => +Math.max(0, t).toFixed(2));
    const endFrames = V.sampleFrames(video, endTimes, p('frames'), 480, 'e').map(f => f.file);
    const lastLine = sentences.length ? sentences[sentences.length - 1].text : '';
    const audioFacts = ending.truncated
      ? `the last word "${ending.lastWord}" is CUT OFF — ${ending.hardStop ? `voice drops ${ending.stepDb} dB in 20 ms at ${ending.stepAtSec}s` : ''}${ending.sourceMatch && ending.sourceMatch.shortByMs > 0 ? ` and it is ${ending.sourceMatch.shortByMs} ms shorter than in the source take` : ''}`
      : `the last word "${ending.lastWord}" ends at ${ending.lastWordEnd}s with a natural release; ${ending.tailAfterVoiceSec}s of tail follows before the file ends`;
    if (endFrames.length) await tryAsk('ending', endFrames, VIS.endingPrompt({ lastLine, audioFacts, ctaExpected: brief.cta || '' }));
  }

  // ── 6. Measured findings -> fixes + per-check facts ──
  const fixes = [];
  const FIXREG = require('./fix-registry.js');
  /**
   * Every finding carries a fix-registry id. The registry says whether it is
   * editor-fixable (and through which brief fields) or human-only.
   *
   * Before 2026-09-22 this helper took no id and a finding with no brief
   * patch was indistinguishable from a finding with nothing to say —
   * produce.js printed "nothing left to change" and exited while a 27-second
   * static stretch sat unaddressed in dossie_trial_06.mp4. `owner` is what
   * makes that impossible now: 'editor' with no patch is a BUG in the
   * reviewer and is reported as one; 'human' is a legitimate outcome that
   * gets named out loud.
   */
  const fix = (id, check, instruction, briefPatch, section) => {
    const reg = FIXREG.lookup(id);
    const owner = reg ? reg.owner : 'unregistered';
    fixes.push({
      id, check, section, instruction,
      brief: briefPatch || null,
      owner,
      knobs: reg ? reg.knobs : [],
      humanReason: reg && reg.owner === 'human' ? reg.humanReason : null,
      // An editor-owned finding that produced no patch is a reviewer defect,
      // not silence. produce.js surfaces this by name.
      knobGap: owner === 'editor' && !briefPatch,
    });
  };
  const weak = []; // candidate weakest moments for the §18 synthesis
  const fumbled = (() => {
    if (!srcWords || !sentences.length) return null;
    const lastSent = sentences[sentences.length - 1];
    const norm = t => t.toLowerCase().replace(/[^a-z']/g, '');
    const key = lastSent.words.slice(0, 3).map(w => norm(w.text)).join(' ');
    let srcIdx = -1;
    for (let i = 0; i <= srcWords.length - 3; i++) if (srcWords.slice(i, i + 3).map(w => norm(w.text)).join(' ') === key) srcIdx = i;
    if (srcIdx <= 0) return null;
    const before = srcWords.slice(Math.max(0, srcIdx - 6), srcIdx).filter(w => w.start >= srcWords[srcIdx].start - 2.5);
    const stutter = before.find(w => /-$/.test(w.text.trim()));
    return stutter ? { stutter: stutter.text, line: lastSent.text, start: lastSent.start } : null;
  })();
  const srcFalseStarts = srcWords ? srcWords.filter(w => /-$/.test(w.text.trim())).length : null;

  // ── 7. The §17 QC table ──
  const qc = {};
  const set = (k, score, why, sections) => { qc[k] = { score: clamp(score), reason: why.filter(Boolean).join('; '), sections }; };

  // HOOK (§2, §3) + CLARITY (§2)
  {
    const vh = vision.hook;
    let s = vh && num(vh.hook) != null ? num(vh.hook) : 3; let cl = vh && num(vh.clarity) != null ? num(vh.clarity) : 3; const why = [], whyC = [];
    if (!faceAt0 || !faceAt0.found) { s = Math.min(s, 2); why.push('no face on screen in the first second'); fix('hook.no_face_frame0', 'HOOK', 'Frame 0 has no person on it; open on the face, not a card or empty frame (brief.openOnFace).', { openOnFace: true }, 2); }
    if (leadIn != null && leadIn > 1.5) { s = Math.min(s, 3); why.push(`silence for the first ${leadIn}s`); fix('hook.lead_in_silence', 'HOOK', `Nothing is said for ${leadIn}s; trim the lead-in so the first word lands inside 0.5 s.`, { silenceThreshold: 0.4 }, 2); }
    if (/^(hey (guys|everyone|y'all)|hi (guys|everyone)|my name is|today i want|welcome back)/i.test(firstSentence)) { s = Math.min(s, 2); why.push(`banned opener: "${firstSentence.slice(0, 40)}"`); fix('hook.banned_opener', 'HOOK', `Opens on "${firstSentence.slice(0, 40)}…" (§2 banned opener); start on the first line that names the problem (brief.startAtLine).`, sentences.length > 1 ? { startAtLine: sentences[1].text } : null, 2); }
    if (vh) {
      if (vh.person_visible === false) { s = Math.min(s, 2); why.push('no person visible at 0s'); }
      if (!vh.headline_seen) { s = Math.min(s, 3); why.push('no legible headline at 0s'); fix('hook.no_headline', 'HOOK', 'No headline text at frame 0; put the hook line on screen from 0.0 s (brief.hookLine).', { hookLine: autoHookLine(sentences, brief) }, 2); }
      if (vh.banned_opener) { s = Math.min(s, 2); why.push('§2 banned opener'); }
      if (vh.opener_is_strongest === false && vh.better_opener) { s = Math.min(s, 3); why.push(`stronger opener available: "${vh.better_opener}"`); fix('hook.weak_opener', 'HOOK', `Open on "${vh.better_opener}" instead of "${firstSentence}" (brief.startAtLine).`, { startAtLine: vh.better_opener }, 2); weak.push(`0s: opener "${firstSentence.slice(0, 50)}" is weaker than "${vh.better_opener.slice(0, 50)}" (storytelling)`); }
      if (vh.hook_exists_in_footage === false) { s = Math.min(s, 2); why.push('no line in the take would stop a scroll (§3: concept, not edit)'); }
      why.push(vh.reason);
      whyC.push(vh.reason);
    } else if (useVision) { why.push('vision unavailable for the hook'); whyC.push('vision unavailable'); }
    else whyC.push('not judged (--no-vision)');
    set('HOOK', s, why, [2, 3]);
    set('CLARITY', cl, whyC, [2]);
  }

  // PACING (§4, §12)
  {
    let s = 5; const why = [];
    if (longest.len >= T.longestStretchFailSec) { s -= 2; why.push(`${longest.len}s with no visual change from ${longest.start}s`); fix('pacing.static_stretch', 'PACING', `Longest uncut stretch is ${longest.len}s from ${longest.start}s; re-cut the picture inside it — shot-plan.js puts a framing change on the sentence/clause boundaries (§4).`, { shotPlan: true, maxShotSec: Math.max(2.5, Math.min(brief.maxShotSec != null ? +brief.maxShotSec : 5.0, +(longest.len / 2).toFixed(1))), punchFactor: Math.min(1.3, (brief.punchFactor != null ? +brief.punchFactor : 1.18) + 0.04) }, 4); weak.push(`${longest.start}s: ${longest.len}s static stretch (pacing)`); }
    else if (longest.len >= T.longestStretchWarnSec) { s -= 1; why.push(`${longest.len}s stretch with no visual change from ${longest.start}s`); weak.push(`${longest.start}s: ${longest.len}s with no visual change (pacing)`); }
    if (chain.deadAir.length) { s -= 1; why.push(`dead air left in: ${chain.deadAir.map(d => `${d.gapSec}s after "${d.after}" @${d.atSec}s`).join(', ')}`); fix('pacing.dead_air', 'PACING', `Pauses of ${chain.deadAir.map(d => d.gapSec + 's @' + d.atSec + 's').join(', ')} survived the cut; tighten silenceThreshold.`, { silenceThreshold: 0.45 }, 5); for (const d of chain.deadAir) weak.push(`${d.atSec}s: ${d.gapSec}s of dead air (editing)`); }
    if (scaleJumps.length) { s -= 1; why.push(`jarring scale jump ${scaleJumps.map(j => `${j.ratio}x at ${j.atSec}s`).join(', ')}`); fix('pacing.scale_jump', 'PACING', `Scale jumps ${scaleJumps.map(j => `${j.ratio}x at ${j.atSec}s`).join(', ')}; keep consecutive shots within 1.25x (§4: intentional, not frantic).`, { maxScaleRatio: 1.25 }, 4); }
    if (vision.framing && vision.framing.shot_variety === 'frantic') { s -= 1; why.push('cutting feels frantic'); }
    if (meta.durationSec > 45) { s -= 1; why.push(`${meta.durationSec.toFixed(0)}s runtime — §12: shortest version that lands the idea`); }
    if (!why.length) why.push(`${cuts.length} cuts, longest stretch ${longest.len}s, no dead air, ${meta.durationSec.toFixed(0)}s`);
    set('PACING', s, why, [4, 12]);
  }

  // VISUALS (§4, §5 framing, §9)
  {
    const vf = vision.framing;
    let s = vf && num(vf.visuals) != null ? num(vf.visuals) : 4; const why = [];
    if (faceHP25 != null && faceHP25 >= T.faceTooTight) { s = Math.min(s, 2); why.push(`face fills ${Math.round(faceHP25 * 100)}% of the frame height even in the wide shots (too close)`); fix('visuals.face_too_tight', 'VISUALS', `Face is ${Math.round(faceHP25 * 100)}% of frame height in the wide shots; pull back — zoom ${brief.zoom ? `${brief.zoom} -> ${(brief.zoom - 0.2).toFixed(2)}` : '-0.2'} so the face sits near 25-30%.`, { zoom: brief.zoom ? +(brief.zoom - 0.2).toFixed(2) : 1.0 }, 5); }
    else if (faceHP25 != null && faceHP25 >= T.faceTight) { s = Math.min(s, 3); why.push(`tight: face is ${Math.round(faceHP25 * 100)}% of frame height in the wide shots (want ~25-30%)`); fix('visuals.face_tight', 'VISUALS', `Face is ${Math.round(faceHP25 * 100)}% of frame height in the wide shots; pull back — zoom ${brief.zoom ? `${brief.zoom} -> ${(brief.zoom - 0.15).toFixed(2)}` : '-0.15'} for head-and-shoulders.`, { zoom: brief.zoom ? +(brief.zoom - 0.15).toFixed(2) : 1.05 }, 5); }
    else if (faceHMedian != null && faceHMedian <= T.faceTooLoose) { s = Math.min(s, 3); why.push(`face only ${Math.round(faceHMedian * 100)}% of frame height (too loose)`); fix('visuals.face_too_loose', 'VISUALS', `Face is only ${Math.round(faceHMedian * 100)}% of frame height; punch in (zoom +0.15).`, { zoom: brief.zoom ? +(brief.zoom + 0.15).toFixed(2) : 1.35 }, 5); }
    if (faceHMax != null && faceHMax >= T.punchInMax) { s -= 1; why.push(`punch-ins reach ${Math.round(faceHMax * 100)}% of frame height (floating head)`); fix('visuals.punch_too_tight', 'VISUALS', `Tightest shot puts the face at ${Math.round(faceHMax * 100)}% of frame height; cap punch-ins so the face stays under 60% (brief.punchZoomMax).`, { punchZoomMax: +Math.max(1.0, (brief.punchZoomMax != null ? +brief.punchZoomMax : 1.6) * (0.58 / faceHMax)).toFixed(2) }, 5); }
    if (clippedAt.length) { s = Math.min(s, 2); why.push(`head clipped at the top at ${clippedAt.slice(0, 3).join(', ')}s`); fix('visuals.head_clipped', 'VISUALS', `Head is cut off at the top (${clippedAt.slice(0, 3).join(', ')}s); add headroom — bias the crop down (brief.headroom +0.08) or zoom out.`, { headroom: 0.08 }, 5); weak.push(`${clippedAt[0]}s: head clipped at the top (editing)`); }
    if (blackFrames.length) { s = Math.min(s, 2); why.push(`black frame at ${blackFrames.map(b => b.t).join(', ')}s`); fix('technical.black_frame', 'TECHNICAL', `Accidental black frame at ${blackFrames.map(b => b.t).join(', ')}s; check the concat / hold boundaries (brief.blackFrameGuard makes edit.js fail the build on one).`, { blackFrameGuard: true }, 17); }
    if (vf) {
      if (vf.room_visible) { s = Math.min(s, 2); why.push(`original room visible: ${vf.room_detail || 'yes'}`); fix('visuals.room_visible', 'VISUALS', `The room is visible (${vf.room_detail || 'background clutter'}); matte the subject over the navy backdrop for EVERY shot (brief.matte=true, brief.backdrop="navy").`, { matte: true, backdrop: 'navy' }, 5); weak.push(`throughout: ${vf.room_detail || 'the room'} visible behind him (source footage / editing)`); }
      const edgeKind = vision.edge && vision.edge.edge && !['clean', 'natural'].includes(vision.edge.edge) && (num(vision.edge.severity) || 0) >= 1 ? vision.edge.edge : null;
      if (edgeKind && (!vf.blur_or_halo || vf.blur_or_halo === 'none')) vf.blur_or_halo = edgeKind === 'vignette' ? 'vignette oval' : edgeKind;
      if (vf.blur_or_halo && vf.blur_or_halo !== 'none') {
        s = Math.min(s, 2); why.push(`${vf.blur_or_halo} around the person`);
        fix('visuals.matte_halo', 'VISUALS', vf.blur_or_halo === 'vignette oval' ? 'Drop the blurred/darkened oval (brief.vignette=false); use a clean matte over a flat backdrop instead.' : `Cutout shows a ${vf.blur_or_halo}; tighten the matte edge (erode +1, feather 1) or disable feathering.`, vf.blur_or_halo === 'vignette oval' ? { vignette: false, matte: true } : { matteErode: 3, matteFeather: 1 }, 5);
        weak.push(`throughout: ${vf.blur_or_halo} around the cutout (editing)`);
        if (edgeKind) why.push(`edge: ${vision.edge.reason}`);
      }
      if (vf.clipped_head && !clippedAt.length) { s = Math.min(s, 3); why.push('vision sees a clipped head'); }
      if (vf.shot_variety === 'static') { s = Math.min(s, 3); why.push('one static shot, no purposeful change'); fix('visuals.shot_variety_static', 'VISUALS', 'The screen never changes with purpose; turn on the shot plan so the framing cuts on the list items, and add a product cutaway where he names the solution (§4/§9).', { shotPlan: true, maxShotSec: Math.min(brief.maxShotSec != null ? +brief.maxShotSec : 5.0, 4.0), punchFactor: Math.min(1.3, (brief.punchFactor != null ? +brief.punchFactor : 1.18) + 0.04) }, 4); }
      why.push(vf.visuals_reason);
    } else if (useVision) why.push('vision unavailable for visuals');
    if (!why.length) why.push(`face ${Math.round((faceHMedian || 0) * 100)}% of frame, headroom ok`);
    set('VISUALS', s, why, [4, 5, 9]);
  }

  // HUMAN (§5, §16)
  {
    const vf = vision.framing, vg = vision.gaze;
    let s = vf && num(vf.human) != null ? num(vf.human) : 4; const why = [];
    if (vf) why.push(vf.human_reason);
    let eyeShare = null;
    if (vg && gazeGrid) {
      eyeShare = num(vg.eye_contact_tiles) != null ? num(vg.eye_contact_tiles) / gazeGrid.times.length : null;
      if (eyeShare != null && eyeShare < T.eyeContactFailShare) { s = Math.min(s, 2); why.push(`eyes on the lens in only ${Math.round(eyeShare * 100)}% of ${gazeGrid.times.length} face samples (${vg.pattern})`); fix('human.eyes_away_fail', 'HUMAN', `He is looking away/down in ${Math.round((1 - eyeShare) * 100)}% of the samples (${vg.pattern}); cut to takes with eye contact, cover with product footage, or reshoot (§5).`, null, 5); weak.push(`throughout: eyes ${vg.pattern} — reads as script reading (source footage)`); }
      else if (vg.pattern && vg.pattern !== 'steady') { s -= 1; why.push(`eyes ${vg.pattern} (${Math.round((eyeShare || 0) * 100)}% on the lens)`); fix('human.eyes_pattern', 'HUMAN', `Eyes read as ${vg.pattern} across the shots; prefer takes where he holds the lens, cover the worst stretches with product footage (§5).`, null, 5); weak.push(`throughout: eyes ${vg.pattern} (source footage)`); }
      if (vg.natural_skin === false) { s = Math.min(s, 2); why.push('skin looks processed'); }
      why.push(vg.reason);
    } else if (useVision) why.push('gaze pass unavailable');
    set('HUMAN', s, why, [5, 16]);
    qc.HUMAN.eyeContactShare = eyeShare;
  }

  // AUDIO (§6, §7)
  {
    let s = 5; const why = [];
    if (loud.integratedLufs != null && (loud.integratedLufs < T.lufsMin || loud.integratedLufs > T.lufsMax)) { s -= 1; why.push(`loudness ${loud.integratedLufs} LUFS (want -16 ±3)`); fix('audio.loudness', 'AUDIO', `Normalize to -16 LUFS (measured ${loud.integratedLufs}).`, { loudnessTarget: -16 }, 6); }
    if (loud.truePeakDb != null && loud.truePeakDb > T.truePeakMax) { s -= 1; why.push(`true peak ${loud.truePeakDb} dBFS`); }
    if (box != null && box >= T.boxinessHollowDb) { s = Math.min(s, 2); why.push(`hollow room tone: 200-500 Hz sits ${box} dB over 1-4 kHz on the voice`); fix('audio.boxy', 'AUDIO', `Voice sounds hollow/boxy (low-mids +${box} dB). Cut ~4 dB around 330 Hz, add 3 dB presence at 3.2 kHz, and gate the tails between words (brief.deroom=true).`, { deroom: true }, 6); weak.push(`throughout: hollow room tone on the voice (audio)`); }
    if (chain.crestDb != null && chain.crestDb < T.crestSquashedDb) { s = Math.min(s, 3); why.push(`voice is squashed (crest ${chain.crestDb} dB) — over-compressed`); fix('audio.squashed', 'AUDIO', `Voice crest factor is ${chain.crestDb} dB (excessively compressed, §6); back off the compressor ratio (brief.compressorRatio).`, { compressorRatio: brief.compressorRatio === 'light' ? 'off' : 'light' }, 6); }
    if (chain.hfBalanceDb != null && chain.hfBalanceDb < T.hfMuffledDb) { s = Math.min(s, 3); why.push(`voice muffled/underwater (HF ${chain.hfBalanceDb} dB)`); fix('audio.muffled', 'AUDIO', 'Voice sounds underwater (highs gone); reduce denoise strength and add presence (brief.denoiseStrength / brief.presenceDb, §6).', { denoiseStrength: +Math.max(0, (brief.denoiseStrength != null ? +brief.denoiseStrength : 1) - 0.4).toFixed(2), presenceDb: Math.min(6, (brief.presenceDb != null ? +brief.presenceDb : 3) + 1.5) }, 6); }
    if (chain.hfBalanceDb != null && chain.hfBalanceDb > T.hfHarshDb) { s = Math.min(s, 3); why.push(`voice harsh/metallic (HF ${chain.hfBalanceDb} dB)`); fix('audio.harsh', 'AUDIO', 'Voice sounds harsh/metallic; ease the presence boost and add de-essing (brief.presenceDb / brief.deess, §6).', { deess: true, presenceDb: Math.max(0, (brief.presenceDb != null ? +brief.presenceDb : 3) - 2) }, 6); }
    if (lv.gapMedianDb != null && lv.speechMedianDb - lv.gapMedianDb < T.musicUnderVoiceDb) { s -= 1; why.push(`bed between words only ${(lv.speechMedianDb - lv.gapMedianDb).toFixed(0)} dB under the voice`); fix('audio.music_too_loud', 'AUDIO', `Music/noise bed is ${(lv.speechMedianDb - lv.gapMedianDb).toFixed(0)} dB under the voice; drop it to at least 14 dB under (§7).`, { musicVolume: brief.musicVolume != null ? +(brief.musicVolume * 0.6).toFixed(3) : 0.07 }, 7); }
    if (diff && diff.hadKeepSegments && diff.missing.length) { s = 1; why.push(`${diff.missing.length} intended word(s) missing from the output: ${diff.missing.slice(0, 5).map(m => `"${m.text}"`).join(', ')}`); fix('audio.missing_words', 'AUDIO', `Intended words never made it to the output (${diff.missing.slice(0, 5).map(m => `"${m.text}" @${m.start}s`).join(', ')}); widen the keep segments around them (padStart/padEnd) or drop the cut that removed them.`, { padStart: 0.14, padEnd: 0.26 }, 17); }
    if (diff && diff.fragments.length) { s = Math.min(s, 2); why.push(`chopped word fragment(s) heard: ${diff.fragments.map(f => `"${f.text}" @${f.start}s`).join(', ')}`); for (const f of diff.fragments) { fix('audio.chopped_fragment', 'AUDIO', `"${f.text}" at ${f.start}s is a chopped word — the cut lands inside it; move the cut to the end of that word +200 ms or drop the fragment entirely.`, { padEnd: 0.26 }, 17); weak.push(`${f.start}s: "${f.text}" chopped mid-word (editing)`); } }
    if (midDrops.length) { s = Math.min(s, 2); why.push(`hard splice inside speech at ${midDrops.map(d => `${d.atSec}s${d.word ? ` ("${d.word.text}")` : ''}`).join(', ')}`); for (const d of midDrops) { fix('audio.mid_splice', 'AUDIO', `Cut at ${d.atSec}s lands on "${d.word ? d.word.text : '?'}" (voice drops ${(d.fromDb - d.toDb).toFixed(0)} dB in 20 ms); end that segment at word end +200 ms and start the next on a breath.`, { padStart: 0.12, padEnd: 0.24 }, 17); weak.push(`${d.atSec}s: hard splice on "${d.word ? d.word.text : '?'}" (editing)`); } }
    if (sync && sync.medianOffsetMs != null) {
      const off = Math.abs(sync.medianOffsetMs);
      if (off >= T.syncFailMs) { s = Math.min(s, 2); why.push(`lip sync off by ${sync.medianOffsetMs} ms (audio ${sync.medianOffsetMs > 0 ? 'ahead of' : 'behind'} the picture)`); fix('audio.sync_fail', 'AUDIO', `Audio is ${sync.medianOffsetMs > 0 ? 'ahead of' : 'behind'} the picture by ${off} ms; shift the voice ${sync.medianOffsetMs > 0 ? 'later' : 'earlier'} by ${off} ms (brief.audioOffsetMs).`, { audioOffsetMs: -sync.medianOffsetMs }, 17); }
      else if (off >= T.syncWarnMs) { s -= 1; why.push(`lip sync ${sync.medianOffsetMs} ms (borderline)`); fix('audio.sync_warn', 'AUDIO', `Audio is ${off} ms ${sync.medianOffsetMs > 0 ? 'ahead' : 'behind'}; nudge the voice ${sync.medianOffsetMs > 0 ? 'later' : 'earlier'} by ${off} ms.`, { audioOffsetMs: -sync.medianOffsetMs }, 17); }
      else why.push(`sync ${sync.medianOffsetMs} ms`);
    } else if (!src) why.push('sync not measured (no --src)');
    if (!why.length) why.push(`${loud.integratedLufs} LUFS, room tone ${box} dB, crest ${chain.crestDb} dB, clean word boundaries`);
    set('AUDIO', s, why, [6, 7]);
  }

  // CAPTIONS (§8)
  {
    const vc = vision.captions;
    let s = vc && num(vc.score) != null ? num(vc.score) : 3; const why = [];
    if (vc) {
      const n = 4;
      if (num(vc.frames_with_caption) != null && num(vc.frames_with_caption) < n) { s = Math.min(s, 3); why.push(`captions on only ${vc.frames_with_caption}/${n} sampled speaking frames`); fix('captions.coverage', 'CAPTIONS', `Captions missing on ${n - num(vc.frames_with_caption)} of ${n} sampled speaking frames; every kept word needs a caption chunk (brief.captionCoverage="all").`, { captionCoverage: 'all' }, 8); }
      if (vc.legible === false) { s = Math.min(s, 2); why.push('not legible at phone scale'); fix('captions.illegible', 'CAPTIONS', 'Captions too small to read on a phone; raise the caption size (brief.captionSize +14).', { captionSize: (brief.captionSize || 56) + 14 }, 8); }
      else if (vc.busy_background) { s -= 1; why.push('a caption sits over busy b-roll text'); fix('captions.busy_background', 'CAPTIONS', 'A caption lands over busy on-screen text in the b-roll; put a dark box behind the caption (brief.captionBox).', { captionBox: true }, 8); }
      if (vc.over_face) { s = Math.min(s, 2); why.push('captions sit over the face'); fix('captions.over_face', 'CAPTIONS', 'Captions overlap the face; move them down (brief.captionMarginV -60) or zoom out.', { captionMarginV: Math.max(120, (brief.captionMarginV || 220) - 60) }, 8); }
      if (vc.in_safe_zone === false) { s -= 1; why.push('outside the safe zone'); fix('captions.safe_zone', 'CAPTIONS', 'Captions run into the platform UI zone; keep them above the bottom 12% (brief.captionMarginV 260).', { captionMarginV: 260 }, 8); }
      if (vc.emphasis_present === false) { s -= 1; why.push('no emphasis words highlighted'); fix('captions.no_emphasis', 'CAPTIONS', 'No emphasis words highlighted; set brief.emphasisWords to the words that carry the claim (§8).', { emphasisWords: autoEmphasisWords(outT, brief) }, 8); }
      if (vc.carries_point_without_sound === false) { s = Math.min(s, 3); why.push('verbatim text, does not carry the point with sound off'); fix('captions.verbatim', 'CAPTIONS', 'Captions are a transcript, not a storytelling tool (§8); render the list items and the claim as big emphasis cards ("THREE DEADLINES / ONE TRANSACTION") — brief.captionStyle="emphasis".', { captionStyle: 'emphasis', emphasisWords: autoEmphasisWords(outT, brief) }, 8); }
      why.push(vc.reason);
    } else if (useVision) why.push('vision unavailable for captions');
    set('CAPTIONS', s, why, [8]);
  }

  // STORY + PAYOFF (§3, §11, §12) — vision synthesis over the words
  {
    const facts = [
      `${meta.durationSec.toFixed(0)}s runtime, ${cuts.length} cuts, longest static ${longest.len}s`,
      srcWords ? `raw take ${srcTranscript.audio_duration_secs}s with ${srcFalseStarts} false start(s)` : null,
      box != null ? `room tone ${box} dB low-mid emphasis (${box >= T.boxinessHollowDb ? 'hollow' : 'acceptable'})` : null,
      qc.HUMAN.eyeContactShare != null ? `eye contact on the lens in ${Math.round(qc.HUMAN.eyeContactShare * 100)}% of face samples` : null,
      fumbled ? `the closing line was re-taken after a stumble ("${fumbled.stutter}")` : null,
      ending.truncated ? `last word "${ending.lastWord}" truncated` : 'last word intact',
      vision.hook && vision.hook.hook_exists_in_footage === false ? 'hook pass found no scroll-stopping line in the take' : null,
      `~${brollSec}s of product/b-roll footage in the cut`,
    ].filter(Boolean).join('; ');
    if (useVision) await tryAsk('story', [sheets[0]], VIS.storyPrompt({ transcript: outT.text.slice(0, 900), sourceTranscript: srcTranscript ? srcTranscript.text.slice(0, 900) : '', durationSec: meta.durationSec.toFixed(0), facts }));
    const vs = vision.story;
    const stages = vs ? (Array.isArray(vs.stages_present) ? vs.stages_present.join(' > ') : (typeof vs.stages === 'string' ? vs.stages : '')) : '';
    set('STORY', vs && num(vs.story) != null ? num(vs.story) : 3, [vs ? vs.story_reason : (useVision ? 'vision unavailable' : 'not judged'), stages ? `stages: ${stages}` : null], [3, 11, 12]);
    set('PAYOFF', vs && num(vs.payoff) != null ? num(vs.payoff) : 3, [vs ? vs.payoff_reason : (useVision ? 'vision unavailable' : 'not judged')], [11, 17]);
    if (vs && vs.broll_missing) { fix('story.broll_missing', 'STORY', `Missing B-roll: ${vs.broll_missing} (§9).`, null, 9); weak.push(`story: ${vs.broll_missing} never shown (missing B-roll)`); }
  }

  // CTA (§11, §17)
  {
    const ve = vision.ending;
    let s = ve && num(ve.cta_score) != null ? num(ve.cta_score) : 3; const why = [];
    const spokenCta = /follow|link|comment|dm|sign up|try|download|message/i.test(sentences.slice(-2).map(x => x.text).join(' '));
    if (ve) {
      if (!ve.cta_seen) { s = Math.min(s, spokenCta ? 3 : 2); why.push('no CTA readable on screen at the end'); fix('cta.not_seen', 'CTA', 'No CTA on screen at the end; add a 2 s end card or CTA caption (brief.cta / brief.ending="card").', { ending: 'card' }, 17); }
      else if (ve.cta_readable_long_enough === false) { s -= 1; why.push('CTA not on screen long enough'); fix('cta.too_short', 'CTA', 'Hold the CTA for at least 1.5 s.', { endHoldSec: 0.6 }, 17); }
      why.push(ve.reason);
    } else if (useVision) why.push('vision unavailable for the ending');
    if (spokenCta) why.push('spoken CTA present'); else why.push('no spoken CTA');
    set('CTA', s, why, [11, 17]);
  }

  // TECHNICAL (§17)
  {
    let s = 5; const why = [];
    if (ending.truncated) {
      s = Math.min(s, 1);
      const shortBy = ending.sourceMatch && ending.sourceMatch.shortByMs > 0 ? ending.sourceMatch.shortByMs : null;
      why.push(`last word "${ending.lastWord}" is cut off${shortBy ? ` (${shortBy} ms short of the source take)` : ''}${ending.hardStop ? `, voice drops ${ending.stepDb} dB in 20 ms at ${ending.stepAtSec}s` : ''}`);
      fix('technical.clipped_last_word', 'TECHNICAL', `Last segment ends ${shortBy ? `${shortBy} ms before` : 'before'} "${ending.lastWord}" finishes; extend the final keep segment to the word end +300 ms, then hold the frame 0.5 s before the card.`, { padEnd: 0.3, endHoldSec: 0.5 }, 17);
      weak.push(`${ending.lastWordEnd}s: last word "${ending.lastWord}" cut off (editing)`);
    }
    if (fumbled) { s = Math.min(s, 2); why.push(`last line comes from a fumbled take ("${fumbled.stutter}" restart right before it) — likely slurred`); fix('technical.fumbled_last_line', 'TECHNICAL', `The closing line "${fumbled.line}" was re-taken after a stumble ("${fumbled.stutter}"); end on the previous clean line instead (brief.endAfterLine).`, { endAfterLine: sentences.length > 1 ? sentences[sentences.length - 2].text : null }, 19); weak.push(`${fumbled.start}s: closing line from a fumbled take, slurred (source footage)`); }
    if (sentences.length && !/[.!?]$/.test(sentences[sentences.length - 1].text.trim()) && !ending.truncated) { s = Math.min(s, 3); why.push('final sentence has no terminal punctuation in the transcript (possibly incomplete)'); }
    if (leadIn != null && leadIn < T.leadInMinSec) { s -= 1; why.push(`first word at ${leadIn}s — no lead-in padding`); fix('technical.no_lead_in_pad', 'TECHNICAL', `First word lands at ${leadIn}s; leave ~0.2 s before it (padEnd on the lead-in cut).`, { padEnd: 0.2 }, 17); }
    if (ending.tailAfterVoiceSec != null && ending.tailAfterVoiceSec < T.tailMinSec) { s -= 1; why.push(`only ${ending.tailAfterVoiceSec}s after the last word`); fix('technical.short_tail', 'TECHNICAL', `Only ${ending.tailAfterVoiceSec}s after the last word; hold 0.5 s (brief.endHoldSec).`, { endHoldSec: 0.5 }, 17); }
    if (midDrops.length || (diff && diff.fragments.length)) { s = Math.min(s, 2); why.push('abrupt audio cut inside speech (see AUDIO)'); }
    if (blackFrames.length) { s = Math.min(s, 2); why.push(`black frame at ${blackFrames.map(b => b.t).join(', ')}s`); }
    if (vision.captions && vision.captions.in_safe_zone === false) { s = Math.min(s, 3); why.push('captions outside safe areas'); }
    if (vision.framing && vision.framing.blur_or_halo && vision.framing.blur_or_halo !== 'none') { s = Math.min(s, 3); why.push(`visual artifact: ${vision.framing.blur_or_halo}`); }
    if (!why.length) why.push(`complete last sentence, ${leadIn}s lead-in, ${ending.tailAfterVoiceSec}s tail, no black frames, no abrupt cuts`);
    set('TECHNICAL', s, why, [17]);
  }

  // ── 8. §22 / §18 / §19 synthesis ──
  const order = ['HOOK', 'CLARITY', 'PACING', 'VISUALS', 'HUMAN', 'AUDIO', 'CAPTIONS', 'STORY', 'PAYOFF', 'CTA', 'TECHNICAL'];
  const qcSummary = order.map(k => `${k} ${qc[k].score}/5 — ${qc[k].reason}`).join('\n');
  if (useVision) await tryAsk('verdict', [sheets[1] || sheets[0]], VIS.verdictPrompt({ qcSummary, transcript: outT.text.slice(0, 900), weakCandidates: weak.slice(0, 8) }));
  const vv = vision.verdict, vs = vision.story;
  const hardFails = order.filter(k => qc[k].score <= 2);
  const scores = order.map(k => qc[k].score);
  const average = +(scores.reduce((x, y) => x + y, 0) / scores.length).toFixed(2);

  const proud = { answer: vv ? !!vv.proud : (hardFails.length === 0 && average >= 4), reason: vv ? vv.proud_reason : (useVision ? 'synthesis unavailable — derived from the QC table' : 'derived from the QC table (--no-vision)') };
  // §19: the source is the limiting factor when the story pass or the synthesis says so AND at least one measured/vision source signal backs it.
  const sourceSignals = [
    qc.HUMAN.eyeContactShare != null && qc.HUMAN.eyeContactShare < T.eyeContactFailShare ? `eye contact ${Math.round(qc.HUMAN.eyeContactShare * 100)}%` : null,
    box != null && box >= T.boxinessHollowDb ? `hollow room ${box} dB` : null,
    vision.hook && vision.hook.hook_exists_in_footage === false ? 'no usable hook line' : null,
    vs && vs.source_delivery === 'weak' ? 'delivery judged weak' : null,
    srcFalseStarts != null && srcFalseStarts >= 2 ? `${srcFalseStarts} false starts in the take` : null,
    fumbled ? 'closing line fumbled' : null,
  ].filter(Boolean);
  const source = {
    hookUsable: vs ? vs.source_hook_usable !== false : null,
    audioUsable: vs ? vs.source_audio_usable !== false : (box != null ? box < T.boxinessHollowDb : null),
    delivery: vs ? vs.source_delivery : null,
    brollMissing: vs ? (vs.broll_missing || '') : '',
    signals: sourceSignals,
    recommendReshoot: !!((vs && vs.recommend_reshoot) || (vv && vv.verdict === 'RESHOOT')) && sourceSignals.length > 0,
    reason: (vs && vs.reshoot_reason) || (vv && vv.verdict === 'RESHOOT' ? vv.proud_reason : ''),
  };
  const weakest = vv && Array.isArray(vv.weakest) ? vv.weakest.slice(0, 3).map(w => ({ atSec: num(w.atSec), what: String(w.what || ''), cause: String(w.cause || '') })) : weak.slice(0, 3).map(w => { const m = /^([\d.]+)s: (.*) \((.*)\)$/.exec(w); return m ? { atSec: +m[1], what: m[2], cause: m[3] } : { atSec: null, what: w, cause: 'editing' }; });
  const sourceCauses = weakest.filter(w => /source|missing B-roll/i.test(w.cause)).length;

  // §19 source findings become REAL entries in the fix list, tagged
  // human-only. They used to live only in `review.source`, which meant a FAIL
  // (not a RESHOOT) could carry an unfixable source problem that produce.js
  // never named. Now every one of them is on the list produce.js reports.
  if (vs && vs.source_delivery === 'weak') fix('human.delivery_weak', 'HUMAN', `Delivery in the take is weak${vs.reshoot_reason ? ` — ${vs.reshoot_reason}` : ''}; §19 says say so rather than hide it in the edit.`, null, 19);
  if (source.audioUsable === false) fix('audio.unusable_source', 'AUDIO', `Source audio is not usable as recorded${box != null ? ` (room 200-500 Hz sits ${box} dB over 1-4 kHz)` : ''}; no filter chain removes a room, only reduces it.`, null, 19);
  if (vision.hook && vision.hook.hook_exists_in_footage === false) fix('story.weak_concept', 'STORY', 'No line in the take would stop a scroll (§3: the problem is the concept, not the edit).', null, 3);

  let verdict;
  if (source.recommendReshoot || (sourceCauses >= 2 && !proud.answer && sourceSignals.length)) verdict = 'RESHOOT';
  else if (hardFails.length === 0 && average >= 4 && proud.answer) verdict = 'PASS';
  else verdict = 'FAIL';
  if (verdict === 'RESHOOT' && !source.recommendReshoot) source.recommendReshoot = true;

  const review = {
    label, video, durationSec: meta.durationSec, resolution: `${meta.width}x${meta.height}`,
    standard: 'docs/DOSSIE-CREATIVE-DIRECTOR-STANDARD.md',
    verdict, proud, average, failedOn: hardFails,
    qc: order.reduce((o, k) => { o[k] = qc[k]; return o; }, {}),
    weakest, oneChange: vv ? vv.one_change_that_matters_most : null,
    source,
    fixes,
    // The loop-accountability ledger. produce.js must be able to say, for
    // every single finding, either "I turned this knob" or "a human has to do
    // this and here is what". `knobGaps` being non-empty is a REVIEWER bug.
    fixAccounting: {
      total: fixes.length,
      editorFixable: fixes.filter(f => f.owner === 'editor' && f.brief).length,
      humanOnly: fixes.filter(f => f.owner === 'human').length,
      knobGaps: fixes.filter(f => f.knobGap).map(f => f.id),
      unregistered: fixes.filter(f => f.owner === 'unregistered').map(f => f.id),
    },
    measured: {
      loudness: loud, levels: { speechMedianDb: +lv.speechMedianDb.toFixed(1), gapMedianDb: lv.gapMedianDb != null ? +lv.gapMedianDb.toFixed(1) : null }, room: { ...room, boxinessDb: box }, chain,
      hardDrops: drops, ending, leadInSec: leadIn, wordDiff: diff ? { intended: diff.intendedCount, output: diff.outputCount, missing: diff.missing, fragments: diff.fragments, extra: diff.extra.length } : null,
      sync, cuts, longestStretch: longest, blackFrames, face: { median: faceHMedian, p25: faceHP25, max: faceHMax, clippedAt, scaleJumps, samples: faces.length, found: talking.length }, brollSec,
      outputText: outT.text, sourceFalseStarts: srcFalseStarts,
    },
    vision,
    notes: [
      src ? null : 'A/V sync was not measured: pass --src <raw take> to enable it.',
      srcWords ? null : 'No source transcript: missing-word check limited to chopped fragments; fumbled-take check off.',
      'Cannot hear tone directly — "hollow", "squashed", "muffled/harsh" come from measured spectra; "slurred" comes from the source take (restart right before the line) and word timing.',
    ].filter(Boolean),
  };
  const outPath = args.out || p('review.json');
  fs.writeFileSync(outPath, JSON.stringify(review, null, 2));

  console.log(`\n=== REVIEW ${label}: ${verdict} (avg ${average}) — §22 proud: ${proud.answer ? 'YES' : 'NO'} — ${proud.reason} ===`);
  for (const k of order) console.log(`  ${k.padEnd(10)} ${qc[k].score}  ${qc[k].reason}`);
  console.log('  §18 weakest:'); for (const w of weakest) console.log(`   - ${w.atSec != null ? w.atSec + 's' : '—'}: ${w.what} [${w.cause}]`);
  if (source.recommendReshoot) console.log(`  §19 RESHOOT: ${source.reason} (signals: ${sourceSignals.join(', ')})`);
  if (fixes.length) {
    console.log('  fixes:');
    for (const f of fixes) console.log(`   - [${f.owner === 'human' ? 'HUMAN' : f.brief ? 'KNOB ' : 'GAP  '}] [${f.check} §${f.section}] ${f.id}: ${f.instruction}`);
    const acct = review.fixAccounting;
    console.log(`  fix accounting: ${acct.editorFixable} editor-fixable, ${acct.humanOnly} human-only, ${acct.knobGaps.length} knob gaps${acct.unregistered.length ? `, ${acct.unregistered.length} UNREGISTERED` : ''}`);
    if (acct.knobGaps.length) console.log(`  REVIEWER BUG — editor-owned findings with no brief patch: ${acct.knobGaps.join(', ')}`);
  }
  if (vision.errors.length) console.log(`  vision errors: ${vision.errors.join(' | ')}`);
  console.log(`  -> ${outPath}`);
  process.exit(verdict === 'PASS' ? 0 : verdict === 'RESHOOT' ? 3 : 2);
}

main().catch(e => { console.error(e); process.exit(1); });
