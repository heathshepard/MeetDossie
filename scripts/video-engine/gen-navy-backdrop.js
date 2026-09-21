#!/usr/bin/env node
/**
 * gen-navy-backdrop.js — "founder in a dim modern room" matte backdrop.
 *
 * A clean dark neutral backdrop in the Dossie navy palette (#1A1A2E) with a
 * soft radial vignette + a faint diagonal light sweep + a very subtle grain,
 * so it reads as depth/a real dim room rather than a flat color card. Built
 * deliberately generic (no desk/monitor/plant shapes) — those read as "stock
 * office photo," which is explicitly what this must NOT look like.
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
      <radialGradient id="vig" cx="50%" cy="38%" r="75%">
        <stop offset="0%" stop-color="#23233a"/>
        <stop offset="55%" stop-color="#1a1a2e"/>
        <stop offset="100%" stop-color="#0f0f1c"/>
      </radialGradient>
      <linearGradient id="sweep" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.05"/>
        <stop offset="35%" stop-color="#ffffff" stop-opacity="0"/>
        <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
      </linearGradient>
      <filter id="grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" result="noise"/>
        <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.02 0"/>
      </filter>
      <filter id="soft"><feGaussianBlur stdDeviation="60"/></filter>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#vig)"/>
    <rect width="${w}" height="${h}" fill="url(#sweep)"/>
    <!-- one very soft, very dim light source, upper-frame, off-center: gives depth without reading as any specific object -->
    <ellipse cx="${w * 0.68}" cy="${h * 0.14}" rx="${w * 0.45}" ry="${h * 0.16}" fill="#3a3a5c" opacity="0.28" filter="url(#soft)"/>
    <!-- a second, cooler, lower/behind glow for depth separation -->
    <ellipse cx="${w * 0.22}" cy="${h * 0.82}" rx="${w * 0.4}" ry="${h * 0.2}" fill="#12121f" opacity="0.5" filter="url(#soft)"/>
    <rect width="${w}" height="${h}" filter="url(#grain)"/>
    <!-- hard vignette darken at the very edges -->
    <rect width="${w}" height="${h}" fill="url(#vig)" opacity="0.001"/>
  </svg>`;

  await sharp(Buffer.from(svg)).png().toFile(outPath);
  console.log('Wrote navy backdrop:', outPath, `${w}x${h}`);
}

main();
