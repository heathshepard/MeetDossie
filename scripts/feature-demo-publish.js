'use strict';

// scripts/feature-demo-publish.js
//
// Upload a finished feature-demo mp4 to Supabase Storage and insert a row in
// the video_library table with type='feature_demo' and status='ready' so it
// flows through the standard Telegram approval pipeline.
//
// STATUS FIX (2026-09-17): this used to insert directly as
// status='pending_approval', on the belief that "cron-post-videos already
// picks up rows when Heath approves." That's true of the APPROVE step, but
// nothing ever sends the video to Heath in the first place from that state:
// api/cron-video-approval.js (the only code that PATCHes a row TO
// pending_approval and fires the Telegram Approve/Reject message) only
// SELECTs rows already at status='ready' — it never re-reads a row a caller
// dropped directly into pending_approval. api/cron-post-videos.js only reads
// 'approved' and 'heath_approved'. The result: a row inserted straight into
// pending_approval has no code path that ever sends it to Telegram, so it
// sits invisible forever with `telegram_message_id` staying null. This is
// exactly how 8 of the 9 rows that piled up 2026-06-09 through 2026-08-23
// went dead — confirmed by querying video_library directly: all 8 have
// telegram_message_id=null, versus the one non-feature_demo row in that same
// pending_approval backlog (amendment-demo-desktop-2026-05-27, inserted
// through the OLD/correct 'ready' path) which DOES carry a real
// telegram_message_id, because cron-video-approval.js actually ran on it.
// Inserting as 'ready' here routes every future publish through the front
// door instead of skipping the one step that sends the approval message.
//
// Usage:
//   node scripts/feature-demo-publish.js <scene-script.json>

const fs = require('fs');
const path = require('path');
const os = require('os');

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

// SUPABASE_URL is a write-only Vercel var; `vercel env pull` returns the
// literal string "[SENSITIVE]" locally instead of the real value. Prefer the
// always-readable NEXT_PUBLIC_ mirror, and skip SUPABASE_URL entirely if it's
// the placeholder so we don't build a request against a bogus hostname.
const rawSupabaseUrl = process.env.SUPABASE_URL;
const SUPABASE_URL = (rawSupabaseUrl && rawSupabaseUrl !== '[SENSITIVE]')
  ? rawSupabaseUrl
  : process.env.NEXT_PUBLIC_SUPABASE_URL;
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

// Full quality gate, run on the real bytes immediately before they leave
// this machine. Added 2026-09-16 as a measurable-only preflight; upgraded
// 2026-09-17 to the FULL gate (measurable + vision) after the frame-by-frame
// review that unblocked the 9-video pending_approval backlog found that a
// measurable-only check would have missed the actual disqualifying defect on
// every 2026-08-17 recording: each one opens on the Dossie sign-in screen —
// real, legible content at frame 0 (so first_frame_not_uniform passes), just
// the WRONG content. Only the vision rule (opening_not_login_or_empty)
// catches that. A narrower check here would keep shipping the same defect
// forever.
//
// Orientation source of truth: delegates to classifyOrientation() —the same
// function api/cron-video-approval.js's ingestion gate and
// scripts/queue-finished-videos.py's CLI path use — so there is exactly one
// place that decides which platform wants which shape. (This used to carry
// its own local `VERTICAL_SURFACES` guess that listed 'facebook' as
// vertical, contradicting docs/FEATURE-VIDEO-DAILY-PLAN.md §1's dual-cut
// design and would have refused every correctly-shaped desktop demo.)
//
// Never throws — mirrors scripts/queue-finished-videos.py's run_quality_gate
// pattern: returns a verdict, and the caller decides status ('ready' on
// pass, 'quality_hold' on fail), uploading either way so a held video is
// still visible to Heath with its real failure reasons attached, instead of
// silently vanishing before it ever reaches the database.
async function runFullQualityGate(mp4Path, coverPath, platforms) {
  const { checkVideoQuality } = require(path.join(__dirname, '..', 'api', '_lib', 'verify-video-quality.js'));
  try {
    const result = await checkVideoQuality({ videoPath: mp4Path, coverPath, platforms });
    return result;
  } catch (err) {
    // A thrown gate is still fail-closed, never a silent pass.
    return {
      pass: false,
      rules: { gate_executed: { pass: false, blocking: true, note: `gate threw: ${err.message}` } },
      failedRules: ['gate_executed'],
      detail: {},
    };
  }
}

// Auto-cover: frame 0, same convention scripts/queue-finished-videos.py's
// extract_cover_frame() already uses for the other ingestion lane. A bad
// frame-0 (login screen, blank splash) is exactly what the gate's own vision
// rules are built to catch — using it as the cover rather than hand-picking
// a flattering frame means the cover asset and the gate see the same truth.
async function extractCoverFrame(mp4Path) {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);
  const outPath = path.join(os.tmpdir(), `feature-demo-cover-${process.pid}-${Date.now()}.png`);
  await execFileAsync('ffmpeg', ['-y', '-ss', '0', '-i', mp4Path, '-frames:v', '1', outPath]);
  const stat = await fs.promises.stat(outPath);
  if (!stat.size) throw new Error(`ffmpeg produced an empty cover frame for ${mp4Path}`);
  return outPath;
}

async function publish(scriptPath) {
  const cfg = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  const mp4Path = path.join(OUT_DIR, cfg.filename);
  if (!fs.existsSync(mp4Path)) throw new Error(`Final mp4 missing: ${mp4Path}. Run feature-demo-merge.js first.`);

  const platforms = cfg.platforms || ['facebook', 'twitter', 'linkedin'];

  let coverLocal = null;
  try {
    coverLocal = await extractCoverFrame(mp4Path);
  } catch (err) {
    console.warn(`[publish] WARN: cover frame extraction failed (${err.message}) — cover_asset_present will fail`);
  }

  const gateResult = await runFullQualityGate(mp4Path, coverLocal || undefined, platforms);
  if (coverLocal) await fs.promises.unlink(coverLocal).catch(() => {});

  const qualityPassed = !!gateResult.pass;
  const failedRules = gateResult.failedRules || [];
  if (!qualityPassed) {
    console.warn(`[publish] QUALITY HOLD: ${path.basename(mp4Path)} failed: ${failedRules.join(', ')}`);
    for (const ruleName of failedRules) {
      const rule = gateResult.rules && gateResult.rules[ruleName];
      if (rule) console.warn(`  - ${ruleName}: ${rule.note}`);
    }
  } else {
    console.log(`[publish] quality gate PASSED — orientation=${gateResult.detail && gateResult.detail.orientation}`);
  }

  const id = cfg.filename.replace(/\.mp4$/i, '');
  const storagePath = `${STORAGE_PREFIX}/${cfg.filename}`;

  // Upload regardless of pass/fail — a held video still needs to be visible
  // (with its real failure reasons attached) rather than vanishing before it
  // ever reaches the database. Matches scripts/queue-finished-videos.py.
  const publicUrl = await uploadToStorage(mp4Path, storagePath);

  const today = new Date().toISOString().slice(0, 10);
  const row = {
    id,
    path: `Media/feature-demos/${cfg.filename}`,
    type: 'feature_demo',
    topic: cfg.topic || cfg.name,
    produced_date: today,
    // status='ready' ONLY on a quality-gate pass — cron-video-approval.js
    // sends 'ready' rows straight to Heath's Telegram, so a failing video
    // must never reach that state. 'quality_hold' keeps it out of every
    // approval/posting cron (see api/_lib/silence-alarm.js's
    // quality_hold check) until someone fixes and re-runs this script.
    status: qualityPassed ? 'ready' : 'quality_hold',
    platforms,
    caption: cfg.caption || '',
    supabase_url: publicUrl,
    quality_status: qualityPassed ? 'passed' : 'held',
    quality_failed_rules: failedRules,
    quality_detail: gateResult,
    quality_checked_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  const inserted = await upsertVideoLibrary(row);
  console.log(`[publish] video_library row: id=${row.id} status=${row.status}`);
  return { id: row.id, supabase_url: publicUrl, row: inserted, qualityPassed, failedRules };
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
