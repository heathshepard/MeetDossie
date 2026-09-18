'use strict';

// api/_lib/silence-alarm.js
//
// Shared detection logic for api/cron-silence-alarm.js. Split out so the
// conditions can be unit-tested against a mock PostgREST server without
// spinning up the whole cron handler (see
// scripts/regression-silence-alarm.js).
//
// Heath, 2026-09-12: three separate silent failures hit him this week and
// nobody noticed until he said something. This is the monitor that closes
// that gap — checked conditions:
//   1. Platform silence — no successful post on a (platform, target_owner)
//      pair in N days (default 3), even though that pair is clearly still
//      "in use" (has recent generation activity).
//   2. Approvals sitting >48h without publishing.
//   3. Drafts sitting >24h that were never even sent to Telegram for review.
//   4. A status accumulating rows without moving — the exact
//      video_failed/pending_video pattern that jammed Instagram/TikTok, PLUS
//      video_library rows stuck at pending_heath_review (sent to Telegram,
//      never tapped).
//
// Dedup: api/_lib/weekly-batch-digest.js's sibling table, alert_state — one
// row per condition key, alerts only if not already fired in the last
// ALERT_COOLDOWN_HOURS.
//
// Owner: Carter, 2026-09-12

const { scanCronSanity } = require('./cron-sanity.js');
const { listGoalSetKeys } = require('./social-goals.js');
const { getAttributionSummary } = require('./attribution.js');
const { computeGoalProgress } = require('./social-goals-progress.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SILENCE_DAYS_DEFAULT = 3;
const APPROVAL_STALE_HOURS = 48;
const DRAFT_STALE_HOURS = 24;
const BACKLOG_THRESHOLD = 5;
const VIDEO_REVIEW_STALE_HOURS = 48;
// Carter, 2026-09-17: pending_approval is a dead end for any row that didn't
// arrive there via api/cron-video-approval.js's own PATCH — see
// checkVideoLibraryPendingApprovalStale()'s header comment. 7 days is
// deliberately much longer than VIDEO_REVIEW_STALE_HOURS's 48h: a
// pending_review row is a known-good state waiting on a human tap (should
// resolve fast), whereas pending_approval can legitimately sit for the
// ~24h between cron-video-approval.js's daily run and Heath's reply — 7 days
// is "something is actually wrong," not "he hasn't checked Telegram yet today."
const PENDING_APPROVAL_STALE_DAYS = 7;
const ALERT_COOLDOWN_HOURS = 20; // < 24 so a once-daily cron always re-fires next day, never skips one

// scripts/harvest-tc-discovery-responses.js's own HOT_WINDOW_MS/HOT_INTERVAL_MS
// (48h hot window, 45-min cadence within it) — duplicated as plain hours here
// rather than imported, so this file never pulls in that script's playwright
// dependency chain into the Vercel bundle.
const TC_HARVEST_HOT_WINDOW_HOURS = 48;
const TC_HARVEST_HOT_STALE_HOURS = 24; // Heath's ask, 2026-09-15: no host harvest in 24h -> alert
const TC_HARVEST_SCOPE_GAP_HOURS = 3; // a posted row should get its first harvest pass well inside this

// Comments awaiting a reply decision sitting unattended (Carter, 2026-09-16
// heartbeat build). Two separate reply pipelines exist and are counted
// separately in the heartbeat, not merged:
//   - tc_discovery_responses.reply_status='notified' — TC-discovery FB group
//     host comments, Heath notified via Telegram, awaiting approve/skip.
//   - social_comment_replies.reply_status='draft' — organic FB/IG/TikTok
//     comment replies drafted by the Claude Code worker, awaiting posting.
const COMMENT_REPLY_STALE_HOURS = 24;

// The gap checkCommentsAwaitingReplyStale() cannot see: it only looks at
// reply_status='notified' (Heath WAS pinged, hasn't tapped a button yet).
// A row can also get stuck at reply_status='new' FOREVER without ever
// reaching 'notified' — draft + classify can succeed while the Telegram
// notify step silently fails (send throws, or telegram-gate suppresses it)
// and the row is simply never retried into anyone's view. Found 2026-09-17:
// 14 real comments sat at 'new' for up to 22h, harvester kept adding more on
// top, cron_runs said 'ok' every 30 minutes, and nothing surfaced this until
// Heath asked why nobody got answered. A stale 'new' row with the harvester
// still actively inserting siblings is the "worse than notified-and-ignored"
// case — it means the notify step itself is broken, not that Heath is slow.
const NEW_COMMENT_NEVER_NOTIFIED_STALE_HOURS = 3;

// A reply SUBMIT happened but verification could not confirm it landed --
// the "submitted-but-not-found" terminal outcome from the 2026-09-17
// false-'posted' fix (scripts/_lib/fb-post-verify-outcome.js,
// scripts/fb-reply-poster.js, scripts/fb-group-commenter.js --tc-reply-queue).
// These rows are deliberately NEVER auto-retried (Heath's "never retry an
// unverified send" rule — a retry could double-post if the original submit
// actually landed), which means without this alarm a genuinely-unanswered
// commenter sits forever with nothing surfacing it again after the one-time
// Telegram notice sent at the moment it happened.
const REPLY_UNVERIFIED_STALE_HOURS = 24;

// Comment-opportunity pipeline (scripts/fb-comment-hunt-daily.js ->
// api/cron-comment-opp-approval.js -> scripts/fb-comment-opp-poster.js) gone
// silent (Carter, 2026-09-17): a GLOBAL halt sat from 2026-09-15 to
// 2026-09-17 with the scanner finding ZERO new candidates and 2 Heath-
// approved comments never posting, and nobody noticed until Heath asked —
// the exact "silent failure" shape this file exists to catch, just not yet
// wired up for this pipeline.
const COMMENT_OPP_SCANNER_STALE_HOURS = 24;
const COMMENT_OPP_APPROVED_STALE_HOURS = 24;

// (platform, target_owner) pairs worth tracking. Kept explicit (not derived
// from zernio_accounts) so a brand-new/experimental owner doesn't silently
// start alerting before anyone's decided it should be monitored — see
// docs/PIPELINE.md "SOCIAL MEDIA ACCOUNTS" / "ZERNIO ACCOUNT IDs" for the
// live account roster this mirrors.
const TRACKED_PAIRS = [
  { platform: 'facebook', target_owner: 'dossie' },
  { platform: 'instagram', target_owner: 'dossie' },
  { platform: 'twitter', target_owner: 'dossie' },
  { platform: 'linkedin', target_owner: 'dossie' },
  { platform: 'tiktok', target_owner: 'dossie' },
  // YouTube was missing from this list until 2026-09-16, which is exactly why
  // nobody noticed it had NEVER published a single post. The channel
  // (@meetdossie) has been connected to Zernio with the youtube.upload scope
  // since 2026-05-29, but ZERNIO_ACCOUNTS.youtube read an env var
  // (ZERNIO_YOUTUBE_ACCOUNT_ID) that was never set in Vercel, and
  // zernio_accounts held the literal string
  // 'PLACEHOLDER_SET_ZERNIO_YOUTUBE_ACCOUNT_ID' with is_active=false. Account
  // resolution therefore returned null and every YouTube target failed
  // silently. An untracked platform cannot go "silent" — it just never
  // existed as far as the alarm was concerned. That is the precise shape of
  // failure feedback_silent-failure-is-the-enemy.md exists to prevent.
  { platform: 'youtube', target_owner: 'dossie' },
  { platform: 'facebook', target_owner: 'heath-realtor' },
  { platform: 'instagram', target_owner: 'heath-realtor' },
];

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

function hoursAgoIso(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function daysAgoIso(days) {
  return hoursAgoIso(days * 24);
}

// ─── condition detectors ──────────────────────────────────────────────────

// 1. Platform silence.
async function checkPlatformSilence(silenceDays = SILENCE_DAYS_DEFAULT) {
  const results = [];
  const sinceRecentActivity = daysAgoIso(30);
  const sinceThreshold = daysAgoIso(silenceDays);

  for (const { platform, target_owner } of TRACKED_PAIRS) {
    const ownerFilter = `&target_owner=eq.${encodeURIComponent(target_owner)}`;

    // Only alert on pairs with real recent generation activity — otherwise
    // a pair that's intentionally dormant (e.g. no content plan yet) would
    // alarm forever.
    const activity = await supabaseFetch(
      `/rest/v1/social_posts?platform=eq.${encodeURIComponent(platform)}${ownerFilter}` +
      `&created_at=gte.${encodeURIComponent(sinceRecentActivity)}&select=id&limit=1`,
    );
    const hasRecentActivity = activity.ok && Array.isArray(activity.data) && activity.data.length > 0;
    if (!hasRecentActivity) continue;

    const lastPosted = await supabaseFetch(
      `/rest/v1/social_posts?platform=eq.${encodeURIComponent(platform)}${ownerFilter}` +
      `&status=eq.posted&select=posted_at&order=posted_at.desc&limit=1`,
    );
    const lastPostedAt = lastPosted.ok && Array.isArray(lastPosted.data) && lastPosted.data[0]
      ? lastPosted.data[0].posted_at
      : null;

    const silent = !lastPostedAt || lastPostedAt < sinceThreshold;
    if (!silent) continue;

    // Likely-reason: what's actually backed up for this pair right now.
    const backlog = await supabaseFetch(
      `/rest/v1/social_posts?platform=eq.${encodeURIComponent(platform)}${ownerFilter}` +
      `&status=in.(pending_video,video_failed,draft,approved)&select=status`,
    );
    const counts = {};
    if (backlog.ok && Array.isArray(backlog.data)) {
      for (const row of backlog.data) counts[row.status] = (counts[row.status] || 0) + 1;
    }
    const reasonParts = Object.entries(counts).map(([status, n]) => `${n} ${status}`);
    const reason = reasonParts.length ? reasonParts.join(', ') + ' rows sitting unpublished' : 'no backlog found — check Zernio connection';

    const days = lastPostedAt
      ? Math.floor((Date.now() - new Date(lastPostedAt).getTime()) / (24 * 60 * 60 * 1000))
      : null;

    results.push({
      key: `silence:${platform}:${target_owner}`,
      platform,
      target_owner,
      last_posted_at: lastPostedAt,
      days_silent: days,
      reason,
      message: `${platform}${target_owner !== 'dossie' ? ` (${target_owner})` : ''} has not posted in ${days != null ? `${days} days` : 'ever'} (last: ${lastPostedAt || 'never'}). Likely reason: ${reason}.`,
    });
  }
  return results;
}

// 2. Approvals older than 48h still not published.
async function checkStaleApprovals(staleHours = APPROVAL_STALE_HOURS) {
  const cutoff = hoursAgoIso(staleHours);
  const results = [];

  const social = await supabaseFetch(
    `/rest/v1/social_posts?status=eq.approved&approved_at=lt.${encodeURIComponent(cutoff)}&select=id,platform,approved_at&order=approved_at.asc`,
  );
  if (social.ok && Array.isArray(social.data) && social.data.length > 0) {
    results.push({
      key: 'approvals_stale:social_posts',
      count: social.data.length,
      oldest: social.data[0],
      message: `${social.data.length} social_posts row(s) approved >${staleHours}h ago still not published (oldest: ${social.data[0].platform}, approved ${social.data[0].approved_at}).`,
    });
  }

  const group = await supabaseFetch(
    `/rest/v1/group_posts?status=eq.approved&approved_at=lt.${encodeURIComponent(cutoff)}&select=id,group_name,approved_at&order=approved_at.asc`,
  );
  if (group.ok && Array.isArray(group.data) && group.data.length > 0) {
    results.push({
      key: 'approvals_stale:group_posts',
      count: group.data.length,
      oldest: group.data[0],
      message: `${group.data.length} group_posts row(s) approved >${staleHours}h ago still not posted (oldest: ${group.data[0].group_name}, approved ${group.data[0].approved_at}).`,
    });
  }

  return results;
}

// 2b. Group posting has gone quiet — no group_posts row has actually
// reached status='posted' in GROUP_POSTING_SILENCE_HOURS, while there IS
// real approved (or draft-with-nothing-approved) content sitting waiting.
// checkStaleApprovals/checkStaleDrafts above catch individual stale rows,
// but neither one answers "is the pipeline moving AT ALL" — a day where
// every group's draft gets rejected/skipped (never approved) would sail
// through both of those checks with zero alerts while zero posts go out.
// Distinguishes two real causes so the alert names the right thing to look
// at: content sitting APPROVED and simply not draining (queue/scheduler/
// circuit-breaker problem — scripts/fb-group5-post-queue.js,
// scripts/fb-listing-group-post-queue.js) vs nothing ever getting approved
// at all (Heath backlog or a broken notify step — same failure class fixed
// in api/_lib/telegram-gate.js's 2026-09-17 job-context bug, see that
// file's header). Deliberately does NOT fire on a day with truly nothing
// generated and nothing approved (e.g. every group hard-blocked by content
// gates) — that is a content-supply problem, not a "posting has gone
// quiet while work waits" problem, and alarming on it would just be noise
// the model architecture change (fix the generator) is the real answer to.
const GROUP_POSTING_SILENCE_HOURS = 24;

async function checkGroupPostingSilence(staleHours = GROUP_POSTING_SILENCE_HOURS) {
  const results = [];
  const cutoff = hoursAgoIso(staleHours);

  const recentlyPosted = await supabaseFetch(
    `/rest/v1/group_posts?status=eq.posted&posted_at=gte.${encodeURIComponent(cutoff)}&select=id&limit=1`,
  );
  const hasPostedRecently = recentlyPosted.ok && Array.isArray(recentlyPosted.data) && recentlyPosted.data.length > 0;
  if (hasPostedRecently) return results; // pipeline is moving — nothing to say

  const approvedWaiting = await supabaseFetch(
    `/rest/v1/group_posts?status=eq.approved&select=id,group_name,approved_at&order=approved_at.asc`,
  );
  const approvedRows = approvedWaiting.ok && Array.isArray(approvedWaiting.data) ? approvedWaiting.data : [];

  const undispositionedDrafts = await supabaseFetch(
    `/rest/v1/group_posts?status=eq.draft&created_at=gte.${encodeURIComponent(daysAgoIso(7))}&select=id&limit=1`,
  );
  const hasRecentDrafts = undispositionedDrafts.ok && Array.isArray(undispositionedDrafts.data) && undispositionedDrafts.data.length > 0;

  // Nothing approved AND nothing even drafted this week — genuinely quiet
  // pipeline (content-supply problem, not a stuck-queue problem). Still
  // worth naming, just distinctly.
  if (approvedRows.length === 0 && !hasRecentDrafts) {
    results.push({
      key: 'group_posting_silent:no_supply',
      count: 0,
      message: `No group_posts row has posted in >${staleHours}h AND nothing is approved or has even been drafted in the last 7 days — the generator itself has gone quiet (check api/cron-daily-group5-posts.js / scripts/listing-marketing-generate-live.js cron_runs).`,
    });
    return results;
  }

  if (approvedRows.length > 0) {
    results.push({
      key: 'group_posting_silent:approved_not_draining',
      count: approvedRows.length,
      oldest: approvedRows[0],
      message: `No group_posts row has posted in >${staleHours}h, but ${approvedRows.length} row(s) sit approved and waiting (oldest: "${approvedRows[0].group_name}", approved ${approvedRows[0].approved_at || 'unknown'}). Check scripts/fb-group5-post-queue.js / scripts/fb-listing-group-post-queue.js are actually running on their Task Scheduler tick, and the shared circuit breaker (scripts/_lib/comment-hunt-halt.js) isn't halted.`,
    });
  } else {
    results.push({
      key: 'group_posting_silent:nothing_approved',
      count: 0,
      message: `No group_posts row has posted in >${staleHours}h and nothing is currently approved, even though drafts exist from the last 7 days — content is being generated but never approved. Check the Telegram approval cards are actually reaching Heath (telegram-gate job-name gating, cron_runs for cron-daily-group5-posts) and clear the draft backlog.`,
    });
  }

  return results;
}

// 3. Drafts older than 24h never sent for approval.
async function checkStaleDrafts(staleHours = DRAFT_STALE_HOURS) {
  const cutoff = hoursAgoIso(staleHours);
  const results = [];

  const social = await supabaseFetch(
    `/rest/v1/social_posts?status=eq.draft&telegram_sent_at=is.null&created_at=lt.${encodeURIComponent(cutoff)}&select=id,platform,created_at&order=created_at.asc`,
  );
  if (social.ok && Array.isArray(social.data) && social.data.length > 0) {
    results.push({
      key: 'drafts_stale:social_posts',
      count: social.data.length,
      oldest: social.data[0],
      message: `${social.data.length} social_posts draft(s) >${staleHours}h old were never sent to Telegram for approval (oldest: ${social.data[0].platform}, created ${social.data[0].created_at}).`,
    });
  }

  const group = await supabaseFetch(
    `/rest/v1/group_posts?status=eq.draft&telegram_sent_at=is.null&created_at=lt.${encodeURIComponent(cutoff)}&select=id,group_name,created_at&order=created_at.asc`,
  );
  if (group.ok && Array.isArray(group.data) && group.data.length > 0) {
    results.push({
      key: 'drafts_stale:group_posts',
      count: group.data.length,
      oldest: group.data[0],
      message: `${group.data.length} group_posts draft(s) >${staleHours}h old were never sent to Telegram for approval (oldest: ${group.data[0].group_name}, created ${group.data[0].created_at}).`,
    });
  }

  return results;
}

// 4a. A status accumulating rows without moving — video_failed/pending_video
// pattern on social_posts, per platform.
async function checkAccumulatingBacklog(threshold = BACKLOG_THRESHOLD) {
  const results = [];
  const res = await supabaseFetch(
    `/rest/v1/social_posts?status=in.(pending_video,video_failed)&select=platform,status`,
  );
  if (!res.ok || !Array.isArray(res.data)) return results;

  const counts = {};
  for (const row of res.data) {
    const k = `${row.platform}:${row.status}`;
    counts[k] = (counts[k] || 0) + 1;
  }
  for (const [k, count] of Object.entries(counts)) {
    if (count < threshold) continue;
    const [platform, status] = k.split(':');
    results.push({
      key: `backlog:${platform}:${status}`,
      platform,
      status,
      count,
      message: `${count} ${platform} rows stuck at status='${status}' — accumulating without moving.`,
    });
  }
  return results;
}

// 4b. video_library rows stuck at pending_heath_review (already sent to
// Telegram, waiting on a tap) — the exact mechanism that silenced the
// Instagram/TikTok mobile-cut feature-demo videos in Sept 2026.
async function checkVideoLibraryPendingReview(staleHours = VIDEO_REVIEW_STALE_HOURS) {
  const cutoff = hoursAgoIso(staleHours);
  const res = await supabaseFetch(
    `/rest/v1/video_library?status=eq.pending_heath_review&created_at=lt.${encodeURIComponent(cutoff)}&select=id,topic,platforms,created_at&order=created_at.asc`,
  );
  if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) return [];
  const platforms = new Set();
  for (const row of res.data) {
    for (const p of (row.platforms || [])) platforms.add(p);
  }
  return [{
    key: 'video_library_pending_review',
    count: res.data.length,
    oldest: res.data[0],
    message: `${res.data.length} video(s) in video_library sitting >${staleHours}h at pending_heath_review, targeting [${[...platforms].join(', ') || 'unknown'}] — already sent to Telegram, waiting on your Approve tap (oldest: ${res.data[0].topic}, created ${res.data[0].created_at}).`,
  }];
}

// 4c. video_library rows stuck at pending_approval past
// PENDING_APPROVAL_STALE_DAYS (default 7) — the dead-end status Carter found
// 2026-09-17: 9 rows sat here for up to 4 months because pending_approval is
// only ever a CRON-WRITTEN transient state (api/cron-video-approval.js
// PATCHes a 'ready' row to pending_approval right before sending the
// Telegram Approve/Reject message) — nothing ever re-reads a row that a
// caller drops directly into pending_approval, so a miswired ingestion path
// (scripts/feature-demo-publish.js used to do exactly this) produces a row
// with no Telegram message ever sent (telegram_message_id stays null) and no
// cron that will ever look at it again. Distinct from
// checkVideoLibraryPendingReview() above: that one catches a row that WAS
// sent to Telegram and is waiting on a tap; this one catches a row that may
// never have been sent at all. Both are worth knowing, so both alarms run.
async function checkVideoLibraryPendingApprovalStale(staleDays = PENDING_APPROVAL_STALE_DAYS) {
  const cutoff = hoursAgoIso(staleDays * 24);
  const res = await supabaseFetch(
    `/rest/v1/video_library?status=eq.pending_approval&created_at=lt.${encodeURIComponent(cutoff)}&select=id,topic,platforms,telegram_message_id,created_at&order=created_at.asc`,
  );
  if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) return [];
  const neverSent = res.data.filter((r) => !r.telegram_message_id).length;
  return [{
    key: 'video_library_pending_approval_stale',
    count: res.data.length,
    oldest: res.data[0],
    message: `${res.data.length} video(s) in video_library stuck at pending_approval for >${staleDays}d (${neverSent} never got a Telegram message at all — telegram_message_id is null, meaning nothing ever sent them to you) — oldest: ${res.data[0].topic}, created ${res.data[0].created_at}. This status is a dead end unless a cron actively moves it; check whether the ingestion path that created these skipped api/cron-video-approval.js's 'ready' entry point.`,
  }];
}

// 5. TC-discovery/group-post HOST COMMENT HARVEST gone silent while a post
// is still in its hot window (Heath, 2026-09-15: people commenting on our
// own FB group posts and never getting a reply, because the harvester
// running on Heath's PC via Task Scheduler had no way to distinguish
// "correctly waiting for its next cadence tick" from "actually dead"). Only
// checks posts still inside the 48h hot window (45-min harvest cadence) —
// a post past that window legitimately goes days between harvests (3-day
// long-tail cadence), so silence there is NOT alarm-worthy and checking it
// would false-positive constantly.
async function checkTcHarvestHotWindowStale(staleHours = TC_HARVEST_HOT_STALE_HOURS, hotWindowHours = TC_HARVEST_HOT_WINDOW_HOURS) {
  const hotSince = hoursAgoIso(hotWindowHours);
  const staleCutoff = hoursAgoIso(staleHours);

  const res = await supabaseFetch(
    `/rest/v1/group_posts?status=eq.posted&post_url=not.is.null&posted_at=gte.${encodeURIComponent(hotSince)}`
    + '&select=id,group_name,category,post_url,posted_at,last_harvested_at,harvest_count&order=posted_at.asc',
  );
  if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) return [];

  // Only rows with a REAL permalink are harvestable at all — a group-URL
  // fallback row (see checkTcHarvestScopeGap()) would never show a harvest
  // regardless of whether the task is alive, so it can't be used as
  // evidence the harvester died.
  const eligible = res.data.filter((p) => /\/posts\/\d+/.test(String(p.post_url || '')));
  if (eligible.length === 0) return [];

  const freshest = eligible.reduce((max, p) => {
    const t = p.last_harvested_at ? new Date(p.last_harvested_at).getTime() : 0;
    return t > max ? t : max;
  }, 0);

  if (freshest >= new Date(staleCutoff).getTime()) return []; // something harvested recently enough — healthy

  const oldest = eligible.reduce((o, p) => (!o || p.posted_at < o.posted_at ? p : o), null);
  return [{
    key: 'tc_harvest_hot_window_stale',
    count: eligible.length,
    oldest,
    message: `${eligible.length} FB group post(s) still in their 48h hot window have had NO host-comment harvest in >${staleHours}h (oldest: "${oldest.group_name}", posted ${oldest.posted_at}). Check the "Dossie TC Discovery Harvest" Windows Task Scheduler task is actually running (Get-ScheduledTaskInfo) — scripts/harvest-tc-discovery-harvest.cmd should tick every 30 min.`,
  }];
}

// 6. SCOPE GAP — a posted row that should have gotten at least its first
// harvest pass by now but never has (harvest_count 0/null or
// last_harvested_at null). This is the exact bug found live 2026-09-15: the
// harvester's category filter silently excluded 4 of the last 10 posts
// (daily5/listing-groups/heath_realtor_listing) from ever being scanned —
// harvest_count stayed 0 forever with no signal anywhere. Also separately
// flags rows whose post_url has no real /posts/<id> permalink (the
// fb-group-poster.js group-URL fallback) — those can NEVER be harvested
// until re-posted, a different problem from "just hasn't run yet".
async function checkTcHarvestScopeGap(staleHours = TC_HARVEST_SCOPE_GAP_HOURS) {
  const cutoff = hoursAgoIso(staleHours);
  const res = await supabaseFetch(
    `/rest/v1/group_posts?status=eq.posted&post_url=not.is.null&posted_at=lt.${encodeURIComponent(cutoff)}`
    + '&select=id,group_name,category,post_url,posted_at,last_harvested_at,harvest_count&order=posted_at.asc',
  );
  if (!res.ok || !Array.isArray(res.data)) return [];

  const neverHarvested = res.data.filter((p) => !p.last_harvested_at && !p.harvest_count);
  if (neverHarvested.length === 0) return [];

  const noPermalink = neverHarvested.filter((p) => !/\/posts\/\d+/.test(String(p.post_url || '')));
  const scopeGap = neverHarvested.filter((p) => /\/posts\/\d+/.test(String(p.post_url || '')));

  const results = [];
  if (scopeGap.length > 0) {
    const groups = [...new Set(scopeGap.map((p) => `${p.group_name}${p.category ? ` (${p.category})` : ''}`))];
    results.push({
      key: 'tc_harvest_scope_gap',
      count: scopeGap.length,
      groups,
      message: `${scopeGap.length} posted group_posts row(s) >${staleHours}h old have NEVER been harvested for host comments: ${groups.join(', ')}. If the harvester's own category/pipeline filter changed, these are falling outside it — check scripts/harvest-tc-discovery-responses.js fetchCampaignPosts().`,
    });
  }
  if (noPermalink.length > 0) {
    const groups = [...new Set(noPermalink.map((p) => `${p.group_name}${p.category ? ` (${p.category})` : ''}`))];
    results.push({
      key: 'tc_harvest_no_permalink',
      count: noPermalink.length,
      groups,
      message: `${noPermalink.length} posted group_posts row(s) have no real post permalink captured (post_url falls back to the group URL) and can NEVER be auto-harvested for comments: ${groups.join(', ')}. This is scripts/fb-group-poster.js's permalink-capture-failed fallback — comments on these posts need a manual check.`,
    });
  }
  return results;
}

// 7. Comments notified/drafted but sitting >24h without a decision — the
// harvest/draft step worked, but nobody acted, which from Heath's side
// looks identical to "nobody's watching the group." Read-only against
// tables owned by the comment/reply pipeline (cron-comment-monitor.js,
// telegram-webhook.js, scripts/harvest-tc-discovery-responses.js) — this
// file never writes to either table, only counts.
async function checkCommentsAwaitingReplyStale(staleHours = COMMENT_REPLY_STALE_HOURS) {
  const cutoff = hoursAgoIso(staleHours);
  const results = [];

  const tc = await supabaseFetch(
    `/rest/v1/tc_discovery_responses?reply_status=eq.notified&created_at=lt.${encodeURIComponent(cutoff)}&select=id,commenter_name,created_at&order=created_at.asc`,
  );
  if (tc.ok && Array.isArray(tc.data) && tc.data.length > 0) {
    results.push({
      key: 'comments_awaiting_reply:tc_discovery',
      count: tc.data.length,
      oldest: tc.data[0],
      message: `${tc.data.length} TC-discovery comment(s) notified >${staleHours}h ago with no approve/skip decision (oldest: ${tc.data[0].commenter_name || 'unknown'}, notified ${tc.data[0].created_at}).`,
    });
  }

  const social = await supabaseFetch(
    `/rest/v1/social_comment_replies?reply_status=eq.draft&created_at=lt.${encodeURIComponent(cutoff)}&select=id,created_at&order=created_at.asc`,
  );
  if (social.ok && Array.isArray(social.data) && social.data.length > 0) {
    results.push({
      key: 'comments_awaiting_reply:social',
      count: social.data.length,
      oldest: social.data[0],
      message: `${social.data.length} drafted comment reply(s) sitting >${staleHours}h without posting (oldest drafted ${social.data[0].created_at}).`,
    });
  }

  return results;
}

// 8a. Comments stuck at 'new'/'flagged' that never even reached 'notified' —
// see NEW_COMMENT_NEVER_NOTIFIED_STALE_HOURS above for why this is a
// separate, worse condition than checkCommentsAwaitingReplyStale's
// already-notified case. Also reports whether the harvester is STILL adding
// rows on top of the stuck backlog (the exact "actively getting worse, not
// just old" signal from the 2026-09-17 incident) by checking for any row
// harvested more recently than the oldest stuck one.
async function checkNewCommentsNeverNotifiedStale(staleHours = NEW_COMMENT_NEVER_NOTIFIED_STALE_HOURS) {
  const cutoff = hoursAgoIso(staleHours);
  const results = [];

  const stuck = await supabaseFetch(
    '/rest/v1/tc_discovery_responses?reply_status=in.(new,flagged)&reply_notified_at=is.null'
    + `&is_own_comment=eq.false&harvested_at=lt.${encodeURIComponent(cutoff)}`
    + '&select=id,commenter_name,harvested_at,reply_status&order=harvested_at.asc',
  );
  if (!stuck.ok || !Array.isArray(stuck.data) || stuck.data.length === 0) return results;

  const oldest = stuck.data[0];
  const growing = await supabaseFetch(
    '/rest/v1/tc_discovery_responses?is_own_comment=eq.false'
    + `&harvested_at=gt.${encodeURIComponent(oldest.harvested_at)}&select=id&limit=1`,
  );
  const stillGrowing = growing.ok && Array.isArray(growing.data) && growing.data.length > 0;

  results.push({
    key: 'new_comments_never_notified:tc_discovery',
    count: stuck.data.length,
    oldest,
    message: `${stuck.data.length} tc_discovery_responses comment(s) stuck at '${oldest.reply_status}' >${staleHours}h with NO Telegram notification ever sent (oldest: reply to ${oldest.commenter_name || 'unknown'}, harvested ${oldest.harvested_at}).`
      + (stillGrowing
        ? ' The harvester has added MORE comments on top of this backlog since — the notify step is broken, not just slow. Check cron-tc-reply-approval / telegram-gate.'
        : ''),
  });
  return results;
}

// 8b. Reply SUBMITS that could not be verified, sitting stale. Terminal by
// design (never auto-retried — see REPLY_UNVERIFIED_STALE_HOURS above), so
// this is the only thing that will ever surface them again after the
// one-time Telegram notice sent at the moment it happened. Covers both
// reply pipelines:
//   - fb_comment_replies.status='failed' with reply_error carrying the
//     'unconfirmed_submit' marker (scripts/fb-reply-poster.js markUnconfirmed,
//     2026-09-17 fix).
//   - tc_discovery_responses.reply_status='post_failed' with reply_error
//     starting 'submitted but' (scripts/fb-group-commenter.js
//     --tc-reply-queue's pre-existing verifier, 2026-09-08) — the SAME
//     terminal shape, just an older pipeline that had no stale-alarm either.
// Does NOT include a genuinely clean failure (reply_error 'not_submitted:'
// on tc_discovery_responses, or a pre-submit retry left at status='approved'
// on fb_comment_replies) — those are safe-to-retry-or-already-actioned, not
// "may have actually posted and nobody would ever know."
async function checkUnverifiedRepliesStuck(staleHours = REPLY_UNVERIFIED_STALE_HOURS) {
  const cutoff = hoursAgoIso(staleHours);
  const results = [];

  const legacy = await supabaseFetch(
    `/rest/v1/fb_comment_replies?status=eq.failed&reply_error=like.*unconfirmed_submit*`
    + `&posted_at=lt.${encodeURIComponent(cutoff)}&select=id,reply_author,posted_at&order=posted_at.asc`,
  );
  if (legacy.ok && Array.isArray(legacy.data) && legacy.data.length > 0) {
    results.push({
      key: 'unverified_reply_stuck:fb_comment_replies',
      count: legacy.data.length,
      oldest: legacy.data[0],
      message: `${legacy.data.length} fb_comment_replies row(s) submitted >${staleHours}h ago but never verified in the thread (oldest: reply to ${legacy.data[0].reply_author || 'unknown'}, submitted ${legacy.data[0].posted_at}). Terminal by design — will NOT auto-retry (may have actually posted). Check Facebook manually.`,
    });
  }

  const tc = await supabaseFetch(
    `/rest/v1/tc_discovery_responses?reply_status=eq.post_failed&reply_error=like.*submitted but*`
    + `&updated_at=lt.${encodeURIComponent(cutoff)}&select=id,commenter_name,updated_at&order=updated_at.asc`,
  );
  if (tc.ok && Array.isArray(tc.data) && tc.data.length > 0) {
    results.push({
      key: 'unverified_reply_stuck:tc_discovery_responses',
      count: tc.data.length,
      oldest: tc.data[0],
      message: `${tc.data.length} tc_discovery_responses reply(s) submitted >${staleHours}h ago but never verified in the thread (oldest: reply to ${tc.data[0].commenter_name || 'unknown'}, last touched ${tc.data[0].updated_at}). Terminal by design — will NOT auto-retry (may have actually posted). Check Facebook manually.`,
    });
  }

  return results;
}

// 8. Static vercel.json scan — schedules effectively disabled by syntax
// (fixed dom+month = fires ~once/year, the exact 2026-07 shutdown trick) or
// pointing at a handler file that no longer exists. See api/_lib/cron-
// sanity.js for the detection logic. Fires at most once per cooldown window
// per distinct issue (keyed by path+type) so a genuinely-intentional rare
// cron doesn't need to be re-acknowledged daily forever — but Heath should
// see it at least once.
// 9a. The daily comment-opportunity SCANNER has gone silent — zero new
// candidates found in COMMENT_OPP_SCANNER_STALE_HOURS. Only alerts if the
// pipeline has real history (has ever inserted a row) so a pipeline that's
// never been turned on doesn't alarm forever. This is precisely the
// 2026-09-15 -> 2026-09-17 gap: fb-comment-hunt-daily.js checks the GLOBAL
// halt before it does anything else and exits silently on every 30-min tick
// while halted — "nothing new found" produced no signal anywhere on its own.
async function checkCommentOppScannerSilence(staleHours = COMMENT_OPP_SCANNER_STALE_HOURS) {
  const everActive = await supabaseFetch('/rest/v1/comment_opportunities?select=id&limit=1');
  if (!everActive.ok || !Array.isArray(everActive.data) || everActive.data.length === 0) return [];

  const cutoff = hoursAgoIso(staleHours);
  const recent = await supabaseFetch(
    `/rest/v1/comment_opportunities?found_at=gte.${encodeURIComponent(cutoff)}&select=id&limit=1`,
  );
  if (recent.ok && Array.isArray(recent.data) && recent.data.length > 0) return []; // healthy

  const lastFound = await supabaseFetch(
    '/rest/v1/comment_opportunities?select=found_at,group_name&order=found_at.desc&limit=1',
  );
  const last = lastFound.ok && Array.isArray(lastFound.data) ? lastFound.data[0] : null;

  return [{
    key: 'comment_opp_scanner_silent',
    lastFoundAt: last ? last.found_at : null,
    message: `The daily comment-opportunity scanner (scripts/fb-comment-hunt-daily.js) has found ZERO new candidates in >${staleHours}h`
      + `${last ? ` (last found ${last.found_at} in "${last.group_name}")` : ''}. Check the "Dossie TC Discovery Harvest" `
      + 'Windows Task Scheduler task is actually ticking and whether scripts/.comment-hunt-halt.json has a GLOBAL halt set '
      + '(node scripts/fb-comment-opp-poster.js --dry-run shows it too).',
  }];
}

// 9b. Heath APPROVED a comment in Telegram and it never posted —
// COMMENT_OPP_APPROVED_STALE_HOURS past approval. Almost always means the
// halt is set (global or for that row's own group) or the DossieBot-Sage
// profile is stuck; either way it's an "approved but nothing happens" gap
// Heath should never have to notice himself.
async function checkCommentOppApprovedStale(staleHours = COMMENT_OPP_APPROVED_STALE_HOURS) {
  const cutoff = hoursAgoIso(staleHours);
  const res = await supabaseFetch(
    `/rest/v1/comment_opportunities?status=eq.approved&approved_at=lt.${encodeURIComponent(cutoff)}`
    + '&select=id,group_name,approved_at&order=approved_at.asc',
  );
  if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) return [];
  return [{
    key: 'comment_opp_approved_stale',
    count: res.data.length,
    oldest: res.data[0],
    message: `${res.data.length} Heath-approved comment(s) sitting >${staleHours}h without posting (oldest: "${res.data[0].group_name}", approved ${res.data[0].approved_at}). `
      + 'Check node scripts/fb-comment-opp-poster.js --dry-run and scripts/.comment-hunt-halt.json for a halt (global or scoped to that group).',
  }];
}

async function checkCronSanity(scanOpts) {
  const scan = scanCronSanity(scanOpts);
  if (!scan.ok) {
    return [{
      key: 'cron_sanity:scan_failed',
      message: `cron sanity scan could not run: ${scan.error}. If this is a live run (not local), check api/cron-silence-alarm.js's vercel.json includeFiles entry.`,
    }];
  }
  return scan.issues.map((issue) => ({
    key: `cron_sanity:${issue.path}:${issue.type}`,
    path: issue.path,
    schedule: issue.schedule,
    issue_type: issue.type,
    message: `vercel.json cron ${issue.path} (schedule "${issue.schedule}"): ${issue.detail}.`,
  }));
}

// ─── dedupe ────────────────────────────────────────────────────────────────

async function shouldFire(key) {
  const res = await supabaseFetch(`/rest/v1/alert_state?key=eq.${encodeURIComponent(key)}&select=last_fired_at`);
  if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) return true;
  const lastFiredAt = res.data[0].last_fired_at;
  if (!lastFiredAt) return true;
  return new Date(lastFiredAt).getTime() < Date.now() - ALERT_COOLDOWN_HOURS * 60 * 60 * 1000;
}

async function markFired(key, reason, metadata) {
  return supabaseFetch(`/rest/v1/alert_state?on_conflict=key`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      key,
      last_fired_at: new Date().toISOString(),
      last_reason: reason,
      metadata: metadata || null,
      updated_at: new Date().toISOString(),
    }),
  });
}

// Runs every detector, filters through dedupe, marks fired ones. Returns
// { fired: [...], suppressed: [...] } — suppressed = true but already
// alerted within the cooldown window.
async function runAllChecks(opts = {}) {
  const [silence, approvals, drafts, backlog, videoReview, videoPendingApprovalStale, tcHarvestStale, tcHarvestGap, commentsStale, newNeverNotified, unverifiedReplies, commentOppScannerSilent, commentOppApprovedStale, groupPostingSilent, cronSanity] = await Promise.all([
    checkPlatformSilence(opts.silenceDays),
    checkStaleApprovals(opts.approvalStaleHours),
    checkStaleDrafts(opts.draftStaleHours),
    checkAccumulatingBacklog(opts.backlogThreshold),
    checkVideoLibraryPendingReview(opts.videoReviewStaleHours),
    checkVideoLibraryPendingApprovalStale(opts.pendingApprovalStaleDays),
    checkTcHarvestHotWindowStale(opts.tcHarvestStaleHours, opts.tcHarvestHotWindowHours),
    checkTcHarvestScopeGap(opts.tcHarvestScopeGapHours),
    checkCommentsAwaitingReplyStale(opts.commentReplyStaleHours),
    checkNewCommentsNeverNotifiedStale(opts.newCommentNeverNotifiedStaleHours),
    checkUnverifiedRepliesStuck(opts.replyUnverifiedStaleHours),
    checkCommentOppScannerSilence(opts.commentOppScannerStaleHours),
    checkCommentOppApprovedStale(opts.commentOppApprovedStaleHours),
    checkGroupPostingSilence(opts.groupPostingSilenceHours),
    checkCronSanity(opts.cronSanityScanOpts),
  ]);

  const all = [...silence, ...approvals, ...drafts, ...backlog, ...videoReview, ...videoPendingApprovalStale, ...tcHarvestStale, ...tcHarvestGap, ...commentsStale, ...newNeverNotified, ...unverifiedReplies, ...commentOppScannerSilent, ...commentOppApprovedStale, ...groupPostingSilent, ...cronSanity];
  const fired = [];
  const suppressed = [];

  // dryRun is READ-ONLY: it must never consult or mutate alert_state. A
  // diagnostic peek marking a condition "fired" would make the NEXT real
  // run silently suppress it inside the cooldown window — dry_run would
  // itself become a silent-failure vector. Bug found + fixed same day it
  // shipped (Carter, 2026-09-12): a dry_run call ate 2 of the first real
  // alarm's conditions, including the video_library nudge.
  if (opts.dryRun) {
    return { fired: all, suppressed: [], totalConditions: all.length };
  }

  for (const condition of all) {
    const ok = await shouldFire(condition.key);
    if (ok) {
      fired.push(condition);
      await markFired(condition.key, condition.message, condition);
    } else {
      suppressed.push(condition);
    }
  }

  return { fired, suppressed, totalConditions: all.length };
}

// ─── heartbeat snapshot (always-shown state, independent of dedupe) ───────
//
// Everything in runAllChecks() above only surfaces once per
// ALERT_COOLDOWN_HOURS — right for an alarm, wrong for "what's the current
// state of the pipeline" which Heath should see every morning regardless of
// whether anything changed. This builds that snapshot fresh every call, no
// alert_state involvement, safe to call as often as needed (read-only).
async function buildHeartbeatSnapshot(cronSanityScanOpts) {
  const since24h = hoursAgoIso(24);
  const now = new Date();
  const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = now.toISOString();
  // End of TODAY (UTC calendar day) — narrower window than scheduled_next_7d,
  // for the "what's scheduled TODAY" line the morning brief spec asks for
  // (Heath, 2026-09-17).
  const endOfTodayIso = `${nowIso.slice(0, 10)}T23:59:59.999Z`;

  const [
    postedSocial,
    postedVideo,
    postedGroups,
    scheduledSocial,
    scheduledSocialToday,
    unscheduledDrafts,
    videoReady,
    approvedUnposted,
    pendingVideo,
    failedRecent,
    pendingAdminApproval,
    videoQualityHold,
    videoFailed,
    tcNotified,
    socialDraftReplies,
  ] = await Promise.all([
    supabaseFetch(`/rest/v1/social_posts?status=eq.posted&posted_at=gte.${encodeURIComponent(since24h)}&select=platform,target_owner`),
    supabaseFetch(`/rest/v1/video_library?status=eq.posted&posted_date=gte.${encodeURIComponent(since24h)}&select=platforms,target_owner`),
    supabaseFetch(`/rest/v1/group_posts?status=in.(posted,pending_admin_approval)&posted_at=gte.${encodeURIComponent(since24h)}&select=id`),
    supabaseFetch(`/rest/v1/social_posts?status=eq.approved&scheduled_for=gte.${encodeURIComponent(nowIso)}&scheduled_for=lt.${encodeURIComponent(in7d)}&select=platform,target_owner`),
    supabaseFetch(`/rest/v1/social_posts?status=eq.approved&scheduled_for=gte.${encodeURIComponent(nowIso)}&scheduled_for=lt.${encodeURIComponent(endOfTodayIso)}&select=platform,target_owner`),
    supabaseFetch(`/rest/v1/social_posts?status=eq.draft&select=id`),
    // Video quality gate (api/_lib/verify-video-quality.js) — only rows that
    // actually PASSED count as "ready", matching gateBeforePublish()'s own
    // fail-closed rule so this count can never overstate real supply.
    supabaseFetch(`/rest/v1/video_library?status=eq.heath_approved&quality_status=eq.passed&select=id`),
    supabaseFetch(`/rest/v1/social_posts?status=eq.approved&select=id`),
    supabaseFetch(`/rest/v1/social_posts?status=eq.pending_video&select=id`),
    supabaseFetch(`/rest/v1/social_posts?status=eq.failed&created_at=gte.${encodeURIComponent(daysAgoIso(7))}&select=id`),
    supabaseFetch(`/rest/v1/group_posts?status=eq.pending_admin_approval&select=id`),
    supabaseFetch(`/rest/v1/video_library?status=eq.quality_hold&select=id`),
    supabaseFetch(`/rest/v1/video_library?status=eq.failed&select=id`),
    supabaseFetch(`/rest/v1/tc_discovery_responses?reply_status=eq.notified&select=id`),
    supabaseFetch(`/rest/v1/social_comment_replies?reply_status=eq.draft&select=id`),
  ]);

  // Fold both posted-social and posted-video rows into one (platform,owner)
  // count map so a platform posting through EITHER pipeline shows up once.
  const postedByPlatform = new Map();
  const bump = (map, platform, owner, n = 1) => {
    if (!platform) return;
    const key = `${platform}:${owner || 'dossie'}`;
    map.set(key, (map.get(key) || 0) + n);
  };
  if (postedSocial.ok && Array.isArray(postedSocial.data)) {
    for (const row of postedSocial.data) bump(postedByPlatform, row.platform, row.target_owner);
  }
  if (postedVideo.ok && Array.isArray(postedVideo.data)) {
    for (const row of postedVideo.data) {
      for (const platform of (row.platforms || [])) bump(postedByPlatform, platform, row.target_owner);
    }
  }

  const scheduledByPlatform = new Map();
  if (scheduledSocial.ok && Array.isArray(scheduledSocial.data)) {
    for (const row of scheduledSocial.data) bump(scheduledByPlatform, row.platform, row.target_owner);
  }

  const scheduledTodayByPlatform = new Map();
  if (scheduledSocialToday.ok && Array.isArray(scheduledSocialToday.data)) {
    for (const row of scheduledSocialToday.data) bump(scheduledTodayByPlatform, row.platform, row.target_owner);
  }

  const toList = (map) => [...map.entries()].map(([key, count]) => {
    const [platform, target_owner] = key.split(':');
    return { platform, target_owner, count };
  }).sort((a, b) => a.platform.localeCompare(b.platform) || a.target_owner.localeCompare(b.target_owner));

  // Per-tracked-pair last-posted status, shown EVERY run regardless of
  // whether it's alarm-worthy — this is the "don't just alarm, also show
  // the boring healthy state" half of the heartbeat.
  const platformStatus = await Promise.all(TRACKED_PAIRS.map(async ({ platform, target_owner }) => {
    const res = await supabaseFetch(
      `/rest/v1/social_posts?platform=eq.${encodeURIComponent(platform)}&target_owner=eq.${encodeURIComponent(target_owner)}`
      + '&status=eq.posted&select=posted_at&order=posted_at.desc&limit=1',
    );
    const lastPostedAt = res.ok && Array.isArray(res.data) && res.data[0] ? res.data[0].posted_at : null;
    const daysSilent = lastPostedAt ? Math.floor((Date.now() - new Date(lastPostedAt).getTime()) / (24 * 60 * 60 * 1000)) : null;
    return { platform, target_owner, last_posted_at: lastPostedAt, days_silent: daysSilent };
  }));

  const cronSanity = scanCronSanity(cronSanityScanOpts);

  const count = (res) => (res.ok && Array.isArray(res.data) ? res.data.length : null);

  // Facebook Professional Dashboard-style goal progress (api/_lib/
  // social-goals.js) — computed fresh every heartbeat, same as everything
  // else here. Never dedup'd (this is the "state of the world" half of the
  // file, not the alarm half). Any single goal set failing to compute
  // (e.g. config_stale or a query error) never blocks the rest of the
  // heartbeat — caught per-key so one bad goal set can't silence the
  // entire morning message.
  const goalSetResults = await Promise.all(
    listGoalSetKeys().map(async (key) => {
      try {
        return [key, await computeGoalProgress(key)];
      } catch (err) {
        return [key, { goalSetKey: key, error: err && err.message }];
      }
    }),
  );
  const goalProgress = Object.fromEntries(goalSetResults);

  // Conversion attribution — clicks -> signup -> paid, per brand, 7d and 30d
  // (api/_lib/attribution.js). Never blocks the rest of the heartbeat: a
  // PostHog outage or a bad query surfaces as an explicit error field, same
  // pattern as goal_progress above, not a missing section.
  // "today" is a 24h-days=1 window on getAttributionSummary — same join
  // logic as 7d/30d, just narrower, so "honest zeros" (Heath's phrase) show
  // up for what it is: a single day is usually too small a sample to see a
  // signup, not evidence the channel doesn't work.
  let attribution;
  try {
    const [today, days7, days30] = await Promise.all([
      getAttributionSummary({ days: 1 }),
      getAttributionSummary({ days: 7 }),
      getAttributionSummary({ days: 30 }),
    ]);
    attribution = { today, last_7d: days7, last_30d: days30 };
  } catch (err) {
    attribution = { error: err && err.message };
  }

  return {
    posted_last_24h: {
      by_platform_owner: toList(postedByPlatform),
      group_posts: count(postedGroups),
    },
    scheduled_today: {
      by_platform_owner: toList(scheduledTodayByPlatform),
    },
    scheduled_next_7d: {
      by_platform_owner: toList(scheduledByPlatform),
      unscheduled_drafts: count(unscheduledDrafts),
      video_ready_to_post: count(videoReady),
    },
    stuck: {
      approved_unposted: count(approvedUnposted),
      pending_video: count(pendingVideo),
      failed_last_7d: count(failedRecent),
      pending_admin_approval: count(pendingAdminApproval),
      video_quality_hold: count(videoQualityHold),
      video_failed: count(videoFailed),
    },
    comments_awaiting_reply: {
      tc_discovery_notified: count(tcNotified),
      social_draft: count(socialDraftReplies),
    },
    platform_status: platformStatus,
    cron_sanity: cronSanity,
    goal_progress: goalProgress,
    attribution,
  };
}

// ─── decisions — the "2-3 tappable choices" half of the morning brief ─────
//
// Heath, 2026-09-17: the brief must carry "the 2-3 decisions only Heath can
// make, each as a single tappable choice rather than a paragraph" — and the
// ROUTINE approvals api/cron-comment-opp-approval.js /
// api/cron-tc-reply-approval.js already batch into (see
// api/_lib/ops-policy.js capability 'batch_routine_approvals': those crons
// mark a row 'notified' WITHOUT an individual Telegram send when batching
// is on) need to actually reach Heath from SOMEWHERE. This is that
// somewhere: pick the oldest pending rows across both pipelines, reuse
// their EXISTING approve/edit/skip callback_data verbatim (tcreply_*,
// oppc_* — api/telegram-webhook.js already handles both), so tapping a
// button embedded in the brief message does exactly what tapping it in an
// individual card always did. Zero new approval logic.
//
// group_posts pending_admin_approval stays COUNT-only in the STUCK section
// above — its approval path isn't the simple notified->approved shape.
//
// video_library WAS count-only for the same stated reason; that was wrong on
// inspection (Carter, 2026-09-17). Its approval path is exactly the same
// shape: api/telegram-webhook.js already handles `video_approve_{id}` /
// `video_reject_{id}` and PATCHes status to heath_approved / rejected. So it
// is wired in here, verbatim callback_data, zero new approval logic — which is
// what lets api/cron-post-videos.js stop sending one Telegram card per video
// and let the daily brief carry them instead (Heath, 2026-09-17: batch the
// routine approvals, don't ping per item).
const DECISION_SOURCES = [
  {
    table: 'comment_opportunities',
    statusCol: 'status',
    statusVal: 'notified',
    orderCol: 'notified_at',
    label: (row) => `Comment on "${row.group_name}" (${row.author_name || 'someone'}'s post) — score ${row.score ?? '?'}`,
    keyboard: (id) => ({
      inline_keyboard: [[
        { text: 'Approve', callback_data: `oppc_approve:${id}` },
        { text: 'Edit', callback_data: `oppc_edit:${id}` },
        { text: 'Skip', callback_data: `oppc_skip:${id}` },
      ]],
    }),
    select: 'id,group_name,author_name,score,notified_at',
  },
  {
    table: 'tc_discovery_responses',
    statusCol: 'reply_status',
    statusVal: 'notified',
    // NOT 'notified_at' — this table's real column (added in
    // 20260908_tc_reply_approval.sql) is reply_notified_at. Verified against
    // the migration before writing this, per acroform-field-names-lie.md.
    orderCol: 'reply_notified_at',
    label: (row) => `Reply to ${row.commenter_name || 'a commenter'} in ${row.source_group || 'a group'}`,
    keyboard: (id) => ({
      inline_keyboard: [[
        { text: 'Approve', callback_data: `tcreply_approve:${id}` },
        { text: 'Edit', callback_data: `tcreply_edit:${id}` },
        { text: 'Skip', callback_data: `tcreply_skip:${id}` },
      ]],
    }),
    select: 'id,commenter_name,source_group,reply_notified_at',
  },
  {
    table: 'video_library',
    statusCol: 'status',
    statusVal: 'pending_heath_review',
    // video_library has no notified_at column; created_at is when the row was
    // queued, which for a pending_heath_review row is the age that matters.
    orderCol: 'created_at',
    label: (row) => `Video ready to post: ${row.topic || row.id}`
      + `${row.target_owner && row.target_owner !== 'dossie' ? ` [${row.target_owner}]` : ''}`
      + `${row.supabase_url ? `\n${row.supabase_url}` : ''}`,
    // EXACTLY the callback_data api/telegram-webhook.js already handles for
    // the individual video cards — an underscore separator here, not the colon
    // the two comment pipelines use. Do not "normalise" it.
    keyboard: (id) => ({
      inline_keyboard: [[
        { text: 'Approve', callback_data: `video_approve_${id}` },
        { text: 'Reject', callback_data: `video_reject_${id}` },
      ]],
    }),
    select: 'id,topic,target_owner,supabase_url,created_at',
  },
];

/**
 * Pick the oldest `limit` pending routine-approval decisions across both
 * batched pipelines, each with real, working Approve/Edit/Skip buttons.
 *
 * @param {number} limit
 * @returns {Promise<Array<{ table, id, label, age_hours, keyboard }>>}
 */
async function pickTopDecisions(limit = 3) {
  const perSource = await Promise.all(DECISION_SOURCES.map(async (src) => {
    const res = await supabaseFetch(
      `/rest/v1/${src.table}?${src.statusCol}=eq.${src.statusVal}&${src.orderCol}=not.is.null`
      + `&select=${src.select}&order=${src.orderCol}.asc&limit=${limit}`,
    );
    if (!res.ok || !Array.isArray(res.data)) return [];
    return res.data.map((row) => ({
      table: src.table,
      id: row.id,
      label: src.label(row),
      notified_at: row[src.orderCol],
      keyboard: src.keyboard(row.id),
    }));
  }));

  return perSource
    .flat()
    .sort((a, b) => String(a.notified_at).localeCompare(String(b.notified_at)))
    .slice(0, limit)
    .map((d) => ({
      ...d,
      age_hours: d.notified_at ? Math.round((Date.now() - new Date(d.notified_at).getTime()) / 3600000) : null,
    }));
}

module.exports = {
  TRACKED_PAIRS,
  SILENCE_DAYS_DEFAULT,
  APPROVAL_STALE_HOURS,
  DRAFT_STALE_HOURS,
  BACKLOG_THRESHOLD,
  VIDEO_REVIEW_STALE_HOURS,
  PENDING_APPROVAL_STALE_DAYS,
  ALERT_COOLDOWN_HOURS,
  TC_HARVEST_HOT_WINDOW_HOURS,
  TC_HARVEST_HOT_STALE_HOURS,
  TC_HARVEST_SCOPE_GAP_HOURS,
  COMMENT_REPLY_STALE_HOURS,
  NEW_COMMENT_NEVER_NOTIFIED_STALE_HOURS,
  REPLY_UNVERIFIED_STALE_HOURS,
  COMMENT_OPP_SCANNER_STALE_HOURS,
  COMMENT_OPP_APPROVED_STALE_HOURS,
  GROUP_POSTING_SILENCE_HOURS,
  checkPlatformSilence,
  checkStaleApprovals,
  checkStaleDrafts,
  checkAccumulatingBacklog,
  checkVideoLibraryPendingReview,
  checkVideoLibraryPendingApprovalStale,
  checkTcHarvestHotWindowStale,
  checkTcHarvestScopeGap,
  checkCommentsAwaitingReplyStale,
  checkNewCommentsNeverNotifiedStale,
  checkUnverifiedRepliesStuck,
  checkCommentOppScannerSilence,
  checkCommentOppApprovedStale,
  checkGroupPostingSilence,
  checkCronSanity,
  shouldFire,
  markFired,
  runAllChecks,
  buildHeartbeatSnapshot,
  DECISION_SOURCES,
  pickTopDecisions,
};
