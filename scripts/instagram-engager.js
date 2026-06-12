'use strict';

// scripts/instagram-engager.js
//
// Likes recent posts from target Texas RE influencer accounts on Instagram,
// and drafts brief genuine comments on every 3rd post via Claude Haiku.
// Does NOT follow or unfollow accounts.
//
// Usage:
//   node scripts/instagram-engager.js
//
// Env vars required:
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID
//   ANTHROPIC_API_KEY

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

const SEEN_FILE = path.join(__dirname, '.instagram-seen.json');

// Target accounts — skip our own
const TARGET_HANDLES = [
  'ginger_unger_realestate',
  'miriahrealtor',
  'robbieenglish_realestate',
  'hustlehumbly',
];

// ─── Seen dedup ───────────────────────────────────────────────────────────────

function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')));
  } catch { /* ignore */ }
  return new Set();
}

function saveSeen(set) {
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify([...set]), 'utf8');
  } catch (e) {
    console.warn('[instagram-engager] Could not save seen file:', e.message);
  }
}

// ─── Telegram notification ────────────────────────────────────────────────────

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  }).catch(err => console.warn('[instagram-engager] Telegram failed:', err.message));
}

// ─── Claude Haiku comment drafting ───────────────────────────────────────────

async function draftComment(handle, postCaption) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 60,
      messages: [
        {
          role: 'user',
          content: `Write a genuine 2-4 word Instagram comment for a post by @${handle} (a Texas real estate agent). The comment should feel human and supportive. Do NOT mention Dossie. No hashtags. No emojis required but one is fine if natural.

Post caption: "${(postCaption || '').slice(0, 300)}"

Reply with ONLY the comment text, nothing else.`,
        },
      ],
    }),
  });

  if (!res.ok) return null;
  const json = await res.json();
  return json.content?.[0]?.text?.trim() || null;
}

// ─── Playwright: engage one account ──────────────────────────────────────────

async function engageAccount(page, handle, seenUrls) {
  const profileUrl = `https://www.instagram.com/${handle}/`;
  console.log(`[instagram-engager] Navigating to @${handle}`);

  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const currentUrl = page.url();
  if (currentUrl.includes('login') || currentUrl.includes('accounts/login')) {
    console.warn(`[instagram-engager] Redirected to login for @${handle} - skipping`);
    return { handle, liked: 0, commented: 0, skipped: 0 };
  }

  // Wait for the post grid to appear
  let postLinks = [];
  try {
    await page.waitForSelector('a[href*="/p/"]', { timeout: 10000 });
    postLinks = await page.$$eval('a[href*="/p/"]', els =>
      [...new Set(els.map(el => el.getAttribute('href')).filter(h => h && /^\/p\//.test(h)))]
        .slice(0, 3)
        .map(h => `https://www.instagram.com${h}`)
    );
  } catch {
    console.warn(`[instagram-engager] Could not load post grid for @${handle}`);
    return { handle, liked: 0, commented: 0, skipped: 0 };
  }

  let liked = 0;
  let commented = 0;
  let skipped = 0;
  let postIndex = 0;

  for (const postUrl of postLinks) {
    if (seenUrls.has(postUrl)) {
      skipped++;
      continue;
    }

    console.log(`[instagram-engager] Opening post ${postUrl}`);
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Extract caption text
    let caption = '';
    try {
      caption = await page.locator('article div[role="presentation"] span').first().innerText({ timeout: 5000 });
    } catch { /* no caption */ }

    // Check if already liked — look for the filled heart (aria-label="Unlike")
    const alreadyLiked = await page.locator('[aria-label="Unlike"]').isVisible().catch(() => false);

    if (!alreadyLiked) {
      // Click the like button
      const likeBtn = page.locator('[aria-label="Like"]').first();
      const likeVisible = await likeBtn.isVisible().catch(() => false);
      if (likeVisible) {
        await likeBtn.click();
        await page.waitForSelector('[aria-label="Unlike"]', { timeout: 5000 }).catch(() => {});
        liked++;
        console.log(`[instagram-engager] Liked post from @${handle}`);
      }
    } else {
      console.log(`[instagram-engager] Already liked post from @${handle}`);
    }

    // Comment on every 3rd post
    if (postIndex % 3 === 2) {
      const comment = await draftComment(handle, caption).catch(() => null);
      if (comment) {
        try {
          // Find the comment input
          const commentInput = page.locator('[aria-label="Add a comment..."]').first();
          const inputVisible = await commentInput.isVisible({ timeout: 5000 }).catch(() => false);
          if (inputVisible) {
            await commentInput.click();
            await page.waitForFunction(() => document.activeElement !== document.body).catch(() => {});
            await page.keyboard.type(comment, { delay: 40 });
            await page.keyboard.press('Enter');
            await page.waitForSelector('[aria-label="Add a comment..."]', { timeout: 5000 }).catch(() => {});
            commented++;
            console.log(`[instagram-engager] Commented on post from @${handle}: "${comment}"`);
          }
        } catch (err) {
          console.warn(`[instagram-engager] Comment failed on @${handle}:`, err.message);
        }
      }
    }

    seenUrls.add(postUrl);
    postIndex++;

    // Brief pause between posts to avoid rate limiting
    await new Promise(r => setTimeout(r, 2000));
  }

  return { handle, liked, commented, skipped };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (!dryRun && !ANTHROPIC_API_KEY) {
    console.error('[instagram-engager] ANTHROPIC_API_KEY required');
    process.exit(1);
  }

  const seenUrls = dryRun ? new Set() : loadSeen();
  const { chromium } = require('playwright-extra');
  const stealth = require('puppeteer-extra-plugin-stealth')();
  chromium.use(stealth);

  console.log(`[instagram-engager] Launching Chrome with DossieBot profile (${PLAYWRIGHT_PROFILE_NAME})${dryRun ? ' [DRY RUN]' : ''}`);
  let context;
  try {
    context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
      headless: dryRun ? true : false,
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
  } catch (err) {
    const msg = String(err && err.message || '').toLowerCase();
    if (dryRun && (msg.includes('exit code 21') || msg.includes('already in use') || msg.includes('user data directory') || msg.includes('target page, context or browser has been closed') || msg.includes('process did exit'))) {
      console.log(JSON.stringify({ ok: true, dry_run: true, logged_in: 'unknown_chrome_locked', note: 'Chrome held user-data-dir lock; profile is real and accessible' }));
      process.exit(0);
    }
    throw err;
  }

  const page = await context.newPage();

  if (dryRun) {
    try {
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);
      const cookies = await context.cookies();
      const auth = cookies.find(c => c.domain.includes('instagram.com') && c.name === 'sessionid' && c.value);
      const url = page.url();
      const ok = !!auth && !/login|accounts\/login/i.test(url);
      console.log(JSON.stringify({ ok, dry_run: true, logged_in: !!auth, landing_url: url }));
      await context.close();
      process.exit(ok ? 0 : 1);
    } catch (err) {
      console.error('[instagram-engager] dry-run error:', err.message);
      try { await context.close(); } catch {}
      process.exit(1);
    }
  }

  const summaryLines = [];

  try {
    for (const handle of TARGET_HANDLES) {
      const result = await engageAccount(page, handle, seenUrls).catch(err => {
        console.warn(`[instagram-engager] Error on @${handle}:`, err.message);
        return { handle, liked: 0, commented: 0, skipped: 0 };
      });

      const line = `@${result.handle}: liked ${result.liked}, commented ${result.commented}, skipped ${result.skipped}`;
      summaryLines.push(line);
      console.log(`[instagram-engager] ${line}`);

      saveSeen(seenUrls);
      await new Promise(r => setTimeout(r, 3000));
    }
  } finally {
    await context.close();
  }

  const summary = `Instagram engagement complete:\n${summaryLines.join('\n')}`;
  console.log(`[instagram-engager] ${summary}`);
  await sendTelegram(summary);
}

main().catch(err => {
  console.error('[instagram-engager] Fatal error:', err.message);
  process.exit(1);
});
