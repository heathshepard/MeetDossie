#!/usr/bin/env node
/**
 * recording-preset.js — loads recording-presets.json and decides which
 * preset (if any) applies to a given source file.
 *
 * A recording preset is a measured, human-verified baseline framing for one
 * physical place Heath shoots from. See recording-presets.json for the full
 * rationale; the short version is that "how much of the sensor is the actual
 * picture" is a property of the ROOM, not of the take, so it is config with
 * its derivation recorded rather than a constant inside a function.
 *
 * THE PRESET IS A BASELINE FOR THE FACE TRACKER, NOT A RIGID CROP.
 * Nothing in this file crops anything. It hands face-track-crop.js a home
 * rect + a tracking policy; the tracker follows the face around that home
 * and clamps to source bounds. Applied statically, the 2026-09-22
 * kitchen-island rect amputates a raised hand in the last seconds of the
 * very take it was derived from.
 *
 * ROTATION. Everything here works in DISPLAY space — after the container's
 * rotation metadata is applied. `displayDimensions()` is the only place that
 * conversion happens and every other function takes display dims.
 *
 * Usage (CLI, for inspection):
 *   node scripts/video-engine/recording-preset.js --src <video>
 *   node scripts/video-engine/recording-preset.js --list
 *
 * Library:
 *   const RP = require('./recording-preset.js');
 *   const r = await RP.resolvePreset({ src, explicit: 'kitchen-island'|'none'|null });
 *   // r = { name, preset, how: 'explicit'|'auto'|'none', confidence, evidence, reason }
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PRESETS_PATH = path.join(__dirname, 'recording-presets.json');

function loadPresets() {
  const raw = JSON.parse(fs.readFileSync(PRESETS_PATH, 'utf8'));
  return raw.presets || {};
}

function getPreset(name) {
  const all = loadPresets();
  if (!all[name]) {
    throw new Error(`Unknown recording preset "${name}". Known: ${Object.keys(all).join(', ') || '(none)'}`);
  }
  return all[name];
}

/**
 * displayDimensions — the frame size AFTER rotation metadata is applied,
 * which is what ffmpeg actually decodes and therefore the only coordinate
 * space a preset may be expressed in.
 *
 * Phone footage is routinely stored 3840x2160 with a -90 display matrix and
 * presents as 2160x3840. Reading stream width/height and skipping this step
 * is how a preset silently lands sideways.
 */
function displayDimensions(srcPath) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate:stream_side_data=rotation',
    '-of', 'json', srcPath]).toString();
  const j = JSON.parse(out);
  const s = (j.streams || [])[0];
  if (!s) throw new Error(`no video stream in ${srcPath}`);
  let rotation = 0;
  for (const sd of (s.side_data_list || [])) {
    if (sd.rotation != null) rotation = Number(sd.rotation);
  }
  const swap = Math.abs(rotation % 180) === 90;
  const fpsParts = String(s.r_frame_rate || '30/1').split('/');
  return {
    storedWidth: s.width,
    storedHeight: s.height,
    rotation,
    rotated: swap,
    width: swap ? s.height : s.width,
    height: swap ? s.width : s.height,
    fps: Number(fpsParts[0]) / Number(fpsParts[1] || 1),
  };
}

/** Duration in seconds, or null. */
function durationSec(srcPath) {
  try {
    return parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'csv=p=0', srcPath]).toString().trim());
  } catch { return null; }
}

/**
 * sampleFaces — decode N evenly spaced frames and run the engine's own
 * RFB-320 detector on each. Returns per-frame {cxFrac, cyFrac, fhFrac,
 * score}. Frames are decoded at reduced size (long edge 960) purely for
 * speed; all outputs are FRACTIONS so the reduction cannot skew them.
 */
async function sampleFaces(srcPath, opts = {}) {
  const count = opts.count || 9;
  const dur = durationSec(srcPath) || 10;
  const dims = displayDimensions(srcPath);
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rp-faces-'));
  const results = [];
  try {
    // Skip the first and last 5% — lean-ins toward the phone to start/stop
    // recording are not representative of how the take is framed.
    const t0 = dur * 0.05, t1 = dur * 0.95;
    const times = [];
    for (let i = 0; i < count; i++) times.push(t0 + (t1 - t0) * (count === 1 ? 0.5 : i / (count - 1)));

    for (let i = 0; i < times.length; i++) {
      const f = path.join(tmpDir, `s${String(i).padStart(3, '0')}.png`);
      try {
        execFileSync('ffmpeg', ['-v', 'error', '-ss', times[i].toFixed(3), '-i', srcPath,
          '-frames:v', '1', '-vf', 'scale=960:-2', f, '-y'], { stdio: 'ignore' });
      } catch { continue; }
      if (!fs.existsSync(f)) continue;
      results.push({ t: +times[i].toFixed(2), file: f });
    }

    if (!results.length) return { dims, faces: [], reason: 'no frames could be decoded' };

    const { detectFaceInFile } = require('./face-detect-lib.js');
    const faces = [];
    for (const r of results) {
      const d = await detectFaceInFile(r.file);
      if (d && d.found) {
        faces.push({
          t: r.t, found: true, score: d.score,
          cxFrac: d.cx / d.srcW, cyFrac: d.cy / d.srcH, fhFrac: d.fh / d.srcH,
        });
      } else {
        faces.push({ t: r.t, found: false });
      }
    }
    return { dims, faces };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function within(v, range) {
  return v >= range.min && v <= range.max;
}

/**
 * matchPreset — score one preset's autoDetect rules against measured dims +
 * faces. Returns { match, confidence, evidence, failed[] }.
 *
 * Deliberately strict: shape rules are ALL-or-nothing (a landscape source is
 * simply not this preset), and the face rules must agree on a majority of
 * sampled frames. A preset that fires on the wrong footage is worse than one
 * that never fires, because the wrong crop looks deliberate.
 */
function matchPreset(preset, dims, faces) {
  const ad = preset.autoDetect;
  if (!ad) return { match: false, confidence: 0, evidence: {}, failed: ['preset has no autoDetect rules'] };
  const failed = [];

  const aspect = dims.width / dims.height;
  if (ad.requirePortrait && dims.height <= dims.width) failed.push(`not portrait (${dims.width}x${dims.height})`);
  if (ad.aspect && !within(aspect, ad.aspect)) failed.push(`aspect ${aspect.toFixed(4)} outside ${ad.aspect.min}-${ad.aspect.max}`);
  if (ad.minDisplayHeight && dims.height < ad.minDisplayHeight) failed.push(`display height ${dims.height} < ${ad.minDisplayHeight}`);

  const usable = faces.filter(f => f.found && f.score >= (ad.minFaceScore || 0.9));
  const evidence = {
    aspect: +aspect.toFixed(4),
    displayDims: `${dims.width}x${dims.height}`,
    rotation: dims.rotation,
    framesSampled: faces.length,
    facesFound: usable.length,
  };

  if (!usable.length) {
    failed.push('no confident face detections in the sampled frames');
    return { match: false, confidence: 0, evidence, failed };
  }

  const agree = usable.filter(f =>
    within(f.fhFrac, ad.faceHeightFrac) &&
    within(f.cyFrac, ad.faceCyFrac) &&
    within(f.cxFrac, ad.faceCxFrac));
  const agreementFrac = agree.length / usable.length;

  const med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  evidence.medianFaceHeightFrac = +med(usable.map(f => f.fhFrac)).toFixed(4);
  evidence.medianFaceCyFrac = +med(usable.map(f => f.cyFrac)).toFixed(4);
  evidence.medianFaceCxFrac = +med(usable.map(f => f.cxFrac)).toFixed(4);
  evidence.frameAgreementFrac = +agreementFrac.toFixed(3);

  if (agreementFrac < (ad.minFrameAgreementFrac || 0.6)) {
    failed.push(`only ${(agreementFrac * 100).toFixed(0)}% of frames match the face-position signature (need ${((ad.minFrameAgreementFrac || 0.6) * 100).toFixed(0)}%) — median faceHeight ${evidence.medianFaceHeightFrac} vs ${ad.faceHeightFrac.min}-${ad.faceHeightFrac.max}, median cy ${evidence.medianFaceCyFrac} vs ${ad.faceCyFrac.min}-${ad.faceCyFrac.max}`);
  }

  // Confidence = how far inside the bounds the medians sit (0 at the edge,
  // 1 dead centre), blended with frame agreement. Reported, never a gate.
  const depth = (v, r) => {
    const mid = (r.min + r.max) / 2, half = (r.max - r.min) / 2;
    return half > 0 ? Math.max(0, 1 - Math.abs(v - mid) / half) : 0;
  };
  const confidence = failed.length ? 0 : +(
    0.4 * agreementFrac +
    0.3 * depth(evidence.medianFaceHeightFrac, ad.faceHeightFrac) +
    0.3 * depth(evidence.medianFaceCyFrac, ad.faceCyFrac)
  ).toFixed(3);

  return { match: failed.length === 0, confidence, evidence, failed };
}

/**
 * resolvePreset — the one entry point callers should use.
 *
 * explicit:
 *   a preset name  -> use it, no detection, no argument
 *   'none'/'off'   -> explicitly disable, no detection
 *   null/undefined -> auto-detect against every preset
 *
 * NEVER-SILENT: the returned object always carries `reason` explaining why
 * the answer is what it is, and callers print it. A framing decision that
 * happens invisibly is indistinguishable from a bug.
 */
async function resolvePreset({ src, explicit, allowAuto = true, sampleCount = 9 } = {}) {
  const all = loadPresets();

  if (explicit && ['none', 'off', 'false', '0'].includes(String(explicit).toLowerCase())) {
    return { name: null, preset: null, how: 'none', confidence: 0, evidence: {}, reason: 'preset explicitly disabled' };
  }
  if (explicit && explicit !== true) {
    const p = getPreset(String(explicit));
    return { name: String(explicit), preset: p, how: 'explicit', confidence: 1, evidence: {}, reason: `preset "${explicit}" named explicitly` };
  }
  if (!allowAuto) {
    return { name: null, preset: null, how: 'none', confidence: 0, evidence: {}, reason: 'auto-detection disabled and no preset named' };
  }
  if (!src || !fs.existsSync(src)) {
    return { name: null, preset: null, how: 'none', confidence: 0, evidence: {}, reason: 'no source file to detect against' };
  }

  let sampled;
  try {
    sampled = await sampleFaces(src, { count: sampleCount });
  } catch (e) {
    return { name: null, preset: null, how: 'none', confidence: 0, evidence: {}, reason: `auto-detection could not run (${e.message.slice(0, 160)}) — falling back to no preset` };
  }

  const attempts = [];
  for (const [name, preset] of Object.entries(all)) {
    const m = matchPreset(preset, sampled.dims, sampled.faces);
    attempts.push({ name, ...m });
  }
  const winners = attempts.filter(a => a.match).sort((a, b) => b.confidence - a.confidence);

  if (!winners.length) {
    const why = attempts.map(a => `${a.name}: ${a.failed.join('; ')}`).join(' | ') || 'no presets defined';
    return {
      name: null, preset: null, how: 'none', confidence: 0,
      evidence: attempts[0] ? attempts[0].evidence : {},
      attempts,
      reason: `no recording preset matched — ${why}`,
    };
  }
  const w = winners[0];
  return {
    name: w.name, preset: all[w.name], how: 'auto', confidence: w.confidence,
    evidence: w.evidence, attempts,
    reason: `auto-detected "${w.name}" (confidence ${w.confidence}) — ${w.evidence.displayDims} portrait, median face height ${w.evidence.medianFaceHeightFrac} of frame at cy ${w.evidence.medianFaceCyFrac}, ${(w.evidence.frameAgreementFrac * 100).toFixed(0)}% of ${w.evidence.facesFound} detected frames agree`,
  };
}

/**
 * baselineForFrame — translate a preset's normalized baseline into absolute
 * pixels for whatever resolution the engine is actually working at.
 * The engine downsamples (edit.js caps the long edge at 2880), so this is
 * the only correct way to apply a preset rect.
 */
function baselineForFrame(preset, frameW, frameH) {
  const n = preset.baselineCropNormalized;
  return {
    x: Math.round(n.x * frameW),
    y: Math.round(n.y * frameH),
    w: Math.round(n.w * frameW),
    h: Math.round(n.h * frameH),
    zoom: 1 / n.h,
  };
}

async function main() {
  const a = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) { const k = a[i].slice(2); args[k] = (a[i + 1] && !a[i + 1].startsWith('--')) ? a[++i] : true; }
  }
  if (args.list) {
    const all = loadPresets();
    for (const [name, p] of Object.entries(all)) {
      console.log(`${name}: ${p.label}`);
      console.log(`  baseline crop ${p.baselineCrop.w}x${p.baselineCrop.h}+${p.baselineCrop.x}+${p.baselineCrop.y} on ${p.derivation.sourceDisplayWidth}x${p.derivation.sourceDisplayHeight} (rotation ${p.derivation.sourceRotation}), zoom ${p.baselineZoom}`);
      console.log(`  derived ${p.derivation.date} from ${path.basename(p.derivation.derivedFrom)}`);
    }
    return;
  }
  if (!args.src) { console.error('Usage: recording-preset.js --src <video> | --list'); process.exit(1); }
  const r = await resolvePreset({ src: args.src, explicit: args.preset });
  console.log(JSON.stringify({ name: r.name, how: r.how, confidence: r.confidence, reason: r.reason, evidence: r.evidence, attempts: r.attempts }, null, 2));
}

module.exports = { loadPresets, getPreset, displayDimensions, sampleFaces, matchPreset, resolvePreset, baselineForFrame, PRESETS_PATH };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
