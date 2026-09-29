#!/usr/bin/env node
'use strict';

/**
 * generate-anatomy-card.js — Rust muscle-map content generator.
 *
 * Emits, for one exercise:
 *   a) a 1080x1350 static PNG (IG/FB feed post)
 *   b) a 1080x1920 seamless looping MP4 (2s @ 30fps, h264/yuv420p, faststart)
 *
 * Toolchain is only what we already own: Playwright (node_modules) + the static
 * ffmpeg at ~/.local/bin/ffmpeg. That ffmpeg has NO drawtext/drawbox and there
 * is no PIL/pip on this box, so all typography is rendered as HTML+CSS through
 * Chromium — same reason scripts/render-card-png.js exists. Fonts come from
 * public/fonts (Plus Jakarta Sans), never over the network.
 *
 * The loop is frame-exact because the animation is NOT wall-clock driven: the
 * template exposes window.setPhase(t), t in [0,1), and we screenshot once per
 * phase step. Frame 0 and frame N therefore land on identical state, so the
 * MP4 loops with no visible seam.
 *
 * Exercise data (name -> muscle_group, secondary_muscle_groups) comes from the
 * real Rust library. The Supabase `exercises` table is not readable with the
 * anon key (RLS returns 0 rows), so we read the committed library fixture the
 * Rust repo keeps for its coverage checks.
 *
 * Form cues are parsed out of Rust's src/constants/formCues.ts — never invented.
 *
 * Usage:
 *   node scripts/generate-anatomy-card.js --exercise "Barbell Bench Press"
 *   node scripts/generate-anatomy-card.js --exercise "Barbell Curl" --no-video
 *   node scripts/generate-anatomy-card.js --list-matched        # unattended-run candidates
 *   node scripts/generate-anatomy-card.js --all --limit 20      # batch
 *
 * Options:
 *   --exercise <name>   exercise to render (fuzzy-matched against the library)
 *   --out <dir>         output dir (default Media/anatomy-proto)
 *   --fps <n>           default 30
 *   --duration <sec>    default 2
 *   --no-video          static PNG only
 *   --no-static         MP4 only
 *   --keep-frames       keep the PNG frame sequence
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO = '/mnt/c/Users/Heath/Projects/MeetDossie';
const RUST = '/mnt/c/Users/Heath/Projects/Rust';
const TEMPLATE = path.join(REPO, 'scripts', 'video-cards', 'anatomy-figure.html');
const LIBRARY = path.join(RUST, 'api', '__checks__', 'fixtures', 'exercise-library.json');
const CUES_TS = path.join(RUST, 'src', 'constants', 'formCues.ts');
const FFMPEG = process.env.FFMPEG_BIN || path.join(os.homedir(), '.local', 'bin', 'ffmpeg');
const FFPROBE = process.env.FFPROBE_BIN || path.join(os.homedir(), '.local', 'bin', 'ffprobe');

/** The 7 liftable groups the figure can light up. `cardio` and `yoga` exist in
 *  the library but have no muscle region, so they are skipped. */
const LIFTABLE = ['chest', 'back', 'shoulders', 'legs', 'biceps', 'triceps', 'abs'];

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    if (k.startsWith('no-')) { out[k.slice(3)] = false; continue; }
    const nxt = argv[i + 1];
    if (nxt === undefined || nxt.startsWith('--')) { out[k] = true; }
    else { out[k] = nxt; i++; }
  }
  return out;
}

function loadLibrary() {
  const raw = JSON.parse(fs.readFileSync(LIBRARY, 'utf8'));
  const arr = Array.isArray(raw) ? raw : (raw.exercises || Object.values(raw)[0]);
  return arr.filter(e => e && e.name);
}

/** formCues.ts is a plain JS object literal behind a TS type annotation. Slice
 *  out the literal and eval it rather than duplicating 35 cue sets by hand. */
function loadCues() {
  const src = fs.readFileSync(CUES_TS, 'utf8');
  // Skip past the TS type annotation (`Record<string, { ... }>`) to the `= {`.
  const m = /export const FORM_CUES[^=]*=\s*/.exec(src);
  if (!m) throw new Error('FORM_CUES declaration not found');
  const start = m.index + m[0].length;
  let depth = 0, end = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (start < 0 || end < 0) throw new Error('could not locate FORM_CUES object literal');
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

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

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
    .replace(/\{\{DRIVEN\}\}/g, cfg.driven ? 'true' : 'false');
}

async function render(browser, cfg, width, height, onPage) {
  // Written next to the template so the @font-face relative paths still resolve.
  const tmp = path.join(path.dirname(TEMPLATE), `.tmp-${slug(cfg.exercise)}-${cfg.format}.html`);
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

  if (args['list-matched']) {
    const rows = lib.filter(e => LIFTABLE.includes(e.muscle_group) && cuesFor(e.name, CUES));
    rows.forEach(e => console.log(`${e.muscle_group.padEnd(10)} ${e.name}`));
    console.log(`\n${rows.length} of ${lib.length} exercises are renderable (liftable group + real form cues).`);
    return;
  }

  let targets;
  if (args.all) {
    targets = lib.filter(e => LIFTABLE.includes(e.muscle_group) && cuesFor(e.name, CUES));
    if (args.limit) targets = targets.slice(0, parseInt(args.limit, 10));
  } else {
    const ex = findExercise(args.exercise || 'Barbell Bench Press', lib);
    if (!ex) { console.error(`no exercise matching "${args.exercise}"`); process.exit(2); }
    targets = [ex];
  }

  const outDir = path.resolve(args.out || path.join(REPO, 'Media', 'anatomy-proto'));
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
      // Cues are the whole point of the "proper form" frames and they must be
      // Rust's real ones — never invented, never a generic filler. If the
      // library name doesn't resolve to a FORM_CUES entry, skip the exercise
      // rather than shipping a card with a blank cue block.
      if (!fc && !args['allow-no-cues']) {
        console.warn(`[skip] "${ex.name}" has no entry in formCues.ts (pass --allow-no-cues to render anyway)`);
        continue;
      }
      if (!LIFTABLE.includes(ex.muscle_group)) {
        console.warn(`[skip] "${ex.name}" is ${ex.muscle_group} — no muscle region to light`);
        continue;
      }
      const base = {
        exercise: ex.name,
        muscleGroup: ex.muscle_group,
        secondary: (ex.secondary_muscle_groups || []).filter(g => LIFTABLE.includes(g)),
        cues: fc ? fc.cues.slice(0, 3) : [],
        focus: fc ? fc.focus : '',
      };
      const stem = slug(ex.name);

      // --- a) static 1080x1350 -------------------------------------------
      if (args.static !== false) {
        const png = path.join(outDir, `${stem}-${ex.muscle_group}-1080x1350.png`);
        await render(browser, { ...base, format: 'card', driven: true }, 1080, 1350, async (page) => {
          await page.evaluate(() => window.setPhase(0.62)); // near peak glow — best single frame
          await page.screenshot({ path: png, type: 'png' });
        });
        console.log(`[png] ${png}`);
      }

      // --- b) looping 1080x1920 ------------------------------------------
      if (args.video !== false) {
        const frameDir = path.join(outDir, `.frames-${stem}`);
        fs.rmSync(frameDir, { recursive: true, force: true });
        fs.mkdirSync(frameDir, { recursive: true });

        await render(browser, { ...base, format: 'story', driven: true }, 1080, 1920, async (page) => {
          for (let i = 0; i < frames; i++) {
            await page.evaluate(t => window.setPhase(t), i / frames); // i/frames, not i/(frames-1): frame N == frame 0
            await page.screenshot({ path: path.join(frameDir, `f${String(i).padStart(4, '0')}.png`), type: 'png' });
          }
        });

        const mp4 = path.join(outDir, `${stem}-${ex.muscle_group}-1080x1920-loop.mp4`);
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

      console.log(`[done] ${ex.name} (${ex.muscle_group}) in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    }
  } finally {
    await browser.close();
  }
})().catch(err => { console.error(err && (err.stack || err.message)); process.exit(1); });
