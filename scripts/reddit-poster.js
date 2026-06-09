'use strict';

// scripts/reddit-poster.js
//
// Runs every 15 min via Windows Task Scheduler (DossieBot-Reddit-Poster).
// Queries reddit_engagements where status='pending' AND created_at is older
// than 10 minutes (veto window expired), then posts each draft reply via the
// Reddit OAuth API.
//
// NO browser, NO session cookies. Pure OAuth API call.
//
// Modes:
//   (default)       Post all pending engagements past their veto window
//   --test-mode     Authenticate, post + delete a single TEST comment on a
//                   recent r/realtors post to verify full read+write cycle.
//
// Env vars required:
//   REDDIT_CLIENT_ID
//   REDDIT_CLIENT_SECRET
//   REDDIT_REFRESH_TOKEN  OR  REDDIT_USERNAME + REDDIT_PASSWORD
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID

const path = require('path');
const fs = require('fs');

// ─── Load .env.local ─────────────────────────────────────────────────────────

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

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const reddit = require(path.join(__dirname, '..', 'api', '_lib', 'reddit-oauth.js'));

// ─── Supabase helpers ─────────────────────────────────────────────────────────

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

async function patchEngagement(id, patch) {
  return supabaseFetch(`/rest/v1/reddit_engagements?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

// ─── Telegram helpers ─────────────────────────────────────────────────────────

async function tgSend(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.warn('[reddit-poster] Telegram send failed:', err && err.message);
  }
}

// ─── Fetch pending engagements ────────────────────────────────────────────────

async function fetchPending() {
  // Veto window: only pick up rows older than 10 minutes
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { ok, data } = await supabaseFetch(
    `/rest/v1/reddit_engagements?status=eq.pending&created_at=lt.${encodeURIComponent(cutoff)}&order=created_at.asc&limit=10`,
  );
  if (!ok || !Array.isArray(data)) return [];
  return data;
}

// ─── Extract Reddit fullname from a permalink ─────────────────────────────────

// Permalink looks like /r/realtors/comments/abc123/some_title/
// We need the "t3_abc123" fullname to reply to it.
function permalinkToFullname(permalink) {
  if (!permalink) return null;
  const m = permalink.match(/\/comments\/([a-z0-9]+)/i);
  if (!m) return null;
  return `t3_${m[1]}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runTestMode() {
  console.log('[reddit-poster] TEST MODE: authenticating...');
  const token = await reddit.getAccessToken();
  console.log(`[reddit-poster] Got access token: ${token.slice(0, 12)}...`);

  console.log('[reddit-poster] Fetching r/realtors new posts...');
  const posts = await reddit.fetchSubredditNew('realtors', 5);
  if (posts.length === 0) {
    throw new Error('TEST: no posts returned from r/realtors');
  }
  const target = posts[0];
  const fullname = `t3_${target.id}`;
  console.log(`[reddit-poster] Target post: "${target.title.slice(0, 60)}" (${fullname})`);

  const testText = 'Test comment from Dossie automation - please ignore. Will delete in 30s.';
  console.log('[reddit-poster] Posting test comment...');
  const comment = await reddit.postComment(fullname, testText);
  console.log(`[reddit-poster] Posted: ${comment.fullname} https://www.reddit.com${comment.permalink || ''}`);

  console.log('[reddit-poster] Waiting 30s then deleting...');
  await new Promise(r => setTimeout(r, 30000));

  await reddit.deleteThing(comment.fullname);
  console.log('[reddit-poster] Deleted. TEST PASSED.');
}

async function main() {
  const args = process.argv.slice(2);
  const testMode = args.includes('--test-mode');

  if (testMode) {
    try {
      await runTestMode();
      process.exit(0);
    } catch (err) {
      console.error('[reddit-poster] TEST FAILED:', err && err.message);
      process.exit(1);
    }
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[reddit-poster] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    process.exit(1);
  }

  const pending = await fetchPending();
  if (pending.length === 0) {
    console.log('[reddit-poster] No pending engagements past veto window. Exiting.');
    process.exit(0);
  }

  console.log(`[reddit-poster] Found ${pending.length} engagement(s) to post`);

  let authFailed = false;
  try {
    await reddit.getAccessToken();
  } catch (err) {
    authFailed = true;
    const msg = err && err.message || String(err);
    console.error('[reddit-poster] OAuth auth failed:', msg);
    await tgSend(`Reddit poster auth failed: ${msg.slice(0, 200)}`);
    process.exit(1);
  }

  for (const eng of pending) {
    const id = eng.id;
    const permalink = eng.permalink || eng.post_url || '';
    const draft = eng.our_response_draft || eng.draft_reply || '';
    const subreddit = eng.subreddit || '';
    const title = (eng.post_title || eng.title || '').slice(0, 80);

    if (!permalink) {
      console.warn(`[reddit-poster] Skipping ${id} — no permalink`);
      await patchEngagement(id, { status: 'failed' });
      continue;
    }

    if (!draft) {
      console.warn(`[reddit-poster] Skipping ${id} — no draft reply`);
      await patchEngagement(id, { status: 'failed' });
      continue;
    }

    // Permalink may be a path (/r/realtors/comments/abc123/...) or a full URL.
    // Strip the host if present.
    let pathOnly = permalink;
    try {
      if (/^https?:\/\//i.test(permalink)) {
        pathOnly = new URL(permalink).pathname;
      }
    } catch {}

    const fullname = permalinkToFullname(pathOnly);
    if (!fullname) {
      console.warn(`[reddit-poster] Skipping ${id} — could not parse permalink: ${permalink}`);
      await patchEngagement(id, { status: 'failed' });
      continue;
    }

    console.log(`[reddit-poster] Posting to r/${subreddit} (${fullname}): "${title}"`);

    try {
      const result = await reddit.postComment(fullname, draft);

      await patchEngagement(id, {
        status: 'posted',
        posted_at: new Date().toISOString(),
      });

      const replyUrl = result.permalink
        ? `https://www.reddit.com${result.permalink}`
        : `https://www.reddit.com${pathOnly}`;
      const confirmMsg = `Posted Reddit comment on r/${subreddit}: "${title}"\n${replyUrl}`;
      console.log(`[reddit-poster] ${confirmMsg}`);
      await tgSend(confirmMsg);

      // Polite delay between posts (Reddit rate limits ~1/sec for OAuth)
      await new Promise((r) => setTimeout(r, 3000));

    } catch (err) {
      const msg = err && err.message || String(err);
      console.error(`[reddit-poster] Failed to post ${id}:`, msg);

      await patchEngagement(id, { status: 'failed' });

      // If auth failure mid-loop, bail and alert
      if (msg.includes('401') || msg.includes('invalid_grant') || msg.includes('access_token')) {
        await tgSend(`Reddit poster auth failure mid-batch: ${msg.slice(0, 200)}`);
        process.exit(1);
      }

      await tgSend(`Reddit poster failed on r/${subreddit} "${title}": ${msg.slice(0, 200)}`);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[reddit-poster] fatal error:', err && err.message);
  process.exit(1);
});
