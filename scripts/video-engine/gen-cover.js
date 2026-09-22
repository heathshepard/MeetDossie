#!/usr/bin/env node
'use strict';

/**
 * gen-cover.js — cover images for Dossie videos and posts.
 *
 * Emits, for one headline:
 *   a) 1080x1920  — the Reels/TikTok/Shorts cover (Creative Director Standard §13)
 *   b) 1280x720   — the YouTube / link-preview / OG variant (same idea, reflowed)
 *
 * Toolchain is only what we already own, same as scripts/generate-anatomy-card.js:
 * Playwright Chromium renders HTML+CSS to PNG (there is no PIL on this box and the
 * static ffmpeg has no drawtext), and the static ffmpeg at ~/.local/bin/ffmpeg pulls
 * frames out of real footage. Fonts are read off disk from public/fonts — nothing
 * is fetched over the network.
 *
 * WHAT THIS DELIBERATELY WILL NOT DO
 *   - It will not draw a fake Dossie interface. The screenshot slot renders a real
 *     PNG you hand it, or it renders nothing. (Standard §9: never invent product
 *     capabilities. Memory: dossie-demo-must-match-real-capability.)
 *   - It will not use a stock or generated person. The face slot renders a frame of
 *     Heath out of real footage, or it renders nothing. (Standard §16.)
 *   - It will not matte/cut-out the subject. There is no green screen in the source
 *     and no local matting model on this machine (no sharp, no onnxruntime-node, no
 *     .onnx weights), and a bad matte looks worse than an honest crop. The face is
 *     framed as a panel or a circle instead.
 *
 * ---------------------------------------------------------------- usage ----
 *   # one cover, both sizes
 *   node scripts/video-engine/gen-cover.js \
 *     --headline "How many times have you almost lost your mind on one transaction?" \
 *     --highlight "almost lost your mind" \
 *     --kicker "Real estate agents" \
 *     --template face-headline \
 *     --photo Media/covers-proto/faces/heath-serious.png \
 *     --name pain-almost-lost-my-mind
 *
 *   # build the face + screenshot banks out of real media first
 *   node scripts/video-engine/gen-cover.js --extract-faces
 *   node scripts/video-engine/gen-cover.js --extract-shots
 *
 *   # render every sample in the sample set (what Heath judges)
 *   node scripts/video-engine/gen-cover.js --samples
 *
 * ------------------------------------------------------------- options ----
 *   --headline <text>     required (unless --samples/--extract-*)
 *   --highlight <phrase>  substring of the headline to put in a coral block
 *   --kicker <text>       small all-caps line above the headline
 *   --sub <text>          one supporting line under the headline
 *   --template <name>     face-headline | face-shot | face-icons | text-hero
 *   --photo <png>         REAL frame of Heath (see --extract-faces)
 *   --photo-pos <css>     object-position, default "50% 32%"
 *   --shot <png>          REAL product screenshot (see --extract-shots)
 *   --icons a,b,c         face-icons labels; keys: showings emails inspections
 *                         deadlines clients listings documents texts title money
 *   --theme blush|navy    default blush
 *   --font sans|serif     headline face. sans = Plus Jakarta Sans (default,
 *                         survives a 150px thumbnail); serif = Cormorant Garamond
 *   --cta <text>          pill bottom-right, e.g. "Watch". omit for none
 *   --tagline <text>      small line under the wordmark
 *   --max-font <px>       cap on the auto-fit headline size
 *   --name <slug>         output basename
 *   --out <dir>           default Media/covers-proto
 *   --align top|center    vertical placement of the headline. text-hero defaults to
 *                         centre (playbook §3 wants the hook dead-centre); the
 *                         face templates default to top, since the face owns the
 *                         bottom of the frame
 *   --safe ig|tiktok      safe-zone profile, default ig. See playbook §3 — tiktok
 *                         additionally clears its own left/right/bottom chrome
 *   --only story|yt       render just one size
 *   --guides              overlay Instagram's 4:5 and 1:1 centre-crop boxes
 *   --keep-html           leave the rendered HTML next to the output for debugging
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');
const TEMPLATE = path.join(HERE, 'cover-templates.html');
const FFMPEG = process.env.FFMPEG_BIN || path.join(os.homedir(), '.local', 'bin', 'ffmpeg');

/** Media/ is gitignored, and this script is often run from a worktree that has no
 *  Media/ of its own. MEDIA_ROOT lets the caller point at the checkout that does. */
const MEDIA = process.env.DOSSIE_MEDIA_ROOT || path.join(REPO, 'Media');

const FORMATS = {
  story: { w: 1080, h: 1920, key: 'story' },
  yt:    { w: 1280, h: 720,  key: 'yt'    },
};

const TEMPLATES = ['face-headline', 'face-shot', 'face-icons', 'text-hero'];

// ---------------------------------------------------------------- plumbing --

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    const nxt = argv[i + 1];
    if (nxt === undefined || nxt.startsWith('--')) { out[k] = true; }
    else { out[k] = nxt; i++; }
  }
  return out;
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
}

/** Playwright lives in the deploy checkout's node_modules; a git worktree won't
 *  have its own. Try the obvious places before giving a useful error. */
function loadChromium() {
  const tries = [
    path.join(REPO, 'node_modules', 'playwright'),
    '/mnt/c/Users/Heath/Projects/MeetDossie/node_modules/playwright',
    'playwright',
  ];
  for (const t of tries) {
    try { return require(t).chromium; } catch (_) { /* next */ }
  }
  throw new Error('playwright not found. Run npm i in the MeetDossie checkout, or set NODE_PATH.');
}

function ffmpeg(args) {
  execFileSync(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

// -------------------------------------------------- build the asset banks --

/**
 * Real frames of Heath, pulled out of the raw founder take.
 *
 * Source: Downloads/22054.mp4 — the original 2160x3840 portrait recording behind
 * Media/finished-videos/dossie_trial_0*.mp4 (transcript in
 * dossie_trial_01.transcript.txt). Timestamps below were picked by eye off a
 * 1-frame-per-second contact sheet; each one is a frame where he is looking at the
 * lens and the mouth is closed or near-closed.
 *
 * Honest note on this footage: headphones on, sleeveless shirt, busy kitchen
 * behind him. It is real, which is the only thing that matters for the hard rule,
 * but it is not good cover material. That gap is the entire reason
 * docs/HEATH-PHOTO-SHOT-LIST.md exists.
 */
const FACE_SOURCES = [
  { name: 'heath-serious',    at: '6.4',  note: 'closed mouth, straight down the lens' },
  { name: 'heath-listening',  at: '26.4', note: 'slight head tilt, closed mouth' },
  { name: 'heath-explaining', at: '33.0', note: 'mid-sentence, brows up' },
];
const RAW_TAKE = process.env.DOSSIE_RAW_TAKE || '/mnt/c/Users/Heath/Downloads/22054.mp4';
/** Head-and-shoulders window inside the 2160x3840 portrait frame. */
const FACE_CROP = { w: 1700, h: 1900, x: 250, y: 950 };

function extractFaces(outDir) {
  if (!fs.existsSync(RAW_TAKE)) {
    console.error(`raw take not found: ${RAW_TAKE}\n` +
      'Set DOSSIE_RAW_TAKE, or point --photo at any real frame you already have.');
    process.exit(2);
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of FACE_SOURCES) {
    const png = path.join(outDir, `${f.name}.png`);
    ffmpeg(['-y', '-v', 'error', '-ss', f.at, '-i', RAW_TAKE, '-frames:v', '1',
      '-vf', `crop=${FACE_CROP.w}:${FACE_CROP.h}:${FACE_CROP.x}:${FACE_CROP.y}`, png]);
    console.log(`[face] ${png}  (t=${f.at}s — ${f.note})`);
  }
}

/**
 * Real Dossie screenshots, pulled out of the 20 recorded feature demos in
 * Media/feature-demos/. Crops drop the sidebar and the browser chrome so the
 * panel that matters fills the card. Nothing here is redrawn.
 */
const SHOT_SOURCES = [
  { name: 'morning-brief',        file: 'feature-demo-morning-brief-desktop-2026-08-17.mp4',
    at: '17', crop: '830:300:172:20' },
  { name: 'trec-deadlines',       file: 'feature-demo-trec-deadlines-desktop-2026-09-07.mp4',
    at: '21', crop: '740:232:208:378' },
  { name: 'required-docs',        file: 'feature-demo-chase-documents-desktop-2026-09-07.mp4',
    at: '20', crop: '820:420:180:70' },
];

function extractShots(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const s of SHOT_SOURCES) {
    const src = path.join(MEDIA, 'feature-demos', s.file);
    if (!fs.existsSync(src)) { console.warn(`[skip] missing demo: ${src}`); continue; }
    const png = path.join(outDir, `${s.name}.png`);
    ffmpeg(['-y', '-v', 'error', '-ss', s.at, '-i', src, '-frames:v', '1',
      '-vf', `scale=1280:-1,crop=${s.crop}`, png]);
    console.log(`[shot] ${png}  (${s.file} @ ${s.at}s)`);
  }
}

// ------------------------------------------------------------- the render --

/** Copy an asset next to the temp HTML so the page can reference it relatively.
 *  Chromium is fussy about file:// subresources across directories; this sidesteps
 *  it entirely and keeps the debug HTML (--keep-html) self-contained. */
function stage(file, tmpDir, as) {
  if (!file) return null;
  const abs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) throw new Error(`asset not found: ${abs}`);
  const dest = as + path.extname(abs);
  fs.copyFileSync(abs, path.join(tmpDir, dest));
  return dest;
}

async function renderOne(browser, cfg, fmt, outPng, keepHtml) {
  const tmpDir = fs.mkdtempSync(path.join(HERE, '.tmp-cover-'));
  try {
    const conf = {
      ...cfg,
      format: fmt.key,
      photo: stage(cfg.photo, tmpDir, 'face'),
      shot:  stage(cfg.shot,  tmpDir, 'shot'),
      logo:  stage(cfg.logo,  tmpDir, 'logo'),
    };
    // The template's @font-face URLs are relative to scripts/video-engine/, and the
    // temp dir is one level deeper, so rewrite them for this copy.
    const html = fs.readFileSync(TEMPLATE, 'utf8')
      .replace(/\.\.\/\.\.\/public\/fonts\//g, '../../../public/fonts/')
      .replace('{{CONFIG_JSON}}', JSON.stringify(conf));
    const htmlPath = path.join(tmpDir, 'cover.html');
    fs.writeFileSync(htmlPath, html);

    const page = await browser.newPage({
      viewport: { width: fmt.w, height: fmt.h }, deviceScaleFactor: 1,
    });
    try {
      await page.goto('file://' + htmlPath, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__ready === true, { timeout: 20000 });
      await page.screenshot({ path: outPng, type: 'png' });
      const fontSize = await page.evaluate(() => Math.round(window.__fontSize));
      console.log(`[png] ${outPng}  (${fmt.w}x${fmt.h}, headline ${fontSize}px)`);
    } finally {
      await page.close();
    }

    if (keepHtml) {
      const keepDir = outPng.replace(/\.png$/, '.html-src');
      fs.rmSync(keepDir, { recursive: true, force: true });
      fs.cpSync(tmpDir, keepDir, { recursive: true });
      console.log(`      html kept at ${keepDir}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------- sample set --

/**
 * The six samples Heath judges. Every headline is a real line: the first four come
 * straight out of Media/finished-videos/dossie_trial_01.transcript.txt (his own
 * founder take); the last two describe capabilities that exist today and are
 * recorded in Media/feature-demos/.
 */
function sampleSet(faces, shots) {
  return [
    { name: '01-pain-almost-lost-my-mind', template: 'face-headline', theme: 'blush',
      kicker: 'Real estate agents',
      headline: 'How many times have you almost lost your mind on one transaction?',
      highlight: 'almost lost your mind',
      photo: faces['heath-serious'], cta: 'Watch' },

    { name: '02-everything-in-your-head', template: 'face-icons', theme: 'navy',
      kicker: 'One transaction',
      headline: 'Remember all of it.',
      highlight: 'all of it',
      icons: 'inspections,deadlines,emails,documents,texts,money',
      photo: faces['heath-explaining'] },

    { name: '03-trec-deadlines-real-ui', template: 'face-shot', theme: 'blush',
      kicker: 'Built for Texas agents',
      headline: 'Every TREC deadline, computed off the contract dates.',
      highlight: 'off the contract dates',
      sub: 'Real screen. Not a mockup.',
      photo: faces['heath-listening'], shot: shots['trec-deadlines'], cta: 'Watch' },

    { name: '04-why-i-started-building', template: 'text-hero', theme: 'navy',
      kicker: 'Founder note',
      headline: "That's actually why I started building Dossie.",
      highlight: 'why I started building',
      sub: 'Heath Shepard — Texas REALTOR, San Antonio',
      photo: faces['heath-serious'] },

    { name: '05-morning-brief-real-ui', template: 'face-shot', theme: 'navy',
      kicker: 'Before your first showing',
      headline: 'What needs you, what can wait, what is already moving.',
      highlight: 'what can wait',
      photo: faces['heath-explaining'], shot: shots['morning-brief'], cta: 'Watch' },

    { name: '06-tell-me-what-youd-want', template: 'face-headline', theme: 'blush',
      font: 'serif',
      kicker: 'If you are an agent',
      headline: 'Tell me what you would want Dossie to do.',
      highlight: 'what you would want',
      photo: faces['heath-listening'] },
  ];
}

// -------------------------------------------------------------------- main --

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out || path.join(MEDIA, 'covers-proto'));
  const faceDir = path.join(outDir, 'faces');
  const shotDir = path.join(outDir, 'shots');

  if (args['extract-faces']) { extractFaces(faceDir); return; }
  if (args['extract-shots']) { extractShots(shotDir); return; }
  if (args['list-templates']) { TEMPLATES.forEach(t => console.log(t)); return; }

  fs.mkdirSync(outDir, { recursive: true });
  const logo = path.join(REPO, 'public', 'dossie-logo-d.png');

  let jobs;
  if (args.samples) {
    if (!fs.existsSync(faceDir)) extractFaces(faceDir);
    if (!fs.existsSync(shotDir)) extractShots(shotDir);
    const faces = {}; const shots = {};
    for (const f of FACE_SOURCES) faces[f.name] = path.join(faceDir, `${f.name}.png`);
    for (const s of SHOT_SOURCES) shots[s.name] = path.join(shotDir, `${s.name}.png`);
    jobs = sampleSet(faces, shots);
  } else {
    if (!args.headline) {
      console.error('--headline is required (or use --samples / --extract-faces / --extract-shots)');
      process.exit(2);
    }
    jobs = [{
      name: args.name || slug(args.headline),
      template: args.template || 'face-headline',
      theme: args.theme || 'blush',
      font: args.font,
      kicker: args.kicker, headline: args.headline, highlight: args.highlight,
      sub: args.sub, photo: args.photo, shot: args.shot, icons: args.icons,
      cta: args.cta === true ? 'Watch' : args.cta,
      photoPos: args['photo-pos'],
    }];
  }

  const chromium = loadChromium();
  const browser = await chromium.launch();
  try {
    for (const j of jobs) {
      if (!TEMPLATES.includes(j.template)) {
        console.error(`unknown template "${j.template}". one of: ${TEMPLATES.join(', ')}`);
        process.exit(2);
      }
      // Playbook §3: a cover wants 3-5 words. Longer still renders (Heath's real
      // transcript lines are longer than that and some are worth using whole), but
      // say so rather than shipping a wall of type silently.
      const words = String(j.headline).trim().split(/\s+/).length;
      if (words > 5) {
        console.log(`      [note] "${j.name}" headline is ${words} words; ` +
          'SCROLL-STOPPING-VIDEO-PLAYBOOK §3 asks for 3-5 on a cover.');
      }
      const cfg = {
        template: j.template,
        theme: j.theme || 'blush',
        headlineFont: (j.font === 'serif') ? 'serif' : 'sans',
        kicker: j.kicker || '',
        headline: j.headline,
        highlight: j.highlight || '',
        sub: j.sub || '',
        photo: j.photo || null,
        photoPos: j.photoPos || null,
        shot: j.shot || null,
        icons: j.icons ? String(j.icons).split(',').map(s => s.trim()).filter(Boolean) : null,
        brand: args.brand || 'Dossie',
        tagline: j.tagline || args.tagline || 'Your deals. Her job.',
        cta: j.cta || null,
        logo: fs.existsSync(logo) ? logo : null,
        align: j.align || args.align || (j.template === 'text-hero' ? 'center' : 'top'),
        safe: j.safe || args.safe || 'ig',
        maxFont: args['max-font'] ? parseInt(args['max-font'], 10) : null,
        guides: !!args.guides,
      };
      const stem = slug(j.name);
      const which = args.only ? [args.only] : ['story', 'yt'];
      for (const k of which) {
        const fmt = FORMATS[k];
        if (!fmt) { console.error(`--only must be story or yt`); process.exit(2); }
        await renderOne(browser, cfg, fmt,
          path.join(outDir, `${stem}-${fmt.w}x${fmt.h}.png`), !!args['keep-html']);
      }
    }
  } finally {
    await browser.close();
  }
})().catch(err => { console.error(err && (err.stack || err.message)); process.exit(1); });
