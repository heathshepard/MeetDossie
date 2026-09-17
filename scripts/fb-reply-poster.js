'use strict';

// scripts/fb-reply-poster.js
//
// Playwright script: posts an approved fb_comment_replies draft as a Facebook
// reply to the original comment thread.
//
// Usage:
//   node scripts/fb-reply-poster.js --reply-id [uuid]
//
// The reply row must have status='approved'. Posts it, updates status='posted'
// ONLY when positive evidence confirms the reply is actually visible in the
// thread, and sends a confirmation to Heath's personal Telegram (Claudy bot).
//
// ─── THE 2026-09-17 FIX (false-'posted' bug, same shape as fb-group-poster.js
// 2026-09-16) ────────────────────────────────────────────────────────────────
// The old postReply() here typed the draft, pressed Enter, waited 3s, logged
// "posted successfully", and returned -- with NO check that the reply
// actually rendered. main() then called markPosted() unconditionally on any
// non-throwing return. That is the exact false-positive already found and
// fixed in the group-post pipeline: a submit with no confirming evidence is
// not proof of anything. It matters more here because auto-reply is live in
// production (cron-auto-approve.js auto-approves fb_comment_replies after a
// 10-minute veto window) -- a reply the system believes it answered but never
// actually posted will never be retried, because it silently looks done.
//
// THE FIX
// -------
// Reuses the ALREADY-VERIFIED reply automation from
// scripts/fb-group-commenter.js (postReplyToComment + verifyReplyPosted --
// the proven code path scripts/fb-group-commenter.js --tc-reply-queue uses
// for the live tc_discovery_responses auto-reply loop) instead of a second,
// unverified Playwright implementation. The outcome is then resolved through
// the SAME shared decision function group-posts use
// (scripts/_lib/fb-post-verify-outcome.js resolvePostStatus), generalized
// 2026-09-17 to also cover a post-submit 'blocked' outcome (Facebook
// blocked/removed the reply after a real submit occurred).
//
// Four distinguishable, non-collapsed outcomes (never one "failed" bucket):
//   - posted            positive evidence (verifyReplyPosted found the reply
//                        rendered in the re-fetched thread) -> status='posted'
//   - blocked           a submit occurred but Facebook's own UI shows a
//                        block/removal message afterward -> status='blocked',
//                        terminal, NOT retried
//   - failed            a submit occurred but neither verification nor an
//                        explicit block signal confirms or denies it
//                        ("submitted-but-not-found" -- needs a human re-check,
//                        per Heath's "never retry an unverified send" rule) ->
//                        status='failed', terminal, NOT reset to 'approved'
//   - approved (retry)  NOTHING was submitted at all (couldn't find the
//                        comment/Reply button, redirected to login, etc.) --
//                        safe to reset to 'approved' for a normal retry,
//                        because no keystroke that could have created a
//                        duplicate live reply ever landed
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   TELEGRAM_BOT_TOKEN  (personal Claudy bot)
//   TELEGRAM_CHAT_ID

const path = require('path');
const os = require('os');

// Load .env.local when running locally
try {
  const fs = require('fs');
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
} catch (e) {
  // Non-fatal
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const CHROME_PROFILE_PATH = path.join(
  os.homedir(),
  'AppData', 'Local', 'Google', 'Chrome', 'User Data'
);

// Reuse the proven, already-verified reply automation instead of a second
// parallel implementation. Both take a Playwright `page` + a row shaped
// { comment_permalink, post_url, commenter_name, comment_text }.
const { postReplyToComment, verifyReplyPosted } = require('./fb-group-commenter.js');
const { resolvePostStatus } = require('./_lib/fb-post-verify-outcome.js');

// ─── Supabase ─────────────────────────────────────────────────────────────────

async function supabaseFetch(urlPath, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

async function fetchReply(replyId) {
  const { ok, data } = await supabaseFetch(
    `/rest/v1/fb_comment_replies?id=eq.${encodeURIComponent(replyId)}&select=*&limit=1`,
  );
  if (!ok || !Array.isArray(data) || !data.length) return null;
  return data[0];
}

async function fetchGroupPost(groupPostId) {
  const { ok, data } = await supabaseFetch(
    `/rest/v1/group_posts?id=eq.${encodeURIComponent(groupPostId)}&select=id,group_name,post_url,group_url&limit=1`,
  );
  if (!ok || !Array.isArray(data) || !data.length) return null;
  return data[0];
}

// Positive evidence confirmed the reply is live. verified_at/reply_error
// require supabase/migrations/20260917_fb_comment_replies_verify_outcome.sql
// to have been applied -- see api/admin-migrate-fb-comment-replies-verify-outcome.js.
async function markPosted(replyId) {
  const now = new Date().toISOString();
  await supabaseFetch(`/rest/v1/fb_comment_replies?id=eq.${encodeURIComponent(replyId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'posted', posted_at: now, verified_at: now, reply_error: null }),
  });
}

// Pre-submit failure ONLY -- no keystroke that could have created a
// duplicate live reply was ever sent (couldn't locate the comment/Reply
// button, redirected to login, etc.). Safe to reset to 'approved' so the
// next auto-approve/manual-run cycle retries it cleanly.
async function markPreSubmitFailed(replyId, reason) {
  await supabaseFetch(`/rest/v1/fb_comment_replies?id=eq.${encodeURIComponent(replyId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'approved', reply_error: reason ? String(reason).slice(0, 500) : null }),
  });
  console.error('[fb-reply-poster] pre-submit failure (reset to approved, safe to retry):', reason);
}

// A submit action occurred but neither a block signal nor verification
// confirms/denies whether it landed. Terminal -- do NOT reset to 'approved'.
// Retrying blindly risks a duplicate real reply if the original submit
// actually succeeded (Heath's "never retry an unverified send" rule).
async function markUnconfirmed(replyId, reason) {
  await supabaseFetch(`/rest/v1/fb_comment_replies?id=eq.${encodeURIComponent(replyId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'failed',
      posted_at: new Date().toISOString(), // a submit really happened
      reply_error: reason ? String(reason).slice(0, 500) : null,
    }),
  });
  console.warn('[fb-reply-poster] UNCONFIRMED (terminal, will NOT auto-retry):', reason);
}

// Facebook itself showed a block/removal signal after the submit. Terminal,
// not retryable without a human fixing the underlying restriction.
async function markBlocked(replyId, reason) {
  await supabaseFetch(`/rest/v1/fb_comment_replies?id=eq.${encodeURIComponent(replyId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'blocked',
      posted_at: new Date().toISOString(),
      reply_error: reason ? String(reason).slice(0, 500) : null,
    }),
  });
  console.warn('[fb-reply-poster] BLOCKED (terminal, will NOT auto-retry):', reason);
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegramConfirmation(groupName, draft, outcomeStatus, reason) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  let text;
  if (outcomeStatus === 'posted') {
    text = `Posted reply in ${groupName}:\n\n"${draft}"`;
  } else if (outcomeStatus === 'failed') {
    text = `UNCONFIRMED reply in ${groupName} -- submitted but could not verify it landed. Check Facebook manually before retrying (it may be live):\n\n"${draft}"\n\n${reason || ''}`;
  } else if (outcomeStatus === 'blocked') {
    text = `BLOCKED reply in ${groupName} -- Facebook blocked/removed it after submit. Needs a human fix, will not auto-retry:\n\n${reason || ''}`;
  } else {
    text = `Failed to post reply in ${groupName} (nothing was submitted, will retry): ${reason || ''}`;
  }
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  }).catch((err) => console.warn('[fb-reply-poster] Telegram notification failed:', err.message));
}

// ─── Block/removal detection ────────────────────────────────────────────────
//
// Runs AFTER a submit occurred (postReplyToComment resolved). Deliberately
// narrow, known Facebook blocking/removal phrasing only -- generic "Join
// Group"/"Switch to your main profile" patterns
// (scripts/_lib/fb-group-access-detect.js) are pre-submit GROUP-ACCESS gates
// for the Page-identity group-poster and don't fit this personal-profile,
// post-submit context.
const BLOCKED_PATTERNS = [
  /temporarily blocked/i,
  /blocked from commenting/i,
  /violates? (our )?(community standards|policies)/i,
  /we removed your comment/i,
  /this comment (was|has been) removed/i,
  /you.?re restricted from (commenting|posting)/i,
];

async function detectBlocked(page) {
  try {
    const bodyText = await page.locator('body').innerText({ timeout: 2000 });
    const hit = BLOCKED_PATTERNS.find((re) => re.test(bodyText));
    return hit ? hit.exec(bodyText)[0] : null;
  } catch {
    return null;
  }
}

// ─── Playwright posting ────────────────────────────────────────────────────────

// Real Chrome launch -- split out so regression tests can inject a mock
// instead (see scripts/regression-fb-reply-poster-verify.js).
async function launchRealContext() {
  const { chromium } = require('playwright');
  console.log('[fb-reply-poster] NOTE: Close all Chrome windows before running this script.');

  // Fix #6 (Atlas, 2026-06-11): chrome-profile-unlock pre-flight on every
  // fb-reply-poster run. Kills stale chrome.exe holding the user-data-dir
  // lock so the persistent context can attach cleanly.
  try {
    const { unlockProfile } = require('./_lib/chrome-profile-unlock');
    const unlocked = await unlockProfile({ profileDir: CHROME_PROFILE_PATH, reason: 'fb-reply-poster' });
    if (unlocked.killed > 0) {
      console.log(`[fb-reply-poster] profile-unlock: killed ${unlocked.killed} stale chrome process(es)`);
    }
  } catch (e) {
    console.warn(`[fb-reply-poster] profile-unlock non-fatal error: ${e.message}`);
  }

  const context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
    ],
    viewport: { width: 1280, height: 900 },
    channel: 'chrome',
  });

  const page = await context.newPage();
  return { context, page };
}

// Returns { status, reason } -- one of 'posted' | 'blocked' | 'failed'
// (submitted-but-unconfirmed) | 'not_submitted' (pre-submit failure, caller
// resets to 'approved' for retry).
//
// `deps` is test-only injection (poster/verifier/blockedDetector/launch) --
// real callers pass none and get the live Playwright/network path. Mirrors
// scripts/fb-group-commenter.js's runTcReplyQueue(deps) pattern so this stays
// unit-testable without launching Chrome.
async function runReplyFlow(row, draft, deps = {}) {
  const poster = deps.poster || postReplyToComment;
  const verifier = deps.verifier || verifyReplyPosted;
  const blockedDetector = deps.blockedDetector || detectBlocked;
  const launch = deps.launch || launchRealContext;

  const { context, page } = await launch();

  try {
    let submitResult;
    try {
      submitResult = await poster(page, row, draft);
    } catch (err) {
      // Nothing was typed/submitted -- safe to retry (mirrors
      // fb-group-poster.js's pre-submit failure handling).
      return { status: 'not_submitted', reason: err && err.message };
    }

    if (!submitResult || !submitResult.submitted) {
      return { status: 'not_submitted', reason: 'postReplyToComment returned without submitting' };
    }

    // From here on a real submit happened -- never fall back to a blind
    // 'approved' retry no matter what's checked next.
    const blockedMatch = await blockedDetector(page);
    if (blockedMatch) {
      return resolvePostStatus({ blocked: true, blockedReason: `facebook showed a block/removal message: "${blockedMatch}"` });
    }

    const verified = await verifier(page, row, draft);
    return resolvePostStatus({ feedConfirmed: !!verified });
  } finally {
    await context.close();
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(replyId) {
  const REPLY_ID = replyId;
  const reply = await fetchReply(REPLY_ID);
  if (!reply) {
    console.error('[fb-reply-poster] reply not found:', REPLY_ID);
    process.exit(1);
  }

  if (reply.status !== 'approved') {
    console.error(`[fb-reply-poster] reply status is '${reply.status}', expected 'approved'. Exiting.`);
    process.exit(1);
  }

  const groupPost = await fetchGroupPost(reply.group_post_id);
  if (!groupPost) {
    console.error('[fb-reply-poster] group_post not found for group_post_id:', reply.group_post_id);
    process.exit(1);
  }

  const postUrl = groupPost.post_url || groupPost.group_url;
  if (!postUrl) {
    console.error('[fb-reply-poster] no post_url or group_url on group_post:', groupPost.id);
    process.exit(1);
  }

  const draft = reply.our_response_draft;
  const row = {
    comment_permalink: null,
    post_url: postUrl,
    commenter_name: reply.reply_author,
    comment_text: reply.reply_text,
  };

  console.log(`[fb-reply-poster] posting reply to "${groupPost.group_name}"`);
  console.log(`[fb-reply-poster] in response to ${reply.reply_author}: "${String(reply.reply_text || '').slice(0, 60)}"`);
  console.log(`[fb-reply-poster] draft: "${draft}"`);

  const outcome = await runReplyFlow(row, draft).catch((err) => ({ status: 'not_submitted', reason: err && err.message }));

  if (outcome.status === 'posted') {
    await markPosted(REPLY_ID);
    await sendTelegramConfirmation(groupPost.group_name, draft, 'posted', null);
    console.log('[fb-reply-poster] done — verified posted');
  } else if (outcome.status === 'blocked') {
    await markBlocked(REPLY_ID, outcome.reason);
    await sendTelegramConfirmation(groupPost.group_name, draft, 'blocked', outcome.reason);
    process.exit(1);
  } else if (outcome.status === 'failed') {
    // Submitted but unconfirmed -- terminal, never a blind retry.
    await markUnconfirmed(REPLY_ID, outcome.reason);
    await sendTelegramConfirmation(groupPost.group_name, draft, 'failed', outcome.reason);
    process.exit(1);
  } else {
    // not_submitted -- nothing happened that could duplicate on retry.
    await markPreSubmitFailed(REPLY_ID, outcome.reason);
    await sendTelegramConfirmation(groupPost.group_name, draft, 'not_submitted', outcome.reason);
    process.exit(1);
  }
}

module.exports = {
  runReplyFlow,
  detectBlocked,
  BLOCKED_PATTERNS,
  main,
  markPosted,
  markPreSubmitFailed,
  markUnconfirmed,
  markBlocked,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const replyIdIdx = args.indexOf('--reply-id');
  const REPLY_ID = replyIdIdx >= 0 ? args[replyIdIdx + 1] : null;

  if (!REPLY_ID) {
    console.error('[fb-reply-poster] Usage: node scripts/fb-reply-poster.js --reply-id [uuid]');
    process.exit(1);
  }

  main(REPLY_ID).catch((err) => {
    console.error('[fb-reply-poster] fatal error:', err && err.message);
    process.exit(1);
  });
}
