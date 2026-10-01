/* Run the repo's own video gates against the finished cut.
   Loads .env.local for the vision-check key. Never prints any env value. */
const fs = require('fs');

const ENV = '/mnt/c/Users/Heath/Projects/MeetDossie/.env.local';
for (const line of fs.readFileSync(ENV, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const Q = require('/home/heath/mw/v8/verify-video-quality.js');

(async () => {
  console.log('TIKTOK_RANGE', Q.TIKTOK_RANGE, 'HARD_MAX_RUNTIME_S', Q.HARD_MAX_RUNTIME_S);
  const res = await Q.checkVideoQuality({
    videoPath: '/home/heath/mw/v8/v8_SPLICED.mp4',
    coverPath: '/home/heath/mw/v8/cards/cover8.png',
    platforms: ['tiktok', 'instagram'],
    tmpDir: '/home/heath/mw/v8/gatetmp',
  });
  console.log('\nPASS:', res.pass, '| failed:', res.failedRules);
  console.log('\ndetail:', JSON.stringify(res.detail, null, 1));
  console.log('\nrules:');
  for (const [k, v] of Object.entries(res.rules)) {
    console.log(' %s %s%s %s', v.pass ? 'PASS' : 'FAIL', k, v.blocking ? '' : ' (non-blocking)',
      v.note ? '- ' + String(v.note).slice(0, 220) : '');
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
