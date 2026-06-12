'use strict';

// api/cron-reddit-scanner.js
//
// Vercel cron: scans r/realtors + r/realestate for keyword matches,
// drafts replies via Claude Haiku, sends to DossieMarketingBot in veto mode.
// Dedup via Supabase reddit_engagements table.
// Runs 4x daily (no browser required).

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

// Heath-approved caps 2026-06-10 -- shared source of truth.
const {
  canComment,
  meetsSubstanceFloor,
  SUBSTANCE_MIN_CHARS,
} = require('../scripts/_lib/comment-caps');

const SUBREDDITS = ['realtors', 'realestate'];
const KEYWORDS = [
  'transaction coordinator',
  'zipforms',
  'dotloop',
  'skyslope',
  'real estate software',
  'TC software',
  'real estate apps',
  'option period',
  'closing deadline',
];
const TEXAS_SIGNALS = ['texas', 'tx', 'san antonio', 'houston', 'austin', 'dallas', 'fort worth', 'dfw'];
const MIN_SCORE = 3;
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

// ─── Supabase ──────────────────────────────────────────────────────────────────

async function sbFetch(urlPath, init = {}) {
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

async function isAlreadySeen(redditId) {
  const { data } = await sbFetch(
    `/rest/v1/reddit_engagements?reddit_id=eq.${encodeURIComponent(redditId)}&select=id&limit=1`,
  );
  return Array.isArray(data) && data.length > 0;
}

async function saveEngagement(post, keyword, draft) {
  const { ok, data } = await sbFetch('/rest/v1/reddit_engagements', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      reddit_id: `${post.subreddit}_${post.id}`,
      subreddit: post.subreddit || '',
      post_title: (post.title || '').slice(0, 500),
      post_body: (post.selftext || '').slice(0, 1000),
      post_url: `https://www.reddit.com${post.permalink || ''}`,
      keyword_matched: keyword,
      our_response_draft: draft,
      status: draft ? 'pending' : 'skipped',
      score: post.score || 0,
    }),
  });
  if (!ok) return null;
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

// ─── Reddit ────────────────────────────────────────────────────────────────────

async function fetchRedditSearch(subreddit, keyword) {
  const q = encodeURIComponent(keyword);
  const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${q}&sort=new&t=week&limit=25`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'DossieBot/1.0 (+https://meetdossie.com)' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.data?.children || []).map(c => c.data).filter(Boolean);
  } catch { return []; }
}

function scorePost(post) {
  const now = Math.floor(Date.now() / 1000);
  if ((now - (post.created_utc || 0)) > MAX_AGE_SECONDS) return -1;
  if ((post.score || 0) < MIN_SCORE) return -1;
  let score = post.score || 0;
  const fullText = `${post.title || ''} ${post.selftext || ''}`.toLowerCase();
  if (TEXAS_SIGNALS.some(s => fullText.includes(s))) score += 50;
  return score;
}

// ─── Claude Haiku ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You draft Reddit replies for Heath Shepard, a licensed Texas REALTOR who built Dossie (AI transaction coordinator for Texas agents).

Heath's voice: warm, casual, genuine, first-person. Sounds like a working agent, not a marketer. Short sentences. Never corporate. Never "excited," "thrilled," "game-changer," "leverage."

Rules:
- Be genuinely helpful first
- One sentence about Dossie max, then meetdossie.com/founding only if relevant
- Pain point or TC software question: empathize + mention Dossie naturally
- No clear opening for Dossie: return SKIP
- Max 3 sentences. Plain ASCII only.`;

async function draftReply(post, keyword) {
  if (!ANTHROPIC_API_KEY) return null;
  const isTexas = TEXAS_SIGNALS.some(s =>
    `${post.title || ''} ${post.selftext || ''}`.toLowerCase().includes(s)
  );
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
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `Subreddit: r/${post.subreddit}\nKeyword: "${keyword}"\nTexas: ${isTexas ? 'yes' : 'no'}\nTitle: "${(post.title || '').slice(0, 200)}"\nBody: "${(post.selftext || '').slice(0, 400)}"\n\nDraft reply or SKIP.`,
        }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = String(data?.content?.[0]?.text || '').trim();
    if (!text || text.toUpperCase().startsWith('SKIP')) return null;
    return text;
  } catch { return null; }
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendVetoMessages(post, keyword, draft, engId) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const redditUrl = `https://www.reddit.com${post.permalink || ''}`;
  const isTexas = TEXAS_SIGNALS.some(s =>
    `${post.title || ''} ${post.selftext || ''}`.toLowerCase().includes(s)
  );
  const texasTag = isTexas ? ' [Texas]' : '';

  const send = async (text, replyMarkup) => {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
        reply_markup: replyMarkup || undefined,
      }),
    });
  };

  await send(
    `Reddit match${texasTag}: r/${post.subreddit || ''} (${post.score || 0} upvotes)\nKeyword: "${keyword}"\n\n"${(post.title || '').slice(0, 200)}"\n\n${redditUrl}`,
    null,
  );

  await new Promise(r => setTimeout(r, 800));

  await send(
    `Draft reply:\n\n${draft}\n\nAuto-posts in 10 min - tap STOP to cancel`,
    { inline_keyboard: [[{ text: 'STOP', callback_data: `reddit_stop_${engId}` }]] },
  );
}

// ─── Handler ───────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let queued = 0;
  let skipped = 0;
  let capBlocked = 0;
  let substanceRejected = 0;

  for (const subreddit of SUBREDDITS) {
    for (const keyword of KEYWORDS) {
      const posts = await fetchRedditSearch(subreddit, keyword);

      const scored = posts
        .map(p => ({ post: p, score: scorePost(p) }))
        .filter(x => x.score >= 0)
        .sort((a, b) => b.score - a.score);

      for (const { post } of scored) {
        // Per-platform cap gate (Heath-approved 2026-06-10: Reddit 5/day).
        const cap = await canComment('reddit', sbFetch);
        if (!cap.allowed) { capBlocked++; continue; }

        const redditId = `${subreddit}_${post.id}`;
        const seen = await isAlreadySeen(redditId);
        if (seen) { skipped++; continue; }

        const draft = await draftReply(post, keyword);

        // Substance floor: 80+ chars referencing a source-post specific.
        let finalDraft = draft;
        if (draft) {
          const srcKeywords = [keyword].filter(Boolean);
          const sub = meetsSubstanceFloor(draft, srcKeywords);
          if (!sub.ok) {
            finalDraft = null;
            substanceRejected++;
          }
        }

        const saved = await saveEngagement(post, keyword, finalDraft);
        if (!saved) continue;

        if (finalDraft) {
          await sendVetoMessages(post, keyword, finalDraft, saved.id);
          await new Promise(r => setTimeout(r, 2000));
          queued++;
        }
      }

      await new Promise(r => setTimeout(r, 1500));
    }
  }

  return res.status(200).json({
    ok: true,
    queued,
    skipped,
    cap_blocked: capBlocked,
    substance_rejected: substanceRejected,
    substance_floor_chars: SUBSTANCE_MIN_CHARS,
  });
}
