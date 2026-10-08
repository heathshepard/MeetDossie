#!/usr/bin/env node
/**
 * gen-cta-card.js — Heath's note 7 default: the video ends on a clean
 * spoken line, THEN a 2-second static text CTA card in brand style — not a
 * caption overlaid on the last few seconds of talking-head footage.
 *
 * Brand style per CLAUDE.md Section 4: Navy (#1A1A2E) card background,
 * Coral (#E8836B) CTA text, Cormorant Garamond.
 *
 * Usage: node scripts/video-engine/gen-cta-card.js <out.png> <ctaText> [w] [h]
 */
const sharp = require('sharp');

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function wrapLines(text, maxCharsPerLine) {
  const words = text.split(/\s+/);
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

async function main() {
  const outPath = process.argv[2];
  const ctaText = process.argv[3];
  const w = parseInt(process.argv[4] || '1080', 10);
  const h = parseInt(process.argv[5] || '1920', 10);
  if (!outPath || !ctaText) {
    console.error('Usage: gen-cta-card.js <out.png> <ctaText> [w] [h]');
    process.exit(1);
  }
  const lines = wrapLines(ctaText, 22);
  const fontSize = 88;
  const lineHeight = fontSize * 1.25;
  const totalTextH = lines.length * lineHeight;
  const startY = h / 2 - totalTextH / 2 + fontSize * 0.8;

  const tspans = lines.map((l, i) =>
    `<tspan x="${w / 2}" y="${startY + i * lineHeight}">${escapeXml(l)}</tspan>`
  ).join('');

  const svg = `
  <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${w}" height="${h}" fill="#1A1A2E"/>
    <text x="${w / 2}" text-anchor="middle" font-family="Cormorant Garamond, serif" font-weight="700"
      font-size="${fontSize}" fill="#E8836B">${tspans}</text>
  </svg>`;

  await sharp(Buffer.from(svg)).png().toFile(outPath);
  console.log('Wrote CTA card:', outPath, `${w}x${h}`, `"${ctaText}"`);
}

if (require.main === module) main();
module.exports = { main };
