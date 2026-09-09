'use strict';

// scripts/_lib/comment-caps.js
//
// SINGLE SOURCE OF TRUTH for autonomous engagement caps.
// Heath approved these 2026-06-10. Do not change without his explicit sign-off.
//
// Read by:
//   - api/cron-sage-draft-engagements.js  (drafting gate — don't draft if cap hit)
//   - api/cron-sage-autonomous-review.js  (veto-post gate — don't auto-publish past cap)
//   - api/cron-sage-first-comment.js      (follow-up comment gate)
//   - api/cron-reddit-scanner.js          (Reddit scanner gating)
//   - Any future scanner / draft / poster cron — import from HERE, never re-declare.
//
// State lives in Supabase table `comment_caps_state` (one row per platform per UTC day).

// POST-SHADOWBAN TIGHTENING 2026-07-01 (Heath green-lit):
// Prior caps (FB 12 / IG 8 / LI 6 / RD 5 / TW 15 = 46/day total) got us
// shadowbanned in June. Slowed cron to once/day and dropped per-platform
// caps below platform "human agent" volume. Stays here until Sage delivers
// an algorithm-safe strategy.
//
// FACEBOOK BUDGET SPLIT 2026-09-08 (Carter, for the guest-comment growth
// strategy — pending Heath's merge sign-off, which is the explicit approval
// this header requires):
//   facebook       = comments Heath INITIATES on other people's posts.
//                    Raised 5 -> 15 to unblock the 15-20/day strategy. Honest
//                    risk note: the June shadowban hit at 12/day — BUT those
//                    were automated posts fired in bursts (6 inside 60 min).
//                    Today's initiated comments are drafted-only; Heath
//                    pastes and posts them BY HAND via the engagement_queue
//                    handoff, so timing is human. 15 is the strategy floor;
//                    ramp to 20 only after 2 clean weeks, Heath's call. If
//                    ANY warning sign appears (comment removed, temp block,
//                    reduced reach), drop straight back to 5.
//   facebook_reply = threaded replies to people who replied to Heath (posted
//                    by automation via fb-group-commenter --tc-reply-queue).
//                    Separate budget so reply follow-through never starves
//                    new commenting and vice versa. Replying to someone who
//                    replied to YOU is the most human-looking action class,
//                    but it IS automated keystrokes on the one account the
//                    entire distribution strategy runs through — kept at 10
//                    with a 30-min min-gap.
// A banned profile ends the whole strategy. These are ceilings, not targets.
//   facebook_auto  = AUTOMATED initiated comments from the daily
//                    comment-opportunity finder (fb-comment-hunt-daily.js ->
//                    cron-comment-opp-approval -> fb-comment-opp-poster.js).
//                    Every one is individually Heath-approved in Telegram, but
//                    the KEYSTROKES are automated — the exact action class
//                    that got the profile shadowbanned in June at 12/day in
//                    bursts. Ceiling 8/day, 45-60 min VARIED spacing (poster
//                    adds per-run jitter on top of the 45-min floor), one
//                    comment per poster run. THIS IS THE CONFIG VALUE for the
//                    daily hunt — ramp only after 2+ clean weeks and Heath's
//                    explicit sign-off; drop to 4 at the FIRST warning sign
//                    (the poster also hard-halts the whole pipeline on any
//                    removed comment / checkpoint / verify failure).
// FACEBOOK GROUP POST BUDGET 2026-09-09 (Carter, Heath's explicit call,
// verbatim: "people can post more than once a day. 5 groups 1 post to each
// group per day is fone" -- one ORIGINATED post/day into EACH of the 5
// comment-hunt-groups.json groups, never bursted). This is a DIFFERENT
// action class from facebook_auto (a comment on someone else's post) -- a
// standalone top-level post with Heath's name on it, in front of the whole
// group. Separate budget so group-post volume can never eat into the
// comment-opportunity budget or vice versa. Spacing 2026-09-09 (Heath,
// verbatim: "and do the posts like 20 minutes apart"): 18-24 min varied
// (18-min floor + 0-6 min jitter, same "floor + fresh per-run jitter, never
// metronomic" pattern as facebook_auto's 45-60). Shares the SAME circuit
// breaker (scripts/_lib/comment-hunt-halt.js) as facebook_auto -- it's one
// Facebook profile; a checkpoint/login-redirect on either action class must
// halt both.
//   facebook_group_post = automated ORIGINATED group posts from the daily
//                    5-group pipeline (api/cron-daily-group5-posts.js ->
//                    Telegram Approve/Edit/Skip -> scripts/fb-group5-post-
//                    queue.js -> scripts/fb-group-poster.js). Every one is
//                    individually Heath-approved, but the KEYSTROKES are
//                    automated. Ceiling 5/day (exactly one per target
//                    group), 18-24 min varied spacing. Drop toward 0 at the
//                    first warning sign, same as facebook_auto.
const PLATFORM_DAILY_CAPS = Object.freeze({
  facebook: 15,       // initiated comments (human-pasted; see split note above)
  facebook_auto: 8,   // automated initiated comments (daily hunt; see note above)
  facebook_reply: 10, // automated threaded replies to replies-to-Heath
  facebook_group_post: 5, // automated ORIGINATED group posts (daily 5-group pipeline; see note above)
  instagram: 5,
  linkedin: 3,
  reddit: 3,
  twitter: 5,
});

const TOTAL_DAILY_CAP = 54; // sum of the above; hard ceiling across all platforms

const PER_THREAD_CAP = 1;            // 1 comment per thread / post
const PER_THREAD_CAP_IF_MENTIONED = 2; // 2 if the thread @-mentions Dossie/Heath

const PER_AUTHOR_COOLDOWN_DAYS = 7;  // don't comment on the same author twice within 7 days

// POST-SHADOWBAN TIGHTENING 2026-07-01: min-gap between comments per
// platform. Bursts get spread. Prior 8/15-min gaps let 6 FB comments fire
// inside 60 min — bot-pattern to any moderation system.
const MIN_GAP_MINUTES = Object.freeze({
  facebook: 45,
  facebook_auto: 45, // FLOOR only — fb-comment-opp-poster.js adds 0-15 min random jitter per run so spacing is 45-60, varied, never metronomic

  facebook_reply: 30, // replying promptly to a reply-to-you reads as normal human behavior
  facebook_group_post: 18, // FLOOR only — fb-group5-post-queue.js adds 0-6 min random jitter per run so spacing is 18-24, varied, never exactly 20:00 (Heath, 2026-09-09: "do the posts like 20 minutes apart")
  instagram: 20,
  twitter: 45,
  linkedin: 90,
  reddit: 60,
});

// Substance floor — drafted comments must clear this bar or get auto-rejected.
const SUBSTANCE_MIN_CHARS = 80;
// Substance also requires the draft to reference a specific from the source post
// (a noun, a pain phrase, a number). Checked in caller via includes() against
// candidate.post_title + candidate.post_body keywords.

// ─── Supabase helpers (lazy — caller passes its own sbFetch) ───────────────────

/**
 * Returns the UTC date key in YYYY-MM-DD form. Caps reset at 00:00 UTC.
 * UTC is intentional — Heath's audience spans CDT/CST/MST/etc and the cron
 * grid runs on UTC. One reset boundary is simpler than five timezones.
 */
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Read today's counts for every platform. Returns a map:
 *   { facebook: 3, instagram: 0, linkedin: 1, reddit: 0, twitter: 6, total: 10 }
 *
 * @param {(path: string, init?: object) => Promise<{ok, status, data}>} sbFetch
 */
async function getTodayCounts(sbFetch) {
  const key = todayKey();
  const { ok, data } = await sbFetch(
    `/rest/v1/comment_caps_state?day=eq.${key}&select=platform,count`
  );
  // Derive from PLATFORM_DAILY_CAPS so a new budget key can never be silently
  // dropped from counting (caught live 2026-09-08: facebook_auto was counted
  // as 0 forever by the old hardcoded map — cap would never have enforced).
  const out = { total: 0 };
  for (const p of Object.keys(PLATFORM_DAILY_CAPS)) out[p] = 0;
  if (!ok || !Array.isArray(data)) return out;
  for (const row of data) {
    const p = String(row.platform || '').toLowerCase();
    if (p in out) {
      out[p] = Number(row.count) || 0;
      out.total += out[p];
    }
  }
  return out;
}

/**
 * Check whether a NEW comment for `platform` would breach any cap.
 * Returns { allowed: boolean, reason?: string }.
 *
 * @param {string} platform  e.g. 'facebook'
 * @param {(path: string, init?: object) => Promise<{ok, status, data}>} sbFetch
 */
async function canComment(platform, sbFetch) {
  const p = String(platform || '').toLowerCase();
  if (!(p in PLATFORM_DAILY_CAPS)) {
    return { allowed: false, reason: `unknown_platform:${platform}` };
  }
  const counts = await getTodayCounts(sbFetch);
  if (counts.total >= TOTAL_DAILY_CAP) {
    return { allowed: false, reason: `total_cap_hit:${counts.total}/${TOTAL_DAILY_CAP}` };
  }
  if (counts[p] >= PLATFORM_DAILY_CAPS[p]) {
    return { allowed: false, reason: `platform_cap_hit:${p}:${counts[p]}/${PLATFORM_DAILY_CAPS[p]}` };
  }
  return { allowed: true };
}

/**
 * Atomically increment today's counter for `platform`.
 * Uses Supabase upsert (on_conflict=platform,day) with a Postgres-side
 * increment via the rpc fallback if the row exists.
 *
 * @param {string} platform
 * @param {(path: string, init?: object) => Promise<{ok, status, data}>} sbFetch
 */
async function recordComment(platform, sbFetch) {
  const p = String(platform || '').toLowerCase();
  if (!(p in PLATFORM_DAILY_CAPS)) return { ok: false, status: 400 };
  const key = todayKey();
  // Try to insert with count=1; on conflict, increment via PATCH.
  const insertRes = await sbFetch(
    `/rest/v1/comment_caps_state?on_conflict=platform,day`,
    {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify({ platform: p, day: key, count: 1 }),
    }
  );
  // If a row already existed, the insert returns 200/201 with no body OR
  // we need to PATCH-increment. Easiest path: always PATCH after, so the
  // count reflects the new comment regardless of insert outcome.
  // Using PostgREST's `count=count+1` requires rpc; we do read-then-write.
  const { ok: readOk, data: readData } = await sbFetch(
    `/rest/v1/comment_caps_state?platform=eq.${p}&day=eq.${key}&select=count`
  );
  if (!readOk || !Array.isArray(readData) || readData.length === 0) {
    return { ok: insertRes.ok, status: insertRes.status };
  }
  const current = Number(readData[0].count) || 0;
  // If insert was a true insert (we just put count=1), don't double-bump.
  // Detect insert by inspecting insertRes — when it returns a body array
  // with a row, that was the insert.
  const wasFreshInsert =
    insertRes.ok && Array.isArray(insertRes.data) && insertRes.data.length > 0;
  if (wasFreshInsert) return { ok: true, status: 201 };
  const patchRes = await sbFetch(
    `/rest/v1/comment_caps_state?platform=eq.${p}&day=eq.${key}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ count: current + 1, updated_at: new Date().toISOString() }),
    }
  );
  return { ok: patchRes.ok, status: patchRes.status };
}

/**
 * Last-comment-at lookup for cooldown gating. Caller passes the engagement
 * log table (engagement_candidates.posted_at or reddit_engagements.posted_at).
 * Min-gap is enforced platform-by-platform.
 *
 * @param {string} platform  budget key for the gap lookup (e.g. 'facebook_reply')
 * @param {(path: string, init?: object) => Promise<{ok, status, data}>} sbFetch
 * @param {string} logTable  e.g. 'engagement_candidates' or 'reddit_engagements'
 * @param {string} timestampCol  e.g. 'posted_at'
 * @param {string} [filterPlatform]  value stored in logTable.platform when it
 *   differs from the budget key — tc_discovery_responses rows carry
 *   platform='facebook' while their budget is 'facebook_reply'.
 */
async function minGapElapsed(platform, sbFetch, logTable, timestampCol = 'posted_at', filterPlatform = null) {
  const p = String(platform || '').toLowerCase();
  const gapMin = MIN_GAP_MINUTES[p] || 8;
  const fp = String(filterPlatform || p).toLowerCase();
  const { ok, data } = await sbFetch(
    `/rest/v1/${logTable}?platform=eq.${fp}&${timestampCol}=not.is.null&order=${timestampCol}.desc&limit=1&select=${timestampCol}`
  );
  if (!ok || !Array.isArray(data) || data.length === 0) return { elapsed: true };
  const last = new Date(data[0][timestampCol]).getTime();
  const ageMin = (Date.now() - last) / 60000;
  if (ageMin < gapMin) {
    return { elapsed: false, ageMin, gapMin };
  }
  return { elapsed: true, ageMin, gapMin };
}

/**
 * Check the substance floor on a drafted comment.
 * Returns { ok: boolean, reason?: string }.
 */
function meetsSubstanceFloor(draftText, sourceKeywords = []) {
  const t = String(draftText || '').trim();
  if (t.length < SUBSTANCE_MIN_CHARS) {
    return { ok: false, reason: `too_short:${t.length}<${SUBSTANCE_MIN_CHARS}` };
  }
  if (Array.isArray(sourceKeywords) && sourceKeywords.length > 0) {
    const lower = t.toLowerCase();
    const hit = sourceKeywords.some((k) => k && lower.includes(String(k).toLowerCase()));
    if (!hit) return { ok: false, reason: 'no_source_specifics' };
  }
  return { ok: true };
}

module.exports = {
  PLATFORM_DAILY_CAPS,
  TOTAL_DAILY_CAP,
  PER_THREAD_CAP,
  PER_THREAD_CAP_IF_MENTIONED,
  PER_AUTHOR_COOLDOWN_DAYS,
  MIN_GAP_MINUTES,
  SUBSTANCE_MIN_CHARS,
  todayKey,
  getTodayCounts,
  canComment,
  recordComment,
  minGapElapsed,
  meetsSubstanceFloor,
};
