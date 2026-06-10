'use strict';

// scripts/fb-reply-poster.js
//
// Playwright script: posts an approved fb_comment_replies draft as a Facebook
// reply to the original comment thread.
//
// Usage:
//   node scripts/fb-reply-poster.js --reply-id [uuid]
//
// The reply row must have status='approved'. Posts it, updates status='posted',
// and sends a confirmation to Heath's personal Telegram (Claudy bot).
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

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const replyIdIdx = args.indexOf('--reply-id');
const REPLY_ID = replyIdIdx >= 0 ? args[replyIdIdx + 1] : null;

if (!REPLY_ID) {
  console.error('[fb-reply-poster] Usage: node scripts/fb-reply-poster.js --reply-id [uuid]');
  process.exit(1);
}

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

async function markPosted(replyId) {
  await supabaseFetch(`/rest/v1/fb_comment_replies?id=eq.${encodeURIComponent(replyId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'posted', posted_at: new Date().toISOString() }),
  });
}

async function markFailed(replyId, reason) {
  await supabaseFetch(`/rest/v1/fb_comment_replies?id=eq.${encodeURIComponent(replyId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'approved' }), // reset so it can be retried
  });
  console.error('[fb-reply-poster] failed:', reason);
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegramConfirmation(groupName, draft, success, errorMsg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const text = success
    ? `Posted reply in ${groupName}:\n\n"${draft}"`
    : `Failed to post reply in ${groupName}: ${errorMsg}`;
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

// ─── Playwright posting ────────────────────────────────────────────────────────

async function postReply(postUrl, replyAuthor, replyText, draft) {
  const { chromium } = require('playwright');
  console.log('[fb-reply-poster] NOTE: Close all Chrome windows before running this script.');

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

  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
      throw new Error('Facebook redirected to login. Make sure Chrome is logged in as Heath.');
    }

    // Find the specific comment by replyAuthor
    // Look for a comment block containing the author name and a Reply button
    let replyButton = null;

    const authorLocators = [
      `text="${replyAuthor}"`,
      `text="${replyAuthor.split(' ')[0]}"`,
    ];

    for (const loc of authorLocators) {
      try {
        const authorEl = page.locator(loc).first();
        if (await authorEl.isVisible({ timeout: 3000 })) {
          // Walk up to the comment container, then find the Reply button within it
          const container = authorEl.locator('xpath=ancestor::div[@role="article" or @data-testid]').first();
          const replyInContainer = container.locator('text=/Reply/i').first();
          if (await replyInContainer.isVisible({ timeout: 2000 })) {
            replyButton = replyInContainer;
            break;
          }
        }
      } catch { continue; }
    }

    // Fallback: find any Reply button near matching text
    if (!replyButton) {
      const allReplyButtons = page.locator('text=/^Reply$/i');
      const count = await allReplyButtons.count();
      if (count > 0) {
        // Use the first visible one — best we can do without exact comment locating
        for (let i = 0; i < count; i++) {
          if (await allReplyButtons.nth(i).isVisible()) {
            replyButton = allReplyButtons.nth(i);
            break;
          }
        }
      }
    }

    if (!replyButton) {
      throw new Error('Could not find Reply button for the comment. The comment may have been deleted or Facebook changed its layout.');
    }

    await replyButton.click();
    await page.waitForTimeout(1500);

    // Type the reply in the newly opened reply box
    const replyBox = page.locator('[role="textbox"][aria-label*="reply" i], [contenteditable="true"][aria-label*="reply" i], [placeholder*="Write a reply" i]').first();
    if (!(await replyBox.isVisible({ timeout: 5000 }))) {
      throw new Error('Reply text box did not appear after clicking Reply');
    }

    await replyBox.click();
    await page.keyboard.type(draft, { delay: 30 });
    await page.waitForTimeout(1000);

    // Submit
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);

    console.log('[fb-reply-poster] reply posted successfully');
  } finally {
    await context.close();
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
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

  console.log(`[fb-reply-poster] posting reply to "${groupPost.group_name}"`);
  console.log(`[fb-reply-poster] in response to ${reply.reply_author}: "${reply.reply_text.slice(0, 60)}"`);
  console.log(`[fb-reply-poster] draft: "${reply.our_response_draft}"`);

  try {
    await postReply(postUrl, reply.reply_author, reply.reply_text, reply.our_response_draft);
    await markPosted(REPLY_ID);
    await sendTelegramConfirmation(groupPost.group_name, reply.our_response_draft, true, null);
    console.log('[fb-reply-poster] done');
  } catch (err) {
    await markFailed(REPLY_ID, err && err.message);
    await sendTelegramConfirmation(groupPost.group_name, reply.our_response_draft, false, err && err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[fb-reply-poster] fatal error:', err && err.message);
  process.exit(1);
});
