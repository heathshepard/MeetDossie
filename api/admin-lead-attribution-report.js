// api/admin-lead-attribution-report.js
//
// Single assembled report for "is the marketing engine producing real
// business" — Heath's instrumentation ask, 2026-10-02 (feat/lead-
// attribution-1002). Read-only. Changes nothing, enqueues nothing, sends
// nothing. Combines:
//
//   1. Dossie funnel (api/_lib/attribution.js) — content -> click -> trial
//      start -> paying subscriber, plus lead-magnet (waitlist) signups.
//   2. Brokerage funnel (api/_lib/brokerage-funnel.js) — heath-realtor
//      content -> comment-to-DM lead. Downstream of the DM is explicitly
//      marked unattributable by this repo (see that file).
//   3. Checkpoint scoring against the ALREADY-SET Day 30/60/90 targets from
//      the 2026-09-26 social growth plan (memory: social-growth-research-
//      2026-09-26.md) — campaign start 2026-09-26, not a rolling window, so
//      "30+ emails by Day 30" means cumulative waitlist signups since
//      campaign start, not signups in the last 30 days from whenever this
//      runs.
//
// WHAT THIS CANNOT CHECK (said outright, never silently skipped): FB
// reach/Reel, personal IG skip rate, YouTube Shorts median views, and
// personal IG follower count are platform-analytics numbers (Meta/YouTube
// dashboards) that live nowhere in this Supabase project or in PostHog —
// this file has no credential or table to read them from. Those three Day
// 60/90 checkpoint items are reported as "not Supabase-queryable", not
// guessed at or left implying zero.
//
// Auth: Authorization: Bearer ${CRON_SECRET} (same pattern as every other
// admin-* endpoint in this repo — read-only, so no ops_flags/SOCIAL_RUNNER
// gate applies).
//
// Owner: Pierce, 2026-10-02 (feat/lead-attribution-1002)

const { getAttributionSummary } = require('./_lib/attribution.js');
const { getBrokerageFunnelSummary } = require('./_lib/brokerage-funnel.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

// Social growth plan start date — memory social-growth-research-2026-09-26.md
// ("Targets set... Day 30 = ... Day 60 = ... Day 90 = ..."). The Day 30/60/90
// checkpoints are cumulative from THIS date, not a rolling N-day window.
const CAMPAIGN_START = '2026-09-26T00:00:00.000Z';

async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

function daysSince(iso) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000));
}

// Cumulative waitlist count since campaign start, ACROSS every source (the
// growth plan's "emails" target is total list growth, not Dossie-funnel-
// specific) — degrades the same explicit way as attribution.js's
// waitlist_tracking if the table/columns aren't queryable.
async function getCumulativeWaitlistCount() {
  const res = await sb(`/rest/v1/waitlist?created_at=gte.${encodeURIComponent(CAMPAIGN_START)}&select=id`);
  if (!res.ok) return { ok: false, count: null, error: `status ${res.status}` };
  return { ok: true, count: Array.isArray(res.data) ? res.data.length : null };
}

// Comment-engine health since campaign start — thread_status is guaranteed
// to exist (base column, not optional), unlike reply_status enum values
// this file doesn't want to guess at.
async function getCommentReplyCounts() {
  const res = await sb(`/rest/v1/social_comment_replies?comment_created_at=gte.${encodeURIComponent(CAMPAIGN_START)}&select=id,thread_status`);
  if (!res.ok) return { ok: false, error: `status ${res.status}` };
  const rows = Array.isArray(res.data) ? res.data : [];
  return {
    ok: true,
    total: rows.length,
    closed: rows.filter((r) => r.thread_status === 'closed').length,
    open: rows.filter((r) => r.thread_status === 'open').length,
  };
}

function scoreCheckpoint(label, dayTarget, elapsed, checks) {
  if (elapsed < dayTarget) {
    return { label, status: 'too early to call', elapsed_days: elapsed, target_day: dayTarget, checks };
  }
  const allMet = checks.every((c) => c.met !== false);
  return { label, status: allMet ? 'on track' : 'missed on at least one item', elapsed_days: elapsed, target_day: dayTarget, checks };
}

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  const elapsed = daysSince(CAMPAIGN_START);

  const [dossie30, dossieSinceStart, brokerage30, brokerageSinceStart, waitlistCum, commentReplies] = await Promise.all([
    getAttributionSummary({ days: 30 }),
    getAttributionSummary({ days: Math.max(elapsed, 1) }),
    getBrokerageFunnelSummary({ days: 30 }),
    getBrokerageFunnelSummary({ days: Math.max(elapsed, 1) }),
    getCumulativeWaitlistCount(),
    getCommentReplyCounts(),
  ]);

  const day30 = scoreCheckpoint('Day 30 — execution', 30, elapsed, [
    { item: 'DM funnel live (>=1 armed comment-to-DM automation producing leads)', met: brokerageSinceStart.leads_total > 0, value: brokerageSinceStart.leads_total },
    { item: '30+ emails (cumulative waitlist signups since campaign start, all sources)', met: waitlistCum.ok ? waitlistCum.count >= 30 : null, value: waitlistCum.ok ? waitlistCum.count : 'unavailable' },
    { item: '23 comments answered', met: commentReplies.ok ? commentReplies.closed >= 23 : null, value: commentReplies.ok ? commentReplies.closed : 'unavailable' },
  ]);

  const day60 = scoreCheckpoint('Day 60 — reach', 60, elapsed, [
    { item: 'FB reach/Reel >500', met: null, value: 'not Supabase-queryable — Meta dashboard only' },
    { item: 'personal IG skip rate <60%', met: null, value: 'not Supabase-queryable — Meta dashboard only' },
    { item: 'Shorts median views >1,000', met: null, value: 'not Supabase-queryable — YouTube Studio only' },
    { item: '100+ emails (cumulative)', met: waitlistCum.ok ? waitlistCum.count >= 100 : null, value: waitlistCum.ok ? waitlistCum.count : 'unavailable' },
  ]);

  const day90 = scoreCheckpoint('Day 90 — proof', 90, elapsed, [
    { item: 'one video >5,000 views', met: null, value: 'not Supabase-queryable — platform dashboards only' },
    { item: '300+ emails (cumulative)', met: waitlistCum.ok ? waitlistCum.count >= 300 : null, value: waitlistCum.ok ? waitlistCum.count : 'unavailable' },
    { item: '10+ trials', met: dossieSinceStart.totals.trial_starts_total >= 10, value: dossieSinceStart.totals.trial_starts_total },
    { item: 'personal IG +150 followers', met: null, value: 'not Supabase-queryable — Meta dashboard only' },
  ]);

  return res.status(200).json({
    ok: true,
    generated_at: new Date().toISOString(),
    campaign_start: CAMPAIGN_START,
    days_elapsed: elapsed,
    checkpoints: { day30, day60, day90 },
    dossie_funnel: {
      last_30d: dossie30,
      since_campaign_start: dossieSinceStart,
    },
    brokerage_funnel: {
      last_30d: brokerage30,
      since_campaign_start: brokerageSinceStart,
    },
    cumulative_waitlist_since_campaign_start: waitlistCum,
    comment_replies_since_campaign_start: commentReplies,
    what_this_cannot_measure: [
      'Cross-device / delayed-search attribution: someone sees a Reel, searches Heath\'s name days later on a different device, and calls — no last-click or first/last-touch model in this repo can join that path. Honest gap, not a bug.',
      'Instagram and TikTok caption links are never clickable (api/_lib/content-tag.js) — clicks from those platforms will always read 0/untracked regardless of real engagement.',
      'Platform-native reach/views/follower metrics (Meta, YouTube) are not in this Supabase project or PostHog — see the day60/day90 "not Supabase-queryable" items above.',
      'Brokerage funnel downstream of the DM (reply, appointment, listing/buyer agreement, closing) has no automated event source anywhere and is only as current as a manual comment_dm_leads.outcome update, if that migration is even applied — see brokerage_funnel.*.downstream_tracking.',
    ],
  });
};
