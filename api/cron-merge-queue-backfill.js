const { withTelemetry } = require('./_lib/cron-telemetry.js');

'use strict';

// api/cron-merge-queue-backfill.js
//
// SV-ENG-MERGE-QUEUE-BACKFILL (Atlas, 2026-07-06)
//
// PURPOSE: Backstop the merge_queue post-merge writer.
//
// ROOT CAUSE FIXED:
// merge_queue rows default to merged_to_main=false. The primary post-merge
// writer lives in /api/merge-to-main, which flips the flag when Heath clicks
// the Merge button in /today. BUT: when Heath (or an agent) merges directly
// via `git push origin main` on the CLI — bypassing the API — the row stays
// false forever. Over ~2 weeks, 85 rows accumulated, bloating the Jarvis
// merge-queue UI.
//
// FIX:
// This cron runs daily at 6:00 AM CDT (11:00 UTC). For every merge_queue
// row where merged_to_main=false, it asks GitHub whether that SHA is an
// ancestor of main. If YES, flip merged_to_main=true and fill merged_at
// from the actual commit-on-main timestamp (best-effort via compare API).
//
// Uses the same GitHub Compare API pattern as merge-to-main.js:
//   GET /repos/:owner/:repo/compare/:sha...main
//   - status = "identical"  -> sha IS main HEAD, definitely merged
//   - status = "ahead"      -> main is ahead of sha, meaning sha IS in main's
//                              history (unless force-push scenario)
//   - status = "behind"     -> sha is ahead of main -> NOT merged
//   - status = "diverged"   -> sha is on a different branch / never merged
//
// Only "identical" and "ahead" mean merged. Everything else stays pending.
//
// Idempotent: rows already merged_to_main=true are skipped by the query.
// Safe to re-run.
//
// Cost: ~1 GitHub API call per pending row per day. Well under rate limits.
//
// Auth: Bearer ${CRON_SECRET} OR x-vercel-cron header.
// Schedule: vercel.json `0 11 * * *` (daily 11:00 UTC = 6 AM CDT).

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;
const GITHUB_TOKEN              = process.env.GITHUB_TOKEN;

const GITHUB_REPO = 'heathshepard/MeetDossie';
const MAIN_BRANCH = 'main';
const POLL_NAME   = 'cron-merge-queue-backfill';
const MAX_ROWS_PER_TICK = 100; // hard cap; ~50s worst case at ~500ms/GH call

// ─── Supabase ─────────────────────────────────────────────────────────────────

async function sb(path, init = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, status: 0, data: null, error: 'missing_supabase_env' };
  }
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  try {
    const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: String(err && err.message || err) };
  }
}

// ─── GitHub ───────────────────────────────────────────────────────────────────

async function ghFetch(path) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'meetdossie-merge-queue-backfill',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

// Returns { merged: boolean, committed_at: string|null, error?: string }
async function isShaInMain(sha) {
  if (!sha || typeof sha !== 'string') return { merged: false, error: 'bad_sha' };
  // Compare sha...main:
  //   identical  -> sha IS main head  -> merged
  //   ahead      -> main is ahead of sha -> sha in main history -> merged
  //   behind     -> sha ahead of main -> not merged
  //   diverged   -> different lineage -> not merged
  const { ok, status, data } = await ghFetch(
    `/repos/${GITHUB_REPO}/compare/${sha}...${MAIN_BRANCH}`,
  );
  if (!ok) {
    // 404 => sha doesn't exist at all in the repo -> treat as not-mergeable-here.
    return { merged: false, error: `compare_${status}` };
  }
  const s = data && data.status;
  const merged = s === 'identical' || s === 'ahead';
  // committed_at: pull from the commit itself if we can. compare returns
  // base_commit for the sha side.
  let committed_at = null;
  if (data && data.base_commit && data.base_commit.commit && data.base_commit.commit.committer) {
    committed_at = data.base_commit.commit.committer.date || null;
  }
  return { merged, committed_at, status: s };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

module.exports = withTelemetry(POLL_NAME, async function handler(req, res) {
  const auth = req.headers.authorization || '';
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const isCronSecret = CRON_SECRET && auth === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isCronSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) {
    return res.status(500).json({ ok: false, error: `missing_env:${missing.join(',')}` });
  }

  // Optional dry-run mode: ?dry=1 (report but don't write)
  const url = new URL(req.url || '/', 'https://x');
  const dryRun = url.searchParams.get('dry') === '1';

  // 1. Fetch pending rows
  const listRes = await sb(
    `/rest/v1/merge_queue?select=id,commit_sha,committed_at&merged_to_main=eq.false&order=created_at.asc&limit=${MAX_ROWS_PER_TICK}`,
  );
  if (!listRes.ok) {
    return res.status(500).json({ ok: false, error: 'pending_list_failed', detail: listRes.error || listRes.status });
  }
  const pending = Array.isArray(listRes.data) ? listRes.data : [];
  if (pending.length === 0) {
    return res.status(200).json({ ok: true, pending: 0, flipped: 0, note: 'no_pending_rows' });
  }

  // 2. For each, ask GitHub whether it's in main
  let flipped = 0;
  let stillPending = 0;
  const failures = [];
  const results = [];

  for (const row of pending) {
    const check = await isShaInMain(row.commit_sha);
    results.push({
      sha: row.commit_sha.slice(0, 7),
      merged: check.merged,
      status: check.status,
      error: check.error,
    });

    if (check.error && !check.merged) {
      failures.push({ id: row.id, sha: row.commit_sha, error: check.error });
      stillPending += 1;
      continue;
    }

    if (!check.merged) {
      stillPending += 1;
      continue;
    }

    // Flip merged_to_main = true
    if (dryRun) {
      flipped += 1;
      continue;
    }

    const patch = await sb(`/rest/v1/merge_queue?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        merged_to_main: true,
        merged_at: check.committed_at || row.committed_at || new Date().toISOString(),
        merged_by_user_id: 'cron-backfill',
        updated_at: new Date().toISOString(),
      }),
    });
    if (patch.ok) {
      flipped += 1;
    } else {
      failures.push({ id: row.id, sha: row.commit_sha, error: `patch_${patch.status}` });
      stillPending += 1;
    }
  }

  return res.status(200).json({
    ok: true,
    dry_run: dryRun,
    scanned: pending.length,
    flipped,
    still_pending: stillPending,
    failures: failures.slice(0, 10),
    results: results.slice(0, 20),
  });
});
