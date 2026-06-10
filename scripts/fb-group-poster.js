'use strict';

// scripts/fb-group-poster.js
//
// Playwright script: posts approved group_posts content to Facebook groups
// using Heath's persistent Chrome profile. No session-cookie capture needed —
// the profile stays logged in indefinitely as long as Heath uses Chrome.
//
// Usage:
//   node scripts/fb-group-poster.js --post-id [uuid]
//
// Requires an approved group_posts row. Fetches it from Supabase, posts,
// then updates group_posts status='posted' and group_registry last_posted_at.
//
// Migrated 2026-06-10 from sessions/facebook.json to launchPersistentContext
// to eliminate the recurring "renew Facebook session" pings.
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   TELEGRAM_BOT_TOKEN  (personal Claudy bot, for confirmation)
//   TELEGRAM_CHAT_ID

const path = require('path');
const os = require('os');
const fs = require('fs');

// Use isolated DossieBot-Sage profile so we don't collide with Heath's
// running Chrome (which locks the main User Data dir). Matches the pattern
// used by sage-fb-scan-mission.js, fb-lead-scraper.js, etc.
const CHROME_PROFILE_PATH = process.env.SAGE_PROFILE_DIR || path.join(
  os.homedir(), 'AppData', 'Local', 'DossieBot-Sage'
);
const PLAYWRIGHT_PROFILE_NAME = process.env.SAGE_PROFILE_NAME || 'Default';

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

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const postIdIdx = args.indexOf('--post-id');
const POST_ID = postIdIdx >= 0 ? args[postIdIdx + 1] : null;

if (!POST_ID) {
  console.error('[fb-group-poster] Usage: node scripts/fb-group-poster.js --post-id [uuid]');
  process.exit(1);
}

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

async function fetchPost(postId) {
  const { ok, data } = await supabaseFetch(
    `/rest/v1/group_posts?id=eq.${encodeURIComponent(postId)}&limit=1`,
  );
  if (!ok || !Array.isArray(data) || !data.length) return null;
  return data[0];
}

async function markPosted(postId, groupRegistryId, postUrl) {
  const now = new Date().toISOString();

  await supabaseFetch(`/rest/v1/group_posts?id=eq.${encodeURIComponent(postId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'posted', posted_at: now, post_url: postUrl || null }),
  });

  if (groupRegistryId) {
    await supabaseFetch(`/rest/v1/group_registry?id=eq.${encodeURIComponent(groupRegistryId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ last_posted_at: now }),
    });
  }
}

async function markFailed(postId, reason) {
  // Reset to approved so Heath can retry
  await supabaseFetch(`/rest/v1/group_posts?id=eq.${encodeURIComponent(postId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'approved' }),
  });
  console.error(`[fb-group-poster] Marked as failed (reset to approved): ${reason}`);
}

// ─── Telegram confirmation ────────────────────────────────────────────────────

async function sendTelegramConfirmation(groupName, postBody, success, errorMsg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const preview = String(postBody || '').slice(0, 100);
  const text = success
    ? `Posted to ${groupName}\n\n${preview}...`
    : `Failed to post to ${groupName}: ${errorMsg}`;

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  }).catch((err) => {
    console.warn('[fb-group-poster] Telegram notification failed:', err.message);
  });
}

// ─── Post first comment (on the same page instance after main post) ────────────

async function postFirstComment(page, firstCommentBody) {
  if (!firstCommentBody) {
    console.log('[fb-group-poster] No first_comment_body — skipping first comment');
    return true;
  }

  console.log('[fb-group-poster] Posting first comment...');

  try {
    await page.waitForTimeout(2000);

    // Find the most recent article (the post we just posted)
    const articles = await page.locator('[role="article"]').all();
    if (!articles.length) {
      console.warn('[fb-group-poster] No articles found on page - first comment skipped');
      return false;
    }

    const firstArticle = articles[0];

    // Look for the comment button within the article
    const commentBtn = firstArticle.locator('button').filter({ hasText: /Comment/ }).first();
    if (await commentBtn.isVisible({ timeout: 3000 })) {
      await commentBtn.click();
      console.log('[fb-group-poster] Clicked Comment button');
      await page.waitForTimeout(1000);
    } else {
      console.warn('[fb-group-poster] Comment button not found');
      return false;
    }

    // Find the comment input box
    const commentInputSelectors = [
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      'textarea',
    ];

    let commentInput = null;
    for (const selector of commentInputSelectors) {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
        commentInput = el;
        console.log(`[fb-group-poster] Found comment input via: ${selector}`);
        break;
      }
    }

    if (!commentInput) {
      console.warn('[fb-group-poster] Comment input not found');
      return false;
    }

    // Click and type the comment
    await commentInput.click();
    await page.keyboard.type(firstCommentBody, { delay: 20 });
    await page.waitForTimeout(500);

    // Find and click the Post button for the comment
    const commentPostBtnSelectors = [
      'button:has-text("Post")',
      'button[aria-label*="Post"]',
      'button[type="submit"]',
    ];

    let commentPostBtn = null;
    for (const selector of commentPostBtnSelectors) {
      try {
        const btn = page.locator(selector).last();
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
          commentPostBtn = btn;
          break;
        }
      } catch {}
    }

    if (!commentPostBtn) {
      console.warn('[fb-group-poster] Comment Post button not found');
      return false;
    }

    await commentPostBtn.click();
    console.log('[fb-group-poster] Comment posted successfully');
    await page.waitForTimeout(1000);
    return true;
  } catch (err) {
    console.warn('[fb-group-poster] Error posting first comment:', err.message);
    return false;
  }
}

// ─── Playwright posting ───────────────────────────────────────────────────────

async function postToGroup(post) {
  const { chromium } = require('playwright');

  console.log('[fb-group-poster] Launching Heath\'s persistent Chrome profile...');

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
    console.log(`[fb-group-poster] Navigating to ${post.group_url}`);
    await page.goto(post.group_url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the page to settle
    await page.waitForTimeout(3000);

    // Check if the session has expired — the Chrome profile should always
    // be logged in, but if it isn't, fail loudly without pinging Heath. The
    // keep-alive cron (scripts/fb-session-keepalive.js) and the comment
    // monitor reuse the same profile, so this should not regress in practice.
    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
      throw new Error('Facebook redirected to login from persistent Chrome profile — open Chrome manually and re-login. Keep-alive cron should prevent this.');
    }

    // Dismiss any auto-opened dialog/overlay (Facebook sometimes opens a
    // Story composer or notification popup on group landing).
    try {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
    } catch {}

    // Find the "Write something" / "What's on your mind?" post box.
    // Facebook uses multiple selectors; we prefer specific aria-labels and
    // ignore the generic tabindex=0 div fallback because it's nearly always
    // an unrelated wrapper.
    const postBoxSelectors = [
      '[aria-label*="Write something"]',
      '[aria-label*="What\'s on your mind"]',
      '[aria-label="Write something..."]',
      '[aria-label="What\'s on your mind?"]',
      '[data-testid="status-attachment-mentions-input"]',
    ];

    let postBox = null;
    for (const selector of postBoxSelectors) {
      try {
        postBox = await page.waitForSelector(selector, { timeout: 5000 });
        if (postBox) {
          console.log(`[fb-group-poster] Found post box via selector: ${selector}`);
          break;
        }
      } catch {
        continue;
      }
    }

    // Fallback: look for text matching common prompts
    if (!postBox) {
      const textMatches = [
        'Write something...',
        "What's on your mind?",
        'Share something with this group',
      ];
      for (const text of textMatches) {
        try {
          const cand = page.getByText(text, { exact: false }).first();
          if (await cand.isVisible({ timeout: 3000 })) {
            postBox = await cand.elementHandle();
            console.log(`[fb-group-poster] Found post box via text: "${text}"`);
            break;
          }
        } catch {
          continue;
        }
      }
    }

    if (!postBox) {
      throw new Error('Could not find the post input box on the group page. The group layout may have changed or you may not be a member.');
    }

    // Scroll the post box into view and click. If a transparent overlay
    // intercepts pointer events (Facebook quirk where the inline composer
    // sits behind a backdrop div on Public groups), fall back to a direct
    // dispatchEvent which bypasses pointer-event interception.
    try {
      await postBox.scrollIntoViewIfNeeded();
    } catch {}
    try {
      await postBox.click({ timeout: 10000 });
    } catch (clickErr) {
      console.warn('[fb-group-poster] Normal click intercepted, falling back to force click + dispatchEvent');
      try {
        await postBox.click({ force: true, timeout: 10000 });
      } catch {
        await postBox.evaluate((el) => {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        });
      }
    }
    await page.waitForTimeout(4000);

    // Look for the expanded text input area
    // After clicking, Facebook expands a modal or inline editor
    const editorSelectors = [
      '[role="dialog"] div[contenteditable="true"]',
      '[role="dialog"] [contenteditable="true"]',
      '[role="dialog"] [contenteditable]',
      'div[contenteditable="true"][role="textbox"]',
      '[data-lexical-editor="true"]',
      '[aria-label="Write something..."][contenteditable="true"]',
      '[aria-label="What\'s on your mind?"][contenteditable="true"]',
      'div[contenteditable="true"]',
      '[contenteditable]',
    ];

    let editor = null;
    for (const selector of editorSelectors) {
      try {
        const candidate = await page.waitForSelector(selector, { timeout: 5000 });
        if (candidate) {
          editor = candidate;
          console.log(`[fb-group-poster] Found editor via: ${selector}`);
          break;
        }
      } catch {
        continue;
      }
    }

    if (!editor) {
      throw new Error('Could not find the text editor after clicking post box. Facebook layout may have changed.');
    }

    // Click the editor to focus it and wait for cursor to settle
    await editor.click();
    await page.waitForTimeout(1000);

    // Type the post body character by character (natural typing)
    console.log(`[fb-group-poster] Typing post body (${post.post_body.length} chars)...`);
    await page.keyboard.type(post.post_body, { delay: 30 });
    await page.waitForTimeout(1500);

    // Verify text was typed by checking the editor content
    const editorText = await editor.innerText().catch(() => '');
    if (!editorText.trim()) {
      throw new Error('Post body did not appear in the editor after typing. The editor may not have accepted input.');
    }

    // Find and click the Post button
    const postButtonSelectors = [
      '[role="dialog"] div[aria-label="Post"][role="button"]',
      '[role="dialog"] button[type="submit"]',
      'div[aria-label="Post"][role="button"]',
      'button[type="submit"]',
      '[data-testid="react-composer-post-button"]',
    ];

    let postButton = null;
    for (const selector of postButtonSelectors) {
      try {
        const btn = await page.locator(selector).last();
        if (await btn.isVisible({ timeout: 3000 }) && await btn.isEnabled({ timeout: 3000 })) {
          postButton = btn;
          console.log(`[fb-group-poster] Found Post button via: ${selector}`);
          break;
        }
      } catch {
        continue;
      }
    }

    // Fallback: find button with text "Post"
    if (!postButton) {
      try {
        postButton = page.getByRole('button', { name: 'Post' }).last();
        if (await postButton.isVisible({ timeout: 3000 })) {
          console.log('[fb-group-poster] Found Post button via role/name');
        } else {
          postButton = null;
        }
      } catch {
        postButton = null;
      }
    }

    if (!postButton) {
      throw new Error('Could not find the Post button. The composer may not have fully loaded.');
    }

    console.log('[fb-group-poster] Clicking Post button...');
    await postButton.click();

    // Wait up to 30s for the post to appear (poll for success)
    console.log('[fb-group-poster] Waiting for post confirmation...');
    let posted = false;
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(3000);

      // Check if the composer closed (success indicator)
      const composerGone = !(await page.locator('div[contenteditable="true"]').isVisible().catch(() => false));
      if (composerGone) {
        posted = true;
        console.log('[fb-group-poster] Composer closed - post likely submitted successfully');
        break;
      }

      // Check for error message
      const errorEl = await page.locator('[data-testid="error-message"], [role="alert"]').first();
      const errorVisible = await errorEl.isVisible().catch(() => false);
      if (errorVisible) {
        const errorText = await errorEl.innerText().catch(() => 'unknown error');
        throw new Error(`Facebook showed an error: ${errorText}`);
      }
    }

    if (!posted) {
      // Best-effort: assume it posted if no error after 30s
      console.warn('[fb-group-poster] Could not confirm post - no error shown, assuming success');
      posted = true;
    }

    // Try to capture the post permalink from the feed.
    // Facebook renders a timestamp <a href="/groups/.../posts/..."> once the
    // post appears. Give the feed a moment to render before querying.
    let postUrl = null;
    try {
      await page.waitForTimeout(3000);
      // Look for the most recent post permalink in the feed — links containing
      // /posts/ that are not navigation links (skip if they contain /permalink/).
      const links = await page.$$('a[href*="/posts/"]');
      for (const link of links) {
        const href = await link.getAttribute('href').catch(() => null);
        if (!href) continue;
        // Normalize to absolute URL
        const absolute = href.startsWith('http') ? href : `https://www.facebook.com${href}`;
        // Must look like a group post URL: /groups/[id]/posts/[id]
        if (/\/groups\/[^/]+\/posts\/\d+/.test(absolute)) {
          postUrl = absolute.split('?')[0]; // strip query params
          console.log(`[fb-group-poster] Captured post permalink: ${postUrl}`);
          break;
        }
      }
    } catch (err) {
      console.warn('[fb-group-poster] Could not capture post permalink:', err.message);
    }

    // Fallback: use group URL so the comment monitor can at least navigate there
    if (!postUrl) {
      postUrl = post.group_url;
      console.log('[fb-group-poster] Permalink not found — falling back to group URL');
    }

    // Post first comment if needed (keeps page open)
    if (post.first_comment_body) {
      console.log('[fb-group-poster] Posting first comment...');
      const firstCommentSuccess = await postFirstComment(page, post.first_comment_body);
      if (firstCommentSuccess) {
        // Update DB to mark first comment as posted
        await supabaseFetch(`/rest/v1/group_posts?id=eq.${encodeURIComponent(post.id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ first_comment_posted_at: new Date().toISOString() }),
        });
        console.log('[fb-group-poster] First comment posted and DB updated');
      } else {
        console.warn('[fb-group-poster] First comment posting failed - continuing anyway');
      }
    }

    return postUrl;
  } finally {
    await context.close();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[fb-group-poster] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    process.exit(1);
  }

  console.log(`[fb-group-poster] Fetching post ${POST_ID}`);
  const post = await fetchPost(POST_ID);

  if (!post) {
    console.error(`[fb-group-poster] Post ${POST_ID} not found in group_posts`);
    process.exit(1);
  }

  if (post.status !== 'approved') {
    console.error(`[fb-group-poster] Post ${POST_ID} has status="${post.status}", expected "approved". Aborting.`);
    process.exit(1);
  }

  if (!post.group_url || post.group_url.includes('PLACEHOLDER')) {
    console.error(`[fb-group-poster] Group URL for "${post.group_name}" is still a placeholder: ${post.group_url}`);
    console.error('[fb-group-poster] Update the group_url in the group_registry table first.');
    process.exit(1);
  }

  console.log(`[fb-group-poster] Posting to "${post.group_name}" (${post.group_url})`);
  console.log(`[fb-group-poster] Template: ${post.template_id} | Pillar: ${post.pillar}`);

  let postUrl = null;
  let errorMsg = null;

  try {
    postUrl = await postToGroup(post);
  } catch (err) {
    errorMsg = err.message;
    console.error('[fb-group-poster] Playwright error:', err.message);
  }

  if (postUrl) {
    await markPosted(POST_ID, post.group_registry_id, postUrl);
    console.log(`[fb-group-poster] Success - updated status to "posted", post_url: ${postUrl}`);
    await sendTelegramConfirmation(post.group_name, post.post_body, true, null);
  } else {
    await markFailed(POST_ID, errorMsg || 'unknown error');
    await sendTelegramConfirmation(post.group_name, post.post_body, false, errorMsg);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[fb-group-poster] Fatal error:', err.message);
  process.exit(1);
});
