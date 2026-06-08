'use strict';

// scripts/reddit-poster.js
//
// Runs every 15 min via Windows Task Scheduler (DossieBot-Reddit-Poster).
// Queries reddit_engagements where status='pending' AND created_at is older
// than 10 minutes (veto window expired), then posts each draft reply to Reddit
// using Playwright browser automation.
//
// Requires a saved session at scripts/sessions/reddit.json.
// If session is missing or expired, sends a Telegram alert and exits.
//
// Capture session first:
//   node scripts/capture-reddit-session.js
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   TELEGRAM_BOT_TOKEN  (Claudy — personal bot, for confirmations)
//   TELEGRAM_CHAT_ID

const path = require('path');
const fs = require('fs');

const SESSION_FILE = path.join(__dirname, 'sessions', 'reddit.json');

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

// ─── Playwright comment posting ───────────────────────────────────────────────

async function postComment(page, context, permalink, draft) {
  const url = `https://www.reddit.com${permalink}`;
  console.log(`[reddit-poster] Navigating to ${url}`);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Check if we were redirected to login — session expired
  const currentUrl = page.url();
  if (currentUrl.includes('/login') || currentUrl.includes('accounts.reddit.com')) {
    throw new Error('SESSION_EXPIRED: redirected to login page');
  }

  // New Reddit uses a contenteditable div for the comment box.
  // Try multiple selectors in order of reliability.
  const commentSelectors = [
    'div[data-testid="comment-submission-form-richtext"] div[contenteditable="true"]',
    'div[data-click-id="text"] div[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea[placeholder*="comment"]',
    'textarea[placeholder*="Comment"]',
    '#commentbox',
  ];

  let commentBox = null;
  for (const sel of commentSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        commentBox = el;
        console.log(`[reddit-poster] Found comment box via: ${sel}`);
        break;
      }
    } catch {}
  }

  if (!commentBox) {
    // Try clicking the "Add a comment" / "Leave a comment" placeholder text first
    const placeholderSelectors = [
      'div[placeholder="Add a comment"]',
      'div[placeholder="Leave a comment"]',
      'div[aria-placeholder="Add a comment"]',
      'div[aria-placeholder*="comment"]',
    ];
    for (const sel of placeholderSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          await page.waitForTimeout(1000);
          // After click, try finding the now-active contenteditable
          for (const cSel of commentSelectors) {
            const active = await page.$(cSel);
            if (active) { commentBox = active; break; }
          }
          if (commentBox) break;
        }
      } catch {}
    }
  }

  if (!commentBox) {
    throw new Error('Could not locate comment input box on page');
  }

  await commentBox.click();
  await page.waitForTimeout(500);

  // Type the draft — use keyboard to handle contenteditable reliably
  await page.keyboard.type(draft, { delay: 20 });
  await page.waitForTimeout(1000);

  // Find and click the submit button
  const submitSelectors = [
    'button[type="submit"]:has-text("Comment")',
    'button:has-text("Comment")',
    'button[data-click-id="text"]:has-text("Comment")',
    'button[aria-label="Comment"]:not([disabled])',
    'button.submit:not([disabled])',
  ];

  let submitted = false;
  for (const sel of submitSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        const isDisabled = await btn.getAttribute('disabled');
        if (isDisabled !== null) continue;
        await btn.click();
        submitted = true;
        console.log(`[reddit-poster] Submit clicked via: ${sel}`);
        break;
      }
    } catch {}
  }

  if (!submitted) {
    // Fallback: keyboard shortcut
    await page.keyboard.press('Control+Enter');
    submitted = true;
    console.log('[reddit-poster] Submit via Ctrl+Enter fallback');
  }

  // Wait for submission to complete — new comment should appear or URL changes
  await page.waitForTimeout(4000);

  // Verify: page should NOT be on login and should not show an obvious error
  const finalUrl = page.url();
  if (finalUrl.includes('/login')) {
    throw new Error('SESSION_EXPIRED: ended up on login page after submit');
  }

  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
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

  // Check session file exists
  if (!fs.existsSync(SESSION_FILE)) {
    const msg = 'Reddit session file missing. Run: node scripts/capture-reddit-session.js';
    console.error(`[reddit-poster] ${msg}`);
    await tgSend(`Reddit poster: ${msg}`);
    process.exit(1);
  }

  const { chromium } = require('playwright');

  const context = await chromium.launchPersistentContext('', {
    headless: true,
    storageState: SESSION_FILE,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = await context.newPage();
  let sessionExpired = false;

  try {
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

      console.log(`[reddit-poster] Posting to r/${subreddit}: "${title}"`);

      try {
        await postComment(page, context, permalink, draft);

        await patchEngagement(id, {
          status: 'posted',
          posted_at: new Date().toISOString(),
        });

        const confirmMsg = `Posted Reddit comment on r/${subreddit}: "${title}"`;
        console.log(`[reddit-poster] ${confirmMsg}`);
        await tgSend(confirmMsg);

        // Polite delay between posts
        await new Promise((r) => setTimeout(r, 5000));

      } catch (err) {
        const msg = err && err.message || String(err);
        console.error(`[reddit-poster] Failed to post ${id}:`, msg);

        if (msg.includes('SESSION_EXPIRED')) {
          sessionExpired = true;
          await patchEngagement(id, { status: 'failed' });
          await tgSend('Reddit session expired. Run: node scripts/capture-reddit-session.js');
          break;
        }

        await patchEngagement(id, { status: 'failed' });
        await tgSend(`Reddit poster failed on r/${subreddit} "${title}": ${msg.slice(0, 200)}`);
      }
    }
  } finally {
    await context.close();
  }

  if (sessionExpired) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error('[reddit-poster] fatal error:', err && err.message);
  process.exit(1);
});
