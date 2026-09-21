#!/usr/bin/env node
/**
 * render-cutlist.js — applies a cutlist.json's keepSegments to a source
 * video with ffmpeg trim+concat (single filter_complex pass, re-encoded
 * once — no lossy multi-generation re-encodes).
 *
 * Usage: node scripts/video-engine/render-cutlist.js --src <video> \
 *   --cutlist <cutlist json> --out <output mp4> [--scale 720:1280]
 */
const fs = require('fs');
const { execFileSync } = require('child_process');

function parseArgs() {
  const a = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) {
      const key = a[i].slice(2);
      const val = (a[i + 1] && !a[i + 1].startsWith('--')) ? a[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

function main() {
  const args = parseArgs();
  const src = args.src, cutlistPath = args.cutlist, out = args.out;
  const scale = args.scale || null;
  if (!src || !cutlistPath || !out) {
    console.error('Usage: render-cutlist.js --src <video> --cutlist <json> --out <mp4>');
    process.exit(1);
  }
  const cutlist = JSON.parse(fs.readFileSync(cutlistPath, 'utf8'));
  const segs = cutlist.keepSegments;
  if (!segs.length) throw new Error('No keep segments in cutlist');

  const filterParts = [];
  const vLabels = [], aLabels = [];
  segs.forEach((seg, i) => {
    filterParts.push(`[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}]`);
    filterParts.push(`[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`);
    vLabels.push(`[v${i}]`); aLabels.push(`[a${i}]`);
  });
  let concatIn = vLabels.map((v, i) => `${v}${aLabels[i]}`).join('');
  filterParts.push(`${concatIn}concat=n=${segs.length}:v=1:a=1[vout][aout]`);
  let filter = filterParts.join(';');
  let mapV = '[vout]', mapA = '[aout]';
  if (scale) {
    filter += `;[vout]scale=${scale}[vscaled]`;
    mapV = '[vscaled]';
  }

  const ffArgs = [
    '-y', '-i', src,
    '-filter_complex', filter,
    '-map', mapV, '-map', mapA,
    '-c:v', 'libx264', '-crf', '20', '-preset', 'fast',
    '-c:a', 'aac',
    out,
  ];
  console.log('ffmpeg', ffArgs.join(' '));
  execFileSync('ffmpeg', ffArgs, { stdio: 'inherit' });
  console.log('Wrote', out);
}

main();
