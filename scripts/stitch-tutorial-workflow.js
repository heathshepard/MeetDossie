'use strict';

// scripts/stitch-tutorial-workflow.js
//
// Stitches a list of tutorial bite slugs into a single workflow MP4.
//
// Usage:
//   node scripts/stitch-tutorial-workflow.js \
//     --name "Getting Started With Dossie" \
//     --slug general-onboarding-v1 \
//     --bites sign-up-and-complete-profile,open-your-first-dossier,invite-a-buyer,invite-a-seller,add-team-and-brokerage-info
//
// Or pass a workflow brief JSON via --brief:
//   { "name": "...", "slug": "...", "video_slugs": ["...","..."], "target_distribution": "youtube-long-form" }

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const https = require('https');

(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '..', '.env.local');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[k]) process.env[k] = v;
    }
  } catch (_) {}
})();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'Media', 'tutorial-videos', 'workflows');
const CACHE_DIR = path.join(ROOT, 'Media', 'tutorial-videos', '_cache');

function parseArgs() {
  const a = process.argv.slice(2);
  const o = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--name') o.name = a[++i];
    else if (a[i] === '--slug') o.slug = a[++i];
    else if (a[i] === '--bites') o.bites = a[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a[i] === '--brief') o.briefPath = a[++i];
    else if (a[i] === '--target') o.target = a[++i];
  }
  if (o.briefPath) {
    const b = JSON.parse(fs.readFileSync(o.briefPath, 'utf8'));
    return { ...b, ...o, bites: o.bites || b.video_slugs, slug: o.slug || b.slug, name: o.name || b.name };
  }
  if (!o.slug || !o.bites?.length) throw new Error('Need --slug and --bites (or --brief)');
  return o;
}

function findFfmpeg() {
  if (spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0) return 'ffmpeg';
  const winget = path.join(
    process.env.LOCALAPPDATA || '',
    'Microsoft', 'WinGet', 'Packages',
    'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe',
    'ffmpeg-8.1-full_build', 'bin', 'ffmpeg.exe'
  );
  if (fs.existsSync(winget)) return winget;
  throw new Error('ffmpeg not found.');
}

function downloadTo(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`GET ${url} → ${res.statusCode}`));
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchBitesFromDB(slugs) {
  const inList = slugs.map(s => `"${s}"`).join(',');
  const url = `${SUPABASE_URL}/rest/v1/tutorial_videos?slug=in.(${encodeURIComponent(inList)})&select=slug,video_url,duration_seconds`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Fetch bites failed: ${res.status}`);
  const rows = await res.json();
  const bySlug = new Map(rows.map(r => [r.slug, r]));
  return slugs.map(s => {
    const row = bySlug.get(s);
    if (!row || !row.video_url) throw new Error(`Bite missing or has no video_url: ${s}`);
    return row;
  });
}

async function ensureCached(rows) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const local = [];
  for (const r of rows) {
    const file = path.join(CACHE_DIR, `${r.slug}.mp4`);
    if (!fs.existsSync(file)) {
      console.log(`[stitch] download ${r.slug}...`);
      await downloadTo(r.video_url, file);
    }
    local.push(file);
  }
  return local;
}

function concatMP4s(ffmpeg, files, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  // Re-encode for safety (varying sources). Build concat list file.
  const listFile = path.join(CACHE_DIR, '_concat.txt');
  fs.writeFileSync(listFile, files.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
  // First try stream-copy concat (fast) for identical encoding.
  const tryCopy = spawnSync(ffmpeg, [
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy',
    '-movflags', '+faststart',
    '-y', outFile,
  ], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (tryCopy.status === 0) return;
  console.warn('[stitch] copy concat failed, re-encoding...');
  // Re-encode fallback
  const inputs = files.flatMap(f => ['-i', f]);
  const filter = files.map((_, i) => `[${i}:v:0][${i}:a:0]`).join('') + `concat=n=${files.length}:v=1:a=1[v][a]`;
  const r = spawnSync(ffmpeg, [
    ...inputs,
    '-filter_complex', filter,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    '-y', outFile,
  ], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg concat failed: ${(r.stderr || '').slice(0, 600)}`);
}

async function uploadFile(filePath, storagePath) {
  const url = `${SUPABASE_URL}/storage/v1/object/videos/${storagePath}`;
  const body = fs.readFileSync(filePath);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'video/mp4',
      'x-upsert': 'true',
    },
    body,
  });
  if (!res.ok) throw new Error(`upload ${res.status}`);
  return `${SUPABASE_URL}/storage/v1/object/public/videos/${storagePath}`;
}

async function upsertWorkflowRow(slug, name, bites, assembledUrl, target) {
  const url = `${SUPABASE_URL}/rest/v1/tutorial_workflows?on_conflict=slug`;
  const row = {
    slug, name,
    video_slugs: bites,
    assembled_url: assembledUrl,
    target_distribution: target || 'in-app-tour',
    status: 'ready',
  };
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
  if (!res.ok) throw new Error(`upsert ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const args = parseArgs();
  const ffmpeg = findFfmpeg();
  const rows = await fetchBitesFromDB(args.bites);
  const files = await ensureCached(rows);
  const outFile = path.join(OUT_DIR, `${args.slug}.mp4`);
  concatMP4s(ffmpeg, files, outFile);
  console.log(`[stitch] Assembled: ${outFile}`);
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    const url = await uploadFile(outFile, `tutorials/workflows/${args.slug}.mp4`);
    await upsertWorkflowRow(args.slug, args.name || args.slug, args.bites, url, args.target);
    console.log(`[stitch] Uploaded + row upserted: ${url}`);
  }
}

main().catch((e) => { console.error('[stitch] FAILED:', e.message); process.exit(1); });
