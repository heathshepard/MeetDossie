#!/usr/bin/env node
/**
 * transcribe.js — word-timestamped transcript via ElevenLabs scribe_v1.
 *
 * Usage: node scripts/video-engine/transcribe.js --audio <wav/mp3> --out <json path>
 * Reads ELEVENLABS_API_KEY from .env.local (or process env). Errors loudly
 * if the key is missing or is the literal "[SENSITIVE]" Vercel placeholder.
 */
const fs = require('fs');
const path = require('path');

function loadEnvLocal() {
  // See env-local.js: the old inline version resolved .env.local relative to
  // the repo root, which does not exist in a git worktree — so the key
  // silently never loaded and this took its fallback path instead.
  return require('./env-local.js').load(null, { quiet: true });
}

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

async function main() {
  loadEnvLocal();
  const args = parseArgs();
  const audioPath = args.audio;
  const outPath = args.out;
  if (!audioPath || !outPath) {
    console.error('Usage: transcribe.js --audio <file> --out <json>');
    process.exit(1);
  }
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY not set (checked process.env and .env.local)');
  if (key === '[SENSITIVE]') throw new Error('ELEVENLABS_API_KEY is the Vercel Sensitive-var placeholder, not a real value — pull a real key.');

  const buf = fs.readFileSync(audioPath);
  const form = new FormData();
  form.append('model_id', 'scribe_v1');
  form.append('timestamps_granularity', 'word');
  form.append('file', new Blob([buf]), path.basename(audioPath));

  const t0 = Date.now();
  const resp = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': key },
    body: form,
  });
  const elapsed = Date.now() - t0;
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ElevenLabs STT failed ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  const wordCount = (data.words || []).filter(w => w.type === 'word').length;
  console.log(`Transcribed in ${elapsed}ms — ${wordCount} words. Wrote ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
