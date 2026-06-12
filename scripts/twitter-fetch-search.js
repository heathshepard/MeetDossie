'use strict';

// scripts/twitter-fetch-search.js
//
// Pure scraper for Twitter/X keyword search results. Emits JSON to stdout,
// no Supabase writes, no Telegram, no AI draft. This is the unified-scanner
// shim -- it parallels reddit-fetch-new.js so the Python orchestrator can
// score + dedupe + queue candidates uniformly across all 5 platforms.
//
// Usage:
//   node scripts/twitter-fetch-search.js --keyword="transaction coordinator"
//   node scripts/twitter-fetch-search.js --keyword="TREC deadline" --limit=15
//
// Output (stdout):
//   {"keyword":"...", "posts":[{"tweet_url":"...","author":"...","text":"...","posted_at":null}]}
//
// Auth: reuses the DossieBot persistent Chrome profile (same pattern as
// twitter-keyword-scanner.js). NO cookie-file fallback in this script --
// the keep-alive cron handles session renewal.

const path = require('path');
const fs = require('fs');
const os = require('os');

// Load .env.local so any downstream cron flags (e.g. PLAYWRIGHT_PROFILE_NAME)
// pick up the right profile.
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
} catch (e) {}

const CHROME_PROFILE_PATH = process.env.PLAYWRIGHT_PROFILE_DIR || path.join(
  os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data'
);
const PLAYWRIGHT_PROFILE_NAME = process.env.PLAYWRIGHT_PROFILE_NAME || 'Profile 4';

function parseArgs(argv) {
  const out = { keyword: '', limit: 20 };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--keyword=')) out.keyword = a.slice('--keyword='.length);
    else if (a.startsWith('--limit=')) out.limit = parseInt(a.slice('--limit='.length), 10) || 20;
  }
  return out;
}

async function scrapeKeyword(page, keyword, limit) {
  const searchUrl = `https://x.com/search?q=${encodeURIComponent(keyword)}&f=live`;
  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
  } catch (e) {
    process.stderr.write(`[twitter-fetch] nav fail "${keyword}": ${e.message}\n`);
    return [];
  }

  const currentUrl = page.url();
  if (currentUrl.includes('login') || currentUrl.includes('flow/login')) {
    // Don't ping Heath -- the keep-alive cron handles session renewal.
    process.stderr.write(`[twitter-fetch] not logged in -- bailing on "${keyword}"\n`);
    return [];
  }

  // Scroll to load more results.
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('End');
    await page.waitForTimeout(1500);
  }

  const tweets = [];
  try {
    const tweetEls = await page.$$('[data-testid="tweet"]');
    let count = 0;
    for (const el of tweetEls) {
      if (count >= limit) break;
      try {
        const textEl = await el.$('[data-testid="tweetText"]');
        const text = textEl ? (await textEl.textContent()).trim() : null;
        if (!text || text.startsWith('RT @')) continue;

        const authorEl = await el.$('[data-testid="User-Name"] span');
        const author = authorEl ? (await authorEl.textContent()).trim().replace('@', '') : 'unknown';

        const timeEl = await el.$('time');
        let tweetUrl = null;
        let postedAt = null;
        if (timeEl) {
          try { postedAt = await timeEl.getAttribute('datetime'); } catch {}
          const timeParent = await timeEl.$('xpath=../..');
          if (timeParent) {
            const href = await timeParent.getAttribute('href');
            if (href && href.includes('/status/')) {
              tweetUrl = href.startsWith('http') ? href : `https://x.com${href}`;
            }
          }
        }
        if (!tweetUrl) continue;

        tweets.push({
          tweet_url: tweetUrl,
          author,
          text: text.slice(0, 1500),
          posted_at: postedAt || null,
        });
        count++;
      } catch { continue; }
    }
  } catch (err) {
    process.stderr.write(`[twitter-fetch] scrape error "${keyword}": ${err && err.message}\n`);
  }

  return tweets;
}

async function main() {
  const { keyword, limit } = parseArgs(process.argv);
  if (!keyword) {
    process.stderr.write('usage: node twitter-fetch-search.js --keyword="..." [--limit=20]\n');
    process.exit(2);
  }

  const { chromium } = require('playwright');
  let context;
  try {
    context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        `--profile-directory=${PLAYWRIGHT_PROFILE_NAME}`,
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
      ],
      viewport: { width: 1280, height: 900 },
      channel: 'chrome',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
  } catch (e) {
    process.stderr.write(`[twitter-fetch] could not launch persistent context: ${e.message}\n`);
    // Emit empty payload so the Python wrapper doesn't crash on JSON parse.
    process.stdout.write(JSON.stringify({ keyword, posts: [] }));
    process.exit(0);
  }

  const page = await context.newPage();
  let posts = [];
  try {
    posts = await scrapeKeyword(page, keyword, limit);
  } finally {
    try { await context.close(); } catch {}
  }

  process.stdout.write(JSON.stringify({ keyword, posts }));
}

main().catch(err => {
  process.stderr.write(`[twitter-fetch] fatal: ${err && err.message}\n`);
  process.stdout.write(JSON.stringify({ keyword: '', posts: [], error: String(err && err.message) }));
  process.exit(0);
});
