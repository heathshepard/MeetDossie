'use strict';

// scripts/watch-guest-thread-replies.js
//
// READ-ONLY watcher for replies to comments Heath leaves on OTHER PEOPLE'S
// posts (the inverse of scripts/harvest-tc-discovery-responses.js, which
// watches Heath's OWN campaign posts). Heath leaves 15-20 comments/day on
// third-party posts as a growth strategy; those threads are where new people
// meet him, so a dropped conversation there costs more than a missed reply
// on his own post.
//
// SOURCES: comment_watchlist rows with direction='heath_commented_on_others'
// (written by the engage_posted_* "Mark Posted" tap in api/telegram-webhook.js,
// or manually via scripts/add-comment-watch.js). SINK: detected replies-to-
// Heath are upserted into tc_discovery_responses with thread_role='guest',
// where the EXISTING approval loop takes over unchanged:
//   api/cron-tc-reply-approval.js  -> guest-tone draft + Telegram Approve/Edit/Skip
//   api/telegram-webhook.js        -> tcreply_* callbacks (untouched)
//   fb-group-commenter --tc-reply-queue -> threaded post + read-back verify
//
// HARD RULES (same as the harvester):
//   - Read-only against Facebook: only comment-expansion clicks. Never posts,
//     replies, likes, or types.
//   - comment_text stored VERBATIM.
//   - Idempotent: dedupe on (post_url, commenter_name, comment_hash) in-script
//     and via the DB UNIQUE constraint, plus FB's reply_comment_id in-pass.
//   - Reuses the harvester's expandThread/scrapeComments/launchContext, which
//     carry the 2026-09-08 fixes (singular "View 1 reply", nested replies
//     deduped on their OWN id, double-render-clone click-marking). Do NOT
//     re-implement them here.
//
// REPLY ATTRIBUTION: Heath's comment is located in the scraped thread by
// author (Heath Shepard) + normalized-text match against watch.our_text; its
// permalink's comment_id is the parent id. A scraped comment is "a reply to
// Heath" iff its permalink carries comment_id=<Heath's id>&reply_comment_id=…
// and its author isn't Heath. (FB nests one level: every reply in his
// comment's thread carries his comment_id as parent — a third party jumping
// into his thread is still a conversation with him, so that's intended.)
//
// CADENCE: identical scheme to the harvester (module reuse, not a copy):
// hot window = every 45 min for the first 48h after Heath's comment, first
// pass at >= +30 min; long tail = every 3 days, stopping 45 days out.
// Scheduled from scripts/run-tc-discovery-harvest.cmd (30-min Task Scheduler
// tick) because it needs the local DossieBot-Sage Chrome profile.
//
// Usage:
//   node scripts/watch-guest-thread-replies.js             # all due watches
//   node scripts/watch-guest-thread-replies.js --all       # ignore cadence
//   node scripts/watch-guest-thread-replies.js --watch-id <uuid>
//   node scripts/watch-guest-thread-replies.js --dry-run   # scrape + log, no writes
//   node scripts/watch-guest-thread-replies.js --headless  # see harvester caveat
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Owner: Carter, 2026-09-08

const path = require('path');
const fs = require('fs');

// Load .env.local when running locally (same pattern as the harvester)
try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch (e) { /* non-fatal */ }

const harvester = require('./harvest-tc-discovery-responses.js');
const {
  isDue,
  detectLoggedOut,
  expandThread,
  scrapeComments,
  launchContext,
  normHash,
  HEATH_FB_NAMES,
} = harvester;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const isHeath = (author) => HEATH_FB_NAMES.some((n) => norm(author).toLowerCase() === n.toLowerCase());

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function supabaseFetch(urlPath, init = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${process.env.SUPABASE_URL}${urlPath}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

async function fetchWatches(watchId) {
  const filters = watchId
    ? `id=eq.${encodeURIComponent(watchId)}`
    : "direction=eq.heath_commented_on_others&status=in.(watching,reply_detected)&thread_url=not.is.null";
  const { ok, data, status } = await supabaseFetch(
    `/rest/v1/comment_watchlist?${filters}`
    + '&select=id,thread_url,group_name,post_author,our_text,posted_at,status,last_checked_at,check_count,post_body,our_comment_permalink'
    + '&order=posted_at.asc',
  );
  if (!ok) throw new Error(`fetchWatches failed (${status}): ${JSON.stringify(data).slice(0, 200)}`);
  return Array.isArray(data) ? data : [];
}

// ─── Cadence (module reuse: map a watch row into the harvester's isDue) ──────

function isWatchDue(watch, nowMs = Date.now()) {
  return isDue({
    posted_at: watch.posted_at,
    post_url: watch.thread_url,
    harvest_count: watch.check_count || 0,
    last_harvested_at: watch.last_checked_at,
  }, nowMs);
}

// ─── Reply attribution (pure — regression-tested) ────────────────────────────

/**
 * Parse FB comment ids out of a permalink.
 * Top-level comment:  ?comment_id=P                 -> { commentId: P }
 * Nested reply:       ?comment_id=P&reply_comment_id=C -> both
 */
function parseCommentIds(permalink) {
  const s = String(permalink || '');
  const parent = s.match(/[?&]comment_id=(\d+)/);
  const reply = s.match(/[?&]reply_comment_id=(\d+)/);
  return { commentId: parent ? parent[1] : null, replyCommentId: reply ? reply[1] : null };
}

/**
 * From a full scraped thread, find Heath's comment and every reply to it.
 *
 * @param {Array<{author,text,permalink,atRaw,at}>} comments  scrapeComments() output
 * @param {object} watch  comment_watchlist row (our_text used to locate his comment)
 * @returns {{found:boolean, heathComment:?object, replies:Array}}
 */
function selectRepliesToHeath(comments, watch) {
  const list = Array.isArray(comments) ? comments : [];
  const ourNorm = norm(watch && watch.our_text).slice(0, 80).toLowerCase();

  // Locate Heath's comment: his name + his text. Fallback: if the text was
  // tweaked when he pasted it, accept the case where he has exactly ONE
  // top-level comment in the thread — never guess between several.
  let mine = ourNorm
    ? list.find((c) => isHeath(c.author) && norm(c.text).toLowerCase().includes(ourNorm))
    : null;
  if (!mine) {
    const heathTopLevel = list.filter((c) => {
      if (!isHeath(c.author)) return false;
      const ids = parseCommentIds(c.permalink);
      return ids.commentId && !ids.replyCommentId;
    });
    if (heathTopLevel.length === 1) mine = heathTopLevel[0];
  }
  if (!mine) return { found: false, heathComment: null, replies: [] };

  const myIds = parseCommentIds(mine.permalink);
  // If Heath's comment is itself a nested reply, its own id is the reply id.
  const myId = myIds.replyCommentId || myIds.commentId;
  if (!myId) return { found: true, heathComment: mine, replies: [] };

  const replies = [];
  const seenReplyIds = new Set();   // FB's own id — catches double-rendered DOM copies
  const seenKeys = new Set();       // author + normalized-text hash backstop
  for (const c of list) {
    if (isHeath(c.author)) continue; // one reply per comment EVER also means: never reply to himself
    const ids = parseCommentIds(c.permalink);
    if (!ids.replyCommentId) continue;           // top-level comment, not a reply
    if (ids.commentId !== myId) continue;        // reply in someone else's sub-thread
    // Dedupe on the reply's OWN id — matching the parent id here would
    // silently discard every nested reply (the 2026-09-08 harvester bug).
    if (seenReplyIds.has(ids.replyCommentId)) continue;
    seenReplyIds.add(ids.replyCommentId);
    const key = `${norm(c.author)}::${normHash(c.text || '')}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (!norm(c.author) || !String(c.text || '').trim()) continue;
    replies.push(c);
  }
  return { found: true, heathComment: mine, replies };
}

// ─── Upsert (idempotent; deps-injectable for the regression test) ────────────

/**
 * Upsert replies-to-Heath for one watch into tc_discovery_responses as
 * thread_role='guest' rows. Idempotent on the table's
 * (post_url, commenter_name, comment_hash) UNIQUE constraint.
 */
async function upsertGuestReplies(watch, replies, nowIso = new Date().toISOString(), sbFetch = supabaseFetch) {
  const { ok, data, status } = await sbFetch(
    `/rest/v1/tc_discovery_responses?post_url=eq.${encodeURIComponent(watch.thread_url)}&select=id,commenter_name,comment_hash`,
  );
  if (!ok) throw new Error(`existing-rows fetch failed (${status}): ${JSON.stringify(data).slice(0, 200)}`);
  const existing = new Map((data || []).map((r) => [`${r.commenter_name}::${r.comment_hash}`, r.id]));

  const inserts = [];
  const seenIds = [];
  let skipped = 0;
  for (const c of replies) {
    const author = norm(c.author);
    const text = c.text; // VERBATIM — never trimmed/normalized
    if (!author || !text || !text.trim()) { skipped++; continue; }
    const key = `${author}::${normHash(text)}`;
    if (existing.has(key)) { seenIds.push(existing.get(key)); continue; }
    inserts.push({
      watchlist_id: watch.id,
      thread_role: 'guest',
      group_post_id: null,
      post_url: watch.thread_url,
      question_id: null,
      platform: 'facebook',
      source_group: watch.group_name || null,
      commenter_name: author,
      comment_text: text,
      comment_permalink: c.permalink || null,
      commented_at: c.at || null,
      commented_at_raw: c.atRaw || null,
      is_own_comment: false,
      harvested_at: nowIso,
      last_seen_at: nowIso,
    });
  }

  if (inserts.length > 0) {
    const res = await sbFetch(
      '/rest/v1/tc_discovery_responses?on_conflict=post_url,commenter_name,comment_hash',
      {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(inserts),
      },
    );
    if (!res.ok) throw new Error(`insert failed (${res.status}): ${JSON.stringify(res.data).slice(0, 300)}`);
  }

  if (seenIds.length > 0) {
    const res = await sbFetch(
      `/rest/v1/tc_discovery_responses?id=in.(${seenIds.map(encodeURIComponent).join(',')})`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ last_seen_at: nowIso, updated_at: nowIso }),
      },
    );
    if (!res.ok) throw new Error(`last_seen_at patch failed (${res.status}): ${JSON.stringify(res.data).slice(0, 300)}`);
  }

  return { inserted: inserts.length, seen: seenIds.length, skipped };
}

/**
 * Watch-pass bookkeeping on the comment_watchlist row. Only fills post_body /
 * our_comment_permalink when not already set; only flips status to
 * 'reply_detected' from 'watching' (never regresses other states).
 */
async function recordWatchPass(watch, extras, nowIso = new Date().toISOString(), sbFetch = supabaseFetch) {
  const patch = {
    last_checked_at: nowIso,
    check_count: (watch.check_count || 0) + 1,
    updated_at: nowIso,
  };
  if (extras.postBody && !watch.post_body) patch.post_body = String(extras.postBody).slice(0, 3000);
  if (extras.ourCommentPermalink && !watch.our_comment_permalink) patch.our_comment_permalink = extras.ourCommentPermalink;
  if (extras.repliesFound > 0 && watch.status === 'watching') {
    patch.status = 'reply_detected';
    patch.reply_detected_at = nowIso;
  }
  const res = await sbFetch(`/rest/v1/comment_watchlist?id=eq.${encodeURIComponent(watch.id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`recordWatchPass failed (${res.status}): ${JSON.stringify(res.data).slice(0, 200)}`);
}

// ─── Original-post scrape (context only — best-effort) ───────────────────────

async function scrapePostBody(page) {
  return page.evaluate(() => {
    const articles = Array.from(document.querySelectorAll('div[role="article"]'));
    for (const art of articles) {
      const label = art.getAttribute('aria-label') || '';
      if (/^(Comment|Reply) by /i.test(label)) continue; // comments, not the post
      const blocks = Array.from(art.querySelectorAll('div[dir="auto"]'))
        .map((el) => el.innerText)
        .filter((t) => t && t.trim().length > 20);
      if (blocks.length > 0) {
        // Longest block is the post message; header/footer chrome is short.
        return blocks.sort((a, b) => b.length - a.length)[0].slice(0, 3000);
      }
    }
    return null;
  }).catch(() => null);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const FORCE_ALL = args.includes('--all');
  const DRY_RUN = args.includes('--dry-run');
  const TRY_HEADLESS = args.includes('--headless');
  const idIdx = args.indexOf('--watch-id');
  const WATCH_ID = idIdx >= 0 ? args[idIdx + 1] : null;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[guest-watch] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
    process.exit(1);
  }

  const all = await fetchWatches(WATCH_ID);
  const now = Date.now();
  const due = (WATCH_ID || FORCE_ALL) ? all : all.filter((w) => isWatchDue(w, now));
  console.log(`[guest-watch] ${all.length} guest-comment watches, ${due.length} due`);
  if (due.length === 0) return;

  let headless = TRY_HEADLESS;
  let context = null;
  try {
    context = await launchContext(headless);
  } catch (err) {
    if (/held|holder|lock|timeout/i.test(err.message || '')) {
      console.log(`[guest-watch] profile busy (${err.message}) — skipping this tick, next run retries`);
      return;
    }
    throw err;
  }

  const summary = [];
  try {
    let page = context.pages()[0] || await context.newPage();

    for (const watch of due) {
      const rec = { id: watch.id, group: watch.group_name, url: watch.thread_url };
      try {
        await page.goto(watch.thread_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(6000);

        if (await detectLoggedOut(page)) {
          if (headless) {
            // Same false-negative failure mode as the harvester: headless has
            // twice reported logged-out on a live session. Relaunch headed.
            console.warn('[guest-watch] headless run reports logged-out — retrying HEADED before believing it');
            await context.close().catch(() => {});
            headless = false;
            context = await launchContext(false);
            page = context.pages()[0] || await context.newPage();
            await page.goto(watch.thread_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await sleep(6000);
          }
          if (await detectLoggedOut(page)) {
            console.error('[guest-watch] HEADED run confirms logged-out. Aborting with no writes — DossieBot-Sage profile needs a manual FB login.');
            process.exitCode = 2;
            return;
          }
        }

        await expandThread(page);
        const postBody = watch.post_body ? null : await scrapePostBody(page);
        const comments = await scrapeComments(page);
        rec.scraped = comments.length;

        const sel = selectRepliesToHeath(comments, watch);
        rec.heath_comment_found = sel.found;
        rec.replies = sel.replies.length;
        if (!sel.found) {
          // Could be a scrape miss, mod deletion, or the comment not posted
          // yet — never mark stale off one pass, just record the check.
          console.warn(`[guest-watch] Heath's comment NOT found in ${watch.thread_url} — recording pass, will re-check`);
        }

        if (DRY_RUN) {
          rec.dry_run = true;
          console.log(`[guest-watch][dry-run] ${watch.group_name}: found=${sel.found} replies=${sel.replies.length}`);
          for (const r of sel.replies) console.log(`  - ${r.author} (${r.atRaw || '?'}): ${r.text.slice(0, 120).replace(/\n/g, ' ')}`);
        } else {
          const nowIso = new Date().toISOString();
          const res = await upsertGuestReplies(watch, sel.replies, nowIso);
          await recordWatchPass(watch, {
            postBody,
            ourCommentPermalink: sel.heathComment ? sel.heathComment.permalink : null,
            repliesFound: sel.replies.length,
          }, nowIso);
          Object.assign(rec, res);
          console.log(`[guest-watch] ${watch.group_name}: scraped=${comments.length} replies=${sel.replies.length} inserted=${res.inserted} seen=${res.seen} skipped=${res.skipped}`);
        }
      } catch (err) {
        rec.error = err.message;
        console.error(`[guest-watch] FAILED ${watch.group_name || watch.id}: ${err.message}`);
      }
      summary.push(rec);
      await sleep(8000 + Math.floor(Math.random() * 7000)); // pacing between threads
    }
  } finally {
    if (context) await context.close().catch(() => {});
  }

  console.log('[guest-watch] summary: ' + JSON.stringify(summary));
}

module.exports = {
  isWatchDue,
  parseCommentIds,
  selectRepliesToHeath,
  upsertGuestReplies,
  recordWatchPass,
  fetchWatches,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('[guest-watch] FATAL:', err.message);
    process.exit(1);
  });
}
