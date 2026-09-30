// Ad-hoc gate runner for the video-7 build. Read-only: calls checkVideoQuality()
// directly (NOT gateBeforePublish) so nothing is held, alerted, or written to
// Supabase. Only ANTHROPIC_API_KEY is loaded -- the Telegram/Supabase vars are
// deliberately left unset so an alert path cannot fire even by accident.
const fs = require('fs');
const path = require('path');

const envPath = '/mnt/c/Users/Heath/Projects/MeetDossie/.env.local';
const raw = fs.readFileSync(envPath, 'utf8').replace(/^﻿/, '');
for (const line of raw.split('\n')) {
  const m = line.match(/^(ANTHROPIC_API_KEY)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not loaded');

const { checkVideoQuality } = require(path.join(__dirname, '..', 'api', '_lib', 'verify-video-quality.js'));

(async () => {
  const res = await checkVideoQuality({
    videoPath: '/home/heath/mw/v7/v7_FINAL.mp4',
    coverPath: '/home/heath/mw/v7/cards/cover7.png',
    orientation: 'vertical',
    tmpDir: '/tmp',
  });
  console.log('PASS:', res.pass);
  console.log('FAILED RULES:', res.failedRules);
  console.log('DETAIL:', JSON.stringify(res.detail, null, 1));
  for (const [name, r] of Object.entries(res.rules)) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.blocking ? '[blocking]' : '[warn]   '} ${name} — ${r.note}`);
  }
})().catch((e) => { console.error('RUNNER ERROR', e); process.exit(1); });
