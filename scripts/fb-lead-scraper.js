'use strict';

// scripts/fb-lead-scraper.js
//
// Scans FB groups for posts from agents complaining about TC problems or
// looking for help. Surfaces them as warm leads via Telegram. Does NOT
// auto-comment or auto-DM.
//
// Usage:
//   node scripts/fb-lead-scraper.js
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
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

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const CHROME_PROFILE_PATH = process.env.PLAYWRIGHT_PROFILE_DIR || path.join(
  os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data'
);
const PLAYWRIGHT_PROFILE_NAME = process.env.PLAYWRIGHT_PROFILE_NAME || 'Profile 4';

const SEEN_FILE = path.join(__dirname, '.lead-scraper-seen.json');

const LEAD_KEYWORDS = [
  'my tc',
  'transaction coordinator',
  'stressed',
  'overwhelmed with paperwork',
  'juggling files',
  'need help with transactions',
  'looking for a tc',
  'overwhelmed',
  'too many files',
  'behind on paperwork',
  'tc quit',
  'can\'t keep up',
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
    console.warn('[fb-lead-scraper] Could not save seen file:', e.message);
  }
}

// ─── Supabase: load groups ────────────────────────────────────────────────────

async function loadGroups() {
  const { ok, data } = await supabaseFetch(
    '/rest/v1/group_registry?select=id,group_name,group_url&order=last_posted_at.asc.nullsfirst&limit=50'
  );
  if (!ok || !Array.isArray(data)) return [];
  return data.filter(g => g.group_url && !g.group_url.includes('PLACEHOLDER'));
}

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
  }).catch(err => console.warn('[fb-lead-scraper] Telegram failed:', err.message));
}

// ─── Playwright: scan one group ───────────────────────────────────────────────

async function scanGroup(page, group, seenIds) {
  const leads = [];

  console.log(`[fb-lead-scraper] Scanning ${group.group_name}`);
  await page.goto(group.group_url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const currentUrl = page.url();
  if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
    console.warn('[fb-lead-scraper] Redirected to login - skipping group');
    return leads;
  }

  // Scroll to load posts (last 48h)
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy(0, 1500));
    await page.waitForLoadState('networkidle').catch(() => {});
  }

  const posts = await page.evaluate((keywords) => {
    const results = [];
    const articles = document.querySelectorAll('div[role="article"]');
    for (const article of articles) {
      const text = article.innerText || '';
      const lowerText = text.toLowerCase();
      const hasKeyword = keywords.some(kw => lowerText.includes(kw));
      if (!hasKeyword) continue;

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
  }, LEAD_KEYWORDS);

  for (const post of posts) {
    const dedupeKey = post.postId || post.text.slice(0, 80);
    if (seenIds.has(dedupeKey)) continue;
    leads.push({ ...post, groupName: group.group_name });
    seenIds.add(dedupeKey);
  }

  return leads;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[fb-lead-scraper] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
    process.exit(1);
  }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('[fb-lead-scraper] TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required');
    process.exit(1);
  }

  const seenIds = loadSeen();
  const groups = await loadGroups();

  if (!groups.length) {
    console.log('[fb-lead-scraper] No groups in group_registry');
    return;
  }

  const { chromium } = require('playwright');
  console.log('[fb-lead-scraper] Launching Chrome with DossieBot profile');

  const context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      `--profile-directory=${PLAYWRIGHT_PROFILE_NAME}`,
    ],
    viewport: { width: 1280, height: 900 },
    channel: 'chrome',
  });

  const page = await context.newPage();
  let totalLeads = 0;

  try {
    for (const group of groups) {
      const leads = await scanGroup(page, group, seenIds).catch(err => {
        console.warn(`[fb-lead-scraper] Error on ${group.group_name}:`, err.message);
        return [];
      });

      for (const lead of leads) {
        totalLeads++;
        const alertText = [
          'WARM LEAD FOUND',
          `Name: ${lead.authorName || 'unknown'}`,
          `Group: ${lead.groupName}`,
          `Post: ${lead.text.slice(0, 300)}`,
          lead.postUrl ? `URL: ${lead.postUrl}` : '(no direct URL captured)',
          '',
          'Suggested action: Comment or DM this agent.',
        ].join('\n');

        await sendTelegram(alertText);
        console.log(`[fb-lead-scraper] Lead alert sent for "${lead.authorName}" in ${lead.groupName}`);

        // Pause between alerts to not flood Telegram
        await new Promise(r => setTimeout(r, 2000));
      }

      saveSeen(seenIds);
      await page.waitForTimeout(2000);
    }
  } finally {
    await context.close();
  }

  const summary = `fb-lead-scraper complete: ${totalLeads} warm lead(s) found across ${groups.length} group(s)`;
  console.log(`[fb-lead-scraper] ${summary}`);
  if (totalLeads === 0) {
    await sendTelegram('FB lead scraper ran - no new warm leads found this pass.');
  }
}

main().catch(err => {
  console.error('[fb-lead-scraper] Fatal error:', err.message);
  process.exit(1);
});
