#!/usr/bin/env node
/**
 * gen-workspace-backdrop.js — synthetic "modern workspace" backdrop.
 *
 * NOTE (honest disclosure): a real licensed stock photo is preferable and
 * should replace this once someone can pull one manually (Pexels API key in
 * Vercel is Sensitive-type and reads back as [SENSITIVE] locally — see
 * PEXELS_API_KEY in docs/ENV.md; a Playwright pull off pexels.com timed out
 * on networkidle during this build — same JS-heavy-site problem noted for
 * Pixabay in Media/Music/LICENSE.md). This SVG-rendered gradient/bokeh
 * backdrop is a stand-in so the matting pipeline has something real to
 * composite against; swap the output PNG for a real photo when available.
 */
const sharp = require('sharp');
const path = require('path');

async function main() {
  const outPath = process.argv[2] || 'Media/video-engine-proto/workspace-backdrop.png';
  const w = 1080, h = 1920;
  const svg = `
  <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#e9e4dc"/>
        <stop offset="55%" stop-color="#d8d0c4"/>
        <stop offset="100%" stop-color="#bfb5a5"/>
      </linearGradient>
      <filter id="soft"><feGaussianBlur stdDeviation="40"/></filter>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#bg)"/>
    <!-- soft window-light bokeh -->
    <circle cx="200" cy="260" r="260" fill="#fff7e6" opacity="0.35" filter="url(#soft)"/>
    <circle cx="900" cy="420" r="220" fill="#ffffff" opacity="0.25" filter="url(#soft)"/>
    <!-- blurred desk edge -->
    <rect x="-100" y="1450" width="${w + 200}" height="600" fill="#8a7d68" opacity="0.55" filter="url(#soft)"/>
    <!-- monitor silhouette, softened -->
    <rect x="700" y="1150" width="320" height="200" rx="14" fill="#3a3a3a" opacity="0.18" filter="url(#soft)"/>
    <!-- plant silhouette -->
    <ellipse cx="120" cy="1500" rx="140" ry="260" fill="#5b6f52" opacity="0.30" filter="url(#soft)"/>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  console.log('Wrote synthetic backdrop:', outPath);
}
main();
