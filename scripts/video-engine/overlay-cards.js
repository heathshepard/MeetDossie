#!/usr/bin/env node
/**
 * overlay-cards.js — the two graphic overlays the engine never had.
 *
 * ===================================================================
 * 1. STANDING HOOK OVERLAY  (first 2-3 s)
 * ===================================================================
 * THE PROBLEM IT FIXES: frame 1 of the shipped 60 s cut reads "IF YOU WROTE".
 * That is not a hook, it is the first three words of a sentence — it means
 * nothing on its own, and frame 1 is the only frame most people will ever
 * see. §2 wants a scroll-stopping statement in the first second; a caption
 * fragment structurally cannot be one, because captions are chunked by
 * SPEECH, not by meaning.
 *
 * So the hook is a SEPARATE, PERSISTENT graphic that states the whole claim
 * ("TEXAS CONTRACTS CHANGED ON JULY 1ST") and stays up for 2-3 s while the
 * speech gets going underneath. It is not a caption and it does not move.
 *
 * ===================================================================
 * 2. GRAPHIC CTA CARD  (last 3-5 s)
 * ===================================================================
 * THE PROBLEM IT FIXES: the CTA is currently SPOKEN only. ~85% of Facebook
 * video is watched with the sound off, so for most viewers there is no call
 * to action at all. §17's CTA row cannot pass on an audio-only CTA.
 *
 * Variants:
 *   follow   "FOLLOW FOR MORE"  + subline
 *   save     "SAVE THIS"        + subline
 *   comment  comment-trigger — "COMMENT <WORD>" and the payoff. This is the
 *            highest-signal variant on Facebook because a comment weighs more
 *            than a like in ranking, and it gives a reason to comment rather
 *            than asking for one.
 *
 * Both cards are transparent PNGs composited over the footage, NOT a
 * full-screen replacement — gen-cta-card.js already does the full-screen
 * navy end card, and replacing the picture at the CTA throws away the last
 * seconds of watch time on the one element you most want seen.
 *
 * Usage (render a card):
 *   node scripts/video-engine/overlay-cards.js --kind hook --text "TEXAS CONTRACTS CHANGED" --out hook.png
 *   node scripts/video-engine/overlay-cards.js --kind cta --variant comment \
 *     --text "COMMENT \"7I\"" --sub "and I'll send you the clause" --out cta.png
 *
 * Usage (composite onto a clip):
 *   node scripts/video-engine/overlay-cards.js --in cut.mp4 --out cut2.mp4 \
 *     --hookText "TEXAS CONTRACTS CHANGED ON JULY 1ST" --hookSec 2.6 \
 *     --ctaVariant comment --ctaText "COMMENT \"7I\"" --ctaSub "for the clause" --ctaSec 4.0
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// CLAUDE.md Section 4 brand tokens.
const BRAND = {
  navy: '#1A1A2E',
  coral: '#E8836B',
  gold: '#C9A96E',
  blush: '#F5E6E0',
  sage: '#8BA888',
  white: '#FFFFFF',
};

const DEFAULTS = {
  W: 1080, H: 1920,
  hook: {
    // Sits in the upper third, above where the 82px captions live at
    // MarginV 175 + box height. Measured so the two never collide.
    y: 470,
    fontSize: 96,
    lineHeight: 1.16,
    maxCharsPerLine: 17,
    pad: 34,
    bg: BRAND.navy,
    fg: BRAND.white,
    accent: BRAND.gold,
    sec: 2.6,
  },
  cta: {
    y: 1180,
    fontSize: 84,
    subSize: 44,
    lineHeight: 1.16,
    maxCharsPerLine: 18,
    pad: 40,
    bg: BRAND.navy,
    fg: BRAND.white,
    accent: BRAND.coral,
    sec: 4.0,
  },
};

const CTA_VARIANTS = {
  follow: { text: 'FOLLOW FOR MORE', sub: 'Texas contract changes, weekly' },
  save: { text: 'SAVE THIS', sub: "You'll want it at your next closing" },
  comment: { text: 'COMMENT "7I"', sub: "and I'll send you the clause" },
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function wrapLines(text, maxCharsPerLine) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxCharsPerLine && cur) { lines.push(cur); cur = w; }
    else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * renderCard — a transparent 1080x1920 PNG with a solid card band.
 *
 * The band is opaque, not a scrim: §17's CAPTIONS/VISUALS rows both fail on
 * text that competes with a busy background, and this graphic is going over
 * either a face or a scrolling contract, both of which are busy.
 *
 * RENDERED THROUGH PLAYWRIGHT, NOT SHARP. `sharp` is required by matte.js,
 * gen-cta-card.js, gen-navy-backdrop.js, refine-composite.js and
 * oval-vignette.js, but it is NOT in package.json and NOT installed in this
 * checkout — every one of those modules throws "Cannot find module 'sharp'"
 * at require time. Playwright IS installed, is already a declared dependency,
 * and is what the hand-built pipeline used for both the circle and the quote
 * card. Using it here means this module has no new dependency and actually
 * runs today. (Chromium also does real text layout, so the wrap below is a
 * warning check rather than the thing that positions the type.)
 */
async function renderCard(opts) {
  const {
    out, kind = 'hook', text, sub = null,
    W = DEFAULTS.W, H = DEFAULTS.H,
  } = opts;
  const d = { ...DEFAULTS[kind === 'cta' ? 'cta' : 'hook'], ...opts };

  const lines = wrapLines(text, d.maxCharsPerLine);
  if (kind === 'hook' && lines.length > 3) {
    // §2/§8: a hook is a STATEMENT, not a paragraph. Four lines of 96px is a
    // wall of text on frame 1, which is the same failure as a fragment.
    console.warn(`WARNING: hook wraps to ${lines.length} lines ("${text}"). A standing hook is 3-7 words. Shorten it.`);
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;background:transparent}
.band{position:absolute;left:0;width:${W}px;top:${Math.round(d.y)}px;
  background:${d.bg};opacity:.94;
  border-top:10px solid ${d.accent};border-bottom:10px solid ${d.accent};
  padding:${d.pad}px 56px;text-align:center;
  font-family:'DejaVu Sans',sans-serif}
.main{font-size:${d.fontSize}px;font-weight:bold;color:${d.fg};
  letter-spacing:1.5px;line-height:${d.lineHeight};text-transform:uppercase}
.sub{margin-top:${Math.round(d.subSize * 0.5)}px;font-size:${d.subSize}px;
  font-weight:600;color:${d.accent};letter-spacing:1px;line-height:1.25}
</style></head><body>
<div class="band" id="band">
  <div class="main">${escapeXml(text)}</div>
  ${sub ? `<div class="sub">${escapeXml(sub)}</div>` : ''}
</div>
</body></html>`;

  const tmpHtml = out + '.html';
  fs.writeFileSync(tmpHtml, html);
  const { chromium } = require('playwright');
  const b = await chromium.launch();
  let bandBox;
  try {
    const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    await p.goto(`file://${tmpHtml}`, { waitUntil: 'load' });
    bandBox = await p.$eval('#band', el => {
      const r = el.getBoundingClientRect();
      return { y: Math.round(r.top), h: Math.round(r.height) };
    });
    await p.screenshot({ path: out, omitBackground: true });
  } finally { await b.close(); }
  fs.unlinkSync(tmpHtml);

  // A band that runs off the bottom of the frame is a silent crop, and the
  // CTA is the one element that must be fully visible.
  if (bandBox.y + bandBox.h > H) {
    console.warn(`WARNING: ${kind} band ends at ${bandBox.y + bandBox.h}px of ${H} — it is being cut off. Lower --fontSize or raise --y.`);
  }
  return { out, kind, lines, bandY: bandBox.y, bandH: bandBox.h, W, H };
}

/**
 * compositeCards — lay a hook card over [0, hookSec] and/or a CTA card over
 * the last ctaSec of a clip, in ONE ffmpeg pass.
 *
 * Both fade so nothing pops. The CTA window is anchored to the clip's real
 * duration so it lands on the actual ending even when upstream trimming
 * changed the length.
 */
function compositeCards(opts) {
  const { input, out, hookCard = null, hookSec = 0, ctaCard = null, ctaSec = 0, fade = 0.25 } = opts;
  if (!fs.existsSync(input)) throw new Error(`overlay-cards: input not found: ${input}`);
  const dur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input]).toString().trim());

  const inputs = ['-i', input];
  const chain = [];
  let cur = '[0:v]';
  let idx = 1;

  if (hookCard && hookSec > 0) {
    inputs.push('-loop', '1', '-i', hookCard);
    chain.push(`[${idx}:v]format=rgba,fade=t=out:st=${(hookSec - fade).toFixed(3)}:d=${fade}:alpha=1,setpts=PTS-STARTPTS[hk]`);
    chain.push(`${cur}[hk]overlay=0:0:enable='lt(t,${hookSec})'[vh]`);
    cur = '[vh]'; idx++;
  }
  if (ctaCard && ctaSec > 0) {
    const ctaStart = Math.max(0, dur - ctaSec);
    inputs.push('-loop', '1', '-i', ctaCard);
    chain.push(`[${idx}:v]format=rgba,fade=t=in:st=0:d=${fade}:alpha=1,setpts=PTS-STARTPTS[ct]`);
    chain.push(`${cur}[ct]overlay=0:0:enable='gte(t,${ctaStart.toFixed(3)})'[vc]`);
    cur = '[vc]'; idx++;
  }
  if (!chain.length) throw new Error('overlay-cards: nothing to composite (no hook and no CTA).');

  execFileSync('ffmpeg', [
    '-y', ...inputs,
    '-filter_complex', chain.join(';'),
    '-map', cur, '-map', '0:a?',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', '-t', String(dur),
    out, '-hide_banner', '-loglevel', 'error',
  ], { maxBuffer: 1 << 28, timeout: 15 * 60 * 1000 });
  return { out, dur, hookSec, ctaSec };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.in) {
    const work = path.dirname(args.out);
    let hookCard = null, ctaCard = null;
    const hookSec = args.hookSec != null ? +args.hookSec : 0;
    const ctaSec = args.ctaSec != null ? +args.ctaSec : 0;
    if (args.hookText && hookSec > 0) {
      hookCard = path.join(work, 'hook-card.png');
      await renderCard({ out: hookCard, kind: 'hook', text: args.hookText });
    }
    if (ctaSec > 0) {
      const v = CTA_VARIANTS[args.ctaVariant] || CTA_VARIANTS.follow;
      ctaCard = path.join(work, 'cta-card.png');
      await renderCard({
        out: ctaCard, kind: 'cta',
        text: (args.ctaText && args.ctaText !== true) ? args.ctaText : v.text,
        sub: (args.ctaSub && args.ctaSub !== true) ? args.ctaSub : v.sub,
      });
    }
    const res = compositeCards({ input: args.in, out: args.out, hookCard, hookSec, ctaCard, ctaSec });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  const kind = args.kind === 'cta' ? 'cta' : 'hook';
  const v = CTA_VARIANTS[args.variant] || null;
  const text = (args.text && args.text !== true) ? args.text : (v ? v.text : null);
  const sub = (args.sub && args.sub !== true) ? args.sub : (v ? v.sub : null);
  if (!args.out || !text) {
    console.error('Usage: overlay-cards.js --kind hook|cta --text "..." [--sub "..."] [--variant follow|save|comment] --out <png>');
    process.exit(1);
  }
  const res = await renderCard({ out: args.out, kind, text, sub: kind === 'cta' ? sub : null });
  console.log(JSON.stringify(res, null, 2));
}

module.exports = { renderCard, compositeCards, CTA_VARIANTS, BRAND, DEFAULTS };
if (require.main === module) main().catch(e => { console.error('ERR', e.message); process.exit(1); });
