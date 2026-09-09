'use strict';

// scripts/harvest-tc-discovery-responses.js
//
// READ-ONLY harvester for the TC discovery campaign
// (docs/TC-DISCOVERY-CAMPAIGN.md, "2026-09-07 EXPANSION"). Revisits every
// posted campaign row in group_posts (category='tc_discovery_research',
// status='posted', post_url set), renders the Facebook permalink in the
// DossieBot-Sage Chrome profile, expands the comment thread, and upserts
// each comment VERBATIM into tc_discovery_responses.
//
// HARD RULES
//   - Read-only against Facebook: the ONLY clicks are comment-expansion
//     controls ("View more comments", "N replies", "See more"). It never
//     posts, replies, likes, joins, or types anything.
//   - comment_text is stored VERBATIM. No normalizing, no truncation.
//   - Idempotent: dedupe key is (post_url, commenter_name,
//     md5(whitespace-normalized comment_text)) both in-script and as a DB
//     UNIQUE constraint, plus FB's own comment_id in-pass — re-running never
//     duplicates rows; re-seen comments just get last_seen_at bumped. The
//     STORED text is still verbatim; only the hash normalizes whitespace.
//   - Only group_posts mutations: last_harvested_at + harvest_count
//     (harvest metadata added by supabase/migrations/20260907_tc_discovery_responses.sql).
//
// CADENCE (self-gating — safe to run every 30 min):
//   HOT WINDOW (first 48h after posting, when most comments land — feeds the
//   comment-reply approval loop): first pass at >= posted_at + 30 min, then
//   every 45 min. LONG TAIL (after 48h): every 3 days, stopping 45 days
//   after the post. Scheduled via Windows Task Scheduler
//   (scripts/register-tc-discovery-harvest-task.ps1 +
//   scripts/run-tc-discovery-harvest.cmd, 30-min tick) because it needs the
//   local DossieBot-Sage Chrome profile — a Vercel cron cannot reach it, and
//   the agent-queue poller / cron-process-agent-requests are dead.
//
// HEADLESS CAVEAT: headless launches on the DossieBot-Sage profile have
// twice FALSELY reported logged-out while the session was live. Default is
// therefore headed. With --headless, a logged-out read triggers one headed
// relaunch before believing it; a headed logged-out read aborts with exit 2
// and writes nothing.
//
// Usage:
//   node scripts/harvest-tc-discovery-responses.js            # all due posts
//   node scripts/harvest-tc-discovery-responses.js --all      # ignore cadence, harvest every posted campaign row
//   node scripts/harvest-tc-discovery-responses.js --post-id <uuid>   # force one
//   node scripts/harvest-tc-discovery-responses.js --dry-run  # scrape + log, no DB writes
//   node scripts/harvest-tc-discovery-responses.js --headless # try headless first (see caveat)
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Profile override: SAGE_PROFILE_DIR (defaults to %LOCALAPPDATA%\DossieBot-Sage;
// run under WINDOWS node — under WSL os.homedir() resolves wrong).
//
// Owner: Carter, 2026-09-07

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

// Load .env.local when running locally (same pattern as fb-group-poster.js)
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

const CHROME_PROFILE_PATH = process.env.SAGE_PROFILE_DIR || path.join(
  os.homedir(), 'AppData', 'Local', 'DossieBot-Sage'
);

const HEATH_FB_NAMES = ['Heath Shepard'];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CAMPAIGN_WINDOW_MS = 45 * DAY;

const { isJunkText } = require('./_lib/junk-text-guard');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

// Dedupe hash is computed on WHITESPACE-NORMALIZED text (collapse runs,
// trim) — Facebook renders each comment twice in the DOM and the two
// renderings differ in whitespace only (verified live 2026-09-07, Q2 DFW
// post). Must match the DB's generated comment_hash expression:
// md5(btrim(regexp_replace(comment_text, '\s+', ' ', 'g'))).
// The STORED comment_text stays verbatim; only the hash normalizes.
const normHash = (s) => md5(String(s).replace(/\s+/g, ' ').trim());

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

async function fetchCampaignPosts(postId) {
  const filters = postId
    ? `id=eq.${encodeURIComponent(postId)}`
    : 'category=eq.tc_discovery_research&status=eq.posted&post_url=not.is.null';
  const { ok, data, status } = await supabaseFetch(
    `/rest/v1/group_posts?${filters}&select=id,group_name,group_url,post_url,post_body,posted_at,discovery_question_id,last_harvested_at,harvest_count&order=posted_at.asc`,
  );
  if (!ok) throw new Error(`fetchCampaignPosts failed (${status}): ${JSON.stringify(data).slice(0, 200)}`);
  return Array.isArray(data) ? data : [];
}

// ─── Cadence ──────────────────────────────────────────────────────────────────

// TIGHTENED 2026-09-08 (Carter, for the comment-reply approval loop): most
// comments land in the first 48 hours, and the reply loop is only useful if
// Heath can answer while the thread is still warm. First 48h after posting:
// harvest every 45 minutes (first pass as soon as 30 min in). After 48h the
// long tail keeps the old every-3-days cadence, stopping at 45 days.
// (Previous scheme was +24h / +72h / every-3-days — far too slow to feed
// same-hour reply notifications.)
const HOT_WINDOW_MS = 48 * HOUR;
const HOT_INTERVAL_MS = 45 * 60 * 1000;
const FIRST_PASS_DELAY_MS = 30 * 60 * 1000;

function isDue(post, nowMs = Date.now()) {
  if (!post || !post.posted_at || !post.post_url) return false;
  const posted = Date.parse(post.posted_at);
  if (!Number.isFinite(posted)) return false;
  if (nowMs - posted > CAMPAIGN_WINDOW_MS) return false;
  const hc = post.harvest_count || 0;
  const age = nowMs - posted;
  if (age <= HOT_WINDOW_MS) {
    if (hc === 0) return age >= FIRST_PASS_DELAY_MS;
    const last = Date.parse(post.last_harvested_at || post.posted_at);
    return nowMs >= last + HOT_INTERVAL_MS;
  }
  // Long tail: never-harvested posts (scheduler was down during the hot
  // window) are due immediately; otherwise every 3 days from the last pass.
  if (hc === 0) return true;
  const last = Date.parse(post.last_harvested_at || post.posted_at);
  return nowMs >= last + 3 * DAY;
}

// ─── Question inference ───────────────────────────────────────────────────────

// Fallback when a campaign row was queued without discovery_question_id.
// Distinctive lowercase snippets from BOTH wording variants in
// docs/TC-DISCOVERY-CAMPAIGN.md (sections 1 + A).
const QUESTION_SNIPPETS = [
  ['Q1', ['makes you say yes to one over another']],
  ['Q2', ['drove you the most crazy']],
  ['Q3', ['make your tc do one thing']],
  ['Q4', ['what tc software or platform']],
  ['Q5', ['actually matters to you picking one', 'agents using or shopping tc software']],
  ['Q6', ["what do y'all actually pay", 'what does it actually run you']],
  ['Q7', ['how did you find your tc', 'where did they come from']],
  ['Q8', ['fired a tc or switched', 'leave a tc you have used']],
  ['Q9', ['do not use a tc', 'handle your own files solo']],
  ['Q10', ['finally hire a tc', 'finally handed off contract-to-close']],
  ['Q11', ['still end up doing yourself', 'never actually leaves your plate']],
  ['Q12', ['before they hired you', 'expectation agents show up with']],
  ['Q13', ['how many active files', 'honest max file count']],
];

function inferQuestionId(post) {
  if (post.discovery_question_id) return post.discovery_question_id;
  const body = String(post.post_body || '').toLowerCase();
  for (const [qid, snippets] of QUESTION_SNIPPETS) {
    if (snippets.some((s) => body.includes(s))) return qid;
  }
  return null;
}

// ─── Upsert (idempotent) ──────────────────────────────────────────────────────

/**
 * Upsert scraped comments for one post. Idempotent on
 * (post_url, commenter_name, md5(comment_text)).
 * @param {object} post group_posts row
 * @param {Array<{author:string,text:string,permalink:?string,atRaw:?string,at:?string}>} comments
 * @param {string} nowIso
 * @returns {Promise<{inserted:number, seen:number, skipped:number}>}
 */
async function upsertComments(post, comments, nowIso = new Date().toISOString()) {
  const questionId = inferQuestionId(post);
  const { ok, data, status } = await supabaseFetch(
    `/rest/v1/tc_discovery_responses?post_url=eq.${encodeURIComponent(post.post_url)}&select=id,commenter_name,comment_hash`,
  );
  if (!ok) throw new Error(`existing-rows fetch failed (${status}): ${JSON.stringify(data).slice(0, 200)}`);
  const existing = new Map((data || []).map((r) => [`${r.commenter_name}::${r.comment_hash}`, r.id]));

  const inserts = [];
  const seenIds = [];
  const localKeys = new Set(); // dedupe within a single scrape pass too
  const localCommentIds = new Set(); // FB's own comment_id — catches double-rendered DOM copies
  let skipped = 0;

  for (const c of comments) {
    const author = (c.author || '').trim();
    const text = c.text; // VERBATIM — never trimmed/normalized
    if (!author || !text || !text.trim()) { skipped++; continue; }
    // DOM-junk guard (2026-09-09): reject scraped nav/chrome noise before it
    // ever reaches tc_discovery_responses / the reply-approval drafting loop.
    // Rows that pass are still stored verbatim, untouched — this only
    // rejects candidates that were never real comment text to begin with.
    // See scripts/_lib/junk-text-guard.js.
    const junk = isJunkText(text);
    if (junk.junk) { skipped++; continue; }
    // Nested replies carry BOTH ids (?comment_id=PARENT&reply_comment_id=CHILD).
    // Dedupe on the reply's own id when present — matching the parent id here
    // silently discarded EVERY nested reply as a duplicate (bug found 2026-09-08).
    const cidMatch = c.permalink
      ? (String(c.permalink).match(/reply_comment_id=(\d+)/) || String(c.permalink).match(/[?&]comment_id=(\d+)/))
      : null;
    if (cidMatch) {
      if (localCommentIds.has(cidMatch[1])) { skipped++; continue; }
      localCommentIds.add(cidMatch[1]);
    }
    const key = `${author}::${normHash(text)}`;
    if (localKeys.has(key)) { skipped++; continue; }
    localKeys.add(key);
    if (existing.has(key)) {
      seenIds.push(existing.get(key));
      continue;
    }
    inserts.push({
      group_post_id: post.id,
      post_url: post.post_url,
      question_id: questionId,
      platform: 'facebook',
      source_group: post.group_name || null,
      commenter_name: author,
      comment_text: text,
      comment_permalink: c.permalink || null,
      commented_at: c.at || null,
      commented_at_raw: c.atRaw || null,
      is_own_comment: HEATH_FB_NAMES.some((n) => author.toLowerCase() === n.toLowerCase()),
      harvested_at: nowIso,
      last_seen_at: nowIso,
    });
  }

  if (inserts.length > 0) {
    const res = await supabaseFetch(
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
    const res = await supabaseFetch(
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

// Harvest metadata ONLY — the sole group_posts mutation in this script.
async function recordHarvestPass(post, nowIso = new Date().toISOString()) {
  const res = await supabaseFetch(`/rest/v1/group_posts?id=eq.${encodeURIComponent(post.id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      last_harvested_at: nowIso,
      harvest_count: (post.harvest_count || 0) + 1,
    }),
  });
  if (!res.ok) throw new Error(`recordHarvestPass failed (${res.status}): ${JSON.stringify(res.data).slice(0, 200)}`);
}

// ─── Facebook scraping (read-only) ────────────────────────────────────────────

async function detectLoggedOut(page) {
  const url = page.url();
  if (/\/login|\/checkpoint/i.test(url)) return true;
  try {
    const hasLoginForm = await page.locator('form[action*="login"], input[name="pass"]').first()
      .isVisible({ timeout: 2000 }).catch(() => false);
    if (hasLoginForm) return true;
  } catch { /* fall through */ }
  return false;
}

// Whitelisted, read-only expansion clicks. Nothing else is ever clicked.
const EXPAND_RE = /^(View (all )?\d+ (more )?(comments?|repl(?:y|ies))|View more comments|View more replies|Previous comments|\d+ (reply|replies)|See more)$/i;

async function expandThread(page) {
  // Click ALL matching expansion controls per round, marking each so FB's
  // double-rendered DOM clones (which never collapse after a click) can't
  // starve the loop — previously one dead clone ate all 12 rounds and
  // "View 1 reply" links further down were never reached (2026-09-08).
  for (let round = 0; round < 12; round++) {
    const clicked = await page.evaluate((reSrc) => {
      const re = new RegExp(reSrc, 'i');
      const btns = Array.from(document.querySelectorAll('div[role="button"], span[role="button"]'));
      let n = 0;
      for (const b of btns) {
        if (b.dataset.tcHarvestClicked) continue;
        const t = (b.innerText || '').trim();
        if (t && re.test(t) && !/see more$/i.test(t)) { b.dataset.tcHarvestClicked = '1'; b.click(); n++; }
      }
      return n;
    }, EXPAND_RE.source).catch(() => 0);
    if (!clicked) break;
    await sleep(1800);
  }
  // Expand truncated comment text ("See more") — still read-only.
  for (let round = 0; round < 3; round++) {
    const n = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('div[role="button"], span[role="button"]'))
        .filter((b) => (b.innerText || '').trim() === 'See more');
      btns.slice(0, 30).forEach((b) => b.click());
      return btns.length;
    }).catch(() => 0);
    if (!n) break;
    await sleep(1200);
  }
}

function parseRelativeTimestamp(raw, nowMs = Date.now()) {
  if (!raw) return null;
  const m = String(raw).trim().match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  let ms = null;
  if (unit.startsWith('m') && unit !== 'mo') ms = n * 60 * 1000;
  else if (unit.startsWith('h')) ms = n * HOUR;
  else if (unit.startsWith('d')) ms = n * DAY;
  else if (unit.startsWith('w')) ms = n * 7 * DAY;
  if (ms === null) return null;
  return new Date(nowMs - ms).toISOString();
}

async function scrapeComments(page) {
  const raw = await page.evaluate(() => {
    const out = [];
    const articles = Array.from(document.querySelectorAll('div[role="article"]'));
    for (const art of articles) {
      const label = art.getAttribute('aria-label') || '';
      const m = label.match(/^(?:Comment|Reply) by (.+)$/i);
      if (!m) continue; // the original post's article has no "Comment by" label
      // Live labels look like "Comment by Chaska Wilkinson about an hour ago"
      // / "... 36 minutes ago" — strip the trailing relative-time phrase.
      let author = m[1].replace(/\s+(?:about\s+)?(?:an?|\d+)\s+(?:second|minute|hour|day|week|month|year)s?\s+ago$/i, '').trim();
      // Prefer the first profile link's text when present (cleaner than aria-label parsing)
      const authorLink = art.querySelector('a[role="link"] span, a[role="link"] strong');
      if (authorLink && authorLink.innerText && authorLink.innerText.trim()) {
        author = authorLink.innerText.trim();
      }
      // Comment body: FB nests the message in div[dir="auto"] blocks.
      const blocks = Array.from(art.querySelectorAll('div[dir="auto"]'))
        .map((el) => el.innerText)
        .filter((t) => t && t.trim())
        .filter((t) => t.trim() !== author)
        .filter((t) => !/^(Like|Reply|Share|Follow|Edited|Author|Top contributor|Most relevant|All comments)$/i.test(t.trim()))
        .filter((t) => !/^\d+\s*(m|h|d|w|min|mins|hr|hrs|hour|hours|day|days|week|weeks)$/i.test(t.trim()));
      // Deduplicate nested-container repeats (outer div innerText contains inner's)
      const texts = [];
      for (const t of blocks) {
        if (!texts.some((prev) => prev.includes(t))) {
          const container = texts.findIndex((prev) => t.includes(prev));
          if (container >= 0) texts[container] = t; else texts.push(t);
        }
      }
      const text = texts.join('\n');
      const permA = art.querySelector('a[href*="comment_id"]');
      const permalink = permA ? permA.href.split('&__cft__')[0] : null;
      const atRaw = permA ? (permA.innerText || '').trim() || null : null;
      if (author && text) out.push({ author, text, permalink, atRaw });
    }
    return out;
  }).catch(() => []);

  return raw.map((c) => ({ ...c, at: parseRelativeTimestamp(c.atRaw) }));
}

async function launchContext(headless) {
  // Lazy requires so the regression test can import this module without playwright/a browser.
  const { chromium } = require('playwright');
  const { unlockProfile } = require(path.join(__dirname, '_lib', 'chrome-profile-unlock.js'));
  // Cooperative unlock (NO force): if the poster or another job holds the
  // profile, wait; on timeout, bail and let the next scheduled tick retry.
  await unlockProfile({ profileDir: CHROME_PROFILE_PATH, reason: 'tc-discovery-harvest' });
  return chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
    headless,
    channel: 'chrome',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1180,900', '--no-first-run'],
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const FORCE_ALL = args.includes('--all');
  const DRY_RUN = args.includes('--dry-run');
  const TRY_HEADLESS = args.includes('--headless');
  const postIdIdx = args.indexOf('--post-id');
  const POST_ID = postIdIdx >= 0 ? args[postIdIdx + 1] : null;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[tc-harvest] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
    process.exit(1);
  }

  const all = await fetchCampaignPosts(POST_ID);
  const now = Date.now();
  const due = (POST_ID || FORCE_ALL) ? all.filter((p) => p.post_url) : all.filter((p) => isDue(p, now));
  console.log(`[tc-harvest] ${all.length} posted campaign rows, ${due.length} due for harvest`);
  if (due.length === 0) return;

  let headless = TRY_HEADLESS;
  let context = null;
  try {
    context = await launchContext(headless);
  } catch (err) {
    if (/held|holder|lock|timeout/i.test(err.message || '')) {
      console.log(`[tc-harvest] profile busy (${err.message}) — skipping this tick, next run retries`);
      return;
    }
    throw err;
  }

  const summary = [];
  try {
    let page = context.pages()[0] || await context.newPage();

    for (const post of due) {
      const rec = { id: post.id, group: post.group_name, question: inferQuestionId(post), url: post.post_url };
      try {
        await page.goto(post.post_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(6000);

        if (await detectLoggedOut(page)) {
          if (headless) {
            // Known false-negative failure mode on this profile: a headless
            // launch has twice reported logged-out with a live session.
            // Treat as a launch fault: relaunch headed and re-check.
            console.warn('[tc-harvest] headless run reports logged-out — retrying HEADED before believing it');
            await context.close().catch(() => {});
            headless = false;
            context = await launchContext(false);
            page = context.pages()[0] || await context.newPage();
            await page.goto(post.post_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await sleep(6000);
          }
          if (await detectLoggedOut(page)) {
            console.error('[tc-harvest] HEADED run confirms logged-out. Aborting with no writes — DossieBot-Sage profile needs a manual FB login.');
            process.exitCode = 2;
            return;
          }
        }

        await expandThread(page);
        const comments = await scrapeComments(page);
        rec.scraped = comments.length;

        if (DRY_RUN) {
          rec.dry_run = true;
          console.log(`[tc-harvest][dry-run] ${post.group_name}: ${comments.length} comments`);
          for (const c of comments) console.log(`  - ${c.author} (${c.atRaw || '?'}): ${c.text.slice(0, 120).replace(/\n/g, ' ')}`);
        } else {
          const nowIso = new Date().toISOString();
          const res = await upsertComments(post, comments, nowIso);
          await recordHarvestPass(post, nowIso);
          Object.assign(rec, res);
          console.log(`[tc-harvest] ${post.group_name} [${rec.question || '??'}]: scraped=${comments.length} inserted=${res.inserted} seen=${res.seen} skipped=${res.skipped}`);
        }
      } catch (err) {
        rec.error = err.message;
        console.error(`[tc-harvest] FAILED ${post.group_name}: ${err.message}`);
      }
      summary.push(rec);
      await sleep(8000 + Math.floor(Math.random() * 7000)); // pacing between threads
    }
  } finally {
    if (context) await context.close().catch(() => {});
  }

  console.log('[tc-harvest] summary: ' + JSON.stringify(summary));
}

module.exports = {
  isDue,
  inferQuestionId,
  upsertComments,
  recordHarvestPass,
  parseRelativeTimestamp,
  fetchCampaignPosts,
  // Scraping machinery, shared with scripts/watch-guest-thread-replies.js.
  // These carry the 2026-09-08 fixes (singular "View 1 reply" in EXPAND_RE,
  // nested replies deduped on their OWN reply_comment_id, click-marking so
  // FB's double-rendered clones can't starve the expansion loop) — reuse
  // them, never re-implement.
  detectLoggedOut,
  expandThread,
  scrapeComments,
  launchContext,
  normHash,
  HEATH_FB_NAMES,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('[tc-harvest] FATAL:', err.message);
    process.exit(1);
  });
}
