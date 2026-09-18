#!/usr/bin/env node
'use strict';
/**
 * debug-atlas.js — look at what the region builder actually produced.
 *
 * The lobe constants in figure-lib-v3.js cannot be verified by reading them.
 * This renders two things per figure so they can be checked by eye:
 *   --mode all   every region at once, each a distinct hue, argmax wins, plus
 *                horizontal rules at every detected landmark
 *   --mode grid  a contact sheet, one cell per muscle, so a single region can be
 *                checked in isolation (the order is printed to stdout)
 *
 * Usage: node scripts/anatomy-v2/debug-atlas.js --figure male --view front --mode all
 */
const fs = require('fs');
const path = require('path');
const FIG = require('./figure-lib-v3');

const W = FIG.W, H = FIG.H;
const BASE_DIR = path.resolve(__dirname, '..', '..', 'Media', 'anatomy-v2', 'base');

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2), n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) o[k] = true; else { o[k] = n; i++; }
  }
  return o;
}

const hsv = (h, s, v) => {
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const r = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return r.map(c => Math.round(c * 255));
};

function downscale(rgb, k) {
  const ow = Math.round(W / k), oh = Math.round(H / k);
  const out = Buffer.alloc(ow * oh * 3);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const sx = Math.min(W - 1, Math.round(x * k)), sy = Math.min(H - 1, Math.round(y * k));
    for (let c = 0; c < 3; c++) out[(y * ow + x) * 3 + c] = rgb[(sy * W + sx) * 3 + c];
  }
  return { buf: out, w: ow, h: oh };
}

(function main() {
  const a = args(process.argv.slice(2));
  const figure = a.figure || 'male';
  const view = a.view || 'front';
  const mode = a.mode || 'all';
  const f = FIG.loadFigure(BASE_DIR, figure, view);
  const names = FIG.VIEW_MUSCLES[view];
  const L = f.L;
  console.log(`${figure}-${view} scale=${f.scale.toFixed(3)} landmarks=${JSON.stringify(L)}`);
  console.log(`  regions (${names.length}): ${names.join(', ')}`);
  for (const n of names) {
    let px = 0; const g = f.G[n];
    for (let i = 0; i < W * H; i++) if (g[i] > 0.25) px++;
    console.log(`    ${n.padEnd(13)} ${String(px).padStart(7)} px`);
  }

  const out = path.resolve(a.out || path.join(__dirname, '..', '..', 'Media', 'anatomy-v2', '.debug', `${figure}-${view}-${mode}.png`));
  fs.mkdirSync(path.dirname(out), { recursive: true });

  if (mode === 'all') {
    const base = FIG.flattenBg(f.rgb);
    const img = Buffer.from(base);
    for (let i = 0; i < W * H; i++) {
      let bi = -1, bw = 0.12;
      names.forEach((n, k) => { const w = f.G[n][i]; if (w > bw) { bw = w; bi = k; } });
      if (bi < 0) continue;
      const c = hsv((bi / names.length + 0.02) % 1, 0.95, 1);
      const lum = (base[i * 3] * 0.3 + base[i * 3 + 1] * 0.59 + base[i * 3 + 2] * 0.11) / 255;
      const al = 0.30 + 0.60 * Math.min(1, bw) * Math.max(0.45, lum);
      for (let k = 0; k < 3; k++) img[i * 3 + k] = Math.round(base[i * 3 + k] * (1 - al) + c[k] * al);
    }
    // landmark rules
    const rules = ['shoulderTop', 'deltY', 'armSplit', 'elbowY', 'wristY', 'armEnd',
                   'waistY', 'shortsTop', 'hipY', 'legSplit', 'shortsBottom', 'kneeY', 'ankleY'];
    rules.forEach((r, k) => {
      const y = L[r]; if (y == null || y < 0 || y >= H) return;
      const c = hsv((k / rules.length) % 1, 0.6, 1);
      const x0 = 8 + (k % 2) * 16;
      for (let x = x0; x < W - 8; x += 1) {
        if (((x / 6) | 0) % 2) continue;
        for (let k2 = 0; k2 < 3; k2++) img[(y * W + x) * 3 + k2] = c[k2];
      }
    });
    FIG.writeRaw(img, out, 'rgb24');
    console.log(`  rules top->bottom: ${rules.map(r => `${r}=${L[r]}`).join(' ')}`);
  } else {
    const k = 3.6;
    const cols = 5, rows = Math.ceil(names.length / cols);
    const cells = names.map(n => {
      const img = Buffer.from(FIG.flattenBg(f.rgb));
      const hot = FIG.highlight(FIG.flattenBg(f.rgb), f.G, [n], [], 1, f.cloth);
      return downscale(hot, k);
    });
    const cw = cells[0].w, ch = cells[0].h;
    const OW = cw * cols, OH = ch * rows;
    const sheet = Buffer.alloc(OW * OH * 3);
    cells.forEach((c, i) => {
      const cx = (i % cols) * cw, cy = Math.floor(i / cols) * ch;
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++)
        for (let ch2 = 0; ch2 < 3; ch2++)
          sheet[((cy + y) * OW + cx + x) * 3 + ch2] = c.buf[(y * cw + x) * 3 + ch2];
    });
    const t = out + '.rgb';
    fs.writeFileSync(t, sheet);
    require('child_process').execFileSync(FIG.FF, ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
      '-s', `${OW}x${OH}`, '-i', t, out], { stdio: 'ignore' });
    fs.unlinkSync(t);
    console.log(`  grid order (${cols} cols): ${names.map((n, i) => `${i}:${n}`).join(' ')}`);
  }
  console.log(`  -> ${out}`);
})();
