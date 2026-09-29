const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { getRepoConfig } = require('./_lib/tracked-repos.js');

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
// This cron runs every 15 min (vercel.json schedule, tightened 2026-08-06 —
// was hourly at :10, which left up to ~59 min of stale "pending" rows in the
// Jarvis UI after a direct `git push origin main` bypass; Quinn caught 8 such
// rows mid-window on 2026-08-06). For every merge_queue row where
// merged_to_main=false, it asks GitHub whether that SHA is an ancestor of
// main. If YES, flip merged_to_main=true and fill merged_at from the actual
// commit-on-main timestamp (best-effort via compare API).
//
// GENERALIZED TO MULTI-REPO 2026-08-13 (Carter, SV-ENG-MERGE-QUEUE-MULTI-REPO):
// each row now carries its own `repo` column (see api/_lib/tracked-repos.js);
// the GitHub compare call below uses row.repo instead of a single hardcoded
// constant, and main_branch comes from that repo's tracked config (falls
// back to 'main' for any legacy/untracked repo value).
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
// Auth: Bearer ${CRON_SECRET} OR x-vercel-cron header.
// Schedule: vercel.json — this handler is a member of cron-dispatch-every15's
// group (api/_lib/cron-multiplex.js), fired at */15 * * * *.
//
// ─── 2026-09-29 REWRITE (Atlas) — TIME-BUDGET INCIDENT ───────────────────────
// Measured live against prod: 102 pending rows, MAX_ROWS_PER_TICK=100, one
// SEQUENTIAL GitHub compare call per row with NO fetch timeout — this file's
// own prior comment admitted "~50s worst case at ~500ms/GH call." Written for
// a once-daily schedule (`0 11 * * *`), then moved into the */15 dispatcher
// group (40s maxDuration, shared with 7 other members) without re-sizing.
// Root cause of the every15 flood: see docs in api/_lib/cron-multiplex.js and
// api/cron-dispatch-every15.js.
//
// What changed:
//   1. MAX_ROWS_PER_TICK 100 -> 15.
//   2. Wall-clock DEADLINE_MS=12000 budget: the row loop stops STARTING new
//      work once elapsed exceeds this, and returns 200 with
//      { deadline_hit: true, scanned, flipped, remaining } — idempotent and
//      resumable, so a partial pass on any given tick is correct, not a
//      failure. The next tick (15 min later) picks up where this one left
//      off (ordering below keeps never-checked rows first).
//   3. AbortSignal.timeout(6000) on both the GitHub compare fetch and every
//      Supabase REST call — an abort is handled as an ordinary error, same
//      {ok:false} shape as any other failure (see ghFetch/sb).
//   4. Concurrency: rows are processed CONCURRENCY_LIMIT=5 at a time instead
//      of one-at-a-time, while still respecting the deadline.
//   5. BACKOFF (the drain problem): a row whose compare comes back
//      diverged/behind, or whose sha 404s, is not actually resolvable by
//      waiting 15 more minutes — it needs a human (rebase/close/direct-push
//      correction), not a re-check. Without backoff the same ~100 rows were
//      re-scanned every single tick forever. Inspected the live schema first
//      (no existing "last checked"/"attempt count" column on merge_queue) —
//      added next_check_after + check_count (see supabase/migrations/
//      20260929_merge_queue_backoff.sql, applied via
//      api/admin-migrate-merge-queue-backoff.js, same pattern as every other
//      admin-migrate-*.js in this repo because PostgREST can't run DDL).
//      FEATURE-DETECTED at runtime (fetchPending() below): if those columns
//      don't exist yet on a given deploy, the rich query 400s and this falls
//      straight back to the exact original unconditional-rescan query — never
//      crashes, just loses the backoff optimization until the migration is
//      applied. Never-checked rows (next_check_after IS NULL) always sort
//      first regardless.
//      Backoff schedule: 15min * 2^check_count, capped at 24h. A row that
//      just got queued (never checked) is checked on the very next tick, the
//      same as today; a row that has failed to resolve 4 ticks running (1hr)
//      backs off to 4h, then 8h, capped at a day — recheck resumes instantly
//      if `merge-to-main.js`'s own flip beats this cron to it, since that
//      path is untouched and still the primary writer.

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;
const GITHUB_TOKEN              = process.env.GITHUB_TOKEN;

const DEFAULT_REPO = 'heathshepard/MeetDossie';
const POLL_NAME   = 'cron-merge-queue-backfill';
const MAX_ROWS_PER_TICK = 15;
const DEADLINE_MS = 12000;
const FETCH_TIMEOUT_MS = 6000;
const CONCURRENCY_LIMIT = 5;
const BACKOFF_BASE_MIN = 15;   // matches the cron's own cadence
const BACKOFF_CAP_MIN = 1440;  // 24h

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
    const res = await fetch(`${SUPABASE_URL}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    return { ok: res.ok, status: res.status, data, raw: text ? text.slice(0, 400) : '' };
  } catch (err) {
    // AbortSignal.timeout() rejects with a DOMException named 'TimeoutError'
    // (or 'AbortError' on older runtimes) — folded into the same {ok:false}
    // shape as every other network failure. No caller needs to special-case
    // an abort vs. a DNS failure vs. anything else.
    return { ok: false, status: 0, data: null, error: String((err && err.message) || err) };
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
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: String((err && err.message) || err) };
  }
}

// Returns { merged: boolean, committed_at: string|null, error?: string }
async function isShaInMain(repo, mainBranch, sha) {
  if (!sha || typeof sha !== 'string') return { merged: false, error: 'bad_sha' };
  // Compare sha...main:
  //   identical  -> sha IS main head  -> merged
  //   ahead      -> main is ahead of sha -> sha in main history -> merged
  //   behind     -> sha ahead of main -> not merged
  //   diverged   -> different lineage -> not merged
  const { ok, status, data, error } = await ghFetch(
    `/repos/${repo}/compare/${sha}...${mainBranch}`,
  );
  if (!ok) {
    // 404 => sha doesn't exist at all in the repo -> treat as not-mergeable-here.
    // status===0 => network error / abort -> transient, no special-casing needed.
    return { merged: false, error: status ? `compare_${status}` : `compare_fetch_failed:${error}` };
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

// ─── Backoff ──────────────────────────────────────────────────────────────────

function computeBackoff(row) {
  const priorCount = Number(row.check_count) || 0;
  const delayMin = Math.min(BACKOFF_BASE_MIN * (2 ** priorCount), BACKOFF_CAP_MIN);
  return {
    check_count: priorCount + 1,
    next_check_after: new Date(Date.now() + delayMin * 60000).toISOString(),
  };
}

// ─── Row fetch (feature-detects next_check_after/check_count) ────────────────

async function fetchPending(nowIso) {
  const richSelect = 'id,commit_sha,repo,committed_at,next_check_after,check_count';
  const richFilter = [
    'merged_to_main=eq.false',
    `or=(next_check_after.is.null,next_check_after.lte.${encodeURIComponent(nowIso)})`,
    'order=next_check_after.asc.nullsfirst,created_at.asc',
    `limit=${MAX_ROWS_PER_TICK}`,
  ].join('&');

  const rich = await sb(`/rest/v1/merge_queue?select=${richSelect}&${richFilter}`);
  if (rich.ok) {
    return { rows: Array.isArray(rich.data) ? rich.data : [], backoffColumns: true };
  }

  // Fallback: backoff columns not present yet (migration not applied on this
  // deploy) or some other selectable-column mismatch. Behave exactly like
  // the pre-2026-09-29 query — correct, just without the backoff skip.
  const legacy = await sb(
    `/rest/v1/merge_queue?select=id,commit_sha,repo,committed_at&merged_to_main=eq.false&order=created_at.asc&limit=${MAX_ROWS_PER_TICK}`,
  );
  if (!legacy.ok) {
    return { rows: null, backoffColumns: false, error: legacy.error || legacy.status };
  }
  return { rows: Array.isArray(legacy.data) ? legacy.data : [], backoffColumns: false };
}

// ─── Row processing ───────────────────────────────────────────────────────────

async function processRow(row, backoffColumns, dryRun) {
  const repo = row.repo || DEFAULT_REPO;
  const cfg = getRepoConfig(repo);
  const mainBranch = (cfg && cfg.main_branch) || 'main';
  const check = await isShaInMain(repo, mainBranch, row.commit_sha);

  const entry = {
    repo,
    sha: row.commit_sha.slice(0, 7),
    merged: check.merged,
    status: check.status,
    error: check.error,
  };

  if (check.merged) {
    if (dryRun) return { ...entry, outcome: 'flipped' };
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
    if (patch.ok) return { ...entry, outcome: 'flipped' };
    return { ...entry, outcome: 'flip_failed', failure: { id: row.id, sha: row.commit_sha, error: `patch_${patch.status}` } };
  }

  // Not merged. Apply backoff so this row isn't rechecked every single tick
  // forever (the drain problem) — best-effort, never fails the row over it.
  if (backoffColumns && !dryRun) {
    const b = computeBackoff(row);
    await sb(`/rest/v1/merge_queue?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(b),
    });
  }

  if (check.error) {
    return { ...entry, outcome: 'error', failure: { id: row.id, sha: row.commit_sha, error: check.error } };
  }
  return { ...entry, outcome: 'pending' };
}

/** Bounded concurrency, deadline-aware. Never starts new work past `deadlineAt`;
 *  in-flight work (bounded by FETCH_TIMEOUT_MS per call) is allowed to finish. */
async function processAll(rows, deadlineAt, backoffColumns, dryRun) {
  let cursor = 0;
  let deadlineHit = false;
  const results = [];

  async function worker() {
    for (;;) {
      if (Date.now() >= deadlineAt) { deadlineHit = true; return; }
      if (cursor >= rows.length) return;
      const row = rows[cursor];
      cursor += 1;
      const r = await processRow(row, backoffColumns, dryRun);
      results.push(r);
    }
  }

  const n = Math.min(CONCURRENCY_LIMIT, rows.length);
  await Promise.all(Array.from({ length: n }, worker));
  return { results, deadlineHit, remaining: rows.length - results.length };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

module.exports = withTelemetry(POLL_NAME, async function handler(req, res) {
  const t0 = Date.now();
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

  // 1. Fetch pending rows (feature-detects backoff columns).
  const { rows: pending, backoffColumns, error: fetchError } = await fetchPending(new Date().toISOString());
  if (pending === null) {
    return res.status(500).json({ ok: false, error: 'pending_list_failed', detail: fetchError });
  }
  if (pending.length === 0) {
    return res.status(200).json({ ok: true, pending: 0, flipped: 0, backoff_columns: backoffColumns, note: 'no_pending_rows' });
  }

  // 2. Process with bounded concurrency, respecting the deadline budget.
  const deadlineAt = t0 + DEADLINE_MS;
  const { results, deadlineHit, remaining } = await processAll(pending, deadlineAt, backoffColumns, dryRun);

  const flipped = results.filter((r) => r.outcome === 'flipped').length;
  const stillPending = results.filter((r) => r.outcome === 'pending' || r.outcome === 'error' || r.outcome === 'flip_failed').length;
  const failures = results.filter((r) => r.failure).map((r) => r.failure);

  return res.status(200).json({
    ok: true,
    dry_run: dryRun,
    deadline_hit: deadlineHit,
    backoff_columns: backoffColumns,
    scanned: results.length,
    remaining,
    flipped,
    still_pending: stillPending,
    duration_ms: Date.now() - t0,
    failures: failures.slice(0, 10),
    results: results.slice(0, 20),
  });
});
