#!/usr/bin/env node
/**
 * produce-doc-explainer.js — the "contract explainer" pipeline, as a real
 * callable entry point.
 *
 * This is the composite behind Downloads/dossie_water_60s_v4.mp4: a matted
 * cutout of Heath, bottom-aligned at a per-shot size and position, over a
 * scrolling TREC contract, with a drawn-on annotation, a document snip card,
 * proven captions, a standing hook and a graphic CTA.
 *
 * It exists because that video was produced entirely by hand-typed ffmpeg in
 * a temp directory and the engine could not reproduce it. edit.js is the
 * talking-head pipeline (crop -> matte -> backdrop); this is the
 * document-evidence pipeline. They share the same modules.
 *
 * STAGES
 *   1  audio   : fold dead channel -> Audio Isolation (A/B) -> chain -> atempo
 *   2  frames  : island crop -> speed-up (ONCE) -> 640px -> PNG sequence
 *   3  matte   : matte.js --mode rgba (the 5.7 fps path), staged on /tmp
 *   4  bg      : doc-scroll.js for the full duration
 *   5  overlays: annotate.js (draw-on) + doc-snip.js (evidence card)
 *   6  comp    : per-shot cutout composite from shot-plan.js --looks proven
 *   7  caps    : captions-proven.js, burned with libass
 *   8  cards   : overlay-cards.js hook + CTA
 *   9  gate    : sync-guard.js on the delivered file
 *
 * EVERYTHING STAGES ON THE NATIVE LINUX FILESYSTEM. See matte.js's header.
 *
 * Usage:
 *   node scripts/video-engine/produce-doc-explainer.js --config cfg.json --out final.mp4
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SYNC = require('./sync-guard.js');
const DOCSCROLL = require('./doc-scroll.js');
const ANNOTATE = require('./annotate.js');
const DOCSNIP = require('./doc-snip.js');
const CAPS = require('./captions-proven.js');
const CARDS = require('./overlay-cards.js');
const SHOTPLAN = require('./shot-plan.js');

const ROOT = path.join(__dirname, '..', '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      out[k] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    }
  }
  return out;
}
function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { maxBuffer: 1 << 28, timeout: 60 * 60 * 1000, ...opts });
}
function ff(args) { return sh('ffmpeg', ['-y', ...args, '-hide_banner', '-loglevel', 'error']); }
function probe(file, entries) {
  return sh('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'csv=p=0', file]).toString().trim();
}
function log(...a) { console.log('[doc-explainer]', ...a); }

/** Rough MB of frame staging a config will need (input PNGs + RGBA mattes). */
function wantFramesForSpace(cfg) {
  const fps = cfg.fps != null ? +cfg.fps : 30;
  return Math.round((+cfg.durationSec) * fps);
}

async function produce(cfg, outPath) {
  const work = cfg.workdir || path.join(os.tmpdir(), `doc-explainer-${process.pid}`);
  if (work.startsWith('/mnt/')) {
    throw new Error(`workdir ${work} is on the Windows mount. Frame staging must be native — see matte.js.`);
  }
  fs.mkdirSync(work, { recursive: true });
  const p = (n) => path.join(work, n);

  // FREE-SPACE GATE. /tmp on this machine is a 16 GB tmpfs that the agent
  // scratchpad already mostly fills, and tmpfs also costs RAM. A 1812-frame
  // RGBA matte is ~3-4 GB; the first run of this pipeline died at frame 903
  // of 1812 with /tmp at 100%, which surfaced as a bare non-zero exit from
  // matte.js rather than "out of disk". Check up front and name the number.
  try {
    const dfOut = execFileSync('df', ['-Pk', work]).toString().trim().split('\n').pop().split(/\s+/);
    const availGb = parseInt(dfOut[3], 10) / 1024 / 1024;
    const isTmpfs = execFileSync('df', ['-PT', work]).toString().includes('tmpfs');
    const needGb = Math.max(2, (wantFramesForSpace(cfg) * 2.2) / 1024);
    log(`workdir ${work} — ${availGb.toFixed(1)} GB free${isTmpfs ? ' (tmpfs — this also consumes RAM)' : ''}, need ~${needGb.toFixed(1)} GB`);
    if (availGb < needGb) {
      throw new Error(
        `workdir has ${availGb.toFixed(1)} GB free but this render needs ~${needGb.toFixed(1)} GB of frame staging.` +
        (isTmpfs ? `\n  ${work} is on tmpfs. Use a real disk (e.g. ~/.cache) — still native Linux, just not RAM.` : ''));
    }
  } catch (e) {
    if (/needs ~/.test(e.message)) throw e;
    log(`could not check free space (${e.message.slice(0, 80)}) — continuing`);
  }

  const speed = cfg.speed != null ? +cfg.speed : 1.08;
  const fps = cfg.fps != null ? +cfg.fps : 30;
  const outSec = +cfg.durationSec;             // final length, post-speed-up
  const srcWindowSec = outSec * speed;         // how much source that consumes
  const matteW = cfg.matteWidth != null ? +cfg.matteWidth : 640;
  const wantFrames = Math.round(outSec * fps);

  log(`target ${outSec}s @ ${fps}fps = ${wantFrames} frames; speed ${speed}x consumes ${srcWindowSec.toFixed(2)}s of source`);

  // ---------------------------------------------------------------- 1. AUDIO
  // The dead-channel fold is NOT optional on this rig: the DJI lav feeds the
  // LEFT channel only and the right is digital silence, so `-ac 1` averages
  // the voice with nothing and throws away 6 dB.
  const AD = require('./audio-diagnose.js');
  const diag = AD.diagnose(cfg.src);
  const fold = diag.filters.channelFixMono || 'pan=mono|c0=c0';
  log(`audio: ${diag.channels.deadChannels.length ? `dead channel ${diag.channels.deadChannels.join(',')} — folding with ${fold}` : 'both channels live'}`);
  if (diag.clipping.clipping) {
    log(`AUDIO CLIPPING: true peak ${diag.clipping.truePeakDb} dBFS, ${diag.clipping.samplesAtFullScale} samples at full scale. NOT fixable in post — transmitter gain, not receiver.`);
  }

  const rawWav = p('raw.wav');
  ff(['-i', cfg.src, '-vn', '-af', fold, '-ac', '1', '-ar', '44100', rawWav]);

  // Audio Isolation on the FULL take (>= 4.6 s), then A/B. Never per-clip.
  let voiceWav = rawWav;
  const isoReport = { attempted: false, used: false, reason: null, metrics: null };
  if (cfg.audioIsolation !== false) {
    // env-local.js finds the MAIN worktree's .env.local too. Resolving it
    // relative to ROOT is what kept isolation silently off in every
    // worktree-isolated run.
    require('./env-local.js').load(null, { quiet: true });
    const AC = require('./audio-chain.js');
    const A = require('./review-lib/audio.js');
    isoReport.attempted = true;
    try {
      const perm = await AC.detectIsolationPermission(process.env.ELEVENLABS_API_KEY);
      if (perm.status !== 'ok') {
        isoReport.reason = `isolation unavailable (${perm.status}${perm.reason ? ': ' + perm.reason : ''})`;
        log(isoReport.reason);
      } else {
        const isoMp3 = p('isolated.mp3');
        log('isolation: one call on the full take...');
        await AC.isolateAudio(process.env.ELEVENLABS_API_KEY, rawWav, isoMp3);
        const words = JSON.parse(fs.readFileSync(cfg.transcript, 'utf8')).words.filter(w => w.type === 'word');
        const before = { boxiness: A.boxiness(rawWav, words), hf: A.deliveryChain(rawWav, words).hfBalanceDb };
        const after = { boxiness: A.boxiness(isoMp3, words), hf: A.deliveryChain(isoMp3, words).hfBalanceDb };
        isoReport.metrics = { before, after };
        const boxImproved = after.boxiness < before.boxiness - 0.3;
        const hfCollapsed = after.hf < before.hf - 6;
        log(`isolation A/B — boxiness ${before.boxiness} -> ${after.boxiness} dB, HF ${before.hf} -> ${after.hf} dB`);
        if (boxImproved && !hfCollapsed) {
          // Re-wrap to wav at the same rate so the rest of the chain is
          // format-identical whichever take won.
          const isoWav = p('isolated.wav');
          ff(['-i', isoMp3, '-ac', '1', '-ar', '44100', isoWav]);
          voiceWav = isoWav; isoReport.used = true;
          isoReport.reason = `isolation improved boxiness ${before.boxiness} -> ${after.boxiness} dB without collapsing HF (${before.hf} -> ${after.hf} dB)`;
        } else {
          isoReport.reason = hfCollapsed
            ? `isolation collapsed the highs (${before.hf} -> ${after.hf} dB) — the "underwater" failure; keeping the original`
            : `isolation did not reduce boxiness (${before.boxiness} -> ${after.boxiness} dB); keeping the original`;
        }
        log(isoReport.reason);
      }
    } catch (e) {
      isoReport.reason = `isolation errored: ${e.message.slice(0, 180)}`;
      log(isoReport.reason);
    }
  }
  fs.writeFileSync(p('isolation-report.json'), JSON.stringify(isoReport, null, 2));

  // The proven chain. atempo is the ONE place the audio is sped up.
  const voiceOut = p('voice.wav');
  const chain = [
    'highpass=f=80',
    `atempo=${speed}`,
    ...(isoReport.used ? [] : ['equalizer=f=330:t=q:w=1.3:g=-4', 'equalizer=f=3200:t=q:w=1.1:g=3']),
    'acompressor=threshold=-18dB:ratio=3:attack=5:release=120',
    'loudnorm=I=-16:TP=-1.5:LRA=11',
    'aresample=48000',
    'pan=stereo|c0=c0|c1=c0',
  ].join(',');
  ff(['-i', voiceWav, '-af', chain, '-t', String(outSec), '-ar', '48000', '-ac', '2', voiceOut]);
  log(`audio chain: ${chain}`);

  // --------------------------------------------------------------- 2. FRAMES
  // The speed-up is applied EXACTLY ONCE, here, by resampling the frame
  // sequence. setpts drops the COUNT; -r fps plays them at the source rate.
  const framesDir = p('frames');
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  const vfFrames = [
    cfg.crop ? `crop=${cfg.crop}` : null,
    `scale=${matteW}:-2`,
    `setpts=PTS/${speed}`,
  ].filter(Boolean).join(',');
  log(`frames: -t ${srcWindowSec.toFixed(3)} -vf ${vfFrames} -r ${fps}`);
  ff(['-i', cfg.src, '-t', String(srcWindowSec), '-vf', vfFrames, '-r', String(fps), '-fps_mode', 'cfr',
    '-frames:v', String(wantFrames), path.join(framesDir, 'f%05d.png')]);
  const gotFrames = fs.readdirSync(framesDir).filter(f => /\.png$/.test(f)).length;
  log(`frames extracted: ${gotFrames} (want ${wantFrames})`);
  if (Math.abs(gotFrames - wantFrames) > 2) throw new Error(`frame count ${gotFrames} != ${wantFrames}`);

  // ---------------------------------------------------------------- 3. MATTE
  const matteDir = p('matte');
  if (!fs.existsSync(path.join(matteDir, 'rgba')) || fs.readdirSync(path.join(matteDir, 'rgba')).length < gotFrames) {
    log('matte: RVM --mode rgba (fast path)...');
    const t0 = Date.now();
    sh('node', [path.join(__dirname, 'matte.js'), '--frames', framesDir, '--out', matteDir, '--mode', 'rgba'], { stdio: 'inherit' });
    log(`matte done in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
  } else log('matte: reusing existing rgba frames');
  const rgbaDir = path.join(matteDir, 'rgba');

  // ------------------------------------------------------------- 4. SHOTPLAN
  const transcript = JSON.parse(fs.readFileSync(cfg.transcript, 'utf8'));
  const cutlist = cfg.cutlist && fs.existsSync(cfg.cutlist)
    ? JSON.parse(fs.readFileSync(cfg.cutlist, 'utf8'))
    : { keepSegments: [{ start: 0, end: srcWindowSec }], stats: { keptSeconds: srcWindowSec } };

  let shots;
  if (cfg.shots) {
    shots = cfg.shots;                       // explicit override
  } else {
    const plan = SHOTPLAN.buildShotPlan(transcript, cutlist, {
      minShotSec: SHOTPLAN.PROVEN_LOOKS.minShotSec, maxShotSec: 7.0,
      baseZoom: 1, punchFactor: 1, maxScaleRatio: 1.3, punchZoomMax: 1.6,
      openWide: true, jl: true, jlCutSec: 0.14,
      padAfterWordEnd: 0.20, padBeforeOnset: 0.15,
      minGapSec: SHOTPLAN.PROVEN_LOOKS.gapSec,
    });
    // The plan is built on the pre-speed timeline; compress it and clip to
    // the target length.
    shots = plan.shots
      .map(s => ({ startSec: +(s.startSec / speed).toFixed(2), endSec: +(s.endSec / speed).toFixed(2) }))
      .filter(s => s.startSec < outSec)
      .map(s => ({ startSec: s.startSec, endSec: Math.min(s.endSec, outSec) }));
    if (shots.length) shots[shots.length - 1].endSec = outSec;
  }
  const looked = SHOTPLAN.assignLooks(shots, { emphasisWindows: cfg.emphasisWindows || [] });
  shots = looked.shots;
  fs.writeFileSync(p('shots.json'), JSON.stringify({ shots, swExpr: looked.swExpr, sxExpr: looked.sxExpr }, null, 2));
  log(`shots: ${shots.length}, ${shots.filter(s => s.look.forcedByEmphasis).length} forced small by doc emphasis`);

  // ------------------------------------------------------------------- 5. BG
  const bg = p('bg.mp4');
  log('background: doc-scroll...');
  DOCSCROLL.renderScroll({
    pdf: cfg.pdf, out: bg, dur: outSec, fps,
    first: cfg.pdfFirst != null ? +cfg.pdfFirst : 3,
    last: cfg.pdfLast != null ? +cfg.pdfLast : 5,
    targetY: cfg.targetY != null ? +cfg.targetY : DOCSCROLL.PROVEN.targetY,
    stops: cfg.scrollStops || null,
  });

  // ------------------------------------------------------- 6. BG ANNOTATIONS
  let bgCur = bg;
  if (cfg.annotate) {
    const a = cfg.annotate;
    const outA = p('bg-annot.mp4');
    log(`annotate: draw-on at ${a.at}s, hold ${a.holdSec}s`);
    await ANNOTATE.overlayOnClip({
      input: bgCur, out: outA, at: +a.at, holdSec: +a.holdSec, fps,
      cx: a.cx, cy: a.cy, rx: a.rx, ry: a.ry,
    });
    bgCur = outA;
  }
  if (cfg.snip) {
    const s = cfg.snip;
    const card = p('snip-card.png');
    DOCSNIP.buildCard({ pdf: cfg.pdf, page: +s.page, out: card, crop: s.crop, hl: s.hl });
    const outS = p('bg-snip.mp4');
    log(`doc-snip: card at ${s.at}s for ${s.holdSec}s`);
    DOCSNIP.compositeOnClip({ input: bgCur, out: outS, card, at: +s.at, holdSec: +s.holdSec, fps });
    bgCur = outS;
  }

  // -------------------------------------------------- 7. PER-SHOT COMPOSITE
  // scale cannot take a time-varying expression, so each shot is rendered as
  // its own segment at that shot's cutout width and then concatenated. The
  // sw/sx expressions in shots.json are the same numbers, kept for callers
  // that composite in a single filter pass.
  log('compositing cutout per shot...');
  const segList = [];
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    const segOut = p(`seg-${String(i).padStart(3, '0')}.mp4`);
    const startFrame = Math.round(s.startSec * fps) + 1;
    const nFrames = Math.round((s.endSec - s.startSec) * fps);
    if (nFrames <= 0) continue;
    ff([
      '-ss', String(s.startSec), '-i', bgCur,
      '-start_number', String(startFrame), '-framerate', String(fps), '-i', path.join(rgbaDir, 'f%05d.png'),
      '-filter_complex',
      `[1:v]scale=${s.look.w}:-2,format=rgba[fg];` +
      `[0:v][fg]overlay=${s.look.x}:H-h:format=auto[v]`,
      '-map', '[v]', '-frames:v', String(nFrames),
      '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-r', String(fps), segOut,
    ]);
    segList.push(segOut);
  }
  const listFile = p('segs.txt');
  fs.writeFileSync(listFile, segList.map(f => `file '${f}'`).join('\n'));
  const composited = p('composited.mp4');
  ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', composited]);
  log(`composited: ${probe(composited, 'format=duration')}s`);

  // -------------------------------------------------------------- 8. CAPTIONS
  const capsPath = p('caps.ass');
  const capRes = CAPS.build({
    transcript,
    cutlist: cfg.cutlist && fs.existsSync(cfg.cutlist) ? cutlist : null,
    mode: cfg.captionMode === 'thought' ? 'thought' : 'fragment',
    speed,
    emphasis: new Set((cfg.emphasisWords || []).map(w => w.toLowerCase().replace(/[^a-z0-9']/g, ''))),
    hookSuppressUntil: cfg.hookSec != null ? +cfg.hookSec : 0,
  });
  fs.writeFileSync(capsPath, capRes.ass);
  log(`captions: ${capRes.stats.events} cards, mode ${capRes.stats.mode}, ${capRes.stats.avgWordsPerCard} words/card`);

  const captioned = p('captioned.mp4');
  ff(['-i', composited, '-i', voiceOut,
    '-vf', `subtitles=${capsPath.replace(/:/g, '\\:')}`,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-shortest', captioned]);

  // ----------------------------------------------------------------- 9. CARDS
  let final = captioned;
  if (cfg.hookText || cfg.ctaVariant) {
    let hookCard = null, ctaCard = null;
    if (cfg.hookText) {
      hookCard = p('hook-card.png');
      await CARDS.renderCard({ out: hookCard, kind: 'hook', text: cfg.hookText });
    }
    if (cfg.ctaVariant) {
      const v = CARDS.CTA_VARIANTS[cfg.ctaVariant] || CARDS.CTA_VARIANTS.follow;
      ctaCard = p('cta-card.png');
      await CARDS.renderCard({ out: ctaCard, kind: 'cta', text: cfg.ctaText || v.text, sub: cfg.ctaSub || v.sub });
    }
    const carded = p('carded.mp4');
    CARDS.compositeCards({
      input: captioned, out: carded,
      hookCard, hookSec: cfg.hookSec != null ? +cfg.hookSec : 0,
      ctaCard, ctaSec: cfg.ctaSec != null ? +cfg.ctaSec : 0,
    });
    final = carded;
  }

  // ------------------------------------------------------------ 10. DELIVER
  ff(['-i', final, '-c:v', 'libx264', '-crf', '19', '-preset', 'medium', '-pix_fmt', 'yuv420p',
    '-r', String(fps), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', outPath]);

  // ------------------------------------------------------------- 11. SYNC GATE
  const sy = SYNC.assertRenderedSync(outPath, { label: path.basename(outPath) });
  log(`FINAL A/V SYNC OK — picture ${sy.pictureSec.toFixed(3)}s vs audio ${sy.audioSec.toFixed(3)}s (${sy.driftMs >= 0 ? '+' : ''}${sy.driftMs}ms, ${sy.frameCount} frames @ ${sy.outputFps}fps)`);

  return { out: outPath, sync: sy, isolation: isoReport, captions: capRes.stats, shots: shots.length, workdir: work };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config || !args.out) {
    console.error('Usage: produce-doc-explainer.js --config <json> --out <mp4>');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  if (args.workdir) cfg.workdir = args.workdir;
  const res = await produce(cfg, args.out);
  console.log(JSON.stringify({ out: res.out, sync: res.sync, isolation: res.isolation, captions: res.captions, shots: res.shots }, null, 2));
}

module.exports = { produce };
if (require.main === module) main().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1); });
