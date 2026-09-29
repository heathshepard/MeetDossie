#!/usr/bin/env node
'use strict';

/**
 * generate-anatomy-v2.js — Rust muscle-map content generator, v2.
 *
 * Emits, per exercise:
 *   a) a 1080x1350 static PNG (IG/FB feed post)
 *   b) a 1080x1920 seamless looping MP4 (2s @ 30fps, h264/yuv420p, faststart)
 *
 * WHAT CHANGED FROM v1 (scripts/generate-anatomy-card.js)
 * v1 drew the body as flat SVG vector shapes. This one uses four AI-generated
 * anatomical renders (Media/anatomy-v2/base/) and lights the worked muscle group
 * on top of them via scripts/anatomy-v2/figure-lib.js, whose regions are derived
 * from each render's own silhouette rather than hand-drawn.
 *
 * DATA IS REAL, NEVER INVENTED
 *   - muscle_group / secondary_muscle_groups come from Rust's committed exercise
 *     library fixture (263 exercises). The Supabase `exercises` table is not
 *     readable with the anon key (RLS returns 0 rows).
 *   - The library's 8 buckets are coarse. If an exercise says "legs" this lights
 *     the whole leg — it does NOT guess quads-vs-hamstrings.
 *   - Form cues are parsed out of Rust's src/constants/formCues.ts. An exercise
 *     with no cue entry is skipped rather than shipped with filler.
 *
 * COST
 * Base-figure generation was a one-time fal.ai spend. Everything here is free:
 * highlight compositing is local pixels, typography is local Chromium.
 *
 * Highlights are cached by (figure, primary, secondary) rather than by exercise,
 * because that tuple is what actually determines the image — 263 exercises
 * collapse to a few dozen distinct highlight states.
 *
 * Usage:
 *   node scripts/generate-anatomy-v2.js --exercise "Barbell Bench Press"
 *   node scripts/generate-anatomy-v2.js --exercise "Barbell Curl" --figure female
 *   node scripts/generate-anatomy-v2.js --all --limit 20
 *   node scripts/generate-anatomy-v2.js --list-matched
 *
 * Options:
 *   --exercise <name>   exercise to render (fuzzy-matched against the library)
 *   --figure male|female  which base figure (default male)
 *   --out <dir>         output dir (default Media/anatomy-v2)
 *   --fps <n>           default 30
 *   --duration <sec>    default 2
 *   --no-video / --no-static
 *   --keep-frames
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const FIG = require('./anatomy-v2/figure-lib');

const REPO = path.resolve(__dirname, '..');
const RUST = process.env.RUST_REPO || '/mnt/c/Users/Heath/Projects/Rust';
const TEMPLATE = path.join(REPO, 'scripts', 'video-cards', 'anatomy-figure-v2.html');
const BASE_DIR = path.join(REPO, 'Media', 'anatomy-v2', 'base');
const LIBRARY = path.join(RUST, 'api', '__checks__', 'fixtures', 'exercise-library.json');
const CUES_TS = path.join(RUST, 'src', 'constants', 'formCues.ts');
const FFMPEG = process.env.FFMPEG_BIN || path.join(os.homedir(), '.local', 'bin', 'ffmpeg');
const FFPROBE = process.env.FFPROBE_BIN || path.join(os.homedir(), '.local', 'bin', 'ffprobe');

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

function loadLibrary() {
  const raw = JSON.parse(fs.readFileSync(LIBRARY, 'utf8'));
  const arr = Array.isArray(raw) ? raw : (raw.exercises || Object.values(raw)[0]);
  return arr.filter(e => e && e.name);
}

/** formCues.ts is a plain object literal behind a TS type annotation. */
function loadCues() {
  const src = fs.readFileSync(CUES_TS, 'utf8');
  const m = /export const FORM_CUES[^=]*=\s*/.exec(src);
  if (!m) throw new Error('FORM_CUES declaration not found');
  const start = m.index + m[0].length;
  let depth = 0, end = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error('could not locate FORM_CUES object literal');
  // eslint-disable-next-line no-eval
  return eval('(' + src.slice(start, end) + ')');
}

/** Mirrors Rust's own getFormCues(): exact key, then substring either way. */
function cuesFor(name, CUES) {
  const n = String(name).toLowerCase().trim();
  if (CUES[n]) return CUES[n];
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

// ---------------------------------------------------------------- highlights
/** Region masks are expensive-ish to build, so do it once per base image. */
const regionCache = new Map();
function regionsFor(view, figure) {
  const key = `${figure}-${view}`;
  if (!regionCache.has(key)) {
    const base = path.join(BASE_DIR, `${figure}-${view}.png`);
    if (!fs.existsSync(base)) throw new Error(`missing base figure: ${base}`);
    const gray = FIG.toGray(base);
    const { G } = FIG.buildRegions(gray, view);
    regionCache.set(key, { G, gray, rgb: FIG.toRgb(base), base });
  }
  return regionCache.get(key);
}

/**
 * Composite (and cache) the lit figure for one view. Cache key is the muscle
 * state, not the exercise — many exercises share the same state.
 */
function restFile(view, figure, cacheDir) {
  const { rgb, gray } = regionsFor(view, figure);
  const out = path.join(cacheDir, `${figure}-${view}-rest.png`);
  if (!fs.existsSync(out)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    FIG.writeRgba(rgb, gray, out);
  }
  return out;
}

function highlightFile(view, figure, primary, secondary, cacheDir) {
  const { G, rgb, gray } = regionsFor(view, figure);
  const prim = primary.filter(g => FIG.VIEW_GROUPS[view].includes(g));
  const sec = secondary.filter(g => FIG.VIEW_GROUPS[view].includes(g));
  const key = `${figure}-${view}-p_${prim.join('+') || 'none'}-s_${sec.join('+') || 'none'}`;
  const out = path.join(cacheDir, `${key}.png`);
  if (!fs.existsSync(out)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    FIG.writeRgba(FIG.highlight(rgb, G, prim, sec, 1), gray, out);
  }
  return out;
}

// -------------------------------------------------------------------- render
function buildHtml(cfg) {
  const tpl = fs.readFileSync(TEMPLATE, 'utf8');
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return tpl
    .replace(/\{\{EXERCISE\}\}/g, esc(cfg.exercise))
    .replace(/\{\{PRIMARY\}\}/g, esc(cfg.muscleGroup))
    .replace(/\{\{SECONDARY_JSON\}\}/g, JSON.stringify(cfg.secondary || []))
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
  const tmp = path.join(path.dirname(TEMPLATE), `.tmp-v2-${slug(cfg.exercise)}-${cfg.format}.html`);
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
  const figure = args.figure === 'female' ? 'female' : 'male';

  if (args['list-matched']) {
    const rows = lib.filter(e => FIG.LIFTABLE.includes(e.muscle_group) && cuesFor(e.name, CUES));
    rows.forEach(e => console.log(`${e.muscle_group.padEnd(10)} ${e.name}`));
    console.log(`\n${rows.length} of ${lib.length} exercises are renderable (liftable group + real form cues).`);
    return;
  }

  let targets;
  if (args.all) {
    targets = lib.filter(e => FIG.LIFTABLE.includes(e.muscle_group) && cuesFor(e.name, CUES));
    if (args.limit) targets = targets.slice(0, parseInt(args.limit, 10));
  } else {
    const ex = findExercise(args.exercise || 'Barbell Bench Press', lib);
    if (!ex) { console.error(`no exercise matching "${args.exercise}"`); process.exit(2); }
    targets = [ex];
  }

  const outDir = path.resolve(args.out || path.join(REPO, 'Media', 'anatomy-v2'));
  const cacheDir = path.join(outDir, '.highlights');
  fs.mkdirSync(outDir, { recursive: true });

  const fps = parseInt(args.fps || '30', 10);
  const duration = parseFloat(args.duration || '2');
  const frames = Math.round(fps * duration);

  const { chromium } = require(path.join(REPO, 'node_modules', 'playwright'));
  const browser = await chromium.launch();

  try {
    for (const ex of targets) {
      const t0 = Date.now();
      const fc = cuesFor(ex.name, CUES);
      // Cues are the point of the "proper form" block and must be Rust's real
      // ones — never invented. No cue entry => skip rather than ship filler.
      if (!fc && !args['allow-no-cues']) {
        console.warn(`[skip] "${ex.name}" has no entry in formCues.ts`);
        continue;
      }
      if (!FIG.LIFTABLE.includes(ex.muscle_group)) {
        console.warn(`[skip] "${ex.name}" is ${ex.muscle_group} — no muscle region to light`);
        continue;
      }

      const primary = [ex.muscle_group];
      const secondary = (ex.secondary_muscle_groups || []).filter(g => FIG.LIFTABLE.includes(g));
      const rel = p => path.relative(path.dirname(TEMPLATE), p).split(path.sep).join('/');

      const base = {
        exercise: ex.name,
        muscleGroup: ex.muscle_group,
        secondary,
        cues: fc ? fc.cues.slice(0, 3) : [],
        focus: fc ? fc.focus : '',
        frontBase: rel(restFile('front', figure, cacheDir)),
        backBase:  rel(restFile('back',  figure, cacheDir)),
        frontHot:  rel(highlightFile('front', figure, primary, secondary, cacheDir)),
        backHot:   rel(highlightFile('back',  figure, primary, secondary, cacheDir)),
      };
      const stem = `${slug(ex.name)}-${ex.muscle_group}-${figure}`;

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

      console.log(`[done] ${ex.name} (${ex.muscle_group}/${figure}) in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    }
  } finally {
    await browser.close();
  }
})().catch(err => { console.error(err && (err.stack || err.message)); process.exit(1); });
