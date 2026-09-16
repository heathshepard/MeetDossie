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
const { computeGoalProgress } = require('./social-goals-progress.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SILENCE_DAYS_DEFAULT = 3;
const APPROVAL_STALE_HOURS = 48;
const DRAFT_STALE_HOURS = 24;
const BACKLOG_THRESHOLD = 5;
const VIDEO_REVIEW_STALE_HOURS = 48;
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

// 8. Static vercel.json scan — schedules effectively disabled by syntax
// (fixed dom+month = fires ~once/year, the exact 2026-07 shutdown trick) or
// pointing at a handler file that no longer exists. See api/_lib/cron-
// sanity.js for the detection logic. Fires at most once per cooldown window
// per distinct issue (keyed by path+type) so a genuinely-intentional rare
// cron doesn't need to be re-acknowledged daily forever — but Heath should
// see it at least once.
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
  const [silence, approvals, drafts, backlog, videoReview, tcHarvestStale, tcHarvestGap, commentsStale, cronSanity] = await Promise.all([
    checkPlatformSilence(opts.silenceDays),
    checkStaleApprovals(opts.approvalStaleHours),
    checkStaleDrafts(opts.draftStaleHours),
    checkAccumulatingBacklog(opts.backlogThreshold),
    checkVideoLibraryPendingReview(opts.videoReviewStaleHours),
    checkTcHarvestHotWindowStale(opts.tcHarvestStaleHours, opts.tcHarvestHotWindowHours),
    checkTcHarvestScopeGap(opts.tcHarvestScopeGapHours),
    checkCommentsAwaitingReplyStale(opts.commentReplyStaleHours),
    checkCronSanity(opts.cronSanityScanOpts),
  ]);

  const all = [...silence, ...approvals, ...drafts, ...backlog, ...videoReview, ...tcHarvestStale, ...tcHarvestGap, ...commentsStale, ...cronSanity];
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

  const [
    postedSocial,
    postedVideo,
    postedGroups,
    scheduledSocial,
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
  // (e.g. period_expired or a query error) never blocks the rest of the
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

  return {
    posted_last_24h: {
      by_platform_owner: toList(postedByPlatform),
      group_posts: count(postedGroups),
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
  };
}

module.exports = {
  TRACKED_PAIRS,
  SILENCE_DAYS_DEFAULT,
  APPROVAL_STALE_HOURS,
  DRAFT_STALE_HOURS,
  BACKLOG_THRESHOLD,
  VIDEO_REVIEW_STALE_HOURS,
  ALERT_COOLDOWN_HOURS,
  TC_HARVEST_HOT_WINDOW_HOURS,
  TC_HARVEST_HOT_STALE_HOURS,
  TC_HARVEST_SCOPE_GAP_HOURS,
  COMMENT_REPLY_STALE_HOURS,
  checkPlatformSilence,
  checkStaleApprovals,
  checkStaleDrafts,
  checkAccumulatingBacklog,
  checkVideoLibraryPendingReview,
  checkTcHarvestHotWindowStale,
  checkTcHarvestScopeGap,
  checkCommentsAwaitingReplyStale,
  checkCronSanity,
  shouldFire,
  markFired,
  runAllChecks,
  buildHeartbeatSnapshot,
};
