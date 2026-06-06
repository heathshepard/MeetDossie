'use strict';

// scripts/twitter-keyword-scanner.js
//
// Playwright script: searches Twitter/X for relevant keywords, finds posts
// to engage with, drafts a reply in Heath's voice via Claude Haiku, and
// sends to DossieMarketingBot in veto mode (auto-posts after 10 min).
//
// Usage:
//   node scripts/twitter-keyword-scanner.js
//
// Runs through a keyword list, scans top 20 live results each, skips already-seen
// tweet URLs, drafts replies, saves to twitter_engagements, and sends to Telegram.
//
// Run 2x per day manually: morning + afternoon.
//   node scripts/twitter-keyword-scanner.js
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   ANTHROPIC_API_KEY
//   TELEGRAM_MARKETING_BOT_TOKEN (or TELEGRAM_BOT_TOKEN)
//   TELEGRAM_CHAT_ID

const path = require('path');
const os = require('os');

// Load .env.local when running locally
try {
  const fs = require('fs');
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
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const CHROME_PROFILE_PATH = path.join(
  os.homedir(),
  'AppData', 'Local', 'Google', 'Chrome', 'User Data'
);

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

// Keywords to scan — rotate through all each run
const KEYWORDS = [
  'transaction coordinator Texas',
  'TREC deadline',
  'option period',
  'TC quit',
  'what do you use for transactions',
  'real estate paperwork',
];

// Max tweets to inspect per keyword search page
const MAX_PER_KEYWORD = 20;

// ─── Supabase ─────────────────────────────────────────────────────────────────

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

async function isTweetAlreadySeen(tweetUrl) {
  const { data } = await supabaseFetch(
    `/rest/v1/twitter_engagements?tweet_url=eq.${encodeURIComponent(tweetUrl)}&select=id&limit=1`,
  );
  return Array.isArray(data) && data.length > 0;
}

async function saveEngagement(tweetUrl, author, tweetText, keyword, draft) {
  const row = {
    tweet_url: tweetUrl,
    tweet_author: author,
    tweet_text: tweetText,
    keyword_matched: keyword,
    our_response_draft: draft,
    status: 'pending',
  };
  const { ok, data } = await supabaseFetch('/rest/v1/twitter_engagements', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!ok) {
    console.error('[twitter-keyword-scanner] saveEngagement failed:', JSON.stringify(data).slice(0, 200));
    return null;
  }
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function markTelegramSent(engId) {
  await supabaseFetch(`/rest/v1/twitter_engagements?id=eq.${encodeURIComponent(engId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ telegram_sent_at: new Date().toISOString() }),
  });
}

// ─── Claude Haiku reply draft ──────────────────────────────────────────────────

const REPLY_SYSTEM_PROMPT = `You are drafting a Twitter/X reply for Heath Shepard, a licensed Texas REALTOR who built Dossie (an AI transaction coordinator for Texas agents).

Heath's voice: warm, casual, genuine, first-person, self-deprecating. Sounds like a real working agent, not a marketer. Short sentences. No corporate language. Never use "excited," "thrilled," "game-changer," "leverage," "solution."

Rules:
- Reply as if Heath is typing it on his phone between showings
- Be genuinely helpful - answer their question or acknowledge their pain
- If they asked "what do you use?" or about TC software - one sentence about Dossie, then meetdossie.com/founding
- If they expressed a pain point - empathize briefly then offer Dossie as something worth checking out
- If it's a general real estate post with no clear pain point - skip (return SKIP)
- Max 2 sentences, must fit in a tweet (under 280 chars including spaces)
- No em dashes, no curly quotes, plain ASCII only`;

async function draftReply(tweetText, tweetAuthor, keyword) {
  if (!ANTHROPIC_API_KEY) return null;

  const userMsg = `Keyword that matched: "${keyword}"
Tweet by @${tweetAuthor}: "${tweetText}"

Draft a reply for Heath. If this tweet doesn't have a genuine pain point or question worth engaging, reply with just the word SKIP.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 150,
        system: REPLY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = String(data?.content?.[0]?.text || '').trim();
    if (text.toUpperCase() === 'SKIP' || text.startsWith('SKIP')) return null;
    return text || null;
  } catch (err) {
    console.error('[twitter-keyword-scanner] draftReply failed:', err && err.message);
    return null;
  }
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendVetoMessages(author, tweetText, tweetUrl, draft, engId) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const send = async (text, replyMarkup) => {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
        reply_markup: replyMarkup || undefined,
      }),
    });
    const data = await res.json().catch(() => null);
    return data?.result?.message_id || null;
  };

  // Message 1: show the tweet, no buttons
  await send(`Twitter match: @${author}\n\n"${tweetText.slice(0, 280)}"\n\n${tweetUrl}`, null);

  // Message 2: draft + STOP/PREVIEW buttons
  const keyboard = {
    inline_keyboard: [[
      { text: 'STOP', callback_data: `tw_stop_${engId}` },
      { text: 'PREVIEW', callback_data: `tw_preview_${engId}` },
    ]],
  };
  await send(`Draft reply:\n\n${draft}\n\nAuto-posts in 10 min - tap STOP to cancel`, keyboard);
}

// ─── Playwright scraping ───────────────────────────────────────────────────────

async function scanKeyword(page, keyword) {
  const encodedKeyword = encodeURIComponent(keyword);
  const searchUrl = `https://twitter.com/search?q=${encodedKeyword}&f=live`;
  console.log(`[twitter-keyword-scanner] scanning: ${keyword}`);

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
  } catch (err) {
    console.error(`[twitter-keyword-scanner] navigation failed for keyword "${keyword}":`, err && err.message);
    return [];
  }

  const currentUrl = page.url();
  if (currentUrl.includes('login')) {
    throw new Error('Twitter redirected to login. Make sure Chrome is logged in as Heath.');
  }

  // Scroll to load more results
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('End');
    await page.waitForTimeout(1500);
  }

  const tweets = [];
  try {
    const tweetEls = await page.$$('[data-testid="tweet"]');
    let count = 0;
    for (const el of tweetEls) {
      if (count >= MAX_PER_KEYWORD) break;
      try {
        // Get tweet text
        const textEl = await el.$('[data-testid="tweetText"]');
        const tweetText = textEl ? (await textEl.textContent()).trim() : null;
        if (!tweetText) continue;

        // Get author
        const authorEl = await el.$('[data-testid="User-Name"] span');
        const author = authorEl ? (await authorEl.textContent()).trim().replace('@', '') : 'unknown';

        // Get tweet URL — find the timestamp link
        const timeEl = await el.$('time');
        let tweetUrl = null;
        if (timeEl) {
          const timeParent = await timeEl.$('xpath=../..');
          if (timeParent) {
            const href = await timeParent.getAttribute('href');
            if (href && href.includes('/status/')) {
              tweetUrl = href.startsWith('http') ? href : `https://twitter.com${href}`;
            }
          }
        }
        if (!tweetUrl) continue;

        // Skip retweets (RT @)
        if (tweetText.startsWith('RT @')) continue;

        tweets.push({ tweetText, author, tweetUrl });
        count++;
      } catch { continue; }
    }
  } catch (err) {
    console.error(`[twitter-keyword-scanner] scrape failed for "${keyword}":`, err && err.message);
  }

  console.log(`[twitter-keyword-scanner] "${keyword}": found ${tweets.length} tweets`);
  return tweets;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { chromium } = require('playwright');
  console.log('[twitter-keyword-scanner] NOTE: Close all Chrome windows before running this script.');

  const context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
    channel: 'chrome',
  });

  const page = await context.newPage();
  let newEngagements = 0;

  try {
    for (const keyword of KEYWORDS) {
      let tweets;
      try {
        tweets = await scanKeyword(page, keyword);
      } catch (err) {
        console.error(`[twitter-keyword-scanner] scanKeyword threw for "${keyword}":`, err && err.message);
        if (err.message && err.message.includes('login')) break; // auth error — stop all scanning
        continue;
      }

      for (const { tweetText, author, tweetUrl } of tweets) {
        const seen = await isTweetAlreadySeen(tweetUrl);
        if (seen) continue;

        const draft = await draftReply(tweetText, author, keyword);
        if (!draft) {
          // Haiku said SKIP or returned null — save as 'skipped' to prevent re-scanning
          await supabaseFetch('/rest/v1/twitter_engagements', {
            method: 'POST',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({
              tweet_url: tweetUrl,
              tweet_author: author,
              tweet_text: tweetText.slice(0, 500),
              keyword_matched: keyword,
              our_response_draft: null,
              status: 'skipped',
            }),
          }).catch(() => null);
          continue;
        }

        const saved = await saveEngagement(tweetUrl, author, tweetText.slice(0, 500), keyword, draft);
        if (!saved) continue;

        await sendVetoMessages(author, tweetText, tweetUrl, draft, saved.id);
        await markTelegramSent(saved.id);
        newEngagements++;

        // Brief pause between Telegram sends
        await page.waitForTimeout(1000);
      }

      // Brief pause between keyword searches to be a polite crawler
      await page.waitForTimeout(2000);
    }
  } finally {
    await context.close();
  }

  console.log(`[twitter-keyword-scanner] done. New engagements queued: ${newEngagements}`);
}

main().catch((err) => {
  console.error('[twitter-keyword-scanner] fatal error:', err && err.message);
  process.exit(1);
});
