'use strict';

// scripts/feature-demo-publish.js
//
// Upload a finished feature-demo mp4 to Supabase Storage and insert a row in
// the video_library table with type='feature_demo' and status='pending_approval'
// so it flows through the standard Telegram approval pipeline (cron-post-videos
// already picks up rows when Heath approves).
//
// Usage:
//   node scripts/feature-demo-publish.js <scene-script.json>

const fs = require('fs');
const path = require('path');

// ─── Env loader ───────────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local.');
}

const OUT_DIR = path.join(__dirname, '..', 'Media', 'feature-demos');
const STORAGE_BUCKET = 'videos';
const STORAGE_PREFIX = 'feature-demos';

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function uploadToStorage(localPath, storagePath) {
  const buf = fs.readFileSync(localPath);
  const sizeMb = (buf.length / 1024 / 1024).toFixed(2);
  console.log(`[publish] uploading ${sizeMb} MB -> ${STORAGE_BUCKET}/${storagePath}`);
  const url = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'video/mp4',
      'x-upsert': 'true',
    },
    body: buf,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase upload failed ${res.status}: ${text}`);
  }
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${storagePath}`;
  console.log(`[publish] public url: ${publicUrl}`);
  return publicUrl;
}

async function upsertVideoLibrary(row) {
  const url = `${SUPABASE_URL}/rest/v1/video_library?on_conflict=id`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`video_library upsert failed ${res.status}: ${text}`);
  }
  const data = await res.json().catch(() => null);
  return Array.isArray(data) ? data[0] : data;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function publish(scriptPath) {
  const cfg = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  const mp4Path = path.join(OUT_DIR, cfg.filename);
  if (!fs.existsSync(mp4Path)) throw new Error(`Final mp4 missing: ${mp4Path}. Run feature-demo-merge.js first.`);

  const id = cfg.filename.replace(/\.mp4$/i, '');
  const storagePath = `${STORAGE_PREFIX}/${cfg.filename}`;

  const publicUrl = await uploadToStorage(mp4Path, storagePath);

  const today = new Date().toISOString().slice(0, 10);
  const row = {
    id,
    path: `Media/feature-demos/${cfg.filename}`,
    type: 'feature_demo',
    topic: cfg.topic || cfg.name,
    produced_date: today,
    status: 'pending_approval',
    platforms: cfg.platforms || ['facebook', 'twitter', 'linkedin'],
    caption: cfg.caption || '',
    supabase_url: publicUrl,
    created_at: new Date().toISOString(),
  };

  const inserted = await upsertVideoLibrary(row);
  console.log(`[publish] video_library row: id=${row.id} status=${row.status}`);
  return { id: row.id, supabase_url: publicUrl, row: inserted };
}

if (require.main === module) {
  const scriptPath = process.argv[2];
  if (!scriptPath) {
    console.error('Usage: node scripts/feature-demo-publish.js <scene-script.json>');
    process.exit(1);
  }
  publish(path.resolve(scriptPath))
    .then((r) => {
      console.log(`\nDONE`);
      console.log(`  id=${r.id}`);
      console.log(`  supabase_url=${r.supabase_url}`);
    })
    .catch((err) => {
      console.error(`[publish] FATAL: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { publish };
