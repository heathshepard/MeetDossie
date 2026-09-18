#!/usr/bin/env node
'use strict';

/**
 * generate-anatomy-v3.js — Rust muscle-map content generator, v3.
 *
 * Emits, per exercise:
 *   a) a 1080x1350 static PNG (IG/FB feed post)
 *   b) a 1080x1920 seamless looping MP4 (2s @ 30fps, h264/yuv420p, faststart)
 *
 * WHAT CHANGED FROM v2 (generate-anatomy-v2.js, left in place)
 * v2 lit one of the library's 8 coarse buckets. A Cable Shrug and a Lat Pulldown
 * are both `back`, so they produced the same image — obviously wrong to anyone
 * who lifts, and the reason this version exists. v3 lights specific muscles from
 * Rust's own src/constants/muscleMap.ts: the shrug lights the upper traps, the
 * pulldown lights the lats.
 *
 * DATA IS REAL, NEVER INVENTED
 *   - Specific muscles come from Rust's committed muscleMap.ts (263 exercises,
 *     194 high / 58 medium / 11 low confidence). Nothing is guessed here; if the
 *     mapping says an exercise has three prime movers, three light up.
 *   - Exercise names, coarse buckets and equipment come from Rust's committed
 *     exercise-library.json fixture. The Supabase `exercises` table is not
 *     readable with the anon key (RLS returns 0 rows).
 *   - Form cues are Rust's own words: src/constants/formCues.ts first (35 short
 *     3-line entries), then src/constants/exerciseTips.ts (all 263, split into
 *     sentences). Nothing is written here. An exercise with neither is skipped
 *     rather than shipped with filler. The tips fallback is what lifts the
 *     renderable set from 62 to 236 of 263.
 *   - `--min-confidence high` refuses to render anything the mapping itself
 *     flags as uncertain. Use it for anything that goes out unattended.
 *
 * COST
 * Base-figure generation was a one-time fal.ai spend (~$2.22, ideogram/v3).
 * v3 re-uses those same four renders — nothing was regenerated. Everything here
 * is free: highlight compositing is local pixels, typography is local Chromium.
 *
 * Highlights are cached by (figure, view, primary set, secondary set) rather than
 * by exercise, because that tuple is what actually determines the image.
 *
 * Usage:
 *   node scripts/generate-anatomy-v3.js --exercise "Cable Shrug"
 *   node scripts/generate-anatomy-v3.js --exercise "Lat Pulldown" --figure female
 *   node scripts/generate-anatomy-v3.js --all --min-confidence high --limit 20
 *   node scripts/generate-anatomy-v3.js --list-matched
 *
 * Options:
 *   --exercise <name>     exercise to render (fuzzy-matched against the library)
 *   --figure male|female  which base figure (default male)
 *   --out <dir>           output dir (default Media/anatomy-v2)
 *   --min-confidence high|medium|low   (default low = render everything mapped)
 *   --fps <n> --duration <sec>
 *   --no-video / --no-static / --keep-frames
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const FIG = require('./anatomy-v2/figure-lib-v3');

const REPO = path.resolve(__dirname, '..');
const RUST = process.env.RUST_REPO || '/mnt/c/Users/Heath/Projects/Rust';
const TEMPLATE = path.join(REPO, 'scripts', 'video-cards', 'anatomy-figure-v3.html');
const BASE_DIR = path.join(REPO, 'Media', 'anatomy-v2', 'base');
const LIBRARY = path.join(RUST, 'api', '__checks__', 'fixtures', 'exercise-library.json');
const CUES_TS = path.join(RUST, 'src', 'constants', 'formCues.ts');
const TIPS_TS = path.join(RUST, 'src', 'constants', 'exerciseTips.ts');
const MAP_TS = path.join(RUST, 'src', 'constants', 'muscleMap.ts');
const FFMPEG = process.env.FFMPEG_BIN || path.join(os.homedir(), '.local', 'bin', 'ffmpeg');
const FFPROBE = process.env.FFPROBE_BIN || path.join(os.homedir(), '.local', 'bin', 'ffprobe');

const CONF_RANK = { low: 0, medium: 1, high: 2 };

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    if (k.startsWith('no-')) { out[k.slice(3)] = false; continue; }
    const nxt = argv[i + 1];
    if (nxt === undefined || nxt.startsWith('--')) out[k] = true;
    else { out[k] = nxt; i++; }
  }
  return out;
}

/**
 * Pull one object/array literal out of a TS module by name. Rust's constants are
 * plain literals behind a type annotation, so this is exact rather than a regex
 * guess, and it means MeetDossie never keeps its own copy of the data.
 */
function literalFrom(file, declRe, open = '{', close = '}') {
  const src = fs.readFileSync(file, 'utf8');
  const m = declRe.exec(src);
  if (!m) throw new Error(`declaration ${declRe} not found in ${file}`);
  const start = src.indexOf(open, m.index + m[0].length - 1);
  let depth = 0, end = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error(`could not locate literal for ${declRe} in ${file}`);
  // eslint-disable-next-line no-eval
  return eval('(' + src.slice(start, end) + ')');
}

const loadLibrary = () => {
  const raw = JSON.parse(fs.readFileSync(LIBRARY, 'utf8'));
  const arr = Array.isArray(raw) ? raw : (raw.exercises || Object.values(raw)[0]);
  return arr.filter(e => e && e.name);
};
const loadCues = () => literalFrom(CUES_TS, /export const FORM_CUES[^=]*=\s*/);
const loadTips = () => literalFrom(TIPS_TS, /const tips\s*:\s*Record<string,\s*string>\s*=\s*/);
const loadMap = () => literalFrom(MAP_TS, /const muscleMap\s*:\s*Record<string,\s*MuscleMapEntry>\s*=\s*/);
const loadLabels = () => literalFrom(MAP_TS, /export const MUSCLE_LABELS\s*:\s*Record<SpecificMuscle,\s*string>\s*=\s*/);

/**
 * Cue text for the card, and it must be RUST'S OWN WORDS — never written here.
 *
 * First choice is formCues.ts, which is authored as 3 short imperative lines and
 * is exactly what this card's layout wants. But it only covers 35 of the 263
 * exercises, which is why v2 could render barely a fifth of the library and why
 * "Cable Shrug" — half the proof that this change works — had nothing to show.
 *
 * So the fallback is exerciseTips.ts, which DOES cover all 263 (its coverage is
 * enforced by api/__checks__/exercise-tip-coverage.mjs) and is the same text the
 * app already shows behind the in-workout Tips button. It is prose, so it gets
 * split on sentence boundaries; sentences too long for a 27px cue line are
 * dropped rather than allowed to wrap the card apart. If nothing usable survives,
 * the exercise is skipped — an empty cue block is better than filler, and filler
 * is better than neither only if someone writes it, which is not this script's
 * job.
 */
function cuesFor(name, CUES, TIPS) {
  const n = String(name).toLowerCase().trim();
  if (CUES[n]) return CUES[n];
  // An EXACT tips entry beats a FUZZY formCues match. Rust's own getFormCues()
  // does substring matching, which maps "Incline Barbell Bench Press" onto the
  // flat bench's cues — fine as a last resort, wrong when the exercise has its
  // own text. Only fall back to the fuzzy cue match when tips has nothing.
  const tip = TIPS && (TIPS[name] || TIPS[Object.keys(TIPS).find(k => k.toLowerCase() === n) || '\u0000']);
  if (!tip) {
    for (const k of Object.keys(CUES)) if (n.includes(k) || k.includes(n)) return CUES[k];
    return null;
  }
  // Split on sentence ends AND on the em-dashes these tips use to hang a
  // consequence off an instruction ("Shrug straight up — avoid leaning back..."),
  // because without that split the useful half of the sentence is over the
  // length cap and the card ends up with a single cue and a hole under it.
  const cues = String(tip)
    .split(/(?<=[.!?])\s+|\s+[—–]\s+/)
    .map(t => t.trim().replace(/\s+/g, ' ').replace(/[.]$/, ''))
    .map(t => t.charAt(0).toUpperCase() + t.slice(1))
    .filter(t => t.length >= 12 && t.length <= 96)
    .slice(0, 3);
  if (cues.length) return { cues, focus: '', fromTips: true };
  for (const k of Object.keys(CUES)) if (n.includes(k) || k.includes(n)) return CUES[k];
  return null;
}

function findExercise(query, lib) {
  const q = String(query).toLowerCase().trim();
  return lib.find(e => e.name.toLowerCase() === q)
      || lib.find(e => e.name.toLowerCase().includes(q))
      || lib.find(e => q.includes(e.name.toLowerCase()))
      || null;
}

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const uniq = a => [...new Set(a)];

/**
 * Map the mapping's vocabulary onto regions the figure actually has. The 8
 * EXTENDED tokens (adductors, grip, hip_flexors, ...) are real muscles the
 * renders cannot resolve, so each collapses onto its nearest neighbour rather
 * than being silently dropped — a leg press whose only primary is `adductors`
 * must still light something.
 */
const toRegions = list => uniq((list || []).map(FIG.resolveMuscle));

// ---------------------------------------------------------------- highlights
function restFile(view, figure, cacheDir) {
  const f = FIG.loadFigure(BASE_DIR, figure, view);
  const out = path.join(cacheDir, `${figure}-${view}-rest.png`);
  if (!fs.existsSync(out)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    FIG.writeRgba(FIG.flattenBg(f.rgb), f.gray, out, f.body);
  }
  return out;
}

function highlightFile(view, figure, primary, secondary, cacheDir) {
  const f = FIG.loadFigure(BASE_DIR, figure, view);
  const vis = FIG.VIEW_MUSCLES[view];
  const prim = primary.filter(g => vis.includes(g)).sort();
  // a muscle that is primary must never also be painted as secondary
  const sec = secondary.filter(g => vis.includes(g) && !prim.includes(g)).sort();
  const key = `${figure}-${view}-p_${prim.join('+') || 'none'}-s_${sec.join('+') || 'none'}`;
  const out = path.join(cacheDir, `${key}.png`);
  if (!fs.existsSync(out)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const lit = FIG.highlight(FIG.flattenBg(f.rgb), f.G, prim, sec, 1, f.cloth);
    FIG.writeRgba(lit, f.gray, out, f.body);
  }
  return out;
}

// -------------------------------------------------------------------- render
function buildHtml(cfg) {
  const tpl = fs.readFileSync(TEMPLATE, 'utf8');
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return tpl
    .replace(/\{\{EXERCISE\}\}/g, esc(cfg.exercise))
    .replace(/\{\{PRIMARY_JSON\}\}/g, JSON.stringify(cfg.primaryLabels))
    .replace(/\{\{SECONDARY_JSON\}\}/g, JSON.stringify(cfg.secondaryLabels))
    .replace(/\{\{CUES_JSON\}\}/g, JSON.stringify(cfg.cues || []))
    .replace(/\{\{FOCUS\}\}/g, esc(cfg.focus || ''))
    .replace(/\{\{FORMAT\}\}/g, cfg.format)
    .replace(/\{\{FRONT_BASE\}\}/g, cfg.frontBase)
    .replace(/\{\{FRONT_HOT\}\}/g, cfg.frontHot)
    .replace(/\{\{BACK_BASE\}\}/g, cfg.backBase)
    .replace(/\{\{BACK_HOT\}\}/g, cfg.backHot);
}

async function render(browser, cfg, width, height, onPage) {
  // written next to the template so relative font/image paths still resolve
  const tmp = path.join(path.dirname(TEMPLATE), `.tmp-v3-${slug(cfg.exercise)}-${cfg.format}.html`);
  fs.writeFileSync(tmp, buildHtml(cfg));
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  try {
    await page.goto('file://' + tmp, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ready === true);
    await page.evaluate(() => document.fonts.ready);
    await onPage(page);
  } finally {
    await page.close();
    fs.unlinkSync(tmp);
  }
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const lib = loadLibrary();
  const CUES = loadCues();
  const TIPS = loadTips();
  const MAP = loadMap();
  const LABELS = loadLabels();
  const figure = args.figure === 'female' ? 'female' : 'male';
  const minConf = CONF_RANK[args['min-confidence']] != null ? CONF_RANK[args['min-confidence']] : 0;

  /** An exercise is renderable if it has a mapping with a prime mover, that
   *  mapping clears the confidence floor, and Rust has real form cues for it. */
  const renderable = e => {
    const mm = MAP[e.name];
    return !!(mm && mm.primary && mm.primary.length
      && CONF_RANK[mm.confidence] >= minConf
      && cuesFor(e.name, CUES, TIPS));
  };

  if (args['list-matched']) {
    const rows = lib.filter(renderable);
    rows.forEach(e => {
      const mm = MAP[e.name];
      console.log(`${mm.confidence.padEnd(6)} ${e.muscle_group.padEnd(10)} ${e.name.padEnd(36)} -> ${mm.primary.join(', ')}`);
    });
    console.log(`\n${rows.length} of ${lib.length} exercises are renderable (mapped prime mover + real form cues).`);
    return;
  }

  let targets;
  if (args.all) {
    targets = lib.filter(renderable);
    if (args.limit) targets = targets.slice(0, parseInt(args.limit, 10));
  } else {
    const list = String(args.exercise || 'Barbell Bench Press').split('|');
    targets = list.map(q => {
      const ex = findExercise(q, lib);
      if (!ex) { console.error(`no exercise matching "${q}"`); process.exit(2); }
      return ex;
    });
  }

  const outDir = path.resolve(args.out || path.join(REPO, 'Media', 'anatomy-v2'));
  const cacheDir = path.join(outDir, '.highlights-v3');
  fs.mkdirSync(outDir, { recursive: true });

  const fps = parseInt(args.fps || '30', 10);
  const duration = parseFloat(args.duration || '2');
  const frames = Math.round(fps * duration);

  const { chromium } = require(path.join(REPO, 'node_modules', 'playwright'));
  const browser = await chromium.launch();

  try {
    for (const ex of targets) {
      const t0 = Date.now();
      const mm = MAP[ex.name];
      if (!mm) { console.warn(`[skip] "${ex.name}" has no entry in muscleMap.ts`); continue; }
      if (!mm.primary || !mm.primary.length) {
        console.warn(`[skip] "${ex.name}" has no prime mover (${mm.confidence}: ${mm.note || 'no note'})`);
        continue;
      }
      if (CONF_RANK[mm.confidence] < minConf) {
        console.warn(`[skip] "${ex.name}" is ${mm.confidence} confidence, below --min-confidence`);
        continue;
      }
      const fc = cuesFor(ex.name, CUES, TIPS);
      // Cues are the point of the "proper form" block and must be Rust's real
      // ones — never invented. No cue entry => skip rather than ship filler.
      if (!fc && !args['allow-no-cues']) {
        console.warn(`[skip] "${ex.name}" has no entry in formCues.ts`);
        continue;
      }

      const primary = toRegions(mm.primary);
      const secondary = toRegions(mm.secondary).filter(g => !primary.includes(g));
      const label = m => LABELS[m] || m.replace(/_/g, ' ');
      const rel = p => path.relative(path.dirname(TEMPLATE), p).split(path.sep).join('/');

      const base = {
        exercise: ex.name,
        primaryLabels: uniq(mm.primary.map(label)),
        secondaryLabels: uniq(mm.secondary.map(label)),
        cues: fc ? fc.cues.slice(0, 3) : [],
        focus: fc ? fc.focus : '',
        frontBase: rel(restFile('front', figure, cacheDir)),
        backBase: rel(restFile('back', figure, cacheDir)),
        frontHot: rel(highlightFile('front', figure, primary, secondary, cacheDir)),
        backHot: rel(highlightFile('back', figure, primary, secondary, cacheDir)),
      };
      const stem = `${slug(ex.name)}-${slug(mm.primary.join('-'))}-${figure}`;
      console.log(`[map] ${ex.name}: primary=${mm.primary.join(',')} secondary=${mm.secondary.join(',') || '-'} (${mm.confidence})`);

      // --- a) static 1080x1350 -------------------------------------------
      if (args.static !== false) {
        const png = path.join(outDir, `${stem}-1080x1350.png`);
        await render(browser, { ...base, format: 'card' }, 1080, 1350, async (page) => {
          await page.evaluate(() => window.setPhase(0.62));  // near peak glow
          await page.screenshot({ path: png, type: 'png' });
        });
        console.log(`[png] ${png}`);
      }

      // --- b) looping 1080x1920 ------------------------------------------
      if (args.video !== false) {
        const frameDir = path.join(outDir, `.frames-${stem}`);
        fs.rmSync(frameDir, { recursive: true, force: true });
        fs.mkdirSync(frameDir, { recursive: true });

        await render(browser, { ...base, format: 'story' }, 1080, 1920, async (page) => {
          for (let i = 0; i < frames; i++) {
            // i/frames, not i/(frames-1): frame N lands exactly on frame 0
            await page.evaluate(t => window.setPhase(t), i / frames);
            await page.screenshot({ path: path.join(frameDir, `f${String(i).padStart(4, '0')}.png`), type: 'png' });
          }
        });

        const mp4 = path.join(outDir, `${stem}-1080x1920-loop.mp4`);
        execFileSync(FFMPEG, [
          '-y', '-framerate', String(fps),
          '-i', path.join(frameDir, 'f%04d.png'),
          '-c:v', 'libx264', '-profile:v', 'high', '-crf', '18',
          '-pix_fmt', 'yuv420p', '-preset', 'medium',
          '-movflags', '+faststart', mp4,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });

        if (!args['keep-frames']) fs.rmSync(frameDir, { recursive: true, force: true });
        console.log(`[mp4] ${mp4}`);
        try {
          const probe = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height,duration,nb_frames,codec_name,pix_fmt',
            '-of', 'default=nw=1', mp4], { encoding: 'utf8' });
          console.log(probe.trim().split('\n').map(s => '      ' + s).join('\n'));
        } catch (_) { /* ffprobe optional */ }
      }

      console.log(`[done] ${ex.name} (${figure}) in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    }
  } finally {
    await browser.close();
  }
})().catch(err => { console.error(err && (err.stack || err.message)); process.exit(1); });
