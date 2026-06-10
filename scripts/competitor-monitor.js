'use strict';

// scripts/competitor-monitor.js
//
// Checks competitor social accounts (DealDock, ListedKit, Done Deal TC) for
// new posts on Facebook and Instagram. Sends Telegram alerts for any new
// content since the last run.
//
// Usage:
//   node scripts/competitor-monitor.js
//
// Env vars required:
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID

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

const CHROME_PROFILE_PATH = process.env.PLAYWRIGHT_PROFILE_DIR || path.join(
  os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data'
);
const PLAYWRIGHT_PROFILE_NAME = process.env.PLAYWRIGHT_PROFILE_NAME || 'Profile 4';

const SEEN_FILE = path.join(__dirname, '.competitor-monitor-seen.json');

// Competitors with their Facebook page URLs and Instagram handles.
// Update these if/when competitor pages are confirmed.
const COMPETITORS = [
  {
    brand: 'DealDock',
    facebook: 'https://www.facebook.com/search/pages/?q=DealDock',
    instagram: 'dealdock',
    searchFallback: true,
  },
  {
    brand: 'ListedKit',
    facebook: 'https://www.facebook.com/search/pages/?q=ListedKit',
    instagram: 'listedkit',
    searchFallback: true,
  },
  {
    brand: 'Done Deal TC',
    facebook: 'https://www.facebook.com/search/pages/?q=Done+Deal+TC',
    instagram: 'donedealthq',
    searchFallback: true,
  },
  {
    brand: 'Click Contracts',
    facebook: 'https://www.facebook.com/search/pages/?q=clickcontracts',
    instagram: 'clickcontracts',
    searchFallback: true,
  },
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
    console.warn('[competitor-monitor] Could not save seen file:', e.message);
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
  }).catch(err => console.warn('[competitor-monitor] Telegram failed:', err.message));
}

// ─── Playwright: check FB search results for competitor ──────────────────────

async function checkFacebook(page, competitor, seenIds) {
  const found = [];

  console.log(`[competitor-monitor] Checking FB for ${competitor.brand}`);
  await page.goto(competitor.facebook, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const currentUrl = page.url();
  if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
    console.warn('[competitor-monitor] FB login redirect - skipping FB check');
    return found;
  }

  // If search results page, try to click into the first page result
  if (competitor.searchFallback && currentUrl.includes('/search/')) {
    try {
      await page.waitForSelector('a[href*="/pages/"]', { timeout: 8000 });
      const pageLink = await page.$eval('a[href*="/pages/"]', el => el.href);
      if (pageLink) {
        await page.goto(pageLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
      }
    } catch {
      console.warn(`[competitor-monitor] No FB page found via search for ${competitor.brand}`);
      return found;
    }
  }

  // Scroll to load posts
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => window.scrollBy(0, 1500));
    await page.waitForLoadState('networkidle').catch(() => {});
  }

  const posts = await page.evaluate((brand) => {
    const results = [];
    const articles = document.querySelectorAll('div[role="article"]');
    for (const article of articles) {
      const text = article.innerText?.slice(0, 600) || '';
      if (!text.trim()) continue;

      let postUrl = null;
      const links = article.querySelectorAll('a[href*="/posts/"], a[href*="?story_fbid="]');
      for (const link of links) {
        const href = link.getAttribute('href');
        if (href) {
          postUrl = href.startsWith('http') ? href : `https://www.facebook.com${href}`;
          postUrl = postUrl.split('?')[0];
          break;
        }
      }

      const postId = postUrl ? postUrl.split('/').filter(Boolean).pop() : text.slice(0, 60);
      results.push({ brand, platform: 'FB', text, postUrl, postId });
      if (results.length >= 3) break;
    }
    return results;
  }, competitor.brand);

  for (const post of posts) {
    const key = `fb_${post.postId}`;
    if (!seenIds.has(key)) {
      found.push({ ...post, dedupeKey: key });
    }
  }

  return found;
}

// ─── Playwright: check Instagram for competitor ───────────────────────────────

async function checkInstagram(page, competitor, seenIds) {
  const found = [];

  if (!competitor.instagram) return found;

  const profileUrl = `https://www.instagram.com/${competitor.instagram}/`;
  console.log(`[competitor-monitor] Checking IG for ${competitor.brand} (@${competitor.instagram})`);

  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const currentUrl = page.url();
  if (currentUrl.includes('login') || currentUrl.includes('accounts/login')) {
    console.warn('[competitor-monitor] IG login redirect - skipping IG check');
    return found;
  }

  // Check if profile exists (IG redirects non-existent handles to explore)
  if (currentUrl.includes('/explore') || currentUrl.includes('/accounts/')) {
    console.log(`[competitor-monitor] IG handle @${competitor.instagram} not found - skipping`);
    return found;
  }

  let postLinks = [];
  try {
    await page.waitForSelector('a[href*="/p/"]', { timeout: 8000 });
    postLinks = await page.$$eval('a[href*="/p/"]', els =>
      [...new Set(els.map(el => el.getAttribute('href')).filter(h => h && /^\/p\//.test(h)))]
        .slice(0, 3)
        .map(h => `https://www.instagram.com${h}`)
    );
  } catch {
    console.warn(`[competitor-monitor] No IG posts found for @${competitor.instagram}`);
    return found;
  }

  for (const postUrl of postLinks) {
    const postId = postUrl.split('/').filter(Boolean).pop();
    const key = `ig_${postId}`;
    if (seenIds.has(key)) continue;

    // Navigate into post to get caption
    let caption = '';
    try {
      await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      caption = await page.locator('article span').first().innerText({ timeout: 4000 }).catch(() => '');
    } catch { /* skip caption */ }

    found.push({
      brand: competitor.brand,
      platform: 'IG',
      text: caption.slice(0, 600),
      postUrl,
      dedupeKey: key,
    });
  }

  return found;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('[competitor-monitor] TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required');
    process.exit(1);
  }

  const seenIds = loadSeen();
  const { chromium } = require('playwright');

  console.log('[competitor-monitor] Launching Chrome with DossieBot profile');
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
  const allFound = [];

  try {
    for (const competitor of COMPETITORS) {
      const fbPosts = await checkFacebook(page, competitor, seenIds).catch(err => {
        console.warn(`[competitor-monitor] FB error for ${competitor.brand}:`, err.message);
        return [];
      });

      const igPosts = await checkInstagram(page, competitor, seenIds).catch(err => {
        console.warn(`[competitor-monitor] IG error for ${competitor.brand}:`, err.message);
        return [];
      });

      allFound.push(...fbPosts, ...igPosts);

      // Mark all found posts as seen
      for (const post of [...fbPosts, ...igPosts]) {
        seenIds.add(post.dedupeKey);
      }

      saveSeen(seenIds);
      await new Promise(r => setTimeout(r, 2000));
    }
  } finally {
    await context.close();
  }

  if (!allFound.length) {
    console.log('[competitor-monitor] No new competitor posts found');
    await sendTelegram('Competitor monitor ran - no new posts from DealDock, ListedKit, Done Deal TC, or Click Contracts.');
    return;
  }

  for (const post of allFound) {
    const alertText = [
      `COMPETITOR ALERT - ${post.brand}`,
      `Platform: ${post.platform}`,
      `Post: ${post.text.slice(0, 300)}`,
      post.postUrl ? `URL: ${post.postUrl}` : '(no URL)',
    ].join('\n');

    await sendTelegram(alertText);
    console.log(`[competitor-monitor] Alert sent for ${post.brand} on ${post.platform}`);
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log(`[competitor-monitor] Done. ${allFound.length} new competitor post(s) flagged.`);
}

main().catch(err => {
  console.error('[competitor-monitor] Fatal error:', err.message);
  process.exit(1);
});
