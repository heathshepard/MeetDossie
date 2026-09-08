'use strict';

// scripts/fb-comment-opp-poster.js
//
// Part 3 (paced posting) of the daily comment-opportunity pipeline. Drains
// comment_opportunities rows with status='approved' (Heath explicitly
// approved each one in Telegram via cron-comment-opp-approval / the oppc_*
// webhook callbacks) and posts each as a TOP-LEVEL comment on the source
// post — then VERIFIES it by re-rendering the thread and reading it back,
// and registers the thread in comment_watchlist so
// scripts/watch-guest-thread-replies.js catches replies to Heath.
//
// Usage:
//   node scripts/fb-comment-opp-poster.js               # post (at most ONE per run)
//   node scripts/fb-comment-opp-poster.js --dry-run     # list the approved queue
//   node scripts/fb-comment-opp-poster.js --clear-halt  # clear the circuit breaker
//
// HARD RULES (same doctrine as fb-group-commenter.js --tc-reply-queue):
//   - NOTHING posts without status='approved' (Heath's explicit tap/edit).
//   - One comment per post, EVER: unique post_url in the table, a
//     comment_watchlist thread check, a live already-commented DOM check
//     before any keystroke, and an atomic 'approved' -> 'posting' claim.
//     'posted'/'post_failed' are terminal and never retried (a verify
//     failure can mean the comment DID post).
//   - PACING over volume: 'facebook_auto' budget (8/day default — the config
//     value lives in scripts/_lib/comment-caps.js PLATFORM_DAILY_CAPS) and a
//     VARIED 45-60 min gap: 45-min floor plus fresh random jitter each run,
//     so spacing never looks metronomic. The profile was shadowbanned in
//     June at 12/day from automated bursts; losing it ends the entire
//     distribution strategy.
//   - CIRCUIT BREAKER (scripts/_lib/comment-hunt-halt.js): a verify failure,
//     a login/checkpoint redirect, or a removed comment (detected by the
//     daily scanner) halts scanner AND poster until a human clears it.
//   - Every post is VERIFIED by re-rendering the thread before the row is
//     marked posted. DossieBot-Sage profile, headed, cooperative unlock.
//
// Scheduling: Windows Task Scheduler task "Dossie TC Discovery Harvest"
// (scripts/run-tc-discovery-harvest.cmd, 30-min tick). No-op runs exit in
// ~2s without launching Chrome.
//
// Owner: Carter, 2026-09-08

const path = require('path');
const os = require('os');
const fs = require('fs');

// Load .env.local when running locally
try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
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

const halt = require('./_lib/comment-hunt-halt');

const SAGE_PROFILE_PATH = process.env.SAGE_PROFILE_DIR || path.join(
  os.homedir(), 'AppData', 'Local', 'DossieBot-Sage'
);
const HEATH_FB_NAMES = ['Heath Shepard'];
const BUDGET = 'facebook_auto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Varied spacing: 45-min floor + fresh 0-15 min jitter per run (45-60, never fixed). */
function variedGapMinutes(capsModule) {
  const floor = (capsModule && capsModule.MIN_GAP_MINUTES && capsModule.MIN_GAP_MINUTES[BUDGET]) || 45;
  return floor + Math.random() * 15;
}

function makeSbFetch() {
  return async function sbFetch(urlPath, init = {}) {
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
  };
}

// Direct send — approval/safety plumbing, not cron noise.
async function notifyHeath(text) {
  const token = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4090), disable_web_page_preview: true }),
  }).catch(() => {});
}

/**
 * Atomically claim an approved row ('approved' -> 'posting'). The
 * status-guarded PATCH is the double-post lock.
 */
async function claimApprovedOpp(sbFetch, rowId) {
  const res = await sbFetch(
    `/rest/v1/comment_opportunities?id=eq.${encodeURIComponent(rowId)}&status=eq.approved`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'posting', updated_at: new Date().toISOString() }),
    },
  );
  if (res.ok && Array.isArray(res.data) && res.data.length > 0) return res.data[0];
  return null;
}

async function finalizeOpp(sbFetch, rowId, patch) {
  return sbFetch(`/rest/v1/comment_opportunities?id=eq.${encodeURIComponent(rowId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
}

/** Register the posted comment so the guest-thread watcher catches replies.
 * Plain insert (no on_conflict: the watchlist's source-uniqueness index is
 * partial, which PostgREST upsert inference can't target) — duplicates are
 * impossible anyway because the queue skips any thread already watched. */
async function registerWatch(sbFetch, row, finalText) {
  const ins = await sbFetch('/rest/v1/comment_watchlist', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      thread_url: row.post_url,
      group_name: row.group_name,
      post_author: row.author_name || null,
      direction: 'heath_commented_on_others',
      our_text: finalText,
      post_body: row.post_text || null,
      source_table: 'comment_opportunities',
      source_id: row.id,
      posted_at: new Date().toISOString(),
      status: 'watching',
    }),
  });
  if (ins.ok && Array.isArray(ins.data) && ins.data.length > 0) return ins.data[0].id;
  return null;
}

// ─── Browser side ────────────────────────────────────────────────────────────

async function expandRepliesReadOnly(page) {
  const EXPAND_RE = /^(View (all )?\d+ (more )?(comments|replies)|View more comments|View more replies|Previous comments|\d+ (reply|replies))$/i;
  for (let round = 0; round < 10; round++) {
    const clicked = await page.evaluate((reSrc) => {
      const re = new RegExp(reSrc, 'i');
      const btns = Array.from(document.querySelectorAll('div[role="button"], span[role="button"]'));
      for (const b of btns) {
        const t = (b.innerText || '').trim();
        if (t && re.test(t)) { b.click(); return t; }
      }
      return null;
    }, EXPAND_RE.source).catch(() => null);
    if (!clicked) break;
    await sleep(1800);
  }
}

async function heathCommentPresent(page) {
  return page.evaluate((names) => {
    const articles = Array.from(document.querySelectorAll('div[role="article"]'));
    for (const art of articles) {
      const label = art.getAttribute('aria-label') || '';
      if (!/^(Comment|Reply) by /i.test(label)) continue;
      if (names.some((n) => label.toLowerCase().includes(n.toLowerCase()))) return true;
    }
    return false;
  }, HEATH_FB_NAMES).catch(() => false);
}

/**
 * Post `commentText` as a TOP-LEVEL comment on row.post_url.
 * Returns { submitted: true } after keystrokes land, or
 * { alreadyCommented: true } if Heath already has a comment in the thread
 * (nothing typed). Throws (submitted=false semantics) before any keystroke.
 */
async function postTopLevelComment(page, row, commentText) {
  await page.goto(row.post_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(6000);
  if (/\/login|\/checkpoint/i.test(page.url())) {
    throw Object.assign(new Error('redirected to login/checkpoint'), { code: 'CHECKPOINT' });
  }
  await expandRepliesReadOnly(page);

  // Live layer of the one-comment-per-post-ever guarantee.
  if (await heathCommentPresent(page)) return { alreadyCommented: true };

  const commentBoxSelectors = [
    '[aria-label="Write a comment..."]',
    '[aria-label="Write a public comment..."]',
    '[aria-label="Comment as Heath Shepard"]',
    'div[contenteditable="true"][role="textbox"]',
  ];
  let commentBox = null;
  for (const selector of commentBoxSelectors) {
    try {
      commentBox = await page.waitForSelector(selector, { timeout: 5000 });
      if (commentBox) break;
    } catch { continue; }
  }
  if (!commentBox) throw new Error('could not find the comment composer on the post');

  await commentBox.click();
  await page.waitForFunction(
    () => document.activeElement && document.activeElement.getAttribute('contenteditable') === 'true',
  ).catch(() => {});
  await page.keyboard.type(commentText, { delay: 35 });
  await sleep(500);
  await page.keyboard.press('Enter'); // FB comment composer submits on Enter
  // From here on the comment may be live — caller must treat this as submitted.
  await sleep(5000);
  return { submitted: true };
}

/** Verify the comment is actually live: re-render the thread and read it back. */
async function verifyCommentPosted(page, row, commentText) {
  await page.goto(row.post_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(6000);
  await expandRepliesReadOnly(page);
  const wanted = normText(commentText).slice(0, 120);
  return page.evaluate(({ names, wanted: w }) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const articles = Array.from(document.querySelectorAll('div[role="article"]'));
    for (const art of articles) {
      const label = art.getAttribute('aria-label') || '';
      if (!/^(Comment|Reply) by /i.test(label)) continue;
      const isOwn = names.some((n) => label.toLowerCase().includes(n.toLowerCase()));
      if (!isOwn) continue;
      if (norm(art.innerText).includes(w)) return true;
    }
    return false;
  }, { names: HEATH_FB_NAMES, wanted }).catch(() => false);
}

// ─── Core queue logic (deps injectable — the regression test runs this with
//     mocks: no browser, no network) ─────────────────────────────────────────

/**
 * @param {object} deps {
 *   sbFetch, caps, poster, verifier, notify, log,
 *   gapMinutes  — required spacing for THIS run (prod: variedGapMinutes()),
 *   haltState   — { isHalted, setHalt } (prod: scripts/_lib/comment-hunt-halt)
 * }
 * @returns {Promise<{posted:number, queuedForCap:number, failed:number, skipped:number, halted:boolean}>}
 */
async function runOppQueue(deps = {}) {
  const sbFetch = deps.sbFetch || makeSbFetch();
  const caps = deps.caps || require('./_lib/comment-caps.js');
  const poster = deps.poster;     // async (row, text) => { submitted } | { alreadyCommented }
  const verifier = deps.verifier; // async (row, text) => boolean
  const notify = deps.notify || notifyHeath;
  const log = deps.log || console;
  const haltState = deps.haltState || halt;
  const gapMinutes = deps.gapMinutes != null ? deps.gapMinutes : variedGapMinutes(caps);
  const out = { posted: 0, queuedForCap: 0, failed: 0, skipped: 0, halted: false };

  if (haltState.isHalted()) {
    out.halted = true;
    log.log('[opp-poster] pipeline HALTED — nothing posts until the halt is cleared');
    return out;
  }

  // ONLY Heath-approved rows. Nothing else is ever eligible.
  const { ok, data } = await sbFetch(
    '/rest/v1/comment_opportunities'
    + '?status=eq.approved&posted_at=is.null'
    + '&select=id,post_url,group_name,author_name,post_text,comment_final,comment_draft'
    + '&order=approved_at.asc',
  );
  if (!ok) throw new Error('failed to load approved opportunities');
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) return out;

  // Daily cap on the dedicated automated-initiated-comment budget.
  const capCheck = await caps.canComment(BUDGET, sbFetch);
  if (!capCheck.allowed) {
    out.queuedForCap = rows.length;
    log.log(`[opp-poster] cap hit (${capCheck.reason}) — ${rows.length} approved comment(s) stay queued`);
    await notify(`Comment queue: daily budget hit (${capCheck.reason}). ${rows.length} approved comment(s) queued — they post automatically starting tomorrow.`);
    return out;
  }

  // Varied 45-60 min spacing: floor + per-run jitter against the last post.
  const { data: lastData } = await sbFetch(
    '/rest/v1/comment_opportunities?status=eq.posted&posted_at=not.is.null&order=posted_at.desc&limit=1&select=posted_at',
  );
  if (Array.isArray(lastData) && lastData.length > 0) {
    const ageMin = (Date.now() - new Date(lastData[0].posted_at).getTime()) / 60000;
    if (ageMin < gapMinutes) {
      out.queuedForCap = rows.length;
      log.log(`[opp-poster] spacing gap not elapsed (${Math.round(ageMin)}m/${Math.round(gapMinutes)}m) — queued for a later run`);
      return out; // silent: resolves within the hour
    }
  }

  // ONE post per run — spacing comes from the run cadence + gap, never bursts.
  for (const row of rows) {
    const commentText = String(row.comment_final || '').trim();
    if (!commentText) {
      // Approved with no text should be impossible — park it, don't guess.
      await finalizeOpp(sbFetch, row.id, { status: 'post_failed', error: 'approved row has empty comment_final' });
      out.failed++;
      continue;
    }

    // One-comment-per-post-ever, layer 2: any pipeline already posted there?
    const { data: watchHit } = await sbFetch(
      `/rest/v1/comment_watchlist?thread_url=eq.${encodeURIComponent(row.post_url)}&select=id&limit=1`,
    );
    if (Array.isArray(watchHit) && watchHit.length > 0) {
      await finalizeOpp(sbFetch, row.id, { status: 'skipped', error: 'thread already in comment_watchlist — a comment was already posted there' });
      out.skipped++;
      continue;
    }

    // Double-post lock: atomic claim.
    const claimed = await claimApprovedOpp(sbFetch, row.id);
    if (!claimed) {
      out.skipped++;
      continue;
    }

    let postRes = null;
    try {
      postRes = await poster(row, commentText);
    } catch (err) {
      if (err && err.code === 'CHECKPOINT') {
        // Profile-level fault, not a row fault: nothing was typed. Put the
        // row back, halt EVERYTHING, tell Heath.
        await finalizeOpp(sbFetch, row.id, { status: 'approved' });
        haltState.setHalt('facebook login/checkpoint redirect while posting', { opportunity_id: row.id });
        await notify(`COMMENT PIPELINE HALTED — Facebook redirected to login/checkpoint while posting in ${row.group_name}. This can mean a temp block. Check the DossieBot-Sage profile, then clear the halt:\nnode scripts/fb-comment-opp-poster.js --clear-halt`);
        out.halted = true;
        return out;
      }
      // DOM failure before any keystroke — park it, hand Heath the text.
      // Never auto-retry (a repeating DOM failure would hammer the thread).
      await finalizeOpp(sbFetch, row.id, { status: 'post_failed', error: `not_submitted: ${String(err.message).slice(0, 300)}` });
      await notify(`Comment FAILED (nothing was posted) in ${row.group_name}.\nError: ${err.message}\n\nPost it manually:\n${commentText}\n\n${row.post_url}`);
      out.failed++;
      return out; // one attempt per run, even on failure
    }

    if (postRes && postRes.alreadyCommented) {
      // Live DOM shows Heath already commented — layer 3 of the guarantee.
      await finalizeOpp(sbFetch, row.id, { status: 'skipped', error: 'heath already has a comment on this thread (live check)' });
      out.skipped++;
      continue; // nothing typed; safe to consider the next candidate
    }

    // Count against the cap the moment keystrokes were submitted — even if
    // verification fails below, the comment may be live on Facebook.
    await caps.recordComment(BUDGET, sbFetch);

    const verified = await verifier(row, commentText);
    if (verified) {
      const watchlistId = await registerWatch(sbFetch, row, commentText);
      await finalizeOpp(sbFetch, row.id, {
        status: 'posted',
        posted_at: new Date().toISOString(),
        watchlist_id: watchlistId,
        error: null,
      });
      out.posted++;
      log.log(`[opp-poster] posted + verified comment in ${row.group_name}`);
    } else {
      // Submitted but could not read it back. TERMINAL — never auto-retry
      // (retrying a comment that actually landed = double-post) — and a
      // failed render-back is a warning sign: HALT everything.
      await finalizeOpp(sbFetch, row.id, {
        status: 'post_failed',
        error: 'submitted but verification could not find the comment in the re-rendered thread',
      });
      haltState.setHalt('comment submitted but failed to render back on verify', { opportunity_id: row.id, post_url: row.post_url });
      await notify(`COMMENT PIPELINE HALTED — a comment in ${row.group_name} was submitted but could NOT be read back from the thread. It may or may not be live — check manually:\n${row.post_url}\n\nNothing else will post until you clear the halt:\nnode scripts/fb-comment-opp-poster.js --clear-halt`);
      out.failed++;
      out.halted = true;
    }
    return out; // ONE post per run, always
  }

  return out;
}

// ─── Entrypoint ──────────────────────────────────────────────────────────────

async function mainCli() {
  const args = process.argv.slice(2);

  if (args.includes('--clear-halt')) {
    const entry = halt.getHalt();
    if (!entry) { console.log('[opp-poster] no halt set'); return; }
    halt.clearHalt();
    console.log(`[opp-poster] halt cleared (was: ${entry.reason} @ ${entry.halted_at})`);
    return;
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[opp-poster] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
    process.exit(1);
  }
  const sbFetch = makeSbFetch();

  if (args.includes('--dry-run')) {
    const { data } = await sbFetch(
      '/rest/v1/comment_opportunities?status=eq.approved&select=id,group_name,comment_final&order=approved_at.asc',
    );
    const rows = Array.isArray(data) ? data : [];
    console.log(`[opp-poster][dry-run] ${rows.length} approved comment(s) queued:`);
    for (const r of rows) console.log(`  - ${r.group_name}: ${String(r.comment_final || '').slice(0, 100)}`);
    console.log(`[opp-poster][dry-run] halted: ${halt.isHalted()}`);
    return;
  }

  if (halt.isHalted()) {
    const entry = halt.getHalt();
    console.log(`[opp-poster] HALTED (${entry.reason} @ ${entry.halted_at}) — exiting`);
    return;
  }

  // Quick emptiness probe before launching Chrome at all.
  const probe = await sbFetch('/rest/v1/comment_opportunities?status=eq.approved&select=id&limit=1');
  if (!probe.ok || !Array.isArray(probe.data) || probe.data.length === 0) {
    console.log('[opp-poster] nothing approved — exiting without launching Chrome');
    return;
  }

  // Lazy Chrome: launched only when runOppQueue actually reaches the poster
  // (cap/gap short-circuits above it never touch the profile).
  let context = null;
  let page = null;
  async function ensurePage() {
    if (page) return page;
    const { chromium } = require('playwright');
    const { unlockProfile } = require('./_lib/chrome-profile-unlock');
    await unlockProfile({ profileDir: SAGE_PROFILE_PATH, reason: 'opp-poster' });
    context = await chromium.launchPersistentContext(SAGE_PROFILE_PATH, {
      headless: false, // headless has twice falsely reported logged-out on this profile
      channel: 'chrome',
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1180,900', '--no-first-run'],
      viewport: null,
      ignoreDefaultArgs: ['--enable-automation'],
    });
    page = context.pages()[0] || await context.newPage();
    return page;
  }

  try {
    const result = await runOppQueue({
      sbFetch,
      poster: async (row, text) => postTopLevelComment(await ensurePage(), row, text),
      verifier: async (row, text) => verifyCommentPosted(await ensurePage(), row, text),
    });
    console.log('[opp-poster] done:', JSON.stringify(result));
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

module.exports = {
  runOppQueue,
  claimApprovedOpp,
  finalizeOpp,
  registerWatch,
  postTopLevelComment,
  verifyCommentPosted,
  variedGapMinutes,
  BUDGET,
};

if (require.main === module) {
  mainCli().catch((err) => {
    console.error('[opp-poster] fatal:', err.message);
    process.exit(1);
  });
}
