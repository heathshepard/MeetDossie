'use strict';

// scripts/twitter-keyword-scanner.js
//
// Scans Twitter/X for keyword matches, drafts replies via Claude Haiku,
// sends to DossieMarketingBot in veto mode (auto-posts after 10 min).
//
// Uses saved session cookies (scripts/sessions/twitter.json) — Chrome does NOT
// need to be closed. Run save-session.js once to capture the cookies.
//
// Usage:
//   node scripts/twitter-keyword-scanner.js
//
// Schedule: runs 2x daily via Windows Task Scheduler (8AM + 2PM).

const path = require('path');
const fs = require('fs');

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

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const SESSION_FILE = path.join(__dirname, 'sessions', 'twitter.json');
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const KEYWORDS = [
  'transaction coordinator Texas',
  'TREC deadline',
  'option period',
  'TC quit',
  'what do you use for transactions',
  'real estate paperwork',
  'zipforms',
  'dotloop',
  'skyslope',
  'too many apps real estate',
  'real estate software',
  'transaction coordinator software',
];

const MAX_PER_KEYWORD = 20;

// ─── Supabase ──────────────────────────────────────────────────────────────────

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
  try { data = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, data };
}

async function isTweetAlreadySeen(tweetUrl) {
  const { data } = await supabaseFetch(
    `/rest/v1/twitter_engagements?tweet_url=eq.${encodeURIComponent(tweetUrl)}&select=id&limit=1`,
  );
  return Array.isArray(data) && data.length > 0;
}

async function saveEngagement(tweetUrl, author, tweetText, keyword, draft) {
  const { ok, data } = await supabaseFetch('/rest/v1/twitter_engagements', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      tweet_url: tweetUrl,
      tweet_author: author,
      tweet_text: tweetText,
      keyword_matched: keyword,
      our_response_draft: draft,
      status: 'pending',
    }),
  });
  if (!ok) {
    console.error('[twitter-scanner] saveEngagement failed:', JSON.stringify(data).slice(0, 200));
    return null;
  }
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function markTelegramSent(engId) {
  await supabaseFetch(`/rest/v1/twitter_engagements?id=eq.${engId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ telegram_sent_at: new Date().toISOString() }),
  });
}

// ─── Claude Haiku ──────────────────────────────────────────────────────────────

const REPLY_SYSTEM_PROMPT = `You are drafting a Twitter/X reply for Heath Shepard, a licensed Texas REALTOR who built Dossie (an AI transaction coordinator for Texas agents).

Heath's voice: warm, casual, genuine, first-person, self-deprecating. Sounds like a real working agent, not a marketer. Short sentences. No corporate language. Never use "excited," "thrilled," "game-changer," "leverage," "solution."

Rules:
- Reply as if Heath is typing on his phone between showings
- Be genuinely helpful - answer their question or acknowledge their pain
- If they asked about TC software - one sentence about Dossie, then meetdossie.com/founding
- If they expressed a pain point - empathize briefly then offer Dossie as worth checking out
- If it's a general post with no clear pain point - return SKIP
- Max 2 sentences, must fit in 280 chars
- No em dashes, no curly quotes, plain ASCII only`;

async function draftReply(tweetText, tweetAuthor, keyword) {
  if (!ANTHROPIC_API_KEY) return null;
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
        messages: [{ role: 'user', content: `Keyword: "${keyword}"\nTweet by @${tweetAuthor}: "${tweetText}"\n\nDraft reply or return SKIP.` }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = String(data?.content?.[0]?.text || '').trim();
    if (text.toUpperCase().startsWith('SKIP')) return null;
    return text || null;
  } catch { return null; }
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

  await send(`Twitter match: @${author}\n\n"${tweetText.slice(0, 280)}"\n\n${tweetUrl}`, null);
  await send(
    `Draft reply:\n\n${draft}\n\nAuto-posts in 10 min - tap STOP to cancel`,
    { inline_keyboard: [[
      { text: 'STOP', callback_data: `tw_stop_${engId}` },
      { text: 'PREVIEW', callback_data: `tw_preview_${engId}` },
    ]] },
  );
}

// ─── Playwright scraping ───────────────────────────────────────────────────────

async function scanKeyword(page, keyword) {
  const searchUrl = `https://x.com/search?q=${encodeURIComponent(keyword)}&f=live`;
  console.log(`[twitter-scanner] scanning: ${keyword}`);

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
  } catch {
    console.error(`[twitter-scanner] navigation timeout for "${keyword}"`);
    return [];
  }

  const currentUrl = page.url();
  if (currentUrl.includes('login') || currentUrl.includes('flow/login')) {
    throw new Error('Session expired — re-run: node scripts/save-session.js twitter');
  }

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
        const textEl = await el.$('[data-testid="tweetText"]');
        const tweetText = textEl ? (await textEl.textContent()).trim() : null;
        if (!tweetText || tweetText.startsWith('RT @')) continue;

        const authorEl = await el.$('[data-testid="User-Name"] span');
        const author = authorEl ? (await authorEl.textContent()).trim().replace('@', '') : 'unknown';

        const timeEl = await el.$('time');
        let tweetUrl = null;
        if (timeEl) {
          const timeParent = await timeEl.$('xpath=../..');
          if (timeParent) {
            const href = await timeParent.getAttribute('href');
            if (href && href.includes('/status/')) {
              tweetUrl = href.startsWith('http') ? href : `https://x.com${href}`;
            }
          }
        }
        if (!tweetUrl) continue;

        tweets.push({ tweetText, author, tweetUrl });
        count++;
      } catch { continue; }
    }
  } catch (err) {
    console.error(`[twitter-scanner] scrape failed for "${keyword}":`, err && err.message);
  }

  console.log(`[twitter-scanner] "${keyword}": found ${tweets.length} tweets`);
  return tweets;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { chromium } = require('playwright');

  if (!fs.existsSync(SESSION_FILE)) {
    console.error('[twitter-scanner] No session file found.');
    console.error('Run once with Chrome closed: node scripts/save-session.js twitter');
    process.exit(1);
  }

  console.log('[twitter-scanner] Using saved session (Chrome can stay open).');
  const storageState = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    storageState,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();
  let newEngagements = 0;

  try {
    for (const keyword of KEYWORDS) {
      let tweets;
      try {
        tweets = await scanKeyword(page, keyword);
      } catch (err) {
        console.error(`[twitter-scanner] scanKeyword error for "${keyword}":`, err.message);
        if (err.message.includes('Session expired')) break;
        continue;
      }

      for (const { tweetText, author, tweetUrl } of tweets) {
        const seen = await isTweetAlreadySeen(tweetUrl);
        if (seen) continue;

        const draft = await draftReply(tweetText, author, keyword);
        if (!draft) {
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
        await new Promise(r => setTimeout(r, 1000));
      }

      await new Promise(r => setTimeout(r, 2000));
    }
  } finally {
    await browser.close();
  }

  console.log(`[twitter-scanner] done. New engagements queued: ${newEngagements}`);
}

main().catch(err => {
  console.error('[twitter-scanner] fatal:', err.message);
  process.exit(1);
});
