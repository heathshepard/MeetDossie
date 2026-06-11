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
// ─── MANDATORY POST-EXISTENCE VERIFICATION ────────────────────────────────────
// As of 2026-06-11, every post submission MUST be verified before status is
// set to 'posted'. Submitting the composer is NOT sufficient — Facebook
// silently drops posts that violate group rules, blocks posters who never
// agreed to group rules, and queues posts for admin review without any
// composer-level error. Previously 4 of 6 posts in a single day were marked
// 'posted' in the DB but never appeared in any group, giving us false reach
// data.
//
// After submitting, the poster verifies and writes one of these statuses:
//   - posted                  → confirmed visible in the group feed
//   - pending_admin_approval  → post is in the admin moderation queue
//   - blocked_group_rules     → group rules consent banner detected
//   - silently_dropped        → composer closed but post never appeared
//   - failed                  → composer never submitted (network/UI error)
//
// Do NOT remove this verification step. Do NOT short-circuit on "composer
// closed = success." See verifyPostExists() below.
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

// Status-aware DB writer. `result` is the object returned by postToGroup():
//   { status, postUrl?, failureReason? }
// Only 'posted' bumps group_registry.last_posted_at — pending / blocked /
// dropped posts must not count toward "we just hit this group" cooldowns.
async function markResult(postId, groupRegistryId, result) {
  const now = new Date().toISOString();
  const patch = {
    status: result.status,
    failure_reason: result.failureReason || null,
    verified_at: now,
  };

  if (result.status === 'posted') {
    patch.posted_at = now;
    patch.post_url = result.postUrl || null;
  } else if (result.status === 'pending_admin_approval') {
    // Record the submission time so the 2hr auto-attach cron can pick it up
    // once admins approve. Do NOT set post_url — there isn't one yet.
    patch.posted_at = now;
  }

  await supabaseFetch(`/rest/v1/group_posts?id=eq.${encodeURIComponent(postId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });

  if (result.status === 'posted' && groupRegistryId) {
    await supabaseFetch(`/rest/v1/group_registry?id=eq.${encodeURIComponent(groupRegistryId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ last_posted_at: now }),
    });
  }

  console.log(`[fb-group-poster] DB updated → status=${result.status}${result.failureReason ? ` reason="${result.failureReason}"` : ''}`);
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

// ─── Post-existence verification ──────────────────────────────────────────────
//
// After submitting the composer, decide the post's real fate. Order matters:
// banners take priority over feed-scan because Facebook can show a banner
// AND leave a phantom shadow of the post in the composer area.
//
// Returns one of: 'posted' | 'pending_admin_approval' | 'blocked_group_rules'
//                 | 'silently_dropped'
// Plus an optional failureReason string for the DB.

async function verifyPostExists(page, post) {
  const bodyNeedle = String(post.post_body || '').replace(/\s+/g, ' ').trim().slice(0, 60);

  // ── 1) Look for explicit error / status banners FIRST ──
  // Facebook's banner copy varies; we match a few phrasings each.
  const bannerChecks = [
    {
      patterns: [
        /pending\s+(admin|moderator)\s+approval/i,
        /awaiting\s+(admin|moderator)\s+approval/i,
        /your\s+post\s+is\s+pending/i,
        /sent\s+for\s+(admin|moderator)\s+review/i,
        /pending\s+review/i,
      ],
      status: 'pending_admin_approval',
      reason: 'Facebook surfaced an admin-moderation banner after submit.',
    },
    {
      patterns: [
        /haven['’]t\s+agreed\s+to\s+(the\s+)?group\s+rules/i,
        /must\s+agree\s+to\s+(the\s+)?group\s+rules/i,
        /agree\s+to\s+(the\s+)?(group\s+)?rules\s+(before|to)\s+post/i,
        /group\s+rules.*before\s+posting/i,
      ],
      status: 'blocked_group_rules',
      reason: 'Group rules consent banner blocked submission — agreement required.',
    },
    {
      patterns: [
        /your\s+post\s+couldn['’]t\s+be\s+(shared|posted)/i,
        /something\s+went\s+wrong/i,
        /this\s+post\s+goes\s+against\s+community\s+standards/i,
        /you\s+can['’]t\s+post\s+(in|to)\s+this\s+group/i,
      ],
      status: 'silently_dropped',
      reason: 'Facebook displayed a post-rejection banner.',
    },
  ];

  try {
    const pageText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    for (const check of bannerChecks) {
      for (const pattern of check.patterns) {
        if (pattern.test(pageText)) {
          console.log(`[fb-group-poster] verification: matched banner pattern → ${check.status}`);
          return { status: check.status, failureReason: check.reason };
        }
      }
    }
  } catch (err) {
    console.warn('[fb-group-poster] verification: banner scan threw:', err.message);
  }

  // ── 2) Reload the group page and scan the feed for our post body ──
  // 5-10s lets FB index the post into the feed.
  console.log('[fb-group-poster] verification: reloading group page to scan feed...');
  try {
    await page.waitForTimeout(7000);
    await page.goto(post.group_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
  } catch (err) {
    console.warn('[fb-group-poster] verification: reload failed:', err.message);
  }

  // Re-check banners after reload (group rules banner often shows on landing).
  try {
    const pageText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    for (const check of bannerChecks) {
      for (const pattern of check.patterns) {
        if (pattern.test(pageText)) {
          console.log(`[fb-group-poster] verification: matched banner pattern post-reload → ${check.status}`);
          return { status: check.status, failureReason: check.reason };
        }
      }
    }
  } catch {}

  // ── 3) Search the visible feed for our post body ──
  if (!bodyNeedle) {
    return {
      status: 'silently_dropped',
      failureReason: 'Empty post_body — cannot verify (this is a config bug).',
    };
  }

  let permalink = null;
  try {
    // Scroll a bit to load lazy-rendered articles.
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(800);
    }

    const articles = await page.locator('[role="article"]').all();
    console.log(`[fb-group-poster] verification: scanning ${articles.length} articles for "${bodyNeedle.slice(0, 40)}..."`);

    for (const article of articles.slice(0, 25)) {
      const txt = (await article.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (!txt) continue;
      if (txt.toLowerCase().includes(bodyNeedle.toLowerCase())) {
        // Found a match — try to extract the permalink from this article.
        try {
          const link = await article.locator('a[href*="/posts/"]').first();
          const href = await link.getAttribute('href').catch(() => null);
          if (href) {
            const absolute = href.startsWith('http') ? href : `https://www.facebook.com${href}`;
            if (/\/groups\/[^/]+\/posts\/\d+/.test(absolute)) {
              permalink = absolute.split('?')[0];
            }
          }
        } catch {}
        console.log(`[fb-group-poster] verification: post found in feed${permalink ? ` (${permalink})` : ''}`);
        return { status: 'posted', postUrl: permalink || post.group_url };
      }
    }
  } catch (err) {
    console.warn('[fb-group-poster] verification: feed scan threw:', err.message);
  }

  // ── 4) Not found, no banner — Facebook silently dropped it ──
  return {
    status: 'silently_dropped',
    failureReason: 'Composer submitted with no error, but post does not appear in the group feed after reload + scroll.',
  };
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

    // Brief settle window — let Facebook process the submit and render either
    // (a) a banner, (b) the post in the feed, or (c) a silent drop.
    console.log('[fb-group-poster] Waiting for Facebook to process submit...');
    await page.waitForTimeout(8000);

    // Quick composer-error sniff (shows immediately on hard failures).
    try {
      const errorEl = page.locator('[data-testid="error-message"], [role="alert"]').first();
      if (await errorEl.isVisible({ timeout: 1500 }).catch(() => false)) {
        const errorText = await errorEl.innerText().catch(() => 'unknown error');
        // Don't throw — let verifyPostExists classify it.
        console.warn(`[fb-group-poster] Composer surfaced an alert: ${errorText}`);
      }
    } catch {}

    // ─── MANDATORY VERIFICATION ───
    // Decide the post's real fate. Banner > feed-scan > silently_dropped.
    const result = await verifyPostExists(page, post);
    console.log(`[fb-group-poster] verification result: ${result.status}`);

    // First comment only fires on confirmed 'posted'.
    if (result.status === 'posted' && post.first_comment_body) {
      console.log('[fb-group-poster] Posting first comment...');
      const firstCommentSuccess = await postFirstComment(page, post.first_comment_body);
      if (firstCommentSuccess) {
        await supabaseFetch(`/rest/v1/group_posts?id=eq.${encodeURIComponent(post.id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ first_comment_posted_at: new Date().toISOString() }),
        });
        console.log('[fb-group-poster] First comment posted and DB updated');
      } else {
        console.warn('[fb-group-poster] First comment posting failed - continuing anyway');
      }
    } else if (post.first_comment_body) {
      console.log(`[fb-group-poster] Skipping first comment — post status is "${result.status}", not "posted".`);
    }

    return result;
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

  // Preflight: close any facebook.com tabs in Heath's main Chrome so they
  // don't race with the DossieBot-Sage automation profile.
  try {
    const { preflight } = require('./_lib/fb-tab-preflight');
    const pre = await preflight({ reason: 'fb-group-poster' });
    console.log(`[fb-group-poster] preflight: closed=${pre.closed} skipped_dossiebot=${pre.skipped_dossiebot}`);
  } catch (e) {
    console.warn(`[fb-group-poster] preflight non-fatal error: ${e.message}`);
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

  let result = null;
  let errorMsg = null;

  try {
    result = await postToGroup(post);
  } catch (err) {
    errorMsg = err.message;
    console.error('[fb-group-poster] Playwright error:', err.message);
    result = { status: 'failed', failureReason: err.message };
  }

  await markResult(POST_ID, post.group_registry_id, result);

  // Telegram confirmation reflects the verified status, not a blind success.
  const success = result.status === 'posted';
  const reason = result.failureReason || errorMsg || null;
  const tgNote = success
    ? null
    : `${result.status}${reason ? ` — ${reason}` : ''}`;
  await sendTelegramConfirmation(post.group_name, post.post_body, success, tgNote);

  // Non-zero exit on anything that isn't a verified post or a legitimate queue
  // entry — so cron callers can retry or alert. pending_admin_approval is a
  // success-with-asterisk and exits 0.
  if (result.status !== 'posted' && result.status !== 'pending_admin_approval') {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[fb-group-poster] Fatal error:', err.message);
  process.exit(1);
});
