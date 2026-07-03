'use strict';

// scripts/reddit-scanner.js
//
// Scans r/realtors and r/realestate via Reddit's public RSS feeds (new + hot)
// for posts matching target keywords. Drafts a reply in Heath's voice via
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
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// No Reddit credentials needed — public RSS feeds work without auth.
// Reddit's .json feeds return 403 from datacenter IPs; RSS does not.

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
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const SEEN_FILE = path.join(__dirname, '.reddit-scanner-seen.json');

// RSS feeds to fetch — new + hot per subreddit
const FEEDS = [
  { subreddit: 'realtors', sort: 'new', limit: 50 },
  { subreddit: 'realestate', sort: 'new', limit: 50 },
  { subreddit: 'realtors', sort: 'hot', limit: 25 },
  { subreddit: 'realestate', sort: 'hot', limit: 25 },
];

// Keywords to match locally (case-insensitive)
const TC_KEYWORDS = [
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

// Max post age: 7 days
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

// ─── RSS parse helpers ────────────────────────────────────────────────────────

// Decode HTML entities used in RSS content fields.
function decodeHtml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#32;/g, ' ')
    .replace(/&#x27;/g, "'");
}

// Strip HTML tags and collapse whitespace to get plain text.
function stripHtml(str) {
  return str
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract the short Reddit post ID from a t3_xxxxx atom id or a permalink URL.
// Examples:
//   <id>t3_1u0msl7</id>  ->  "1u0msl7"
//   https://www.reddit.com/r/realtors/comments/1u0msl7/...  ->  "1u0msl7"
function extractRedditId(atomId, permalink) {
  const t3Match = atomId && atomId.match(/t3_([a-z0-9]+)/i);
  if (t3Match) return t3Match[1];
  const urlMatch = permalink && permalink.match(/\/comments\/([a-z0-9]+)\//i);
  if (urlMatch) return urlMatch[1];
  return atomId || '';
}

// Parse Reddit's Atom RSS feed XML into an array of post objects.
// Reddit RSS entries look like:
//   <entry>
//     <title>Post title here</title>
//     <id>t3_1u0msl7</id>
//     <link href="https://www.reddit.com/r/realtors/comments/1u0msl7/..." />
//     <published>2026-06-08T22:22:14+00:00</published>
//     <content type="html">...HTML body...</content>
//   </entry>
function parseRss(xml, subreddit) {
  const posts = [];
  // Split on <entry> tags — each block is one post
  const entries = xml.split(/<entry>/i).slice(1);

  for (const entry of entries) {
    const titleMatch = entry.match(/<title>([^<]*)<\/title>/i);
    const idMatch = entry.match(/<id>([^<]*)<\/id>/i);
    const linkMatch = entry.match(/<link[^>]*href="([^"]*)"[^>]*\/?>/i);
    const publishedMatch = entry.match(/<published>([^<]*)<\/published>/i);
    const contentMatch = entry.match(/<content[^>]*>([\s\S]*?)<\/content>/i);

    const rawTitle = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const atomId = idMatch ? idMatch[1].trim() : '';
    const permalink = linkMatch ? linkMatch[1] : '';
    const publishedStr = publishedMatch ? publishedMatch[1] : '';
    const rawContent = contentMatch ? contentMatch[1] : '';

    const redditId = extractRedditId(atomId, permalink);
    const title = rawTitle.trim();
    // Body text: decode entities then strip HTML tags
    const selftext = stripHtml(decodeHtml(rawContent));
    const publishedAt = publishedStr ? new Date(publishedStr).getTime() : 0;

    if (!redditId || !title) continue;

    posts.push({
      id: redditId,
      subreddit,
      title,
      selftext,
      permalink,
      score: 0, // RSS does not expose score
      created_utc: publishedAt ? Math.floor(publishedAt / 1000) : 0,
      published_at: publishedAt,
    });
  }

  return posts;
}

// ─── RSS feed fetch ───────────────────────────────────────────────────────────

async function fetchFeed(subreddit, sort, limit) {
  const url = `https://www.reddit.com/r/${subreddit}/${sort}.rss?limit=${limit}`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'DossieBot/1.0 by MeetDossie',
        'Accept': 'application/rss+xml, application/xml, text/xml',
      },
    });

    if (res.status === 429) {
      console.warn(`[reddit-scanner] Rate limited on r/${subreddit}/${sort} -- skipping`);
      return [];
    }

    if (!res.ok) {
      console.warn(`[reddit-scanner] r/${subreddit}/${sort}: HTTP ${res.status}`);
      return [];
    }

    const xml = await res.text();
    const posts = parseRss(xml, subreddit);
    return posts;
  } catch (err) {
    console.error(`[reddit-scanner] fetch failed for r/${subreddit}/${sort}:`, err && err.message);
    return [];
  }
}

// ─── Local keyword filter ─────────────────────────────────────────────────────

// Returns the first matching keyword, or null if no match.
function matchesKeyword(post) {
  const fullText = `${post.title || ''} ${post.selftext || ''}`.toLowerCase();
  for (const kw of TC_KEYWORDS) {
    if (fullText.includes(kw.toLowerCase())) return kw;
  }
  return null;
}

// ─── Post age filter ──────────────────────────────────────────────────────────

function isTooOld(post) {
  if (!post.published_at) return false;
  return Date.now() - post.published_at > MAX_AGE_MS;
}

// ─── Texas signal check ───────────────────────────────────────────────────────

function isTexasPost(post) {
  const fullText = `${post.title || ''} ${post.selftext || ''}`.toLowerCase();
  return TEXAS_SIGNALS.some((s) => fullText.includes(s));
}

// ─── Supabase persistence ─────────────────────────────────────────────────────

async function saveEngagement(post, keyword, draft, telegramMessageId) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;

  const postId = `${post.subreddit || 'unknown'}_${post.id}`;
  const row = {
    post_id: postId,
    reddit_id: post.id || '',
    subreddit: post.subreddit || '',
    post_title: (post.title || '').slice(0, 500),
    post_body: (post.selftext || '').slice(0, 2000),
    post_url: post.permalink || `https://www.reddit.com/r/${post.subreddit}/`,
    permalink: post.permalink || '',
    keyword_matched: keyword,
    our_response_draft: draft,
    status: 'pending',
    score: post.score || 0,
    telegram_sent_at: new Date().toISOString(),
    telegram_message_id: telegramMessageId || null,
  };

  try {
    const headers = {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'resolution=merge-duplicates,return=minimal',
    };
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/reddit_engagements?on_conflict=post_id`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(row),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      console.warn('[reddit-scanner] saveEngagement failed:', res.status, text.slice(0, 200));
    } else {
      console.log(`[reddit-scanner] Saved engagement to Supabase: ${postId}`);
    }
  } catch (err) {
    console.warn('[reddit-scanner] saveEngagement error:', err && err.message);
  }
}

// ─── Claude Haiku reply draft ─────────────────────────────────────────────────

const REPLY_SYSTEM_PROMPT = `You are drafting a Reddit reply for Heath Shepard, a licensed Texas REALTOR who built Dossie (an AI transaction coordinator for Texas agents).

Heath's voice: warm, casual, genuine, first-person, self-deprecating. Sounds like a working agent, not a marketer. Short sentences. Conversational. Never corporate. Never use "excited," "thrilled," "game-changer," "leverage," or "solution."

Rules:
- Reply as if Heath is typing on his phone between showings
- Be genuinely helpful first -- answer their question or acknowledge their pain
- One sentence about Dossie max, then meetdossie.com/founding if relevant
- If it's a pain point about too many apps / TC frustration / software overload: empathize, mention Dossie naturally
- If it's a question about what TC tools people use: answer with genuine experience, mention Dossie as what he built
- If the post has no genuine opening for Dossie (e.g., unrelated topic, already solved, location outside US): reply with just the word SKIP
- Max 3 sentences total. Plain ASCII only -- no em dashes, no curly quotes.`;

async function draftReply(post, keyword) {
  if (!ANTHROPIC_API_KEY) return null;

  const title = (post.title || '').slice(0, 200);
  const body = (post.selftext || '').slice(0, 400);
  const subreddit = post.subreddit || '';
  const texasContext = isTexasPost(post) ? 'yes' : 'no';

  const userMsg = `Subreddit: r/${subreddit}
Keyword that matched: "${keyword}"
Texas context: ${texasContext}
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
    // Sonnet 5 extended thinking prepends `thinking` block; iterate all text blocks.
    const text = ((data?.content || [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim());
    if (!text || text.toUpperCase().startsWith('SKIP')) return null;
    return text;
  } catch (err) {
    console.error('[reddit-scanner] draftReply failed:', err && err.message);
    return null;
  }
}

// ─── Telegram veto-mode ───────────────────────────────────────────────────────

// Returns the message_id of the draft message (Message 2) so it can be stored
// in reddit_engagements for STOP callback lookups.
async function sendVetoMessages(post, keyword, draft) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return null;

  const redditUrl = post.permalink || `https://www.reddit.com/r/${post.subreddit}/`;
  const texasTag = isTexasPost(post) ? ' [Texas]' : '';

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

  // Message 1: context -- no buttons
  const contextText = [
    `Reddit match${texasTag}: r/${post.subreddit || ''}`,
    `Keyword: "${keyword}"`,
    '',
    `"${(post.title || '').slice(0, 200)}"`,
    '',
    redditUrl,
  ].join('\n');
  await send(contextText, null);

  // Small delay to avoid Telegram flood limits
  await new Promise((r) => setTimeout(r, 800));

  // Message 2: draft reply + STOP button
  // post_id uses the composite key format "subreddit_redditid" so the callback
  // handler can find the row by post_id column.
  const compositePostId = `${post.subreddit || 'unknown'}_${post.id}`;
  const keyboard = {
    inline_keyboard: [[
      { text: 'STOP', callback_data: `reddit_stop_${compositePostId}` },
    ]],
  };
  const draftText = `Draft reply:\n\n${draft}\n\nAuto-posts in 10 min - tap STOP to cancel`;
  const draftMessageId = await send(draftText, keyboard);
  return draftMessageId;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const seen = loadSeen();
  let totalFetched = 0;
  let totalMatched = 0;
  let queued = 0;

  // Collect posts per composite key to deduplicate across feeds
  // (same post may appear in both new and hot)
  const candidateMap = new Map();

  for (const { subreddit, sort, limit } of FEEDS) {
    console.log(`[reddit-scanner] fetching r/${subreddit}/${sort}.rss (limit=${limit})`);
    const posts = await fetchFeed(subreddit, sort, limit);
    totalFetched += posts.length;
    console.log(`[reddit-scanner] got ${posts.length} posts from r/${subreddit}/${sort}`);

    for (const post of posts) {
      const compositeId = `${subreddit}_${post.id}`;
      if (candidateMap.has(compositeId)) continue;
      if (isTooOld(post)) continue;

      const keyword = matchesKeyword(post);
      if (!keyword) continue;

      candidateMap.set(compositeId, { post, keyword });
    }

    // Polite pause between feed requests
    await new Promise((r) => setTimeout(r, 1000));
  }

  totalMatched = candidateMap.size;
  console.log(`[reddit-scanner] ${totalFetched} posts fetched, ${totalMatched} matched keywords`);

  for (const [compositeId, { post, keyword }] of candidateMap) {
    if (seen.has(compositeId)) {
      console.log(`[reddit-scanner] already seen: ${compositeId}`);
      continue;
    }

    // Mark seen immediately so a crash doesn't cause double-sends
    seen.add(compositeId);
    saveSeen(seen);

    const draft = await draftReply(post, keyword);

    if (!draft) {
      console.log(`[reddit-scanner] SKIP: ${post.title || post.id}`);
      continue;
    }

    console.log(`[reddit-scanner] queueing: r/${post.subreddit} -- ${(post.title || '').slice(0, 60)}`);
    const telegramMessageId = await sendVetoMessages(post, keyword, draft);
    await saveEngagement(post, keyword, draft, telegramMessageId);
    queued++;

    // Pause between Telegram sends to avoid flood limits
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(`[reddit-scanner] done. Posts queued for veto review: ${queued}`);
}

main().catch((err) => {
  console.error('[reddit-scanner] fatal error:', err && err.message);
  process.exit(1);
});
