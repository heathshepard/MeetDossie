'use strict';

// scripts/fb-group-commenter.js
//
// Scans FB groups for posts mentioning TC pain keywords, drafts a reply via
// Claude Haiku in Heath's voice, sends to Telegram for approval, then posts
// the comment if approved within 30 minutes.
//
// Usage:
//   node scripts/fb-group-commenter.js                       # legacy scan-and-comment mode
//   node scripts/fb-group-commenter.js --tc-reply-queue      # post APPROVED TC discovery replies
//   node scripts/fb-group-commenter.js --tc-reply-queue --dry-run
//
// Env vars required:
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID
//   ANTHROPIC_API_KEY (scan mode only)
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (--tc-reply-queue only)
//
// Groups are loaded from scripts/fb-commenter-groups.json (local file).
// Add or edit group entries there — no database needed.
//
// ─── --tc-reply-queue (Carter, 2026-09-08) ───────────────────────────────────
// Drains tc_discovery_responses rows with reply_status='approved' (Heath
// explicitly approved each one in Telegram via cron-tc-reply-approval) and
// posts each reply THREADED UNDER THE SPECIFIC COMMENT — the capability the
// legacy postComment() lacks (it can only type into the post's top-level
// "Write a comment..." box). Covers BOTH thread roles: comments on Heath's
// own campaign posts (thread_role='host') and replies to comments Heath left
// on other people's posts (thread_role='guest', fed by
// scripts/watch-guest-thread-replies.js) — same lifecycle, same locks.
//
// Hard rules:
//   - NOTHING posts without reply_status='approved' (Heath's explicit tap).
//   - One reply per comment, EVER: rows are claimed with an atomic
//     status-guarded PATCH ('approved' -> 'posting'); 'posted'/'post_failed'
//     are terminal and never retried (a verify failure can mean it DID post).
//   - Respects scripts/_lib/comment-caps.js on the dedicated 'facebook_reply'
//     budget (10/day + 30-min min-gap — separate from the 'facebook' budget
//     Heath's initiated comments use, so neither starves the other).
//     Over-cap approved replies stay queued and Heath gets ONE Telegram note.
//   - Every post is VERIFIED by re-rendering the thread and reading the reply
//     back before the row is marked posted.
//   - Uses the DossieBot-Sage Chrome profile (same live FB session the
//     harvester reads with), cooperative unlock, headed.
// Scheduled from run-tc-discovery-harvest.cmd right after each harvest pass.

const path = require('path');
const os = require('os');
const fs = require('fs');

// Load .env.local when running locally
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
} catch (e) {
  // Non-fatal
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const CHROME_PROFILE_PATH = process.env.PLAYWRIGHT_PROFILE_DIR || path.join(
  os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data'
);
const PLAYWRIGHT_PROFILE_NAME = process.env.PLAYWRIGHT_PROFILE_NAME || 'Profile 4';

const GROUPS_FILE = path.join(__dirname, 'fb-commenter-groups.json');
const SEEN_FILE = path.join(__dirname, '.fb-commenter-seen.json');
const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const TC_KEYWORDS = [
  'transaction coordinator',
  ' tc ',
  'need help with my deals',
  'looking for a tc',
  'my tc quit',
  'overwhelmed with paperwork',
  'need a tc',
  'hire a tc',
  'transaction coordinating',
];

// ─── Local groups loader ──────────────────────────────────────────────────────

function loadGroups() {
  if (!fs.existsSync(GROUPS_FILE)) {
    console.error(`[fb-group-commenter] Groups file not found: ${GROUPS_FILE}`);
    console.error('[fb-group-commenter] Create it with entries: [{"group_name":"...", "group_url":"https://www.facebook.com/groups/..."}]');
    return [];
  }
  try {
    const raw = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
    return raw.filter(g => g.group_url && !g.group_url.includes('PLACEHOLDER'));
  } catch (e) {
    console.error('[fb-group-commenter] Failed to parse groups file:', e.message);
    return [];
  }
}

// ─── Seen-posts dedup ─────────────────────────────────────────────────────────

function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')));
    }
  } catch { /* ignore */ }
  return new Set();
}

function saveSeen(set) {
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify([...set]), 'utf8');
  } catch (e) {
    console.warn('[fb-group-commenter] Could not save seen file:', e.message);
  }
}

// ─── Claude Haiku comment drafting ───────────────────────────────────────────

async function draftComment(groupName, authorName, postText) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: `You are drafting a Facebook comment for Heath Shepard, a Texas REALTOR who built Dossie (meetdossie.com) - an AI transaction coordinator for Texas agents at $29/mo.

Heath's voice: warm, casual, genuine, never corporate or salesy. He writes like a real agent who's been there. Short sentences. No hashtags. Acknowledges the pain first. Mentions Dossie only if it flows naturally. Always ends with meetdossie.com if Dossie is mentioned.

Group: ${groupName}
Post author: ${authorName || 'someone'}
Post text: "${postText.slice(0, 500)}"

Write a 2-4 sentence comment reply. Be helpful and genuine. If Dossie fits naturally, mention it briefly and include meetdossie.com. If it doesn't fit naturally, just be supportive. Do not use hashtags. Do not be salesy. Write in first person as Heath.`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error: ${res.status} ${err}`);
  }

  const json = await res.json();
  // Sonnet 5 extended thinking prepends `thinking` block; iterate all text blocks.
  return ((json?.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim());
}

// ─── Telegram helpers ─────────────────────────────────────────────────────────

async function sendTelegram(text, replyMarkup) {
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    disable_web_page_preview: true,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return json.result?.message_id || null;
}

async function getTelegramUpdates(offset) {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=10&allowed_updates=["callback_query"]`
  );
  const json = await res.json();
  return json.result || [];
}

async function answerCallbackQuery(callbackQueryId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  }).catch(() => {});
}

// Poll for callback approval with a timeout
async function waitForApproval(callbackId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let offset = 0;

  while (Date.now() < deadline) {
    const updates = await getTelegramUpdates(offset).catch(() => []);
    for (const update of updates) {
      offset = update.update_id + 1;
      const cb = update.callback_query;
      if (!cb) continue;
      if (cb.data === `approve_comment_${callbackId}`) {
        await answerCallbackQuery(cb.id, 'Approved - posting comment...');
        return 'approve';
      }
      if (cb.data === `skip_comment_${callbackId}`) {
        await answerCallbackQuery(cb.id, 'Skipped.');
        return 'skip';
      }
    }
    // Wait 10s between polls
    await new Promise(r => setTimeout(r, 10000));
  }
  return 'timeout';
}

// ─── Playwright: scan a group for matching posts ──────────────────────────────

async function scanGroup(page, group, seenIds, cutoffMs) {
  const matches = [];

  console.log(`[fb-group-commenter] Scanning ${group.group_name}`);
  await page.goto(group.group_url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const currentUrl = page.url();
  if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
    console.warn('[fb-group-commenter] Redirected to login - skipping group');
    return matches;
  }

  // Scroll a few times to load recent posts
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 1500));
    await page.waitForLoadState('networkidle').catch(() => {});
  }

  // Extract all posts visible on the page
  const posts = await page.evaluate((keywords) => {
    const results = [];
    // FB uses article or div[role=article] for feed posts
    const articles = document.querySelectorAll('div[role="article"]');
    for (const article of articles) {
      const text = article.innerText || '';
      const lowerText = text.toLowerCase();
      const hasKeyword = keywords.some(kw => lowerText.includes(kw));
      if (!hasKeyword) continue;

      // Try to extract a post permalink from a timestamp link
      let postUrl = null;
      const links = article.querySelectorAll('a[href*="/groups/"]');
      for (const link of links) {
        const href = link.getAttribute('href');
        if (href && /\/groups\/[^/]+\/posts\/\d+/.test(href)) {
          postUrl = href.startsWith('http') ? href : `https://www.facebook.com${href}`;
          postUrl = postUrl.split('?')[0];
          break;
        }
      }

      // Try to get the author name from the first strong element or h3/h4
      let authorName = '';
      const nameEl = article.querySelector('h3 a, h4 a, strong a');
      if (nameEl) authorName = nameEl.innerText.trim();

      results.push({
        text: text.slice(0, 1000),
        postUrl,
        authorName,
        postId: postUrl ? postUrl.split('/').filter(Boolean).pop() : null,
      });
    }
    return results;
  }, TC_KEYWORDS);

  for (const post of posts) {
    const dedupeKey = post.postId || post.text.slice(0, 80);
    if (seenIds.has(dedupeKey)) continue;
    matches.push({ ...post, groupName: group.group_name, groupUrl: group.group_url });
  }

  return matches;
}

// ─── Playwright: post a comment ───────────────────────────────────────────────

async function postComment(page, postUrl, commentText) {
  console.log(`[fb-group-commenter] Navigating to post: ${postUrl}`);
  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const currentUrl = page.url();
  if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
    throw new Error('Redirected to login when navigating to post');
  }

  // Find the comment input
  const commentBoxSelectors = [
    '[aria-label="Write a comment..."]',
    '[aria-label="Write a public comment..."]',
    '[aria-label="Comment"]',
    'div[contenteditable="true"][role="textbox"]',
  ];

  let commentBox = null;
  for (const selector of commentBoxSelectors) {
    try {
      commentBox = await page.waitForSelector(selector, { timeout: 5000 });
      if (commentBox) {
        console.log(`[fb-group-commenter] Found comment box: ${selector}`);
        break;
      }
    } catch { continue; }
  }

  if (!commentBox) {
    throw new Error('Could not find comment input box on the post');
  }

  await commentBox.click();
  await page.waitForFunction(() => document.activeElement && document.activeElement.getAttribute('contenteditable') === 'true').catch(() => {});
  await page.keyboard.type(commentText, { delay: 30 });

  // Find and click the submit button
  const submitSelectors = [
    'div[aria-label="Comment"][role="button"]',
    'button[type="submit"]',
    '[data-testid="react-composer-post-button"]',
  ];

  let submitBtn = null;
  for (const selector of submitSelectors) {
    try {
      const btn = page.locator(selector).last();
      if (await btn.isVisible({ timeout: 3000 }) && await btn.isEnabled({ timeout: 3000 })) {
        submitBtn = btn;
        break;
      }
    } catch { continue; }
  }

  // Fallback: press Enter to submit
  if (!submitBtn) {
    console.log('[fb-group-commenter] Submit button not found - using Enter key');
    await page.keyboard.press('Enter');
  } else {
    await submitBtn.click();
  }

  // Wait briefly to confirm it went through
  await page.waitForLoadState('networkidle').catch(() => {});
  console.log('[fb-group-commenter] Comment submitted');
}

// ─── TC discovery reply queue (threaded replies, approval-gated) ─────────────

const SAGE_PROFILE_PATH = process.env.SAGE_PROFILE_DIR || path.join(
  os.homedir(), 'AppData', 'Local', 'DossieBot-Sage'
);
const HEATH_FB_NAMES = ['Heath Shepard'];
// BUDGET SPLIT 2026-09-08 (Carter): threaded replies draw from the dedicated
// 'facebook_reply' budget (10/day, 30-min gap) so reply follow-through never
// starves Heath's initiated-comment budget ('facebook', 15/day) or vice
// versa. The rows themselves still carry platform='facebook' — pass that as
// minGapElapsed's filterPlatform.
const TC_BUDGET = 'facebook_reply';
const TC_ROW_PLATFORM = 'facebook';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim();

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

/**
 * Atomically claim an approved row ('approved' -> 'posting'). Returns the
 * claimed row or null if someone else got there first / it's no longer
 * approved. This status-guarded PATCH is the double-reply lock.
 */
async function claimApprovedReply(sbFetch, rowId) {
  const res = await sbFetch(
    `/rest/v1/tc_discovery_responses?id=eq.${encodeURIComponent(rowId)}&reply_status=eq.approved`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ reply_status: 'posting', updated_at: new Date().toISOString() }),
    },
  );
  if (res.ok && Array.isArray(res.data) && res.data.length > 0) return res.data[0];
  return null;
}

async function finalizeReply(sbFetch, rowId, patch) {
  return sbFetch(`/rest/v1/tc_discovery_responses?id=eq.${encodeURIComponent(rowId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
}

// Direct send — this is Heath-requested approval-loop plumbing, not cron noise.
async function tcNotifyHeath(text) {
  const token = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4090), disable_web_page_preview: true }),
  }).catch(() => {});
}

// Read-only-style thread expansion (mirrors the harvester's whitelist).
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

/**
 * Post `replyText` THREADED UNDER the specific comment described by `row`
 * (commenter_name + comment_text). This is the capability postComment() above
 * lacks. Throws with submitted=false semantics before any keystroke lands.
 *
 * @returns {Promise<{submitted: boolean}>}
 */
async function postReplyToComment(page, row, replyText) {
  const targetUrl = row.comment_permalink || row.post_url;
  if (!targetUrl) throw new Error('row has no comment_permalink or post_url');

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(6000);
  if (/\/login|\/checkpoint/i.test(page.url())) {
    throw new Error('redirected to login — DossieBot-Sage profile needs a manual FB login');
  }
  await expandRepliesReadOnly(page);

  // Find the target comment's article and click ITS Reply button.
  const commentSnippet = normText(row.comment_text).slice(0, 80);
  const clicked = await page.evaluate(({ name, snippet }) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const articles = Array.from(document.querySelectorAll('div[role="article"]'));
    for (const art of articles) {
      const label = art.getAttribute('aria-label') || '';
      if (!/^(Comment|Reply) by /i.test(label)) continue;
      if (!label.toLowerCase().includes(name.toLowerCase())) continue;
      if (!norm(art.innerText).includes(snippet)) continue;
      const btns = Array.from(art.querySelectorAll('div[role="button"], span[role="button"]'));
      for (const b of btns) {
        if ((b.innerText || '').trim() === 'Reply') { b.click(); return true; }
      }
    }
    return false;
  }, { name: row.commenter_name, snippet: commentSnippet }).catch(() => false);

  if (!clicked) {
    throw new Error(`could not locate Reply button for comment by ${row.commenter_name}`);
  }
  await sleep(2500);

  // The reply composer: a contenteditable textbox whose aria-label starts
  // with "Reply", or (fallback) the currently focused contenteditable.
  const focused = await page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('div[contenteditable="true"][role="textbox"]'));
    const replyBox = boxes.find((b) => /^reply/i.test(b.getAttribute('aria-label') || ''));
    const el = replyBox || (document.activeElement && document.activeElement.getAttribute('contenteditable') === 'true' ? document.activeElement : null);
    if (!el) return false;
    el.focus();
    return true;
  }).catch(() => false);
  if (!focused) throw new Error('reply composer did not appear after clicking Reply');

  await page.keyboard.type(replyText, { delay: 35 });
  await sleep(500);
  await page.keyboard.press('Enter'); // FB reply composer submits on Enter
  // From here on the reply may be live — caller must treat this as submitted.
  await sleep(5000);
  return { submitted: true };
}

/**
 * Verify the reply is actually live: re-render the thread and read it back.
 * A "success" that didn't post is the failure mode this exists to catch.
 */
async function verifyReplyPosted(page, row, replyText) {
  const targetUrl = row.comment_permalink || row.post_url;
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(6000);
  await expandRepliesReadOnly(page);
  const wanted = normText(replyText);
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

/**
 * Core queue logic — deps injectable so the regression test runs it with a
 * mock DB, mock caps, and a mock poster (no browser, no network).
 *
 * @param {object} deps { sbFetch, caps, poster, verifier, notify, log }
 * @returns {Promise<{posted:number, queuedForCap:number, failed:number, skipped:number}>}
 */
async function runTcReplyQueue(deps = {}) {
  const sbFetch = deps.sbFetch || makeSbFetch();
  const caps = deps.caps || require('./_lib/comment-caps.js');
  const poster = deps.poster;     // async (row, replyText) => { submitted }
  const verifier = deps.verifier; // async (row, replyText) => boolean
  const notify = deps.notify || tcNotifyHeath;
  const log = deps.log || console;
  const out = { posted: 0, queuedForCap: 0, failed: 0, skipped: 0 };

  // ONLY Heath-approved rows. Nothing else is ever eligible.
  const { ok, data } = await sbFetch(
    '/rest/v1/tc_discovery_responses'
    + '?reply_status=eq.approved&replied=eq.false&reply_posted_at=is.null'
    + '&select=id,post_url,comment_permalink,commenter_name,comment_text,reply_final,reply_draft,source_group'
    + '&order=reply_approved_at.asc',
  );
  if (!ok) throw new Error('failed to load approved replies');
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) return out;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const replyText = String(row.reply_final || '').trim();
    if (!replyText) {
      // Approved with no text should be impossible — park it, don't guess.
      await finalizeReply(sbFetch, row.id, { reply_status: 'post_failed', reply_error: 'approved row has empty reply_final' });
      out.failed++;
      continue;
    }

    // Anti-ban caps: daily cap + min-gap on the dedicated reply budget.
    // Over-cap replies STAY QUEUED (status remains 'approved') — never
    // dropped, never force-posted.
    const capCheck = await caps.canComment(TC_BUDGET, sbFetch);
    if (!capCheck.allowed) {
      out.queuedForCap = rows.length - i;
      log.log(`[tc-reply-queue] cap hit (${capCheck.reason}) — ${out.queuedForCap} approved repl${out.queuedForCap === 1 ? 'y' : 'ies'} stay queued`);
      await notify(`TC reply queue: FB reply-budget cap hit (${capCheck.reason}). ${out.queuedForCap} approved repl${out.queuedForCap === 1 ? 'y' : 'ies'} queued — they post automatically on later runs.`);
      break;
    }
    const gap = await caps.minGapElapsed(TC_BUDGET, sbFetch, 'tc_discovery_responses', 'reply_posted_at', TC_ROW_PLATFORM);
    if (!gap.elapsed) {
      out.queuedForCap = rows.length - i;
      log.log(`[tc-reply-queue] min-gap not elapsed (${Math.round(gap.ageMin)}m/${gap.gapMin}m) — ${out.queuedForCap} queued for next run`);
      break; // silent: this resolves within the hour, no need to ping Heath
    }

    // Double-reply lock: atomic claim.
    const claimed = await claimApprovedReply(sbFetch, row.id);
    if (!claimed) {
      out.skipped++;
      continue;
    }

    let submitted = false;
    try {
      const postRes = await poster(row, replyText);
      submitted = !!(postRes && postRes.submitted);
    } catch (err) {
      // Nothing was typed/submitted — but do NOT auto-retry (a repeating DOM
      // failure would hammer the thread). Park it and hand Heath the text.
      await finalizeReply(sbFetch, row.id, { reply_status: 'post_failed', reply_error: `not_submitted: ${String(err.message).slice(0, 300)}` });
      await notify(`TC reply FAILED (nothing was posted) for ${row.commenter_name}.\nError: ${err.message}\n\nPost it manually:\n${replyText}\n\n${row.comment_permalink || row.post_url || ''}`);
      out.failed++;
      continue;
    }

    if (submitted) {
      // Count against the cap the moment keystrokes were submitted — even if
      // verification fails below, the comment may be live on Facebook.
      await caps.recordComment(TC_BUDGET, sbFetch);
    }

    const verified = await verifier(row, replyText);
    if (verified) {
      await finalizeReply(sbFetch, row.id, {
        reply_status: 'posted',
        replied: true,
        reply_posted_at: new Date().toISOString(),
        reply_error: null,
      });
      out.posted++;
      log.log(`[tc-reply-queue] posted + verified reply to ${row.commenter_name}`);
    } else {
      // Submitted but could not read it back. TERMINAL — never auto-retry,
      // because retrying a reply that actually landed = double-reply.
      await finalizeReply(sbFetch, row.id, {
        reply_status: 'post_failed',
        reply_error: 'submitted but verification could not find the reply in the re-rendered thread',
      });
      await notify(`TC reply to ${row.commenter_name} was submitted but could NOT be verified in the thread. Check manually before re-posting (it may be live):\n${row.comment_permalink || row.post_url || ''}`);
      out.failed++;
    }

    await sleep(8000 + Math.floor(Math.random() * 7000));
  }

  return out;
}

// Browser-wired entrypoint for --tc-reply-queue.
async function tcReplyQueueMain({ dryRun }) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[tc-reply-queue] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
    process.exit(1);
  }
  const sbFetch = makeSbFetch();

  if (dryRun) {
    const { data } = await sbFetch(
      '/rest/v1/tc_discovery_responses?reply_status=eq.approved&replied=eq.false&select=id,commenter_name,reply_final,source_group&order=reply_approved_at.asc',
    );
    const rows = Array.isArray(data) ? data : [];
    console.log(`[tc-reply-queue][dry-run] ${rows.length} approved repl${rows.length === 1 ? 'y' : 'ies'} queued:`);
    for (const r of rows) console.log(`  - ${r.commenter_name} (${r.source_group}): ${String(r.reply_final || '').slice(0, 100)}`);
    return;
  }

  // Quick emptiness probe before launching Chrome at all.
  const probe = await sbFetch('/rest/v1/tc_discovery_responses?reply_status=eq.approved&replied=eq.false&select=id&limit=1');
  if (!probe.ok || !Array.isArray(probe.data) || probe.data.length === 0) {
    console.log('[tc-reply-queue] nothing approved — exiting without launching Chrome');
    return;
  }

  const { chromium } = require('playwright');
  const { unlockProfile } = require('./_lib/chrome-profile-unlock');
  // Cooperative unlock (NO force) — same as the harvester: if another job
  // holds the profile, this throws/waits and the next scheduled tick retries.
  await unlockProfile({ profileDir: SAGE_PROFILE_PATH, reason: 'tc-reply-queue' });
  const context = await chromium.launchPersistentContext(SAGE_PROFILE_PATH, {
    headless: false, // headless has twice falsely reported logged-out on this profile
    channel: 'chrome',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1180,900', '--no-first-run'],
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    const result = await runTcReplyQueue({
      sbFetch,
      poster: (row, replyText) => postReplyToComment(page, row, replyText),
      verifier: (row, replyText) => verifyReplyPosted(page, row, replyText),
    });
    console.log('[tc-reply-queue] done:', JSON.stringify(result));
  } finally {
    await context.close().catch(() => {});
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('[fb-group-commenter] TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required');
    process.exit(1);
  }
  if (!ANTHROPIC_API_KEY) {
    console.error('[fb-group-commenter] ANTHROPIC_API_KEY required');
    process.exit(1);
  }

  const seenIds = loadSeen();
  const groups = loadGroups();

  if (!groups.length) {
    console.log('[fb-group-commenter] No groups in fb-commenter-groups.json - populate the file and retry');
    return;
  }

  // Fix #6 (Atlas, 2026-06-11): chrome-profile-unlock pre-flight on EVERY
  // fb-group-commenter run, not just when called explicitly. Matches the
  // pattern already in fb-group-poster.js. Kills any stale chrome.exe holding
  // the user-data-dir lock, waits 2s for handle release, then launches.
  try {
    const { unlockProfile } = require('./_lib/chrome-profile-unlock');
    const unlocked = await unlockProfile({ profileDir: CHROME_PROFILE_PATH, reason: 'fb-group-commenter' });
    if (unlocked.killed > 0) {
      console.log(`[fb-group-commenter] profile-unlock: killed ${unlocked.killed} stale chrome process(es)`);
    }
  } catch (e) {
    console.warn(`[fb-group-commenter] profile-unlock non-fatal error: ${e.message}`);
  }

  const { chromium } = require('playwright-extra');
  const stealth = require('puppeteer-extra-plugin-stealth')();
  chromium.use(stealth);
  const context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      `--profile-directory=${PLAYWRIGHT_PROFILE_NAME}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
    ],
    viewport: { width: 1280, height: 900 },
    channel: 'chrome',
  });

  const page = await context.newPage();

  try {
    const cutoffMs = Date.now() - 24 * 60 * 60 * 1000; // last 24h
    const allMatches = [];

    for (const group of groups) {
      try {
        const matches = await scanGroup(page, group, seenIds, cutoffMs);
        allMatches.push(...matches);
      } catch (err) {
        console.warn(`[fb-group-commenter] Error scanning ${group.group_name}:`, err.message);
      }
    }

    console.log(`[fb-group-commenter] Found ${allMatches.length} matching posts`);

    for (const match of allMatches) {
      const dedupeKey = match.postId || match.text.slice(0, 80);

      // Draft comment via Haiku
      let draft;
      try {
        draft = await draftComment(match.groupName, match.authorName, match.text);
      } catch (err) {
        console.warn('[fb-group-commenter] Haiku draft failed:', err.message);
        continue;
      }

      const callbackId = Date.now().toString(36);
      const alertText = `FB GROUP COMMENTER ALERT\nGroup: ${match.groupName}\nAuthor: ${match.authorName || 'unknown'}\nPost: ${match.text.slice(0, 200)}\n\nDraft reply:\n${draft}`;

      // Message 1: context
      await sendTelegram(alertText);

      // Message 2: approval buttons
      await sendTelegram('Approve this comment?', {
        inline_keyboard: [[
          { text: 'APPROVE', callback_data: `approve_comment_${callbackId}` },
          { text: 'SKIP', callback_data: `skip_comment_${callbackId}` },
        ]],
      });

      const decision = await waitForApproval(callbackId, APPROVAL_TIMEOUT_MS);
      console.log(`[fb-group-commenter] Decision for "${dedupeKey.slice(0, 40)}": ${decision}`);

      if (decision === 'approve' && match.postUrl) {
        try {
          await postComment(page, match.postUrl, draft);
          await sendTelegram(`Comment posted to ${match.groupName}.\nURL: ${match.postUrl}`);
        } catch (err) {
          console.error('[fb-group-commenter] Failed to post comment:', err.message);
          await sendTelegram(`Failed to post comment to ${match.groupName}: ${err.message}`);
        }
      } else if (decision === 'approve' && !match.postUrl) {
        console.warn('[fb-group-commenter] Approved but no post URL - cannot navigate');
        await sendTelegram(`Approved but post URL not captured for ${match.groupName} - post manually.`);
      }

      // Mark seen regardless of decision
      seenIds.add(dedupeKey);
      saveSeen(seenIds);
    }
  } finally {
    await context.close();
  }

  console.log('[fb-group-commenter] Done');
}

module.exports = {
  runTcReplyQueue,
  claimApprovedReply,
  finalizeReply,
  postReplyToComment,
  verifyReplyPosted,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const entry = args.includes('--tc-reply-queue')
    ? tcReplyQueueMain({ dryRun: args.includes('--dry-run') })
    : main();
  entry.catch((err) => {
    console.error('[fb-group-commenter] Fatal error:', err.message);
    process.exit(1);
  });
}
