#!/usr/bin/env node
/**
 * gen-navy-backdrop.js — "founder in a dim modern room" matte backdrop.
 *
 * Heath's note 5 default: a navy GRADIENT backdrop, NO radial vignette, NO
 * oval, no visible halo band. The previous version of this file used a
 * `radialGradient` as its base fill plus edge-darkening — that IS a radial
 * vignette (the exact look Heath keeps flagging), even though the file's
 * own comment called it "soft." Rewritten to use only a linear top-to-
 * bottom navy gradient + one faint diagonal light sweep + a very subtle
 * grain — no radial/elliptical shape anywhere, so there is no oval and no
 * edge-halo for the quality gate's halo check to ever find in the backdrop
 * itself. Built deliberately generic (no desk/monitor/plant shapes) — those
 * read as "stock office photo," which is explicitly what this must NOT
 * look like.
 *
 * Usage: node scripts/video-engine/gen-navy-backdrop.js <out.png> [w] [h]
 */
const sharp = require('sharp');

async function main() {
  const outPath = process.argv[2] || 'Media/video-engine-proto/navy-backdrop.png';
  const w = parseInt(process.argv[3] || '1080', 10);
  const h = parseInt(process.argv[4] || '1920', 10);

  const svg = `
  <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="navy" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#23233a"/>
        <stop offset="55%" stop-color="#1a1a2e"/>
        <stop offset="100%" stop-color="#14141f"/>
      </linearGradient>
      <linearGradient id="sweep" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.05"/>
        <stop offset="35%" stop-color="#ffffff" stop-opacity="0"/>
        <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
      </linearGradient>
      <filter id="grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" result="noise"/>
        <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.02 0"/>
      </filter>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#navy)"/>
    <rect width="${w}" height="${h}" fill="url(#sweep)"/>
    <rect width="${w}" height="${h}" filter="url(#grain)"/>
  </svg>`;

  await sharp(Buffer.from(svg)).png().toFile(outPath);
  console.log('Wrote navy backdrop (linear gradient, no vignette/oval):', outPath, `${w}x${h}`);
}

if (require.main === module) main();
module.exports = { main };
