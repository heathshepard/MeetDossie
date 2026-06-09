'use strict';

// scripts/fb-group-poster.js
//
// Playwright script: posts approved group_posts content to Facebook groups
// using saved session cookies. Chrome does NOT need to be closed.
//
// Usage:
//   node scripts/fb-group-poster.js --post-id [uuid]
//
// Requires an approved group_posts row. Fetches it from Supabase, posts,
// then updates group_posts status='posted' and group_registry last_posted_at.
//
// Session must be captured first:
//   node scripts/capture-facebook-session.js
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   TELEGRAM_BOT_TOKEN  (personal Claudy bot, for confirmation)
//   TELEGRAM_CHAT_ID

const path = require('path');
const fs = require('fs');

const SESSION_FILE = path.join(__dirname, 'sessions', 'facebook.json');

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

// ─── Playwright posting ───────────────────────────────────────────────────────

async function postToGroup(post) {
  const { chromium } = require('playwright-extra');
  const stealth = require('puppeteer-extra-plugin-stealth')();
  chromium.use(stealth);

  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error('Facebook not connected — run: node scripts/capture-facebook-session.js');
  }

  const storageState = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));

  console.log('[fb-group-poster] Launching browser with saved session cookies...');

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    storageState,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  try {
    console.log(`[fb-group-poster] Navigating to ${post.group_url}`);
    await page.goto(post.group_url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the page to settle
    await page.waitForTimeout(3000);

    // Check if the session has expired
    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
      // Notify Heath via Telegram before throwing
      if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text: 'Facebook login expired — run: node scripts/capture-facebook-session.js to reconnect',
          }),
        }).catch(() => {});
      }
      throw new Error('Facebook login expired — run: node scripts/capture-facebook-session.js to reconnect');
    }

    // Find the "Write something" / "What's on your mind?" post box
    // Facebook uses multiple possible selectors depending on group type and layout
    const postBoxSelectors = [
      '[aria-label*="Write something"]',
      '[aria-label*="What\'s on your mind"]',
      '[aria-label="Write something..."]',
      '[aria-label="What\'s on your mind?"]',
      '[data-testid="status-attachment-mentions-input"]',
      'div[role="button"][tabindex="0"]',
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
          postBox = await page.getByText(text, { exact: false }).first();
          if (await postBox.isVisible({ timeout: 3000 })) {
            console.log(`[fb-group-poster] Found post box via text: "${text}"`);
            break;
          }
          postBox = null;
        } catch {
          postBox = null;
          continue;
        }
      }
    }

    if (!postBox) {
      throw new Error('Could not find the post input box on the group page. The group layout may have changed or you may not be a member.');
    }

    // Click the post box to expand the composer
    await postBox.click();
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

    return postUrl;
  } finally {
    await browser.close();
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
