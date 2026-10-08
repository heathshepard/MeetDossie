#!/usr/bin/env node
//
// scripts/video-engine/produce-variants.js
//
// ONE recording -> BOTH platform cuts -> per-variant gate -> auto-queue.
//
// This is the standing production process. Run it once per finished master
// and it does everything that used to be done by hand, in the order that used
// to be forgotten:
//
//   1. read the variant spec (segments tagged CORE / OPTIONAL)
//   2. build both cuts off the SAME master and the SAME matte frames
//   3. remap captions, shot plan and cue points onto each new timeline
//   4. run scripts/check-video-quality-cli.js on EACH cut with ITS platforms
//   5. queue the ones that pass; refuse the ones that don't, with the reason
//
// THE TWO CUTS
//
//   core   CORE only          ~30s   -> tiktok, instagram      (gate: vertical)
//   full   CORE + OPTIONAL    ~50-60s -> youtube, facebook,
//                                        linkedin              (gate: vertical_long)
//
// Aspect ratio is NOT a variable — 9:16 1080x1920 for both.
//
// TWO SOURCE MODES
//
//   --from master   slice the finished composite (fast; what the 2026-09-25
//                   42s cut did). Captions, scroll and annotation are already
//                   burned in, so the remapped artefacts are emitted for
//                   inspection rather than re-rendered.
//   --from frames   slice the shared rgba/ frame directory and re-composite
//                   with the remapped caption file and shot-plan expressions.
//                   Costs one encode per variant; still never re-mattes.
//
// Either way the matte (recipe §5, the expensive step) is paid ONCE per
// recording, not once per cut.
//
// NOTHING PUBLISHES FROM THIS SCRIPT. It writes a `video_library` row at
// status='approved', which is the queue-entry step; api/cron-post-videos.js
// then sends Heath the Telegram approve card and only posts after his tap.
// --dry-run prints the row and uploads nothing.
//
// The row also gets a real `scheduled_for` (Atlas 2026-09-25, via
// queueVariant() -> api/_lib/video-schedule.js) so it doesn't just wait
// oldest-first once approved — see queue-variant.js's own header.
//
// USAGE
//   node scripts/video-engine/produce-variants.js --spec spec.json [--dry-run]
//   node scripts/video-engine/produce-variants.js --spec spec.json --only core
//
// SPEC (see recipes/trec-7i/variants.json for a worked example)
//   {
//     "id": "trec-7i-water",
//     "topic": "...",
//     "master": "/abs/path/master.mp4",
//     "cover":  "/abs/path/cover.png",
//     "fps": 30,
//     "captions": "/abs/path/caps.ass",
//     "shotPlan": { "w": "...w4b.txt", "x": "...x4b.txt" },
//     "cues": [{ "name": "circle", "t": 19.1 }],
//     "framesDir": "/abs/path/rgba",
//     "headTrim": 0.25,
//     "segments": [{ "start": 0, "end": 4.02, "tag": "CORE", "text": "..." }],
//     "variants": {
//       "core": { "caption": "...", "platforms": ["tiktok","instagram"] },
//       "full": { "caption": "...", "platforms": ["youtube","facebook","linkedin"] }
//     }
//   }

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const V = require('./variants.js');
const { VARIANTS } = require('./script-format.js');
const { queueVariant } = require('./queue-variant.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GATE_CLI = path.join(REPO_ROOT, 'scripts', 'check-video-quality-cli.js');

function arg(name, dflt = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}

function ffprobeJson(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-show_entries', 'stream=codec_type,nb_frames,width,height,r_frame_rate',
    '-of', 'json', file,
  ], { encoding: 'utf8', maxBuffer: 1 << 22 });
  return JSON.parse(out);
}

function probe(file) {
  const j = ffprobeJson(file);
  const v = (j.streams || []).find((s) => s.codec_type === 'video') || {};
  const [n, d] = String(v.r_frame_rate || '30/1').split('/').map(Number);
  return {
    duration: Number(j.format.duration),
    frames: Number(v.nb_frames) || null,
    width: Number(v.width), height: Number(v.height),
    fps: d ? n / d : 30,
  };
}

/**
 * renderFromMaster — slice the finished composite to the variant's keep list.
 *
 * One filter_complex, one encode. Video and audio are trimmed on the SAME
 * boundaries and concatenated together, so recipe §4's sync assertion
 * (|frames/fps - audioDuration| < 50ms) still holds on the output — the two
 * streams cannot drift apart if they are cut in the same graph.
 */
function renderFromMaster(master, variant, outPath) {
  const vf = V.ffmpegVideoTrimFilter(variant, { inLabel: '0:v', outLabel: 'vout' });
  const af = V.ffmpegAudioFilter(variant, { inLabel: '0:a', outLabel: 'aout' });
  const args = [
    '-nostdin', '-y', '-i', master,
    '-filter_complex', `${vf};${af}`,
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outPath,
  ];
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status}): ${String(r.stderr).slice(-1200)}`);
  return outPath;
}

/**
 * assertSync — recipe §4, made a hard check instead of an eyeball.
 * "Apply speed in exactly one place. Then assert."
 */
function assertSync(file, label) {
  const p = probe(file);
  const videoSec = p.frames ? p.frames / p.fps : p.duration;
  const drift = Math.abs(videoSec - p.duration);
  if (drift > 0.05) {
    throw new Error(`${label}: A/V drift ${(drift * 1000).toFixed(0)}ms exceeds 50ms (frames ${p.frames} @ ${p.fps}fps = ${videoSec.toFixed(3)}s vs audio ${p.duration.toFixed(3)}s)`);
  }
  return { ...p, driftMs: Math.round(drift * 1000) };
}

/**
 * runGate — the real CLI, with THIS variant's orientation.
 *
 * The orientation argument is the whole point of running it per-variant:
 * without it the long cut is graded against TikTok's 21-34s window and fails
 * for being long, which is the 51.2s "fits neither TikTok's 21-34s window nor
 * IG's 7-15s loop window" rejection this process exists to stop repeating.
 */
function runGate(videoPath, coverPath, orientation) {
  const r = spawnSync('node', [
    GATE_CLI,
    '--video', videoPath,
    '--cover', coverPath,
    '--orientation', orientation,
  ], { encoding: 'utf8', maxBuffer: 1 << 24, timeout: 10 * 60 * 1000 });

  const line = String(r.stdout || '').trim().split('\n').filter(Boolean).pop();
  if (!line) {
    // "No parseable JSON" is a hard failure, never a skip — the CLI's own
    // contract says so.
    throw new Error(`quality gate produced no JSON (exit ${r.status}): ${String(r.stderr).slice(-600)}`);
  }
  return { result: JSON.parse(line), exitCode: r.status, stderr: String(r.stderr || '') };
}

async function main() {
  const specPath = arg('--spec');
  if (!specPath) { console.error('usage: produce-variants.js --spec <spec.json> [--dry-run] [--only core|full] [--from master|frames] [--outdir DIR]'); process.exit(1); }

  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  // Paths in a spec may be repo-relative (portable, checked in) or absolute
  // (local media, which Media/ being gitignored makes unavoidable).
  const abs = (p) => (!p || path.isAbsolute(p) ? p : path.join(REPO_ROOT, p));
  spec.master = abs(spec.master);
  spec.cover = abs(spec.cover);
  spec.captions = abs(spec.captions);
  spec.framesDir = abs(spec.framesDir);
  if (spec.shotPlan) for (const k of Object.keys(spec.shotPlan)) spec.shotPlan[k] = abs(spec.shotPlan[k]);
  const dryRun = process.argv.includes('--dry-run');
  const only = arg('--only');
  const from = arg('--from', 'master');
  const outDir = arg('--outdir', path.join(os.tmpdir(), `variants-${spec.id}`));
  fs.mkdirSync(outDir, { recursive: true });

  const masterProbe = probe(spec.master);
  const fps = spec.fps || masterProbe.fps || 30;

  console.error(`\nmaster: ${spec.master}`);
  console.error(`  ${masterProbe.width}x${masterProbe.height} @${fps}fps  ${masterProbe.duration.toFixed(3)}s  ${masterProbe.frames} frames`);
  console.error(`  segments: ${spec.segments.length} (CORE ${spec.segments.filter((s) => s.tag === 'CORE').length} / OPTIONAL ${spec.segments.filter((s) => s.tag === 'OPTIONAL').length})\n`);

  // Clamp the last segment to the master — caption tail padding routinely
  // runs a couple of hundred ms past the final frame, and an atrim past EOF
  // silently shortens the output instead of erroring.
  const segments = spec.segments.map((s) => ({ ...s, end: Math.min(s.end, masterProbe.duration) }));

  // HEAD TRIM — see spec.headTrim. On the TREC 7.I master the hook card
  // fades IN over the first frames, so frame 0 carries no hook text and the
  // gate's blocking hook_visible_frame0 rule fails on a card that is in fact
  // there. Starting a hair later lands frame 0 on the fully-opaque card and
  // pulls the card's clear time below the 3.0s sample. It is a fade, not
  // content.
  if (spec.headTrim) segments[0] = { ...segments[0], start: segments[0].start + spec.headTrim };

  const report = [];

  for (const which of ['core', 'full']) {
    if (only && only !== which) continue;
    const vspec = (spec.variants || {})[which];
    if (!vspec) { console.error(`(no '${which}' variant in spec — skipping)`); continue; }

    const meta = VARIANTS[which];
    const variant = V.buildVariant({
      segments,
      includeTags: meta.includes,
      fps,
      masterDuration: masterProbe.duration,
      which,
    });

    console.error(`── ${which} (${meta.label}) ──────────────────────────────`);
    console.error(`  keeps ${variant.keep.length} span(s), ${variant.duration.toFixed(2)}s (dropped ${variant.droppedSeconds.toFixed(2)}s)`);
    console.error(`  target window ${meta.targetSeconds.join('-')}s, gate orientation '${meta.gateOrientation}', platforms ${meta.platforms.join(', ')}`);

    // ---- per-variant derived artefacts --------------------------------
    const artefacts = {};
    if (spec.captions && fs.existsSync(spec.captions)) {
      const remapped = V.remapAss(fs.readFileSync(spec.captions, 'utf8'), variant);
      artefacts.captions = path.join(outDir, `${spec.id}-${which}.ass`);
      fs.writeFileSync(artefacts.captions, remapped.text);
      console.error(`  captions: ${remapped.kept} kept, ${remapped.dropped} dropped -> ${artefacts.captions}`);
    }
    for (const key of ['w', 'x']) {
      const src = spec.shotPlan && spec.shotPlan[key];
      if (!src || !fs.existsSync(src)) continue;
      const r = V.remapShotPlan(fs.readFileSync(src, 'utf8').trim(), variant);
      artefacts[`shotPlan_${key}`] = path.join(outDir, `${spec.id}-${which}-${key}.txt`);
      fs.writeFileSync(artefacts[`shotPlan_${key}`], r.expr);
      console.error(`  shot-plan ${key}: ${r.removedWindows} window(s) removed -> ${artefacts[`shotPlan_${key}`]}`);
    }
    if (spec.cues && spec.cues.length) {
      const r = V.remapCues(spec.cues, variant);
      artefacts.cues = r;
      for (const c of r.cues) console.error(`  cue '${c.name}': master ${c.tMaster ?? c.t0Master}s -> ${c.t ?? c.t0}s`);
      for (const c of r.orphaned) console.error(`  cue '${c.name}': ORPHANED — ${c.reason}`);
    }
    if (from === 'frames' && spec.framesDir) {
      const dst = path.join(outDir, `${which}-rgba`);
      const copied = V.copyFrameSlice(spec.framesDir, dst, variant);
      console.error(`  frames: ${copied.frames} (${copied.linked} hard-linked, ${copied.copied} copied) -> ${dst}`);
      artefacts.framesDir = dst;
    }

    // ---- render ---------------------------------------------------------
    const outPath = path.join(outDir, `${spec.id}-${which}.mp4`);
    console.error('  rendering…');
    renderFromMaster(spec.master, variant, outPath);
    const sync = assertSync(outPath, which);
    console.error(`  rendered ${sync.duration.toFixed(3)}s  ${sync.frames} frames  ${sync.width}x${sync.height}  drift ${sync.driftMs}ms`);

    // ---- gate -----------------------------------------------------------
    console.error(`  gate (orientation=${meta.gateOrientation})…`);
    const gate = runGate(outPath, spec.cover, meta.gateOrientation);
    const runtimeRule = gate.result.rules.runtime_in_platform_range;
    console.error(`  gate: ${gate.result.pass ? 'PASS' : `FAIL [${gate.result.failedRules.join(', ')}]`}`);
    console.error(`  runtime rule: ${runtimeRule.pass ? 'pass' : 'FAIL'} — ${runtimeRule.note}`);

    const entry = {
      which,
      label: meta.label,
      platforms: meta.platforms,
      gateOrientation: meta.gateOrientation,
      file: outPath,
      duration: sync.duration,
      frames: sync.frames,
      resolution: `${sync.width}x${sync.height}`,
      driftMs: sync.driftMs,
      keepSpans: variant.keep,
      gatePass: gate.result.pass,
      failedRules: gate.result.failedRules,
      runtimeNote: runtimeRule.note,
      artefacts,
      queued: null,
    };

    // ---- auto-queue -----------------------------------------------------
    // A variant that fails its own gate is NOT queued, and says why. That is
    // the whole contract: the gate is not advisory.
    if (!gate.result.pass) {
      entry.queued = { queued: false, reason: `gate failed: ${gate.result.failedRules.join(', ')}` };
      console.error(`  NOT QUEUED — ${entry.queued.reason}\n`);
      report.push(entry);
      continue;
    }

    try {
      const q = await queueVariant({
        videoPath: outPath,
        coverPath: spec.cover,
        id: `${spec.id}-${which}-${new Date().toISOString().slice(0, 10)}`,
        topic: `${spec.topic} (${meta.label} cut)`,
        caption: vspec.caption,
        platforms: meta.platforms,
        owner: spec.owner || 'dossie',
        gateResult: gate.result,
        dryRun,
        extraDetail: {
          variant: which,
          variant_of: spec.id,
          gate_orientation: meta.gateOrientation,
          keep_spans: variant.keep,
          master_duration: masterProbe.duration,
          produced_by: 'scripts/video-engine/produce-variants.js',
        },
      });
      entry.queued = { queued: true, ...q };
      console.error(`  QUEUED${dryRun ? ' (dry-run — nothing written)' : ''} as status='${q.status}'\n`);
    } catch (err) {
      entry.queued = { queued: false, reason: err.message };
      console.error(`  QUEUE FAILED — ${err.message}\n`);
    }

    report.push(entry);
  }

  process.stdout.write(`${JSON.stringify({ id: spec.id, outDir, variants: report }, null, 2)}\n`);
  const anyFailed = report.some((r) => !r.gatePass);
  process.exit(anyFailed ? 2 : 0);
}

module.exports = { runGate, renderFromMaster, assertSync, probe };
if (require.main === module) main().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
