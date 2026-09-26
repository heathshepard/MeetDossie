#!/usr/bin/env node
//
// scripts/scan-orphan-videos.js
//
// THE SAFETY NET (Atlas 2026-09-25). Three registration paths exist today
// (scripts/queue-finished-videos.py's watch-folder scan, scripts/video-engine/
// produce-variants.js's auto-queue, scripts/register-local-video.js for
// everything else) — all three work, and all three depend on SOMETHING
// actually invoking them for a given file. Nothing catches the case where
// none of them ran. That is exactly how dossie_trec_p8_disclosure.mp4,
// dossie_trec_p22_district_notice.mp4, and dossie_12b_v2.mp4 sat unregistered
// on 2026-09-25 — feedback_silent-failure-is-the-enemy.md: "every pipeline
// needs an alarm, built in the same change."
//
// WHAT THIS DOES, every time it runs:
//   1. List every .mp4 in the watch folders (top-level Media/finished-videos/,
//      /realtor/, /rust/ — same three lanes scripts/queue-finished-videos.py
//      already scans) older than ORPHAN_GRACE_MINUTES (skips a file mid-copy
//      or mid-export).
//   2. Diff against video_library ids.
//   3. INSERT a local_video_orphans row for any new orphan (first_seen_at is
//      set ONLY on first insert — never touched again, so its age is honest).
//   4. DELETE any local_video_orphans row whose file is now registered (the
//      self-heal) or no longer exists on disk (moved/deleted by hand).
//
// This table is what outcome_expectations.video_orphan_files_stale
// (supabase/migrations/20260925_video_scheduling_and_orphan_alarm.sql) reads
// on cron-outcome-monitor's existing 6-hourly pass — this script does NOT
// send its own Telegram alert. That is the whole point of routing through the
// existing alarm machinery instead of inventing a channel: one escalation
// ladder, not two.
//
// THIS MUST ACTUALLY RUN PERIODICALLY TO WORK. It needs local filesystem
// access Vercel does not have, so it cannot be a Vercel cron. Wire it the
// same way scripts/_lib/session-keepalive.js's Task Scheduler entry already
// runs unattended on Heath's PC (see memory
// heath-kitchen-island-recording-setup.md's sibling session-keepalive doc)
// — e.g. `schtasks /create /sc hourly ... node scripts/scan-orphan-videos.js`.
// Until that task exists, run it by hand after any local render session.
//
// Run: node scripts/scan-orphan-videos.js [--dry-run]

'use strict';

const fs = require('fs');
const path = require('path');

require('./video-engine/env-local.js').load(null, { quiet: true });

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const REPO_ROOT = path.resolve(__dirname, '..');
const FINISHED_DIR = process.env.QUEUE_VIDEOS_DIR
  ? path.resolve(process.env.QUEUE_VIDEOS_DIR)
  : path.join(REPO_ROOT, 'Media', 'finished-videos');
const WATCH_DIRS = [
  { dir: FINISHED_DIR, owner: 'dossie' },
  { dir: path.join(FINISHED_DIR, 'realtor'), owner: 'heath-realtor' },
  { dir: path.join(FINISHED_DIR, 'rust'), owner: 'rust' },
];

const ORPHAN_GRACE_MINUTES = 60; // don't flag a file still being written/exported

async function sb(query, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { ok: res.ok, status: res.status, data };
}

function listMp4s(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.mp4'))
    .map((f) => {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      return { stem: path.basename(f, path.extname(f)), full, mtimeMs: stat.mtimeMs };
    });
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('ERROR: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not available (env-local.js could not find .env.local)');
    process.exit(1);
  }

  const cutoffMs = Date.now() - ORPHAN_GRACE_MINUTES * 60 * 1000;

  let onDisk = [];
  for (const { dir, owner } of WATCH_DIRS) {
    for (const f of listMp4s(dir)) {
      if (f.mtimeMs > cutoffMs) continue; // too fresh, might still be writing
      onDisk.push({ ...f, owner });
    }
  }
  console.log(`Found ${onDisk.length} .mp4 file(s) older than ${ORPHAN_GRACE_MINUTES}m across ${WATCH_DIRS.map((w) => w.dir).join(', ')}`);

  const { ok: libOk, data: libRows } = await sb('video_library?select=id');
  if (!libOk) { console.error('ERROR: failed to read video_library ids'); process.exit(1); }
  const registeredIds = new Set((libRows || []).map((r) => r.id));

  const { ok: orphanOk, data: existingOrphans } = await sb('local_video_orphans?select=id,path,target_owner');
  if (!orphanOk) { console.error('ERROR: failed to read local_video_orphans'); process.exit(1); }
  const existingOrphanIds = new Set((existingOrphans || []).map((r) => r.id));

  const stillOrphaned = onDisk.filter((f) => !registeredIds.has(f.stem));
  const newOrphans = stillOrphaned.filter((f) => !existingOrphanIds.has(f.stem));

  // Self-heal: clear a tracked orphan ONLY on real resolution — registered,
  // or its file is genuinely gone from disk. Checked directly against the
  // row's own stored `path` via fs.existsSync, NOT against this run's
  // grace-filtered `onDisk` list.
  //
  // BUG (Atlas 2026-09-26, caught live registering the p22 TREC video): the
  // original version cleared anything absent from `stillOrphaned`, and
  // `stillOrphaned` is built from `onDisk`, which EXCLUDES a file re-written
  // in the last ORPHAN_GRACE_MINUTES (mtime too fresh, "might still be
  // writing"). A re-render that refreshes mtime — exactly what happened when
  // p22's hook was fixed and the file re-rendered — made the file
  // temporarily invisible to this scan, which this logic then read as
  // "resolved" and deleted the tracking row for a video that was STILL
  // unregistered. That is the exact silent-failure class this whole system
  // exists to prevent, just moved one layer down.
  //
  // BUG #2 (Atlas 2026-09-26, caught running the same script from Windows-
  // native node against rows written by a WSL node invocation): `row.path`
  // is an ABSOLUTE path captured at write time from THAT run's __dirname —
  // `/mnt/c/Users/Heath/...` under WSL, `C:\Users\Heath\...` under native
  // Windows node for the identical file. This script is meant to run
  // unattended via Windows Task Scheduler (see header) while videos also get
  // registered from Claude Code's WSL session — a guaranteed environment
  // mismatch. Trusting the stored string meant fs.existsSync(row.path)
  // returned false for every WSL-written row checked from Windows (or vice
  // versa) and this "self-heal" silently deleted the tracking row for a
  // file that was STILL sitting there unregistered — the exact failure mode
  // BUG #1 above already named, one layer up. Fix: never trust the stored
  // path for existence — recompute it from THIS run's own WATCH_DIRS (which
  // already resolves correctly in whichever environment is currently
  // running) using the row's id (stem) + target_owner, and check that.
  const expectedPathFor = (row) => {
    const watch = WATCH_DIRS.find((w) => w.owner === row.target_owner) || WATCH_DIRS[0];
    return path.join(watch.dir, `${row.id}.mp4`);
  };
  const toClear = (existingOrphans || [])
    .filter((row) => registeredIds.has(row.id) || !fs.existsSync(expectedPathFor(row)))
    .map((row) => row.id);

  console.log(`New orphan(s) to track: ${newOrphans.map((f) => f.stem).join(', ') || 'none'}`);
  console.log(`Orphan(s) to clear (registered or gone from disk): ${toClear.join(', ') || 'none'}`);

  if (dryRun) {
    console.log('--dry-run: no writes made');
    return;
  }

  for (const f of newOrphans) {
    const { ok, status, data } = await sb('local_video_orphans', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ id: f.stem, path: f.full, target_owner: f.owner }),
    });
    if (!ok) console.error(`  ERROR inserting orphan ${f.stem}: ${status} ${JSON.stringify(data).slice(0, 200)}`);
    else console.log(`  tracked: ${f.stem} (${f.full})`);
  }

  for (const id of toClear) {
    const { ok, status, data } = await sb(`local_video_orphans?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    });
    if (!ok) console.error(`  ERROR clearing orphan ${id}: ${status} ${JSON.stringify(data).slice(0, 200)}`);
    else console.log(`  cleared: ${id}`);
  }

  // Touch last_checked_at on everything still open, so a human looking at the
  // table can tell the scanner is alive vs. simply not running.
  if (stillOrphaned.length) {
    const stillOrphanedIds = stillOrphaned.map((f) => f.stem);
    await sb(`local_video_orphans?id=in.(${stillOrphanedIds.map(encodeURIComponent).join(',')})`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ last_checked_at: new Date().toISOString() }),
    });
  }

  console.log(`\nStill unregistered (${stillOrphaned.length}): ${stillOrphaned.map((f) => f.stem).join(', ') || 'none'}`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
