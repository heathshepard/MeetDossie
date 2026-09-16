#!/usr/bin/env node
'use strict';

// Thin CLI wrapper around api/_lib/verify-video-quality.js's
// checkVideoQuality(). Exists because scripts/queue-finished-videos.py
// (Python) is where new videos actually land with a local file on disk, but
// the vision-model check reuses the same Anthropic path the rest of the
// content engine already uses in Node (api/_lib/verify-image-match.js) —
// rather than re-implementing that call in Python, queue-finished-videos.py
// shells out to this CLI, the same way it already shells out to ffmpeg for
// compress_video().
//
// Prints ONE JSON object (the checkVideoQuality() result) to stdout.
// Exit code: 0 = pass, 1 = ran fine but failed a rule, 2 = hard tool error
// (bad args, couldn't even run the check) — mirrors how the Python caller
// already branches on ffmpeg's returncode.
//
// Usage:
//   node scripts/check-video-quality-cli.js --video <path-or-url> [--cover <path-or-url>]

const path = require('path');
const { checkVideoQuality } = require(path.join(__dirname, '..', 'api', '_lib', 'verify-video-quality.js'));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.video) {
    console.log(JSON.stringify({ pass: false, error: '--video is required' }));
    process.exit(2);
  }

  try {
    const isUrl = /^https?:\/\//i.test(args.video);
    const isCoverUrl = args.cover && /^https?:\/\//i.test(args.cover);
    const result = await checkVideoQuality({
      videoPath: isUrl ? undefined : args.video,
      videoUrl: isUrl ? args.video : undefined,
      coverPath: args.cover ? (isCoverUrl ? undefined : args.cover) : undefined,
      coverUrl: isCoverUrl ? args.cover : undefined,
    });
    console.log(JSON.stringify(result));
    process.exit(result.pass ? 0 : 1);
  } catch (err) {
    console.log(JSON.stringify({ pass: false, error: (err && err.message) || String(err) }));
    process.exit(2);
  }
})();
