'use strict';

// scripts/fb-group-commenter.js
//
// Scans FB groups for posts mentioning TC pain keywords, drafts a reply via
// Claude Haiku in Heath's voice, sends to Telegram for approval, then posts
// the comment if approved within 30 minutes.
//
// Usage:
//   node scripts/fb-group-commenter.js
//
// Env vars required:
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID
//   ANTHROPIC_API_KEY
//
// Groups are loaded from scripts/fb-commenter-groups.json (local file).
// Add or edit group entries there — no database needed.

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

main().catch((err) => {
  console.error('[fb-group-commenter] Fatal error:', err.message);
  process.exit(1);
});
