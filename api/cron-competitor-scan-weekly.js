'use strict';

// api/cron-competitor-scan-weekly.js
// =============================================================================
// Phase 6 — Continuous competitor scan.
// Sundays 8pm CDT (01 UTC Mon). Refreshes the competitor_tracked_accounts
// list before Sage's Monday batch. Delegates the deep-scrape work to the
// Claude Code CLI worker (Max-billed, no per-token spend).
//
// Behavior:
//   1. Seed: on first-run, ingest the manual JSON at
//      Shepard-Ventures/Marketing/sage/competitors-live.json (if present).
//   2. Enqueue a 'competitor_scan' task with the current active tracked list +
//      a hashtag-discovery list. Worker returns:
//        { retained[], new_discovered[], dormant[], viral_posts[] }.
//   3. Worker updates competitor_tracked_accounts:
//        - new_discovered -> status='active', discovery_source='hashtag_scan'
//        - dormant (>30d no post) -> status='dormant'
//   4. Worker inserts viral_posts into social_posts as source_type='competitor_remix'
//      with status='draft' so Sage's remix pass sees them on Monday morning.
//   5. Report written to Shepard-Ventures/Marketing/sage/
//      competitor-intel-weekly-YYYY-MM-DD.md.
//
// Schedule: "0 1 * * 1" (00:00 CDT Sun→01:00 UTC Mon actually 20:00 CDT Sun).
//   Cron notation: "0 1 * * 1" = 01:00 UTC every Monday = 20:00 CDT Sunday.
// Owner: Atlas 2026-07-08.
//
// 2026-07-10 (Sage): extended payload for per-account scan_targets. Accounts
// whose metadata.scan_targets is populated (e.g., coordi.me — web +
// instagram + meta_ads) get a dedicated deep-scan: homepage capture, pricing
// page diff vs prior week, Meta Ad Library creative pull, and per-creative
// hook analysis. Snapshots land in Supabase Storage bucket
// `competitor-snapshots/<handle>/<YYYY-MM-DD>/`. Change events routed to
// sage_weekly_reviews with severity {critical|notable|informational}.
// =============================================================================

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

async function sb(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function enqueueClaudeCodeTask(host, body) {
  const res = await fetch(`${host}/api/claude-code-enqueue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CRON_SECRET}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  // Load the active tracked list. Handler will re-scan each + hunt neighbors.
  // metadata included so worker sees per-account scan_targets (Coordi et al.).
  const trackedR = await sb(
    `competitor_tracked_accounts?select=id,platform,handle,category,followers,last_scanned_at,last_post_at,discovery_source,metadata&status=eq.active&limit=200`
  );
  if (!trackedR.ok) {
    return res.status(500).json({ ok: false, error: `tracked_query_failed:${trackedR.status}` });
  }
  const tracked = Array.isArray(trackedR.data) ? trackedR.data : [];

  // Hashtag discovery seeds — worker will search each on each platform.
  // Keep these Texas/REALTOR/TC-adjacent so we surface the right competitors.
  const DISCOVERY_HASHTAGS = {
    tiktok: ['#realtorlife', '#txrealestate', '#txrealtor', '#realtortok', '#transactioncoordinator'],
    instagram: ['#realtorlife', '#txrealtor', '#realestateagent', '#transactioncoordinator'],
    youtube: ['realtor tips', 'transaction coordinator', 'texas realtor'],
    facebook: ['#realtorlife', '#transactioncoordinator'],
  };

  const weekOfIso = new Date().toISOString().slice(0, 10);
  const host = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;

  // Per-account scan directives. Any account whose metadata.scan_targets is
  // set gets a dedicated deep-scan pass (homepage/pricing/ad-library/etc).
  // Worker must:
  //   1. Fetch each scan_target URL, capture the fields listed in `capture`.
  //   2. Save raw HTML + captured JSON to Supabase Storage bucket
  //      `competitor-snapshots/<handle>/<YYYY-MM-DD>/<target_type>.{html,json}`.
  //   3. If `diff: true`, load prior-week snapshot for same target; compute
  //      diff; on any change (or when `diff_alert_on` is set), insert a row
  //      into sage_weekly_reviews with recommendations text prefixed
  //      "[competitor_change:<handle>]" and week_start/week_end for this run.
  //      Severity heuristic: pricing change or new tier = critical;
  //      new creative/copy = notable; anything else = informational.
  //   4. For meta_ads targets with analyze.output='hook_adaptations_for_dossie',
  //      run per-creative Claude analysis (pain lead, positioning, CTA,
  //      emotional beat) and insert one row per creative into
  //      sage_intelligence.recommendations JSON (or the accepted follow-up
  //      table if agent_suggestions ships) with author='sage' and
  //      source_handle=<handle>.
  const snapshot_bucket = 'competitor-snapshots';

  const enq = await enqueueClaudeCodeTask(host, {
    task_type: 'competitor_scan',
    agent_name: 'sage',
    priority: 3,
    title: `Sage competitor scan ${weekOfIso}`,
    description: 'Weekly deep-scan of tracked competitor accounts + hashtag discovery. Update tracked list, seed viral remixes. For accounts with metadata.scan_targets (e.g., coordi.me), run homepage/pricing/Meta-Ad-Library capture + diff vs prior week + hook analysis per creative.',
    idempotency_key: `competitor_scan:${weekOfIso}`,
    payload: {
      week_of: weekOfIso,
      tracked,
      tracked_count: tracked.length,
      discovery_hashtags: DISCOVERY_HASHTAGS,
      dormant_threshold_days: 30,
      viral_min_likes: 500,
      viral_min_share_ratio: 0.02,
      snapshot_bucket,
      snapshot_path_template: `${snapshot_bucket}/<handle>/${weekOfIso}/<target_type>`,
      diff_review_table: 'sage_weekly_reviews',
      diff_severity_rules: {
        critical: ['pricing_change', 'new_tier', 'tier_removed'],
        notable: ['new_ad_creative', 'new_headline', 'homepage_h1_change'],
        informational: ['bio_change', 'follower_delta', 'copy_tweak'],
      },
      // Safety guardrails per mission spec.
      never_scrape_authenticated: true,
      never_signup_real_identity: true,
      never_copy_verbatim: true,
    },
  });

  if (!enq.ok) {
    return res.status(502).json({ ok: false, error: 'enqueue_failed', detail: enq.data });
  }

  return res.status(200).json({
    ok: true,
    week_of: weekOfIso,
    tracked_count: tracked.length,
    queue_id: enq.data && enq.data.queue_id,
  });
}

module.exports = withTelemetry('cron-competitor-scan-weekly', handler);
