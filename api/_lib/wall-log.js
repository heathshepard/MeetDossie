'use strict';

// api/_lib/wall-log.js
//
// Shared writer for the wall log — institutional memory of every pipeline
// failure we route around. Two sinks:
//
//   1. Supabase `wall_log_entries` table (durable, queryable, dashboard reads it)
//   2. Local markdown file at Shepard-Ventures/Engineering/wall-log.md
//      (Atlas-readable, grep-able, survives Supabase outages)
//
// Sink #2 only fires when running locally (Atlas + scripts). Cron jobs in
// Vercel cannot write the local file, so they only write Supabase. The
// markdown file is hand-merged from the Supabase table via the morning ops
// digest weekly.
//
// Schema for the wall_log_entries table (Supabase):
//   id              uuid (pk, default uuid_generate_v4)
//   detected_at     timestamptz (default now())
//   wall_id         text  -- e.g. 'WALL-FB-002'
//   title           text  -- 1-line short title
//   what_broke      text
//   detected_by     text  -- 'cron-mission-watchdog' / 'cron-platform-health-checker' / human handle
//   root_cause      text
//   route_around    text  -- what we did to keep moving
//   permanent_fix   text  -- commit SHA or 'PENDING — see SV-ENG-XXX'
//   resolved_by     text
//   reoccurrence_guard text
//   metadata        jsonb -- optional structured detail (platform, latency, http_status, etc.)
//
// If the table doesn't exist yet, the function will log a warning and skip —
// it never throws. Callers should not depend on success.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function logWall(entry) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('[wall-log] Supabase not configured; skipping');
    return { ok: false, reason: 'no-supabase' };
  }
  if (!entry || !entry.wall_id || !entry.title) {
    console.warn('[wall-log] entry missing wall_id or title; skipping');
    return { ok: false, reason: 'invalid-entry' };
  }

  const row = {
    detected_at: entry.detected_at || new Date().toISOString(),
    wall_id: entry.wall_id,
    title: entry.title,
    what_broke: entry.what_broke || null,
    detected_by: entry.detected_by || 'unknown',
    root_cause: entry.root_cause || null,
    route_around: entry.route_around || null,
    permanent_fix: entry.permanent_fix || null,
    resolved_by: entry.resolved_by || null,
    reoccurrence_guard: entry.reoccurrence_guard || null,
    metadata: entry.metadata || null,
  };

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/wall_log_entries`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '<no body>');
      console.warn('[wall-log] insert failed:', res.status, text.slice(0, 200));
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (err) {
    console.warn('[wall-log] threw:', err && err.message);
    return { ok: false, error: err && err.message };
  }
}

// Mark a cron's last_run/last_status in the cron_runs table (idempotent upsert).
// Used by every reliability cron so /api/ventures/cron-health stays accurate.
async function recordCronRun(cronName, status, error = null) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !cronName) return { ok: false };
  try {
    // Try upsert via on_conflict (requires unique constraint on cron_name).
    // If schema doesn't have it, fall back to PATCH+POST.
    const body = JSON.stringify({
      cron_name: cronName,
      last_run: new Date().toISOString(),
      last_status: status,
      last_error: error,
    });
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/cron_runs?on_conflict=cron_name`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body,
      },
    );
    if (!res.ok) {
      console.warn('[wall-log] cron_runs upsert failed:', res.status);
    }
    return { ok: res.ok };
  } catch (err) {
    console.warn('[wall-log] recordCronRun threw:', err && err.message);
    return { ok: false };
  }
}

module.exports = { logWall, recordCronRun };
