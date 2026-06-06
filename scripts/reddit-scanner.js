'use strict';

// scripts/reddit-scanner.js
//
// Scans r/realtors and r/realestate via Reddit's public JSON API for posts
// and comments matching target keywords. Drafts a reply in Heath's voice via
// Claude Haiku and sends to DossieMarketingBot as a veto-mode message.
//
// Usage:
//   node scripts/reddit-scanner.js
//
// Veto-mode: Heath has 10 min to tap STOP. If no action, the reply goes out.
// Already-seen post IDs are stored in scripts/.reddit-scanner-seen.json so
// the same post is never sent twice.
//
// Env vars required:
//   ANTHROPIC_API_KEY
//   TELEGRAM_MARKETING_BOT_TOKEN  (or TELEGRAM_BOT_TOKEN)
//   TELEGRAM_CHAT_ID
//
// No Reddit auth required — uses public .json endpoints.
// No Supabase writes — local seen-file is sufficient for dedup.

const path = require('path');
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

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const SEEN_FILE = path.join(__dirname, '.reddit-scanner-seen.json');

// Subreddits to scan
const SUBREDDITS = ['realtors', 'realestate'];

// Keywords to search within each subreddit
const KEYWORDS = [
  'transaction coordinator',
  'zipforms',
  'dotloop',
  'skyslope',
  'too many tabs',
  'real estate software',
  'TC software',
  'real estate apps',
];

// Texas signal phrases — posts with these score higher
const TEXAS_SIGNALS = ['texas', 'tx', 'san antonio', 'houston', 'austin', 'dallas', 'fort worth', 'dfw'];

// Minimum upvotes and max age (7 days)
const MIN_SCORE = 5;
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

// ─── Seen-file helpers ────────────────────────────────────────────────────────

function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      const raw = fs.readFileSync(SEEN_FILE, 'utf8');
      return new Set(JSON.parse(raw));
    }
  } catch {
    // Non-fatal — start fresh
  }
  return new Set();
}

function saveSeen(seen) {
  try {
    // Keep the last 5000 IDs to prevent unbounded growth
    const arr = [...seen].slice(-5000);
    fs.writeFileSync(SEEN_FILE, JSON.stringify(arr), 'utf8');
  } catch (err) {
    console.warn('[reddit-scanner] Could not save seen file:', err && err.message);
  }
}

// ─── Reddit fetch ─────────────────────────────────────────────────────────────

async function fetchRedditSearch(subreddit, keyword) {
  const q = encodeURIComponent(keyword);
  const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${q}&sort=new&t=week&limit=25`;

  try {
    const res = await fetch(url, {
      headers: {
        // Reddit requires a real User-Agent string — bots that omit it get 429s
        'User-Agent': 'DossieBot/1.0 (+https://meetdossie.com)',
      },
    });

    if (res.status === 429) {
      console.warn(`[reddit-scanner] Rate limited on r/${subreddit} "${keyword}" — skipping`);
      return [];
    }

    if (!res.ok) {
      console.warn(`[reddit-scanner] r/${subreddit} "${keyword}": HTTP ${res.status}`);
      return [];
    }

    const data = await res.json();
    const posts = data?.data?.children || [];
    return posts.map((c) => c.data).filter(Boolean);
  } catch (err) {
    console.error(`[reddit-scanner] fetch failed for r/${subreddit} "${keyword}":`, err && err.message);
    return [];
  }
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

function scorePost(post) {
  const now = Math.floor(Date.now() / 1000);
  const age = now - (post.created_utc || 0);

  // Reject if too old or not enough engagement
  if (age > MAX_AGE_SECONDS) return -1;
  if ((post.score || 0) < MIN_SCORE) return -1;

  let score = post.score || 0;

  // Texas bonus — +50 points if the post mentions Texas geography
  const fullText = `${post.title || ''} ${post.selftext || ''}`.toLowerCase();
  for (const signal of TEXAS_SIGNALS) {
    if (fullText.includes(signal)) {
      score += 50;
      break;
    }
  }

  return score;
}

// ─── Claude Haiku reply draft ─────────────────────────────────────────────────

const REPLY_SYSTEM_PROMPT = `You are drafting a Reddit reply for Heath Shepard, a licensed Texas REALTOR who built Dossie (an AI transaction coordinator for Texas agents).

Heath's voice: warm, casual, genuine, first-person, self-deprecating. Sounds like a working agent, not a marketer. Short sentences. Conversational. Never corporate. Never use "excited," "thrilled," "game-changer," "leverage," or "solution."

Rules:
- Reply as if Heath is typing on his phone between showings
- Be genuinely helpful first — answer their question or acknowledge their pain
- One sentence about Dossie max, then meetdossie.com/founding if relevant
- If it's a pain point about too many apps / TC frustration / software overload: empathize, mention Dossie naturally
- If it's a question about what TC tools people use: answer with genuine experience, mention Dossie as what he built
- If the post has no genuine opening for Dossie (e.g., unrelated topic, already solved, location outside US): reply with just the word SKIP
- Max 3 sentences total. Plain ASCII only — no em dashes, no curly quotes.`;

async function draftReply(post, keyword) {
  if (!ANTHROPIC_API_KEY) return null;

  const title = (post.title || '').slice(0, 200);
  const body = (post.selftext || '').slice(0, 400);
  const subreddit = post.subreddit || '';
  const isTexas = TEXAS_SIGNALS.some((s) =>
    `${title} ${body}`.toLowerCase().includes(s)
  );

  const userMsg = `Subreddit: r/${subreddit}
Keyword that matched: "${keyword}"
Texas context: ${isTexas ? 'yes' : 'no'}
Post title: "${title}"
Post body: "${body}"

Draft a Reddit reply for Heath. If this post doesn't have a genuine opening, reply with just the word SKIP.`;

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
        max_tokens: 200,
        system: REPLY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const text = String(data?.content?.[0]?.text || '').trim();
    if (!text || text.toUpperCase().startsWith('SKIP')) return null;
    return text;
  } catch (err) {
    console.error('[reddit-scanner] draftReply failed:', err && err.message);
    return null;
  }
}

// ─── Telegram veto-mode ───────────────────────────────────────────────────────

async function sendVetoMessages(post, keyword, draft) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const redditUrl = `https://www.reddit.com${post.permalink || ''}`;
  const isTexas = TEXAS_SIGNALS.some((s) =>
    `${(post.title || '')} ${(post.selftext || '')}`.toLowerCase().includes(s)
  );
  const texasTag = isTexas ? ' [Texas]' : '';

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

  // Message 1: context — no buttons
  const contextText = [
    `Reddit match${texasTag}: r/${post.subreddit || ''} (${post.score || 0} upvotes)`,
    `Keyword: "${keyword}"`,
    '',
    `"${(post.title || '').slice(0, 200)}"`,
    '',
    redditUrl,
  ].join('\n');
  await send(contextText, null);

  // Small delay to avoid Telegram flood limits
  await new Promise((r) => setTimeout(r, 800));

  // Message 2: draft reply + STOP button + auto-post label
  const keyboard = {
    inline_keyboard: [[
      { text: 'STOP', callback_data: `reddit_stop_${post.id}` },
    ]],
  };
  const draftText = `Draft reply:\n\n${draft}\n\nAuto-posts in 10 min - tap STOP to cancel`;
  await send(draftText, keyboard);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const seen = loadSeen();
  let queued = 0;

  for (const subreddit of SUBREDDITS) {
    for (const keyword of KEYWORDS) {
      console.log(`[reddit-scanner] scanning r/${subreddit} for "${keyword}"`);

      const posts = await fetchRedditSearch(subreddit, keyword);

      // Score and sort — highest first
      const scored = posts
        .map((p) => ({ post: p, score: scorePost(p) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score);

      for (const { post } of scored) {
        const postId = `${subreddit}_${post.id}`;

        if (seen.has(postId)) {
          console.log(`[reddit-scanner] already seen: ${postId}`);
          continue;
        }

        // Mark seen immediately so a crash doesn't cause double-sends
        seen.add(postId);
        saveSeen(seen);

        const draft = await draftReply(post, keyword);

        if (!draft) {
          console.log(`[reddit-scanner] SKIP: ${post.title || post.id}`);
          continue;
        }

        console.log(`[reddit-scanner] queueing: r/${post.subreddit} — ${(post.title || '').slice(0, 60)}`);
        await sendVetoMessages(post, keyword, draft);
        queued++;

        // Pause between Telegram sends to avoid flood limits
        await new Promise((r) => setTimeout(r, 2000));
      }

      // Pause between Reddit API calls — be a polite crawler
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  console.log(`[reddit-scanner] done. Posts queued for veto review: ${queued}`);
}

main().catch((err) => {
  console.error('[reddit-scanner] fatal error:', err && err.message);
  process.exit(1);
});
