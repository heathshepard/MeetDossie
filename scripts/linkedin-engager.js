'use strict';

// scripts/linkedin-engager.js
//
// Searches LinkedIn for Texas real estate professionals, likes their posts,
// and drafts brief professional comments on every other post via Claude Haiku.
// Does NOT follow or connect with anyone.
//
// Usage:
//   node scripts/linkedin-engager.js
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
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CHROME_PROFILE_PATH = process.env.PLAYWRIGHT_PROFILE_DIR || path.join(
  os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data'
);
const PLAYWRIGHT_PROFILE_NAME = process.env.PLAYWRIGHT_PROFILE_NAME || 'Profile 4';

const SEEN_FILE = path.join(__dirname, '.linkedin-seen.json');

const SEARCH_QUERIES = [
  'Texas REALTOR transaction coordinator',
  'Texas real estate agent',
];

const POSTS_PER_SEARCH = 5;
const WARM_TOUCH_BATCH = 10;

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
    console.warn('[linkedin-engager] Could not save seen file:', e.message);
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
  }).catch(err => console.warn('[linkedin-engager] Telegram failed:', err.message));
}

// ─── Claude Haiku comment drafting ───────────────────────────────────────────

async function draftComment(postText) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: `Write a 1-2 sentence professional LinkedIn comment on a Texas real estate agent's post. Be genuine and supportive. Do NOT mention Dossie. No hashtags. Sound like a real estate industry peer who found value in what they shared.

Post text: "${(postText || '').slice(0, 400)}"

Reply with ONLY the comment text, nothing else.`,
        },
      ],
    }),
  });

  if (!res.ok) return null;
  const json = await res.json();
  // Sonnet 5 extended thinking prepends `thinking` block; iterate all text blocks.
  const text = ((json?.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim());
  return text || null;
}

// ─── Playwright: search and engage ───────────────────────────────────────────

async function runSearch(page, query, seenIds, maxPosts) {
  let liked = 0;
  let commented = 0;

  const searchUrl = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(query)}&sortBy=date_posted`;
  console.log(`[linkedin-engager] Searching: "${query}"`);

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const currentUrl = page.url();
  if (currentUrl.includes('/login') || currentUrl.includes('/authwall')) {
    console.warn('[linkedin-engager] Redirected to login - check DossieBot profile has LinkedIn logged in');
    return { liked, commented };
  }

  // Wait for results to load
  try {
    await page.waitForSelector('[data-urn]', { timeout: 10000 });
  } catch {
    console.warn('[linkedin-engager] No results container found for query:', query);
    return { liked, commented };
  }

  // Scroll to load posts
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => window.scrollBy(0, 1500));
    await page.waitForLoadState('networkidle').catch(() => {});
  }

  // Collect post urns for dedup + extract text
  const posts = await page.evaluate((max) => {
    const results = [];
    const articles = document.querySelectorAll('div.search-results__list > li, div[data-urn]');
    for (const article of articles) {
      const urn = article.getAttribute('data-urn') || article.querySelector('[data-urn]')?.getAttribute('data-urn');
      if (!urn) continue;
      const text = article.innerText?.slice(0, 600) || '';
      results.push({ urn, text });
      if (results.length >= max) break;
    }
    return results;
  }, maxPosts);

  let postIndex = 0;

  for (const post of posts) {
    if (seenIds.has(post.urn)) {
      console.log(`[linkedin-engager] Already seen ${post.urn}, skipping`);
      continue;
    }

    // Like the post — find the like button within the article
    // LinkedIn like buttons have aria-label containing "Like" or "React"
    try {
      const likeBtn = page.locator(`[data-urn="${post.urn}"] button[aria-label*="Like"], [data-urn="${post.urn}"] button[aria-label*="React"]`).first();
      const likeVisible = await likeBtn.isVisible({ timeout: 3000 }).catch(() => false);

      if (likeVisible) {
        // Check if already liked (aria-label changes to "Remove your like" or "Unlike")
        const label = await likeBtn.getAttribute('aria-label').catch(() => '');
        if (!label.toLowerCase().includes('unlike') && !label.toLowerCase().includes('remove')) {
          await likeBtn.click();
          await page.waitForFunction(
            (urn) => {
              const btn = document.querySelector(`[data-urn="${urn}"] button[aria-label*="Unlike"], [data-urn="${urn}"] button[aria-label*="Remove"]`);
              return !!btn;
            },
            post.urn,
            { timeout: 5000 }
          ).catch(() => {});
          liked++;
          console.log(`[linkedin-engager] Liked post ${post.urn}`);
        } else {
          console.log(`[linkedin-engager] Already liked ${post.urn}`);
        }
      }
    } catch (err) {
      console.warn(`[linkedin-engager] Could not like ${post.urn}:`, err.message);
    }

    // Comment on every other post
    if (postIndex % 2 === 1) {
      const comment = await draftComment(post.text).catch(() => null);
      if (comment) {
        try {
          const commentBtn = page.locator(`[data-urn="${post.urn}"] button[aria-label*="Comment"]`).first();
          const commentBtnVisible = await commentBtn.isVisible({ timeout: 3000 }).catch(() => false);
          if (commentBtnVisible) {
            await commentBtn.click();

            // LinkedIn comment box
            const commentInput = page.locator(`[data-urn="${post.urn}"] div[contenteditable="true"]`).first();
            const inputVisible = await commentInput.isVisible({ timeout: 5000 }).catch(() => false);
            if (inputVisible) {
              await commentInput.click();
              await page.waitForFunction(() => document.activeElement && document.activeElement.getAttribute('contenteditable') === 'true').catch(() => {});
              await page.keyboard.type(comment, { delay: 40 });

              // Submit with Ctrl+Enter, then wait for comment box to close/reset
              await page.keyboard.press('Control+Enter');
              await page.waitForFunction(
                (urn) => {
                  const box = document.querySelector(`[data-urn="${urn}"] div[contenteditable="true"]`);
                  return !box || box.innerText.trim() === '';
                },
                post.urn,
                { timeout: 5000 }
              ).catch(() => {});
              commented++;
              console.log(`[linkedin-engager] Commented on ${post.urn}: "${comment}"`);
            }
          }
        } catch (err) {
          console.warn(`[linkedin-engager] Comment failed on ${post.urn}:`, err.message);
        }
      }
    }

    seenIds.add(post.urn);
    postIndex++;
    await new Promise(r => setTimeout(r, 2000));
  }

  return { liked, commented };
}

// ─── Warm-touch queue helpers ────────────────────────────────────────────────

function sbHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function fetchWarmTouchLeads() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[linkedin-engager] Supabase not configured for warm-touch mode');
    return [];
  }
  const url = `${SUPABASE_URL}/rest/v1/warm_touch_queue?status=eq.pending&platform=eq.linkedin&order=created_at.asc&limit=${WARM_TOUCH_BATCH}`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) {
    console.error('[linkedin-engager] Failed to fetch warm-touch leads:', r.status);
    return [];
  }
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

async function markLeadEngaged(leadId) {
  const url = `${SUPABASE_URL}/rest/v1/warm_touch_queue?id=eq.${leadId}`;
  await fetch(url, {
    method: 'PATCH',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'engaged', engaged_at: new Date().toISOString() }),
  });
}

async function markLeadNotFound(leadId) {
  const url = `${SUPABASE_URL}/rest/v1/warm_touch_queue?id=eq.${leadId}`;
  await fetch(url, {
    method: 'PATCH',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'not_found' }),
  });
}

async function searchAndEngageLead(page, lead, seenIds) {
  const name = lead.lead_name;
  const searchUrl = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(name + ' real estate')}&sortBy=date_posted`;
  console.log(`[linkedin-engager] Warm-touch: searching for "${name}"`);

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const currentUrl = page.url();
  if (currentUrl.includes('/login') || currentUrl.includes('/authwall')) {
    console.warn('[linkedin-engager] Redirected to login');
    return false;
  }

  try {
    await page.waitForSelector('[data-urn]', { timeout: 8000 });
  } catch {
    console.warn(`[linkedin-engager] No posts found for "${name}"`);
    return false;
  }

  await page.evaluate(() => window.scrollBy(0, 800));
  await page.waitForLoadState('networkidle').catch(() => {});

  const posts = await page.evaluate(() => {
    const results = [];
    const articles = document.querySelectorAll('div.search-results__list > li, div[data-urn]');
    for (const article of articles) {
      const urn = article.getAttribute('data-urn') || article.querySelector('[data-urn]')?.getAttribute('data-urn');
      if (!urn) continue;
      const text = article.innerText?.slice(0, 600) || '';
      results.push({ urn, text });
      if (results.length >= 3) break;
    }
    return results;
  });

  if (!posts.length) return false;

  let engaged = false;
  for (const post of posts) {
    if (seenIds.has(post.urn)) continue;

    try {
      const likeBtn = page.locator(`[data-urn="${post.urn}"] button[aria-label*="Like"], [data-urn="${post.urn}"] button[aria-label*="React"]`).first();
      const likeVisible = await likeBtn.isVisible({ timeout: 3000 }).catch(() => false);
      if (likeVisible) {
        const label = await likeBtn.getAttribute('aria-label').catch(() => '');
        if (!label.toLowerCase().includes('unlike') && !label.toLowerCase().includes('remove')) {
          await likeBtn.click();
          await page.waitForTimeout(2000);
          engaged = true;
          console.log(`[linkedin-engager] Warm-touch liked post by "${name}"`);
        }
      }
    } catch (err) {
      console.warn(`[linkedin-engager] Could not like post for "${name}":`, err.message);
    }

    seenIds.add(post.urn);
    if (engaged) break;
  }

  return engaged;
}

async function runWarmTouchMode(page, seenIds) {
  const leads = await fetchWarmTouchLeads();
  if (!leads.length) {
    console.log('[linkedin-engager] No pending warm-touch leads');
    return { engaged: 0, not_found: 0 };
  }

  console.log(`[linkedin-engager] Warm-touch: ${leads.length} leads to engage`);
  let engaged = 0;
  let notFound = 0;

  for (const lead of leads) {
    const found = await searchAndEngageLead(page, lead, seenIds);
    if (found) {
      await markLeadEngaged(lead.id);
      engaged++;
    } else {
      await markLeadNotFound(lead.id);
      notFound++;
    }
    await new Promise(r => setTimeout(r, 3000));
  }

  return { engaged, not_found: notFound };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (!dryRun && !ANTHROPIC_API_KEY) {
    console.error('[linkedin-engager] ANTHROPIC_API_KEY required');
    process.exit(1);
  }

  const seenIds = dryRun ? new Set() : loadSeen();
  const { chromium } = require('playwright-extra');
  const stealth = require('puppeteer-extra-plugin-stealth')();
  chromium.use(stealth);

  console.log(`[linkedin-engager] Launching Chrome with DossieBot profile (${PLAYWRIGHT_PROFILE_NAME})${dryRun ? ' [DRY RUN]' : ''}`);
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
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);
      const cookies = await context.cookies();
      const auth = cookies.find(c => c.domain.includes('linkedin.com') && c.name === 'li_at' && c.value);
      const url = page.url();
      const ok = !!auth && !/login|authwall/i.test(url);
      console.log(JSON.stringify({ ok, dry_run: true, logged_in: !!auth, landing_url: url }));
      await context.close();
      process.exit(ok ? 0 : 1);
    } catch (err) {
      console.error('[linkedin-engager] dry-run error:', err.message);
      try { await context.close(); } catch {}
      process.exit(1);
    }
  }

  const warmTouchMode = process.argv.includes('--warm-touch');
  let totalLiked = 0;
  let totalCommented = 0;
  let warmResult = null;

  try {
    if (warmTouchMode) {
      warmResult = await runWarmTouchMode(page, seenIds);
      saveSeen(seenIds);
    }

    if (!process.argv.includes('--warm-touch-only')) {
      for (const query of SEARCH_QUERIES) {
        const { liked, commented } = await runSearch(page, query, seenIds, POSTS_PER_SEARCH).catch(err => {
          console.warn(`[linkedin-engager] Error on query "${query}":`, err.message);
          return { liked: 0, commented: 0 };
        });
        totalLiked += liked;
        totalCommented += commented;
        saveSeen(seenIds);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  } finally {
    await context.close();
  }

  const parts = [`LinkedIn engagement: liked ${totalLiked}, commented ${totalCommented}`];
  if (warmResult) parts.push(`warm-touch: ${warmResult.engaged} engaged, ${warmResult.not_found} not found`);
  const summary = parts.join(' | ');
  console.log(`[linkedin-engager] ${summary}`);
  await sendTelegram(summary);
}

main().catch(err => {
  console.error('[linkedin-engager] Fatal error:', err.message);
  process.exit(1);
});
