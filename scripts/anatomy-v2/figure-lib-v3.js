'use strict';
/**
 * scripts/anatomy-v2/figure-lib-v3.js — SPECIFIC-muscle region mapping and
 * highlight compositing for the Rust anatomy figures in Media/anatomy-v2/base/.
 *
 * WHAT CHANGED FROM v2 (figure-lib.js, still present and still used by the v2
 * generator)
 * v2 lit one of 7 coarse lobes: chest / back / shoulders / legs / biceps /
 * triceps / abs. That meant a shrug and a lat pulldown produced an identical
 * image, which is wrong to anyone who lifts. v3 lights 20 specific muscles:
 *
 *   upper_chest mid_chest lower_chest  front_delts side_delts rear_delts
 *   traps rhomboids lats lower_back    biceps triceps forearms
 *   upper_abs lower_abs obliques       quads hamstrings glutes calves
 *
 * HOW THE REGIONS ARE DERIVED
 * Still from each render's own silhouette, not hand-drawn coordinates — a
 * hand-authored mask never sits on the render's anatomy and drifts the moment a
 * base image is re-rolled. The pipeline is:
 *
 *   1. NORMALISE. Each base render is resampled so the silhouette occupies an
 *      identical band of the frame and is centred on the same x. The four
 *      renders came out of ideogram at noticeably different scales — measured
 *      silhouette heights were 1162 / 1125 / 1059 / 1148 px, i.e. the female
 *      front figure was 9% shorter than the male and sat 40px lower — so a male
 *      card and a female card did not read as the same scale, and even the
 *      front/back pair inside one female card didn't match. Normalising is
 *      free and fixes both.
 *   2. LANDMARKS. Row run-length decomposition gives ARMS | TORSO | ARMS and
 *      LEG | LEG. From that: shoulder shelf, deltoid apex, armpit, waist,
 *      clothing band (waistband + hem), hip, crotch, knee, ankle, and — new in
 *      v3 — elbow and wrist, found from the arm's own width profile (the upper
 *      arm is a plateau, the forearm is a taper; the elbow is where the plateau
 *      ends).
 *   3. LOBES. Each muscle is one or more soft ellipses in (u, v) where u is the
 *      normalised position ACROSS the body at that row and v is the position
 *      along a landmark-anchored band. Because u is per-row, a region follows
 *      the silhouette and can never read as a rectangle.
 *   4. HAND-TUNING. The lobe constants below are tuned against a rendered debug
 *      atlas (scripts/anatomy-v2/debug-atlas.js) on all four figures, because
 *      derivation alone puts
 *      several of them in the wrong place — the pecs in particular, which no
 *      silhouette landmark distinguishes from the ribcage. Accuracy beats
 *      elegance: a highlight on the wrong muscle is worse than a coarse one.
 *
 * THE CLOTHING PROBLEM (this is why glutes work at all)
 * v2 multiplied the tint through the base image's luminance so grooves stayed
 * dark. That is right for skin and wrong for fabric: the shorts sit at luma
 * 48-92, so anything under them stayed black. Two visible consequences —
 *   - the leg highlight began on a hard horizontal line exactly at the shorts
 *     hem, which is the single most obvious flaw in the v2 cards, and
 *   - the glutes, which on these figures are ENTIRELY under fabric, could not
 *     be lit at all.
 * v3 detects the clothing pixels (inside the body mask, darker than skin ever
 * gets) and LIFTS their luminance affinely — raising the level while preserving
 * the fabric's own fold shading, because clamping them all to one floor renders
 * the glutes as a flat orange garment. A region that passes under the waistband
 * therefore keeps glowing through it at reduced intensity. The quad glow now
 * starts at the hip crease and is already at full strength by the hem instead of
 * switching on at it, and glutes are a real region.
 *
 * Toolchain is only what this box already has: the static ffmpeg at
 * ~/.local/bin/ffmpeg for PNG<->raw, and plain JS. No PIL/pip, and this ffmpeg
 * has no drawtext, which is why pixels are composited here and all typography
 * goes through Chromium (see generate-anatomy-v3.js).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FF = process.env.FFMPEG_BIN || path.join(os.homedir(), '.local', 'bin', 'ffmpeg');
const W = 832, H = 1248;   // native size of the ideogram/v3 renders
const T = 38;              // silhouette threshold: background is pure black
const CLOTH_MAX = 104;     // inside the body, below this luma is fabric, not skin

// Normalisation target: where the silhouette is forced to sit in the frame.
const NORM_TOP = Math.round(H * 0.038);
const NORM_BOT = Math.round(H * 0.962);
const NORM_CX = Math.round(W * 0.5);

/* ------------------------------------------------------------------ vocabulary */

/** The 20 muscles that have a real region on the figure. */
const MUSCLES = [
  'upper_chest', 'mid_chest', 'lower_chest',
  'front_delts', 'side_delts', 'rear_delts',
  'traps', 'rhomboids', 'lats', 'lower_back',
  'biceps', 'triceps', 'forearms',
  'upper_abs', 'lower_abs', 'obliques',
  'quads', 'hamstrings', 'glutes', 'calves',
];

/** Which muscles are visible on which view. A muscle absent here is simply not
 *  painted on that view — e.g. the hamstrings do not show from the front. */
const VIEW_MUSCLES = {
  front: ['traps', 'front_delts', 'side_delts', 'upper_chest', 'mid_chest', 'lower_chest',
          'lats', 'biceps', 'forearms', 'upper_abs', 'lower_abs', 'obliques', 'quads', 'calves'],
  back:  ['traps', 'rhomboids', 'rear_delts', 'side_delts', 'lats', 'lower_back',
          'triceps', 'forearms', 'glutes', 'hamstrings', 'calves'],
};

/**
 * Muscles the mapping is allowed to name that have no dedicated region, mapped
 * onto the anatomically adjacent one that does. These are real muscles — the
 * figure just can't resolve them — so the honest move is to light the nearest
 * true neighbour rather than drop the exercise's primary mover on the floor.
 */
const RENDER_FALLBACK = {
  adductors: 'quads',        // inner thigh reads as upper-thigh on a front view
  abductors: 'glutes',       // glute medius IS the abductor
  hip_flexors: 'lower_abs',
  serratus: 'obliques',      // adjacent, same lateral ribcage band
  rotator_cuff: 'rear_delts',
  neck: 'traps',
  tibialis: 'calves',        // same segment, opposite face
  grip: 'forearms',
};

const resolveMuscle = m => RENDER_FALLBACK[m] || m;

/* ------------------------------------------------------------------- pixel I/O */

const clamp01 = x => Math.max(0, Math.min(1, x));
const ss = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
/** Soft-edged ellipse in normalised (u,v). Long falloff => no straight edges. */
const lobe = (u, v, uc, vc, ru, rv) =>
  1 - ss(0.50, 1.0, Math.sqrt(((u - uc) / ru) ** 2 + ((v - vc) / rv) ** 2));

function rawFrom(file, pixFmt, bpp) {
  const t = `${path.join(os.tmpdir(), path.basename(file))}.${process.pid}.${pixFmt}`;
  execFileSync(FF, ['-y', '-i', file, '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', pixFmt, t], { stdio: 'ignore' });
  const b = fs.readFileSync(t); fs.unlinkSync(t);
  if (b.length !== W * H * bpp) throw new Error(`unexpected raw size for ${file}`);
  return b;
}
const toGray = f => rawFrom(f, 'gray', 1);
const toRgb = f => rawFrom(f, 'rgb24', 3);

function writeRaw(buf, out, pixFmt) {
  const t = `${out}.${process.pid}.${pixFmt}`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(t, buf);
  execFileSync(FF, ['-y', '-f', 'rawvideo', '-pix_fmt', pixFmt, '-s', `${W}x${H}`, '-i', t, out], { stdio: 'ignore' });
  fs.unlinkSync(t);
}

/* ----------------------------------------------------------------- body mask */

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
 * far wider and survive untouched. r is deliberately small: r=16 closes every
 * fabric hole but also webs the hands to the hips.
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

  /**
   * Second flood-fill, and it is not redundant. Opening deletes the thin channel
   * that connected a leak to the border, which leaves the rest of that leak as
   * an ISLAND of background stranded inside the shorts. v2 shipped with those
   * islands: on male-back they punched holes through the fabric that split the
   * torso run into three, so the row decomposition handed two of the three
   * pieces to the arms and the glute region came out in blocks. Keeping only the
   * border-connected component of the opened background closes every hole by
   * construction.
   */
  const keep = new Uint8Array(W * H);
  const st2 = [];
  for (let x = 0; x < W; x++) { st2.push(x); st2.push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { st2.push(y * W); st2.push(y * W + W - 1); }
  while (st2.length) {
    const i = st2.pop();
    if (keep[i] || !opened[i]) continue;
    keep[i] = 1;
    const x = i % W, y = (i / W) | 0;
    if (x > 0) st2.push(i - 1);
    if (x < W - 1) st2.push(i + 1);
    if (y > 0) st2.push(i - W);
    if (y < H - 1) st2.push(i + W);
  }
  const body = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) body[i] = keep[i] ? 0 : 255;
  return body;
}

/**
 * Clothing mask: inside the body, but darker than skin ever gets. Used to give
 * fabric a luminance floor so a muscle region can glow THROUGH the shorts —
 * without it the glutes are unlightable and the quads switch on at the hem.
 */
function clothMask(gray, body) {
  const c = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (body[i] && gray[i] < CLOTH_MAX) c[i] = 255;
  return c;
}

/* ----------------------------------------------------- silhouette decomposition */

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
function merged(b, y, gap = 16) {
  const o = [];
  for (const r of runsAt(b, y)) {
    if (o.length && r[0] - o[o.length - 1][1] <= gap) o[o.length - 1][1] = r[1];
    else o.push([r[0], r[1]]);
  }
  return o.filter(a => a[1] - a[0] >= 8);
}

/** Median of a row segment, ignoring background. */
function medianLuma(b, y, a, z, floor = T) {
  const v = [];
  for (let x = a; x <= z; x++) { const q = b[y * W + x]; if (q >= floor) v.push(q); }
  if (!v.length) return 0;
  v.sort((p, q) => p - q);
  return v[v.length >> 1];
}

const smooth = (arr, r) => arr.map((_, i) => {
  let s = 0, n = 0;
  for (let k = -r; k <= r; k++) { const j = i + k; if (j >= 0 && j < arr.length) { s += arr[j]; n++; } }
  return s / n;
});

/* ------------------------------------------------------------------ normalise */

/**
 * Resample so the silhouette occupies [NORM_TOP, NORM_BOT] and is centred on
 * NORM_CX. Uniform scale — the figures must not be stretched — with bilinear
 * sampling so the anti-aliased silhouette edge survives.
 *
 * Centring uses the SHOULDER centroid rather than the bounding-box centre: the
 * bounding box on these renders is set by the hands, which hang at slightly
 * different angles per figure and would shift the torso off-axis.
 */
function normalize(gray, rgb) {
  let top = -1, bot = -1;
  for (let y = 0; y < H; y++) if (merged(gray, y).length) { if (top < 0) top = y; bot = y; }
  const width = y => { const m = merged(gray, y); return m.length ? m[m.length - 1][1] - m[0][0] : 0; };
  let headMax = 0;
  for (let y = top; y < top + Math.round((bot - top) * 0.14); y++) headMax = Math.max(headMax, width(y));
  let shoulderTop = top;
  for (let y = top; y < bot; y++) if (width(y) > headMax * 1.5) { shoulderTop = y; break; }
  let sx = 0, n = 0;
  for (let y = shoulderTop; y < shoulderTop + 40 && y < bot; y++) {
    const m = merged(gray, y); if (m.length) { sx += (m[0][0] + m[m.length - 1][1]) / 2; n++; }
  }
  const cx = n ? sx / n : W / 2;

  const s = (NORM_BOT - NORM_TOP) / (bot - top);
  if (Math.abs(s - 1) < 0.002 && Math.abs(cx - NORM_CX) < 1 && Math.abs(top - NORM_TOP) < 1) {
    return { gray, rgb, scale: 1 };
  }

  const og = new Uint8Array(W * H);
  const orgb = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    const sy = top + (y - NORM_TOP) / s;
    const y0 = Math.floor(sy), fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sxx = cx + (x - NORM_CX) / s;
      const x0 = Math.floor(sxx), fx = sxx - x0;
      if (y0 < 0 || y0 >= H - 1 || x0 < 0 || x0 >= W - 1) continue;
      const i00 = y0 * W + x0, i01 = i00 + 1, i10 = i00 + W, i11 = i10 + 1;
      const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
      og[y * W + x] = Math.round(gray[i00] * w00 + gray[i01] * w01 + gray[i10] * w10 + gray[i11] * w11);
      for (let c = 0; c < 3; c++) {
        orgb[(y * W + x) * 3 + c] = Math.round(
          rgb[i00 * 3 + c] * w00 + rgb[i01 * 3 + c] * w01 + rgb[i10 * 3 + c] * w10 + rgb[i11 * 3 + c] * w11);
      }
    }
  }
  return { gray: og, rgb: orgb, scale: s };
}

/* ------------------------------------------------------------------ landmarks */

/**
 * `b` is the BODY MASK (0/255), not the raw gray. Run decomposition has to come
 * from the mask: the charcoal shorts dip to luma 0-3, so a luma threshold
 * fragments every row that crosses fabric and the per-row run centre jumps
 * around — which showed up as blocky horizontal steps along the glute and quad
 * regions. `gray` is still needed for the one test that is genuinely about
 * brightness: telling fabric from skin.
 */
function landmarks(b, gray) {
  gray = gray || b;
  let top = -1, bot = -1;
  for (let y = 0; y < H; y++) if (merged(b, y).length) { if (top < 0) top = y; bot = y; }
  const width = y => { const m = merged(b, y); return m.length ? m[m.length - 1][1] - m[0][0] : 0; };

  // shoulder shelf = first row appreciably wider than the head
  let headMax = 0;
  for (let y = top; y < top + Math.round((bot - top) * 0.14); y++) headMax = Math.max(headMax, width(y));
  let shoulderTop = top;
  for (let y = top; y < bot; y++) if (width(y) > headMax * 1.5) { shoulderTop = y; break; }

  const cx = NORM_CX;

  // armpit = first row where the arms become their own runs
  let armSplit = -1;
  for (let y = shoulderTop; y < bot; y++) if (merged(b, y).length >= 3) { armSplit = y; break; }
  if (armSplit < 0) armSplit = shoulderTop + Math.round((bot - top) * 0.16);

  // Deltoid apex. NOT the widest row: with the arms hanging the total span keeps
  // growing well past the shoulder, so a max-width search lands at the hands.
  // The acromion is shoulderTop and the axilla is armSplit, and the deltoid
  // belly sits about a third of the way down between them.
  const deltY = Math.round(shoulderTop + 0.34 * (armSplit - shoulderTop));

  // ---- clothing band (waistband + hem) -------------------------------------
  // Fabric is far darker than skin. Find the longest dark-median torso run in
  // the lower half of the torso; that is the shorts.
  const clothed = [];
  for (let y = top; y <= bot; y++) {
    const m = merged(b, y);
    if (!m.length) { clothed.push(false); continue; }
    let ti = 0, best = 1e9;
    m.forEach((r, i) => {
      const d = (r[0] <= cx && r[1] >= cx) ? 0 : Math.min(Math.abs(r[0] - cx), Math.abs(r[1] - cx));
      if (d < best) { best = d; ti = i; }
    });
    clothed.push(medianLuma(gray, y, m[ti][0], m[ti][1], 1) < 92);
  }
  let bestRun = [0, -1], cur = -1;
  for (let i = 0; i < clothed.length; i++) {
    const y = top + i;
    if (clothed[i] && y > shoulderTop + (bot - shoulderTop) * 0.25) { if (cur < 0) cur = y; }
    else if (cur >= 0) { if (y - cur > bestRun[1] - bestRun[0]) bestRun = [cur, y - 1]; cur = -1; }
  }
  if (cur >= 0 && bot - cur > bestRun[1] - bestRun[0]) bestRun = [cur, bot];
  const hasShorts = bestRun[1] > bestRun[0];
  const shortsTop = hasShorts ? bestRun[0] : top + Math.round((bot - top) * 0.47);
  const shortsBottom = hasShorts ? bestRun[1] : top + Math.round((bot - top) * 0.62);

  // Waist = narrowest torso row. The search window is clamped well inside the
  // axilla->waistband span: immediately below the armpit the torso run is the
  // bare ribcage and is narrower than the true waist, so an unclamped search
  // just returns its own lower bound (measured: it put the male-front waist at
  // y=473, 54px below the armpit, which then collapsed S2 and dragged the abs,
  // obliques and lats up with it).
  const wLo = armSplit + Math.round((shortsTop - armSplit) * 0.45);
  const wHi = shortsTop - Math.round((shortsTop - armSplit) * 0.12);
  const wProf = [];
  for (let y = wLo; y <= wHi; y++) {
    const m = merged(b, y);
    if (!m.length) { wProf.push(1e9); continue; }
    let ti = 0, best = 1e9;
    m.forEach((r, i) => {
      const d = (r[0] <= cx && r[1] >= cx) ? 0 : Math.min(Math.abs(r[0] - cx), Math.abs(r[1] - cx));
      if (d < best) { best = d; ti = i; }
    });
    wProf.push(m[ti][1] - m[ti][0]);
  }
  // These figures do not have a pinched waist — the torso run is FLAT to within
  // a couple of px over a 70px plateau (measured on male-front: 188-191 from
  // y=474 to y=544). A plain argmin therefore returns whichever tied row comes
  // first, which is the top of the plateau, not the waist. Take the centroid of
  // the plateau instead.
  const minW = Math.min(...wProf);
  let ws = 0, wn = 0;
  wProf.forEach((w, i) => { if (w <= minW * 1.02) { ws += wLo + i; wn++; } });
  const waistY = wn ? Math.round(ws / wn) : Math.round((wLo + wHi) / 2);

  // ---- legs ---------------------------------------------------------------
  // crotch: the first row below the waistband where two roughly symmetric runs
  // straddle the centreline with a real gap. Searched from shortsTop so the
  // shorts' own centre seam (which sits at about crotch height anyway) can only
  // ever be a few px off, never a gross error.
  let legSplit = -1;
  for (let y = shortsTop; y < bot; y++) {
    const m = merged(b, y); if (m.length !== 2) continue;
    const gL = m[0][1], gR = m[1][0];
    if (gR - gL > 18 && gL < cx && gR > cx) { legSplit = y; break; }
  }
  if (legSplit < 0) legSplit = shortsBottom;

  // per-row single-leg width below the crotch
  const legStart = Math.max(legSplit, shortsBottom);
  const legW = [];
  for (let y = legStart; y <= bot; y++) {
    const m = merged(b, y).filter(r => r[1] - r[0] >= 10);
    const two = m.map(r => ({ r, d: Math.abs((r[0] + r[1]) / 2 - cx) })).sort((a, c) => a.d - c.d).slice(0, 2);
    legW.push(two.length ? two.reduce((s, o) => s + (o.r[1] - o.r[0]), 0) / two.length : 0);
  }
  const sw = smooth(legW, 11);
  const span = bot - legStart;
  /**
   * The knee is NOT the narrowest point of the leg — the shin is narrower. It is
   * the FIRST LOCAL MINIMUM: the thigh tapers into it, the calf belly swells
   * below it, the shin tapers again to the ankle. A plain argmin over the upper
   * leg lands on the shin whenever the search window reaches it (measured: it
   * put the male-front "knee" at y=1020, 125px into the shin).
   *
   * hyst is a relative rise required before a dip is accepted as a real turning
   * point, so render noise in the taper cannot trip it.
   */
  const nextMin = (from, hyst = 0.05) => {
    let bi = from, bv = sw[from] != null ? sw[from] : 1e9;
    for (let i = from; i < sw.length; i++) {
      if (sw[i] < bv) { bv = sw[i]; bi = i; }
      else if (sw[i] > bv * (1 + hyst)) return bi;
    }
    return bi;
  };
  const nextMax = (from, hyst = 0.05) => {
    let bi = from, bv = sw[from] != null ? sw[from] : 0;
    for (let i = from; i < sw.length; i++) {
      if (sw[i] > bv) { bv = sw[i]; bi = i; }
      else if (sw[i] < bv * (1 - hyst)) return bi;
    }
    return bi;
  };
  const kneeI = nextMin(Math.round(span * 0.08));
  const calfI = nextMax(kneeI + 4);
  // stop short of the foot flare — the ankle is the last true minimum above it
  const ankleI = Math.min(nextMin(calfI + 4), Math.round(span * 0.94));
  const kneeY = legStart + kneeI;
  const ankleY = legStart + Math.max(ankleI, kneeI + Math.round(span * 0.25));

  // hip: widest row between the waist and the hem (glute/hip shelf)
  let hipY = shortsTop, hipW = 0;
  for (let y = waistY; y <= Math.min(legSplit, shortsBottom); y++) {
    const w = width(y); if (w > hipW) { hipW = w; hipY = y; }
  }

  // ---- arms ---------------------------------------------------------------
  // Track the outermost run on each side while the arms are detached. The upper
  // arm is a width PLATEAU and the forearm is a monotone taper, so the elbow is
  // where the plateau ends; the wrist is the minimum below it, before the hand
  // flares back out.
  const armRows = [], armWid = [];
  for (let y = armSplit; y <= bot; y++) {
    const m = merged(b, y);
    if (m.length < 3) { if (armRows.length) break; else continue; }
    const l = m[0], r = m[m.length - 1];
    armRows.push(y); armWid.push(((l[1] - l[0]) + (r[1] - r[0])) / 2);
  }
  let elbowY, wristY, armEnd;
  if (armRows.length > 30) {
    const aw = smooth(armWid, 7);
    armEnd = armRows[armRows.length - 1];
    const plateau = aw.slice(0, Math.max(4, Math.round(aw.length * 0.22)))
      .reduce((s, v) => s + v, 0) / Math.max(4, Math.round(aw.length * 0.22));
    let ei = aw.length - 1;
    for (let i = 0; i < aw.length; i++) if (aw[i] < plateau * 0.86) { ei = i; break; }
    elbowY = armRows[ei];
    let wi = ei, wv = 1e9;
    for (let i = ei; i < aw.length; i++) { if (aw[i] < wv) { wv = aw[i]; wi = i; } else if (aw[i] > wv * 1.18) break; }
    wristY = armRows[wi];
  } else {
    armEnd = shortsTop;
    elbowY = armSplit + Math.round((bot - top) * 0.10);
    wristY = armSplit + Math.round((bot - top) * 0.19);
  }

  // Reference spans for the torso-core interpolation in classify(): the full
  // shoulder shelf at the deltoid apex, and the arms-excluded ribcage just below
  // the axilla where the runs are unambiguous.
  const spanAt = y => {
    const m = merged(b, y);
    if (!m.length) return null;
    let ti = 0, best = 1e9;
    m.forEach((r, i) => {
      const d = (r[0] <= cx && r[1] >= cx) ? 0 : Math.min(Math.abs(r[0] - cx), Math.abs(r[1] - cx));
      if (d < best) { best = d; ti = i; }
    });
    return [m[ti][0], m[ti][1]];
  };
  const _coreTop = spanAt(deltY);
  let _coreBot = null;
  for (let y = armSplit + 2; y < armSplit + 40 && y < bot; y++) {
    if (merged(b, y).length >= 3) { _coreBot = spanAt(y); break; }
  }

  return {
    top, bot, h: bot - top, cx,
    shoulderTop, deltY, armSplit, elbowY, wristY, armEnd,
    waistY, shortsTop, shortsBottom, hipY, legSplit, kneeY, ankleY,
    _coreTop, _coreBot,
  };
}

/**
 * Split a row's runs into torso / arms / legs.
 *
 * `core` is the torso WITHOUT the arms, and it is not the same thing as `torso`.
 * Above the axilla the arms hang close enough that the dark gap between arm and
 * ribcage is under the seam-merge threshold, so the run decomposition hands back
 * one wide run that silently includes both upper arms. Any lobe placed near
 * u = ±1 of that run — lats, obliques, the outer pec — then lands on the arm
 * instead of the torso, which showed up as an orange band straight across both
 * upper arms on every lat-primary card.
 *
 * So between the deltoid apex and the axilla, the torso's own edges are linearly
 * interpolated between the row at deltY (where the run legitimately IS the
 * shoulder shelf) and the row at armSplit (where the arms are cleanly separate
 * and the run is genuinely just the ribcage). `torso` keeps the raw run, because
 * the upper-arm band is painted on its outer margin and needs the real outline.
 */
function classify(b, y, L) {
  const m = merged(b, y);
  if (!m.length) return { arms: [], legs: [] };
  if (y >= L.legSplit) {
    const s = m.map(r => ({ r, d: Math.abs((r[0] + r[1]) / 2 - L.cx) })).sort((a, c) => a.d - c.d);
    // below the crotch the two runs nearest the centreline are the legs; any
    // remaining outer runs are still the hands
    return { arms: s.slice(2).map(o => o.r), legs: s.slice(0, 2).map(o => o.r) };
  }
  let ti = 0, best = 1e9;
  m.forEach((r, i) => {
    const d = (r[0] <= L.cx && r[1] >= L.cx) ? 0 : Math.min(Math.abs(r[0] - L.cx), Math.abs(r[1] - L.cx));
    if (d < best) { best = d; ti = i; }
  });
  const torso = m[ti];
  let core = torso;
  if (y > L.deltY && y < L.armSplit && L._coreTop && L._coreBot) {
    const k = clamp01((y - L.deltY) / Math.max(1, L.armSplit - L.deltY));
    core = [Math.round(L._coreTop[0] + (L._coreBot[0] - L._coreTop[0]) * k),
            Math.round(L._coreTop[1] + (L._coreBot[1] - L._coreTop[1]) * k)];
    // never widen past the real silhouette
    core = [Math.max(core[0], torso[0]), Math.min(core[1], torso[1])];
    if (core[1] - core[0] < 20) core = torso;
  }
  return { torso, core, arms: m.filter((_, i) => i !== ti), legs: [] };
}

/* -------------------------------------------------------------- the regions */

/**
 * Build one Float32Array weight map per visible muscle.
 *
 * Vertical placement is expressed in TORSO UNITS: t = (y - shoulderTop) / S
 * where S = waistY - shoulderTop. Every torso constant below is therefore a
 * fraction of the shoulder-to-waist span and transfers between figures of
 * different proportions, which the four renders genuinely are.
 *
 * Horizontal placement is u = (x - runCentre) / runHalfWidth, computed PER ROW,
 * so a lobe hugs the silhouette at whatever width the body happens to be there.
 */
function buildRegions(gray, view, body) {
  const b = body || gray, L = landmarks(b, gray);
  // Three torso spans every constant below is expressed against. All three are
  // detected, so the constants are proportions of real anatomy rather than of
  // the frame, and transfer between figures with different builds.
  const S1 = Math.max(20, L.armSplit - L.shoulderTop);   // acromion -> axilla
  const S2 = Math.max(20, L.waistY - L.armSplit);        // axilla -> waist
  const S3 = Math.max(10, L.shortsTop - L.waistY);       // waist -> waistband

  /** Ellipse with a PIXEL vertical radius, so it can be anchored to landmarks. */
  const yl = (u, y, uc, yc, ru, ry) =>
    1 - ss(0.50, 1.0, Math.sqrt(((u - uc) / ru) ** 2 + ((y - yc) / ry) ** 2));
  const pair = (u, y, uc, yc, ru, ry) => Math.max(yl(u, y, -uc, yc, ru, ry), yl(u, y, uc, yc, ru, ry));

  // ---- anterior anchors ----------------------------------------------------
  // The pec mass runs from just under the clavicle to a little past the axilla.
  const pecTop = L.shoulderTop + 0.42 * S1, pecBot = L.armSplit + 0.14 * S2;
  const P = pecBot - pecTop;
  // ---- posterior anchors ---------------------------------------------------
  // Interscapular block, and the lat sweep from the axilla into the waist.
  const rhomTop = L.shoulderTop + 0.50 * S1, rhomBot = L.armSplit + 0.35 * S2;
  const latTop = L.armSplit - 0.20 * S1, latBot = L.waistY + 0.55 * S2;

  const G = {};
  VIEW_MUSCLES[view].forEach(k => { G[k] = new Float32Array(W * H); });
  const put = (k, x, y, w) => {
    if (w <= 0.004 || !G[k]) return;
    const i = y * W + x;
    if (b[i] > T && w > G[k][i]) G[k][i] = Math.min(1, w);
  };

  // ---- arm segment helper --------------------------------------------------
  // Upper arm = armpit..elbow, forearm = elbow..wrist, both faded at the joints
  // so no band starts on a hard line.
  const upperArmBand = y => ss(L.armSplit - 0.34 * S1, L.armSplit + (L.elbowY - L.armSplit) * 0.16, y)
                          * (1 - ss(L.elbowY - (L.elbowY - L.armSplit) * 0.16, L.elbowY + (L.wristY - L.elbowY) * 0.24, y));
  const forearmBand = y => ss(L.elbowY - (L.elbowY - L.armSplit) * 0.14, L.elbowY + (L.wristY - L.elbowY) * 0.30, y)
                         * (1 - ss(L.wristY - (L.wristY - L.elbowY) * 0.16, L.wristY + (L.wristY - L.elbowY) * 0.22, y));

  // ---- leg segment helper --------------------------------------------------
  // THE HEM LINE. In v2 the leg region was painted only on detached LEG runs,
  // which do not exist above the crotch, so the glow necessarily began on a hard
  // horizontal line at the shorts hem — the most obvious flaw in those cards.
  // Here the thigh bands are also painted on the torso run between the waistband
  // and the crotch (split left/right at u=0), and the fade-in is anchored to the
  // HIP CREASE, well above the hem. Combined with the cloth luminance floor in
  // highlight(), the glow now rises through the fabric and is already at full
  // strength by the time it reaches the hem, so there is no edge to see.
  const thighBot = L.kneeY;
  const thighTop = L.shortsTop + 0.55 * (L.legSplit - L.shortsTop);
  // Fade in from roughly a third of the way down the shorts (the hip crease),
  // not from the waistband: starting at the waistband lights the pelvis and the
  // whole garment reads as the muscle. Fade out AT the knee, not above it — the
  // male figure's shorts are long enough that only ~90px of bare thigh shows,
  // and starting the falloff early wastes most of it.
  const thighBand = y => ss(L.shortsTop + 0.30 * (L.legSplit - L.shortsTop), thighTop + 0.25 * (thighBot - thighTop), y)
                       * (1 - ss(thighBot - (thighBot - thighTop) * 0.06, thighBot + (L.ankleY - thighBot) * 0.28, y));
  const calfBand = y => ss(thighBot - (thighBot - thighTop) * 0.10, thighBot + (L.ankleY - thighBot) * 0.26, y)
                      * (1 - ss(L.ankleY - (L.ankleY - thighBot) * 0.30, L.ankleY + (L.bot - L.ankleY) * 0.35, y));
  // Glutes: iliac crest (the waistband) down to the gluteal fold. Entirely under
  // fabric on all four figures — see the cloth floor in highlight(). The fold is
  // anchored as a fraction of waistband-to-knee because the detected crotch row
  // is not comparable between views (the anterior figures split at the shorts'
  // centre seam, the posterior ones only where the legs actually part).
  const gluteTop = L.shortsTop - 0.25 * S3;
  const gluteBot = L.shortsTop + 0.46 * (thighBot - L.shortsTop);
  const gluteBand = y => ss(gluteTop - 0.45 * S3, gluteTop + (gluteBot - gluteTop) * 0.26, y)
                       * (1 - ss(gluteBot - (gluteBot - gluteTop) * 0.24, gluteBot + (thighBot - gluteBot) * 0.30, y));
  const hamBand = y => ss(gluteBot - (gluteBot - gluteTop) * 0.26, gluteBot + (thighBot - gluteBot) * 0.30, y)
                     * (1 - ss(thighBot - (thighBot - gluteBot) * 0.08, thighBot + (L.ankleY - thighBot) * 0.26, y));
  /** Left/right halves of the torso run, used for the hip block above the crotch. */
  const legLobe = u => Math.max(1 - ss(0.50, 1.0, Math.abs(u + 0.52) / 0.60),
                                1 - ss(0.50, 1.0, Math.abs(u - 0.52) / 0.60));

  for (let y = L.top; y <= L.bot; y++) {
    const c = classify(b, y, L);

    // ------------------------------------------------------------- torso run
    if (c.torso) {
      const [a, z] = c.torso, rc = (a + z) / 2, half = Math.max(1, (z - a) / 2);
      const [ca, cz] = c.core || c.torso;
      const crc = (ca + cz) / 2, chalf = Math.max(1, (cz - ca) / 2);
      for (let x = a; x <= z; x++) {
        const u = (x - crc) / chalf;         // torso-relative: used by every muscle lobe
        const ru = (x - rc) / half;          // run-relative: used by the arm margin only
        const au = Math.abs(ru);

        if (view === 'front') {
          // Upper traps read from the front as the slope from the neck out to
          // the shoulder — ABOVE and MEDIAL to the deltoid cap.
          put('traps', x, y, pair(u, y, 0.58, L.shoulderTop + 0.10 * S1, 0.30, 0.24 * S1));
          // Pecs: three bands across the pec mass. Hand-tuned against the debug
          // atlas — no silhouette landmark separates a pec from a rib, so the
          // only honest way to place these is to render them and look.
          put('upper_chest', x, y, pair(u, y, 0.48, pecTop + 0.16 * P, 0.60, 0.34 * P));
          put('mid_chest', x, y, pair(u, y, 0.48, pecTop + 0.52 * P, 0.60, 0.32 * P));
          put('lower_chest', x, y, pair(u, y, 0.48, pecTop + 0.88 * P, 0.56, 0.30 * P));
          // Abs: upper = bottom of the ribcage to the navel, lower = navel down
          // THROUGH the waistband (it genuinely continues under the shorts,
          // which is the other reason the cloth luminance floor exists).
          put('upper_abs', x, y, yl(u, y, 0, L.armSplit + 0.44 * S2, 0.58, 0.44 * S2));
          put('lower_abs', x, y, yl(u, y, 0, L.waistY + 0.40 * S3, 0.54, 0.48 * S2));
          // Obliques: the lateral wall, ribcage bottom to hip.
          put('obliques', x, y, pair(u, y, 0.86, L.armSplit + 0.72 * S2, 0.32, 0.50 * S2));
          // Lats from the front: only the outer flare under the armpit.
          put('lats', x, y, pair(u, y, 1.02, L.armSplit + 0.16 * S2, 0.24, 0.30 * S2));
          // Deltoids ride the outer edge of the shelf. Front vs side is a real
          // distinction even on a 2D front view: the anterior head faces the
          // camera and sits medial, the lateral head is the outer cap.
          put('front_delts', x, y, pair(u, y, 0.78, L.deltY + 0.20 * S1, 0.30, 0.40 * S1));
          put('side_delts', x, y, pair(u, y, 1.02, L.deltY - 0.14 * S1, 0.26, 0.34 * S1));
          // Hip block: the thigh above the crotch, where there is no leg run yet.
          put('quads', x, y, thighBand(y) * legLobe(u));
        } else {
          // Upper traps from behind: the diamond from the base of the skull out
          // to both acromions and down to roughly mid-scapula. One wide central
          // lobe plus a pair riding out along the shelf.
          put('traps', x, y, Math.max(
            yl(u, y, 0, L.shoulderTop + 0.28 * S1, 0.72, 0.40 * S1),
            pair(u, y, 0.62, L.shoulderTop + 0.10 * S1, 0.40, 0.26 * S1)));
          // Rhomboids (+ mid/lower traps, which a lifter reads as the same area):
          // the interscapular block.
          put('rhomboids', x, y, yl(u, y, 0, (rhomTop + rhomBot) / 2, 0.50, 0.60 * (rhomBot - rhomTop)));
          // Lats: a V. Wide at the armpit, narrowing into the waist — a lobe
          // pair whose u-centre migrates inward as y descends.
          const k = clamp01((y - latTop) / Math.max(1, latBot - latTop));
          put('lats', x, y, pair(u, y, 0.88 - 0.46 * k, (latTop + latBot) / 2, 0.48, 0.62 * (latBot - latTop)));
          // Erectors: the two lumbar columns either side of the spine, running
          // down into the waistband.
          put('lower_back', x, y, pair(u, y, 0.24, L.waistY + 0.45 * S3, 0.34, Math.max(0.50 * S2, 0.9 * S3)));
          put('rear_delts', x, y, pair(u, y, 0.88, L.deltY + 0.05 * S1, 0.30, 0.42 * S1));
          put('side_delts', x, y, pair(u, y, 1.06, L.deltY - 0.02 * S1, 0.24, 0.36 * S1));
          // Glutes are entirely under fabric on all four figures. Painted anyway;
          // highlight() gives fabric a luminance floor so they can read.
          put('glutes', x, y, gluteBand(y) * legLobe(u));
          put('hamstrings', x, y, hamBand(y) * legLobe(u));
        }

        // The upper arm is NOT a separate run for much of its length: the arms
        // only detach from the torso run below armSplit, which on these figures
        // is BELOW the biceps/triceps belly. Painting the arm groups only on
        // detached runs clipped them to a thin stripe across the elbow. So on
        // merged rows the outer margin of the torso run is treated as arm.
        const armK = view === 'front' ? 'biceps' : 'triceps';
        put(armK, x, y, upperArmBand(y) * ss(0.72, 0.95, au));
      }
    }

    // -------------------------------------------------------------- arm runs
    for (const r of c.arms) {
      const [a, z] = r, rc = (a + z) / 2, half = Math.max(1, (z - a) / 2);
      for (let x = a; x <= z; x++) {
        const u = (x - rc) / half, au = Math.abs(u);
        const edge = 1 - ss(0.78, 1.06, au);
        if (view === 'front') {
          put('front_delts', x, y, yl(u, y, 0, L.deltY + 0.04 * S1, 1.30, 0.46 * S1) * 0.85);
          put('side_delts', x, y, yl(u, y, 0, L.deltY - 0.02 * S1, 1.30, 0.40 * S1));
          put('biceps', x, y, upperArmBand(y) * edge);
        } else {
          put('rear_delts', x, y, yl(u, y, 0, L.deltY + 0.05 * S1, 1.30, 0.44 * S1));
          put('side_delts', x, y, yl(u, y, 0, L.deltY - 0.02 * S1, 1.30, 0.38 * S1) * 0.85);
          put('triceps', x, y, upperArmBand(y) * edge);
        }
        put('forearms', x, y, forearmBand(y) * edge);
      }
    }

    // -------------------------------------------------------------- leg runs
    for (const r of c.legs) {
      const [a, z] = r, rc = (a + z) / 2, half = Math.max(1, (z - a) / 2);
      for (let x = a; x <= z; x++) {
        const u = (x - rc) / half;
        const body = 1 - ss(0.82, 1.08, Math.abs(u));
        if (view === 'front') put('quads', x, y, thighBand(y) * body);
        else {
          put('glutes', x, y, gluteBand(y) * body);
          put('hamstrings', x, y, hamBand(y) * body);
        }
        put('calves', x, y, calfBand(y) * body);
      }
    }
  }
  return { G, L };
}

/* -------------------------------------------------------------- compositing */

// Rust brand: bg #0A0C0F, gold/bronze gradient #D4A55A -> #B8853E (src/app.css).
const PRIMARY = [236, 124, 44];    // hot rust orange — the worked muscle
const SECONDARY = [184, 133, 62];  // Rust bronze — assisting muscles
const CARD_BG = [10, 12, 15];      // #0A0C0F, the card background

/**
 * Flatten the render's matte onto the card background. The renders sit on their
 * own near-black, which is not exactly the card colour, so dropping one onto the
 * card unflattened leaves a visible rectangle. Doing it here rather than with a
 * CSS blend mode matters: `screen` washes the highlight out against the pale
 * figure, and `lighten` clips the accent's blue channel and turns the orange
 * white. With the matte baked in, the card needs no blend mode at all.
 */
function flattenBg(rgb) {
  const out = Buffer.from(rgb);
  for (let i = 0; i < W * H; i++) {
    const lum = rgb[i * 3] * 0.30 + rgb[i * 3 + 1] * 0.59 + rgb[i * 3 + 2] * 0.11;
    if (lum >= T) continue;
    const k = clamp01(lum / T);
    for (let c = 0; c < 3; c++) { const p = i * 3 + c; out[p] = Math.round(CARD_BG[c] * (1 - k) + rgb[p] * k); }
  }
  return out;
}

/**
 * Tint the accent in, scaled by the base image's local luminance, then bloom the
 * brightest part of each muscle belly — so grooves between bellies stay dark and
 * the glow reads as the render's own anatomy lighting up.
 *
 * `cloth` is the fabric mask. Fabric gets a synthetic luminance floor and no
 * bloom: enough for a region to read through the shorts, not enough to look like
 * the shorts themselves are the muscle. Without this the glutes cannot be shown
 * at all and the quads begin on a hard line at the hem.
 */
function highlight(baseRgb, G, primary, secondary, phase = 1, cloth = null) {
  const out = Buffer.from(baseRgb);

  /**
   * Flatten each colour's regions to ONE mask by max before compositing.
   *
   * Painting region by region looks equivalent and is not: adjacent regions
   * overlap at their soft edges, and two sequential tints of the same pixel land
   * brighter than either alone. On a Hammer Curl — biceps AND forearms both
   * primary — that drew a bright horizontal seam straight across both arms at
   * the elbow, which reads as a rendering fault rather than anatomy. Taking the
   * max first makes the overlap a no-op, which is what a muscle boundary should
   * be. A muscle in both lists is primary only; the caller already filters that,
   * this just makes it structurally impossible.
   */
  const combine = keys => {
    let m = null;
    for (const k of keys) {
      const g = G[k];
      if (!g) continue;
      if (!m) { m = new Float32Array(g); continue; }
      for (let i = 0; i < m.length; i++) if (g[i] > m[i]) m[i] = g[i];
    }
    return m;
  };
  const primMask = combine(primary);
  const secMask = combine(secondary.filter(k => !primary.includes(k)));
  if (secMask && primMask) for (let i = 0; i < secMask.length; i++) secMask[i] *= 1 - clamp01(primMask[i]);

  const layers = [];
  if (primMask) layers.push([primMask, PRIMARY, 0.94 * (0.70 + 0.30 * phase)]);
  if (secMask) layers.push([secMask, SECONDARY, 0.46 * (0.70 + 0.30 * phase)]);

  for (const [m, c, s] of layers) {
    for (let i = 0; i < W * H; i++) {
      const w = m[i];
      if (w < 0.004) continue;
      const isCloth = cloth && cloth[i];
      const raw = (baseRgb[i * 3] * 0.30 + baseRgb[i * 3 + 1] * 0.59 + baseRgb[i * 3 + 2] * 0.11) / 255;
      // Fabric gets lifted, not flattened. `max(raw, floor)` was the obvious form
      // and it is wrong: the shorts sit in a narrow luma band, so clamping them
      // all to one floor erases the fold shading and the glutes render as a flat
      // orange garment instead of a muscle showing through cloth. An affine lift
      // keeps the fabric's own relative shading and just raises its level.
      const lum = isCloth ? Math.min(0.80, 0.18 + raw * 2.4) : raw;
      const a = w * s * (isCloth ? 0.52 : 1);
      const tint = Math.min(1.18, lum * 1.42);
      const bloom = isCloth ? 0 : Math.pow(raw, 3.2) * 0.42 * w * s;
      for (let k = 0; k < 3; k++) {
        const p = i * 3 + k;
        out[p] = Math.min(255, Math.round(baseRgb[p] * (1 - a) + c[k] * tint * a + c[k] * bloom));
      }
    }
  }
  return out;
}

/**
 * Cut the figure out of its matte and write RGBA. Alpha is always derived from
 * the ORIGINAL base gray, never the highlighted image, so the rest and hot
 * layers cut out identically and the cross-fade cannot shimmer at the edges.
 * This has to be alpha rather than a flattened matte: an opaque rectangle covers
 * the card's own grid and glow layers and reads as a box around each figure.
 */
function writeRgba(rgb, grayForAlpha, out, body = null) {
  const mask = body || bodyMask(grayForAlpha);
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    rgba[i * 4 + 3] = mask[i] ? 255 : Math.round(255 * ss(18, 40, grayForAlpha[i]));
  }
  writeRaw(rgba, out, 'rgba');
}

/* ------------------------------------------------------------------- loading */

const _cache = new Map();
/** Normalised gray/rgb/masks/regions/landmarks for one base figure. */
function loadFigure(baseDir, figure, view) {
  const key = `${figure}-${view}`;
  if (_cache.has(key)) return _cache.get(key);
  const file = path.join(baseDir, `${figure}-${view}.png`);
  if (!fs.existsSync(file)) throw new Error(`missing base figure: ${file}`);
  const n = normalize(toGray(file), toRgb(file));
  const body = bodyMask(n.gray);
  const cloth = clothMask(n.gray, body);
  const { G, L } = buildRegions(n.gray, view, body);
  const v = { gray: n.gray, rgb: n.rgb, body, cloth, G, L, scale: n.scale, file };
  _cache.set(key, v);
  return v;
}

module.exports = {
  W, H, T, FF, CARD_BG, PRIMARY, SECONDARY,
  MUSCLES, VIEW_MUSCLES, RENDER_FALLBACK, resolveMuscle,
  toGray, toRgb, writeRaw, writeRgba, bodyMask, clothMask,
  normalize, landmarks, classify, merged, runsAt, medianLuma,
  buildRegions, highlight, flattenBg, loadFigure, ss, lobe, clamp01,
};
