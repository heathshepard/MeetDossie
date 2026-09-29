'use strict';
/**
 * scripts/anatomy-v2/figure-lib.js — muscle-region mapping + highlight compositing
 * for the Rust anatomy figures in Media/anatomy-v2/base/.
 *
 * WHY THIS EXISTS
 * The v1 card (Media/anatomy-proto) drew the body as flat SVG vector shapes and
 * looked cheap. v2 uses four AI-generated anatomical renders as the base art and
 * lights the worked muscle group on top of them. The problem that creates is
 * alignment: a hand-authored SVG mask never quite sits on the render's anatomy.
 *
 * So the regions are not hand-drawn. They are derived from each render's own
 * silhouette:
 *   1. threshold the image to get the body mask (the figures are light on black),
 *   2. run-length each row to separate ARMS | TORSO | ARMS, and LEG | LEG,
 *   3. find landmarks (shoulder shelf, arm split, waist, shorts hem, leg split)
 *      including the clothing bands, detected as rows whose torso median luma is
 *      dark relative to skin,
 *   4. express every muscle group as ELLIPTICAL LOBES in contour-normalised
 *      coordinates — u is the position across the body at that row, so a lobe
 *      follows the silhouette automatically and cannot read as a rectangle.
 *
 * Highlighting then multiplies through the base image's own luminance, so the
 * separation grooves between muscle bellies and the dark fabric stay dark. The
 * glow reads as the render's anatomy lighting up rather than a coloured shape
 * pasted over it. Everything after the one-time base generation is free.
 *
 * Toolchain is only what this box already has: the static ffmpeg at
 * ~/.local/bin/ffmpeg for PNG<->raw, and plain JS. There is no PIL/pip and this
 * ffmpeg has no drawtext, which is why pixels are composited here and all
 * typography goes through Chromium (see generate-anatomy-v2.js).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FF = process.env.FFMPEG_BIN || path.join(os.homedir(), '.local', 'bin', 'ffmpeg');
const W = 832, H = 1248;   // native size of the ideogram/v3 renders
const T = 38;              // silhouette threshold: background is pure black

/** The 7 groups a figure can light. `cardio` and `yoga` have no muscle region. */
const LIFTABLE = ['chest', 'back', 'shoulders', 'legs', 'biceps', 'triceps', 'abs'];
/** Which groups are visible on which view. */
const VIEW_GROUPS = {
  front: ['chest', 'abs', 'shoulders', 'biceps', 'legs'],
  back:  ['back', 'shoulders', 'triceps', 'legs'],
};

const clamp01 = x => Math.max(0, Math.min(1, x));
const ss = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
/** Soft-edged ellipse in normalised (u,v). Long falloff => no straight edges. */
const lobe = (u, v, uc, vc, ru, rv) =>
  1 - ss(0.52, 1.0, Math.sqrt(((u - uc) / ru) ** 2 + ((v - vc) / rv) ** 2));

// ---------------------------------------------------------------- pixel I/O
function toGray(file) {
  const t = `${file}.${process.pid}.gray`;
  execFileSync(FF, ['-y', '-i', file, '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'gray', t], { stdio: 'ignore' });
  const b = fs.readFileSync(t); fs.unlinkSync(t); return b;
}
function toRgb(file) {
  const t = `${file}.${process.pid}.rgb`;
  execFileSync(FF, ['-y', '-i', file, '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', t], { stdio: 'ignore' });
  const b = fs.readFileSync(t); fs.unlinkSync(t); return b;
}
function writeRgb(buf, out) {
  const t = `${out}.${process.pid}.rgb`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(t, buf);
  execFileSync(FF, ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-i', t, out], { stdio: 'ignore' });
  fs.unlinkSync(t);
}

/**
 * Cut the figure out of its matte and write RGBA.
 *
 * The renders' backgrounds measure luma 0-16, well below any part of the figure
 * (the charcoal shorts, the darkest thing on the body, sit at ~48). So alpha is
 * a soft ramp across that gap, which both removes the matte and keeps the
 * silhouette anti-aliased.
 *
 * Alpha is always derived from the ORIGINAL base image, never from the
 * highlighted one, so the rest and hot layers cut out identically and the
 * cross-fade cannot shimmer at the edges.
 *
 * This has to be alpha rather than flattening the matte to the card colour: an
 * opaque rectangle covers the card's own grid and glow layers and reads as a
 * visible box around each figure.
 */
/**
 * Body mask. Neither available shortcut works alone here:
 *   - a luma threshold fails because the charcoal shorts reach luma 0-3, fully
 *     overlapping the background's 0-16, so thresholding punches holes in the
 *     fabric and the card's glow shines through it;
 *   - a plain border flood-fill fails because on the posterior views the fabric
 *     touches the background through thin dark channels at the hip, leaking into
 *     the shorts (measured: 5% of the male-back block, 17% of female-back).
 *
 * So: flood-fill the background from the border, then morphologically OPEN that
 * background. Opening deletes intrusions thinner than the kernel — exactly the
 * leak channels — while the genuine arm-to-torso and between-the-legs gaps are
 * far wider and survive untouched.
 *
 * r is deliberately small. A large kernel (r=16) does close every fabric hole,
 * but it also bridges the narrow gap between the hands and the hips and webs
 * them together with a dark block. r=8 leaves a few percent of the male-back
 * fabric partially transparent instead, which is invisible in practice because
 * the card puts nothing bright directly behind the figure — see the note on
 * .fig in scripts/video-cards/anatomy-figure-v2.html.
 */
function bodyMask(gray, thr = 20, r = 8) {
  const bg = new Uint8Array(W * H);
  const st = [];
  for (let x = 0; x < W; x++) { st.push(x); st.push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { st.push(y * W); st.push(y * W + W - 1); }
  while (st.length) {
    const i = st.pop();
    if (bg[i] || gray[i] > thr) continue;
    bg[i] = 1;
    const x = i % W, y = (i / W) | 0;
    if (x > 0) st.push(i - 1);
    if (x < W - 1) st.push(i + 1);
    if (y > 0) st.push(i - W);
    if (y < H - 1) st.push(i + W);
  }
  // separable min/max passes = erode then dilate on the background mask
  const pass = (src, take) => {
    const a = new Uint8Array(W * H), o = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = take === 'min' ? 1 : 0;
      for (let k = -r; k <= r; k++) {
        const xx = Math.min(W - 1, Math.max(0, x + k)), s = src[y * W + xx];
        v = take === 'min' ? Math.min(v, s) : Math.max(v, s);
      }
      a[y * W + x] = v;
    }
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
      let v = take === 'min' ? 1 : 0;
      for (let k = -r; k <= r; k++) {
        const yy = Math.min(H - 1, Math.max(0, y + k)), s = a[yy * W + x];
        v = take === 'min' ? Math.min(v, s) : Math.max(v, s);
      }
      o[y * W + x] = v;
    }
    return o;
  };
  const opened = pass(pass(bg, 'min'), 'max');
  const body = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) body[i] = opened[i] ? 0 : 255;
  return body;
}

function writeRgba(rgb, grayForAlpha, out) {
  const body = bodyMask(grayForAlpha);
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    // luma ramp only softens the outer silhouette; the mask owns the interior
    rgba[i * 4 + 3] = body[i] ? 255 : Math.round(255 * ss(18, 40, grayForAlpha[i]));
  }
  const t = `${out}.${process.pid}.rgba`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(t, rgba);
  execFileSync(FF, ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-i', t, out], { stdio: 'ignore' });
  fs.unlinkSync(t);
}

// ------------------------------------------------------- silhouette analysis
function runsAt(b, y) {
  const o = []; let s = -1;
  for (let x = 0; x < W; x++) {
    if (b[y * W + x] > T) { if (s < 0) s = x; }
    else if (s >= 0) { if (x - s >= 5) o.push([s, x - 1]); s = -1; }
  }
  if (s >= 0 && W - s >= 5) o.push([s, W - 1]);
  return o;
}
/** Merge runs split by a thin dark seam (a shorts seam, a muscle groove). */
function merged(b, y) {
  const o = [];
  for (const r of runsAt(b, y)) {
    if (o.length && r[0] - o[o.length - 1][1] <= 16) o[o.length - 1][1] = r[1];
    else o.push([r[0], r[1]]);
  }
  return o.filter(a => a[1] - a[0] >= 8);
}

function landmarks(b) {
  let top = -1, bot = -1;
  for (let y = 0; y < H; y++) if (merged(b, y).length) { if (top < 0) top = y; bot = y; }
  const width = y => { const m = merged(b, y); return m.length ? m[m.length - 1][1] - m[0][0] : 0; };

  // shoulder shelf = first row appreciably wider than the head
  let headMax = 0;
  for (let y = top; y < top + Math.round((bot - top) * 0.14); y++) headMax = Math.max(headMax, width(y));
  let shoulderTop = top;
  for (let y = top; y < bot; y++) if (width(y) > headMax * 1.5) { shoulderTop = y; break; }

  let armSplit = -1;
  for (let y = shoulderTop; y < bot; y++) if (merged(b, y).length >= 3) { armSplit = y; break; }
  let armEnd = -1;
  for (let y = bot; y > armSplit; y--) if (merged(b, y).length >= 3) { armEnd = y; break; }

  let legSplit = -1;
  for (let y = Math.round(armSplit + (armEnd - armSplit) * 0.45); y < bot; y++) {
    const m = merged(b, y); if (m.length !== 2) continue;
    const gL = m[0][1], gR = m[1][0], c = (m[0][0] + m[1][1]) / 2;
    if (gR - gL > 18 && gL < c && gR > c) { legSplit = y; break; }
  }

  let sx = 0, n = 0;
  for (let y = shoulderTop; y < shoulderTop + 40; y++) {
    const m = merged(b, y); if (m.length) { sx += (m[0][0] + m[m.length - 1][1]) / 2; n++; }
  }
  const cx = n ? Math.round(sx / n) : W / 2;

  // clothing rows: the charcoal shorts/bra sit far below skin luma
  const clothed = [];
  for (let y = top; y <= bot; y++) {
    const m = merged(b, y);
    if (!m.length) { clothed.push(false); continue; }
    let ti = 0, best = 1e9;
    m.forEach((r, i) => {
      const d = (r[0] <= cx && r[1] >= cx) ? 0 : Math.min(Math.abs(r[0] - cx), Math.abs(r[1] - cx));
      if (d < best) { best = d; ti = i; }
    });
    const v = [];
    for (let x = m[ti][0]; x <= m[ti][1]; x++) { const q = b[y * W + x]; if (q > T) v.push(q); }
    v.sort((p, q) => p - q);
    clothed.push(v.length ? v[v.length >> 1] < 92 : false);
  }
  // shorts = the longest clothed run in the lower part of the torso
  let bestRun = [0, 0], cur = -1;
  for (let i = 0; i < clothed.length; i++) {
    const y = top + i;
    if (clothed[i] && y > shoulderTop + (bot - shoulderTop) * 0.25) { if (cur < 0) cur = y; }
    else if (cur >= 0) { if (y - cur > bestRun[1] - bestRun[0]) bestRun = [cur, y - 1]; cur = -1; }
  }
  if (cur >= 0 && bot - cur > bestRun[1] - bestRun[0]) bestRun = [cur, bot];
  const hasShorts = bestRun[1] > bestRun[0];

  return {
    top, bot, h: bot - top, shoulderTop, armSplit, armEnd, legSplit, cx,
    waistY: hasShorts ? bestRun[0] : Math.round(legSplit - (bot - top) * 0.085),
    shortsBottom: hasShorts ? bestRun[1] : legSplit,
  };
}

/** Split a row's runs into torso / arms / legs. */
function classify(b, y, L) {
  const m = merged(b, y);
  if (!m.length) return { arms: [], legs: [] };
  if (y >= L.legSplit) {
    const s = m.map(r => ({ r, d: Math.abs((r[0] + r[1]) / 2 - L.cx) })).sort((a, c) => a.d - c.d);
    return { arms: s.slice(2).map(o => o.r), legs: s.slice(0, 2).map(o => o.r) };
  }
  let ti = 0, best = 1e9;
  m.forEach((r, i) => {
    const d = (r[0] <= L.cx && r[1] >= L.cx) ? 0 : Math.min(Math.abs(r[0] - L.cx), Math.abs(r[1] - L.cx));
    if (d < best) { best = d; ti = i; }
  });
  return { torso: m[ti], arms: m.filter((_, i) => i !== ti), legs: [] };
}

// --------------------------------------------------------------- the regions
function buildRegions(gray, view) {
  const b = gray, L = landmarks(b), h = L.h, top = L.top;
  const v = y => (y - top) / h;
  const vS = v(L.shoulderTop), vW = v(L.waistY), vSB = v(L.shortsBottom);

  const G = {};
  VIEW_GROUPS[view].forEach(k => { G[k] = new Float32Array(W * H); });
  const put = (k, x, y, w) => {
    if (w <= 0.003) return;
    const i = y * W + x;
    if (b[i] > T && w > G[k][i]) G[k][i] = Math.min(1, w);
  };

  // lobe centres / radii, all anchored to detected landmarks
  const chestC = vS + 0.094, chestR = 0.066;
  const absC = (vS + 0.168 + vW) / 2, absR = Math.max(0.070, (vW - (vS + 0.168)) / 2 * 1.30);
  const backC = (vS + 0.030 + vW) / 2, backR = Math.max(0.090, (vW - (vS + 0.030)) / 2 * 1.22);
  const deltC = vS + 0.040, deltR = 0.070;
  // The posterior figure carries its shoulder shelf higher, so the same offset
  // lands the arm band on the elbow instead of the triceps belly — nudge it up.
  const armC = vS + (view === 'back' ? 0.126 : 0.148), armR = 0.090;
  const armGroup = view === 'front' ? 'biceps' : 'triceps';
  /** Vertical profile of the upper-arm band, shared by merged and detached rows. */
  const vArm = vy => 1 - ss(0.52, 1.0, Math.abs(vy - armC) / armR);
  const legC = vSB + (1.0 - vSB) * 0.36, legR = (1.0 - vSB) * 0.74;

  for (let y = top; y <= L.bot; y++) {
    const c = classify(b, y, L), vy = v(y);

    if (c.torso) {
      const [a, z] = c.torso, cxr = (a + z) / 2, half = Math.max(1, (z - a) / 2);
      for (let x = a; x <= z; x++) {
        const u = (x - cxr) / half;
        if (view === 'front') {
          put('chest', x, y, Math.max(lobe(u, vy, -0.48, chestC, 0.52, chestR),
                                      lobe(u, vy,  0.48, chestC, 0.52, chestR)));
          put('abs', x, y, lobe(u, vy, 0, absC, 0.62, absR));
        } else {
          put('back', x, y, lobe(u, vy, 0, backC, 1.02, backR));
        }
        // deltoid caps ride the outer edge of the shoulder shelf
        put('shoulders', x, y, Math.max(lobe(u, vy, -0.92, deltC, 0.42, deltR),
                                        lobe(u, vy,  0.92, deltC, 0.42, deltR)));
        // The upper arm is NOT a separate run for much of its length: the arms
        // only detach from the torso run below armSplit, which on these figures
        // is BELOW the biceps/triceps belly. Painting the arm groups only on
        // detached runs clipped them to a thin stripe across the elbow. So on
        // merged rows the outer margin of the torso run is treated as arm.
        put(armGroup, x, y, vArm(vy) * ss(0.70, 0.93, Math.abs(u)));
      }
    }
    for (const r of c.arms) {
      const [a, z] = r, cxr = (a + z) / 2, half = Math.max(1, (z - a) / 2);
      for (let x = a; x <= z; x++) {
        const u = (x - cxr) / half;
        put('shoulders', x, y, lobe(u, vy, 0, deltC, 1.35, deltR));
        put(armGroup, x, y, vArm(vy) * (1 - ss(0.80, 1.06, Math.abs(u))));
      }
    }
    for (const r of c.legs) {
      const [a, z] = r, cxr = (a + z) / 2, half = Math.max(1, (z - a) / 2);
      for (let x = a; x <= z; x++) {
        const u = (x - cxr) / half;
        // ease in below the hem so the glow doesn't start on a straight line
        put('legs', x, y, lobe(u, vy, 0, legC, 1.45, legR) * ss(vSB - 0.004, vSB + 0.052, vy));
      }
    }
  }
  return { G, L };
}

// ----------------------------------------------------------------- highlight
// Rust brand: bg #0A0C0F, gold/bronze gradient #D4A55A -> #B8853E (src/app.css).
const PRIMARY = [236, 124, 44];    // hot rust orange — the worked group
const SECONDARY = [184, 133, 62];  // Rust bronze — assisting groups
const CARD_BG = [10, 12, 15];      // #0A0C0F, the card background

/**
 * Flatten the render's matte onto the card background.
 *
 * The renders sit on their own near-black, which is not exactly the card colour,
 * so dropping one onto the card unflattened leaves a visible rectangle. Doing it
 * here rather than with a CSS blend mode matters: `screen` washes the highlight
 * out against the pale figure, and `lighten` clips the accent's blue channel and
 * turns the orange white. With the matte baked in, the card needs no blend mode
 * at all and the highlight keeps its colour.
 */
function flattenBg(rgb) {
  const out = Buffer.from(rgb);
  for (let i = 0; i < W * H; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const lum = r * 0.30 + g * 0.59 + b * 0.11;
    if (lum >= T) continue;
    // fade the last few levels so the silhouette edge stays anti-aliased
    const k = Math.max(0, Math.min(1, lum / T));
    for (let c = 0; c < 3; c++) {
      const p = i * 3 + c;
      out[p] = Math.round(CARD_BG[c] * (1 - k) + rgb[p] * k);
    }
  }
  return out;
}

/**
 * Tint the accent in, scaled by the base image's local luminance, then bloom the
 * brightest part of each muscle belly. Both terms are driven by the render's own
 * shading, so grooves and fabric stay dark for free.
 */
function highlight(baseRgb, G, primary, secondary, phase = 1) {
  const out = Buffer.from(baseRgb);
  const layers = [];
  primary.forEach(k => { if (G[k]) layers.push([G[k], PRIMARY, 0.92 * (0.70 + 0.30 * phase)]); });
  secondary.forEach(k => { if (G[k]) layers.push([G[k], SECONDARY, 0.50 * (0.70 + 0.30 * phase)]); });

  for (const [m, c, s] of layers) {
    for (let i = 0; i < W * H; i++) {
      const w = m[i];
      if (w < 0.004) continue;
      const lum = (baseRgb[i * 3] * 0.30 + baseRgb[i * 3 + 1] * 0.59 + baseRgb[i * 3 + 2] * 0.11) / 255;
      const a = w * s;
      const t = Math.min(1.18, lum * 1.42);
      const bloom = Math.pow(lum, 3.2) * 0.42 * w * s;
      for (let k = 0; k < 3; k++) {
        const p = i * 3 + k;
        out[p] = Math.min(255, Math.round(baseRgb[p] * (1 - a) + c[k] * t * a + c[k] * bloom));
      }
    }
  }
  return out;
}

module.exports = {
  W, H, T, FF, LIFTABLE, VIEW_GROUPS, PRIMARY, SECONDARY,
  toGray, toRgb, writeRgb, writeRgba, bodyMask, landmarks, classify, merged, buildRegions, highlight, flattenBg, CARD_BG,
};
