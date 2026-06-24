// Vercel Serverless Function: /api/cron-sage-trends
// Sage's daily trend scanner — fetches real estate trending topics and writes
// a brief to sage_trend_briefs so cron-generate-posts can pull it for context.
//
// Auth: Authorization: Bearer ${CRON_SECRET} OR x-vercel-cron: 1
// Triggered by: cron-job.org external cron (NOT in vercel.json — Vercel is at limit)
// Suggested schedule: 30 10 * * * (10:30 UTC = 5:30am CST, 30 min before cron-generate-posts)
//
// Sources (atlas_18 repair 2026-06-24):
//   1. Google Trends RSS (/trending/rss?geo=US-TX) — /api/dailytrends 404'd circa 2026-06.
//   2. Reddit r/realestate + r/RealEstateTechnology .rss?sort=top&t=day — .json now 403s
//      for non-browser UAs (Reddit OAuth-or-bust as of 2026-06).
//
// Output: sage_trend_briefs row with trend_brief summarizing top 3 angles, plus
// raw_google_data, raw_reddit_data (now ALWAYS objects with .topics / per-sub
// post arrays so Ridge can detect empty days), brief_source, source_counts.
//
// Ridge monitoring contract: cron_runs.last_meta now carries:
//   { google_count, reddit_count, brief_source, duration_ms, http_status }
// Ridge alerts when brief_source = 'fallback' for >= 2 consecutive days.

const { recordCronRun } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'; // Trend summarization is lightweight

// User-agent rotation pool — Reddit / Google both 403 anything that smells like a script.
// Real browser strings as of 2026-06; rotate per-request so Vercel's egress IP doesn't
// get rate-limited under a single fingerprint.
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

function pickUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ─── Supabase REST helper ─────────────────────────────────────────────────────

async function supaFetch(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...(opts.headers || {}),
  };
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// ─── RSS / Atom parsing helpers ──────────────────────────────────────────────

// Decode a handful of XML entities — enough for titles + traffic strings.
function decodeXmlEntities(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ');
}

// Pull first inner text of <tag>...</tag>. Handles optional namespace prefix.
function tagText(block, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = block.match(re);
  if (!m) return '';
  // Strip CDATA wrapper if present
  return decodeXmlEntities(m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim());
}

// Split an XML document into top-level <item>...</item> blocks (RSS) or
// <entry>...</entry> (Atom). Returns an array of inner-block strings.
function splitItems(xml, itemTag) {
  const re = new RegExp(`<${itemTag}[^>]*>([\\s\\S]*?)<\\/${itemTag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

// ─── Trend data fetchers ──────────────────────────────────────────────────────

// Google Trends RSS feed for Texas. Replaces deprecated dailytrends JSON endpoint.
// URL pattern: https://trends.google.com/trending/rss?geo=US-TX
// (Verified 2026-06-24 — atlas_18.)
async function fetchGoogleTrends() {
  const url = 'https://trends.google.com/trending/rss?geo=US-TX';
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': pickUA(),
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) {
      console.warn(`[cron-sage-trends] Google Trends HTTP ${res.status}`);
      return { topics: [], fetchedAt: new Date().toISOString(), error: `http_${res.status}` };
    }
    const xml = await res.text();
    const items = splitItems(xml, 'item');
    const topics = items.slice(0, 15).map((item) => {
      const query = tagText(item, 'title');
      const traffic = tagText(item, 'ht:approx_traffic');
      // Related news headlines give us topical color — extract up to 3.
      const newsBlocks = splitItems(item, 'ht:news_item');
      const relatedQueries = newsBlocks.slice(0, 3).map((nb) => tagText(nb, 'ht:news_item_title'));
      return { query, traffic, relatedQueries };
    }).filter((t) => t.query);
    return { topics, fetchedAt: new Date().toISOString() };
  } catch (err) {
    console.warn('[cron-sage-trends] Google Trends fetch error:', err.message);
    return { topics: [], fetchedAt: new Date().toISOString(), error: err.message };
  }
}

// Reddit subreddit top-of-day via Atom feed (.rss?sort=top&t=day).
// The .json endpoint now 403s for non-browser UAs (Reddit OAuth-or-bust as of 2026-06).
// We're polite: stagger requests with a small delay between subs to dodge rate limits.
async function fetchRedditPosts() {
  const subreddits = ['realestate', 'RealEstateTechnology'];
  const results = {};
  for (let i = 0; i < subreddits.length; i++) {
    const sub = subreddits[i];
    if (i > 0) {
      // 1.5s spacing between subreddit fetches — Reddit's rate limit on RSS is
      // ~10 req/min/IP. Vercel's egress IP is shared so we stay well under.
      await new Promise((r) => setTimeout(r, 1500));
    }
    try {
      const url = `https://www.reddit.com/r/${sub}/.rss?sort=top&t=day`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': pickUA(),
          Accept: 'application/atom+xml, application/xml, text/xml, */*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!res.ok) {
        console.warn(`[cron-sage-trends] Reddit r/${sub} HTTP ${res.status}`);
        results[sub] = { posts: [], error: `http_${res.status}` };
        continue;
      }
      const xml = await res.text();
      const entries = splitItems(xml, 'entry');
      const posts = entries.slice(0, 5).map((entry) => {
        const title = tagText(entry, 'title');
        // Atom feeds expose author + link but not raw upvote count. We don't need
        // counts for trend signal — title text is enough to feed Claude.
        const linkMatch = entry.match(/<link[^>]*href="([^"]+)"/i);
        const url = linkMatch ? decodeXmlEntities(linkMatch[1]) : '';
        return { title, score: null, numComments: null, url };
      }).filter((p) => p.title);
      results[sub] = { posts };
    } catch (err) {
      console.warn(`[cron-sage-trends] Reddit r/${sub} error:`, err.message);
      results[sub] = { posts: [], error: err.message };
    }
  }
  return results;
}

// ─── Summarize with Claude ───────────────────────────────────────────────────

async function summarizeTrends(googleData, redditData) {
  // Build a compact context string for Claude to summarize.
  const parts = [];

  const googleTopics = (googleData && Array.isArray(googleData.topics)) ? googleData.topics : [];
  if (googleTopics.length > 0) {
    const topicLines = googleTopics.slice(0, 8).map((t) => {
      const traffic = t.traffic ? ` (${t.traffic})` : '';
      const related = (t.relatedQueries && t.relatedQueries.length)
        ? ` [news: ${t.relatedQueries.filter(Boolean).join(' | ')}]`
        : '';
      return `- ${t.query}${traffic}${related}`;
    }).join('\n');
    parts.push(`GOOGLE TRENDS (Texas, today):\n${topicLines}`);
  }

  let totalRedditPosts = 0;
  for (const [sub, payload] of Object.entries(redditData || {})) {
    const posts = (payload && Array.isArray(payload.posts)) ? payload.posts : [];
    if (posts.length === 0) continue;
    totalRedditPosts += posts.length;
    const postLines = posts.map((p) => `- "${p.title}"`).join('\n');
    parts.push(`REDDIT r/${sub} (top today):\n${postLines}`);
  }

  // Decide brief_source from what actually landed in parts[].
  let briefSource;
  if (googleTopics.length > 0 && totalRedditPosts > 0) briefSource = 'google+reddit';
  else if (totalRedditPosts > 0) briefSource = 'reddit';
  else if (googleTopics.length > 0) briefSource = 'google';
  else briefSource = 'fallback';

  if (briefSource === 'fallback') {
    return {
      brief: 'No trend data available today. Default to evergreen TREC deadline and cost-savings content angles.',
      briefSource,
      googleCount: 0,
      redditCount: 0,
    };
  }

  const context = parts.join('\n\n');

  // Source attribution prefix so downstream readers (Sage chat, Heath's review)
  // can see at a glance where today's signal came from.
  const sourceLine = (() => {
    const bits = [];
    if (googleTopics.length > 0) bits.push(`Google Trends (${googleTopics.length} TX topics)`);
    if (totalRedditPosts > 0) {
      const subs = Object.entries(redditData || {})
        .filter(([, payload]) => payload && Array.isArray(payload.posts) && payload.posts.length > 0)
        .map(([sub, payload]) => `r/${sub} (${payload.posts.length})`);
      bits.push(`Reddit ${subs.join(', ')}`);
    }
    return `Sources: ${bits.join(' + ')}.`;
  })();

  const prompt = `You are Sage, Head of Social Media for Dossie — a Texas real estate transaction management app. Your audience is Texas REALTORS.

Below is today's real estate trend data. Identify the top 3 content angles most relevant to Texas agents using a transaction management tool. Each angle should be a 1-2 sentence hook Sage can use to shape today's social posts.

Focus on: pain points agents face, compliance/deadline stress, time savings, technology adoption. Avoid: national macro news, mortgage rates (not our angle), political content. If the trend data is mostly off-topic (celebrities, sports, etc.), pivot to evergreen TREC/transaction angles and note that explicitly.

Format your output as exactly 3 numbered items. No preamble, no sign-off.

TREND DATA:
${context}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn('[cron-sage-trends] Anthropic error:', res.status, errText.slice(0, 200));
      return {
        brief: 'Trend summarization failed. Use evergreen TREC deadline and cost-savings angles today.',
        briefSource: 'fallback',
        googleCount: googleTopics.length,
        redditCount: totalRedditPosts,
      };
    }

    const body = await res.json();
    const text = body?.content?.[0]?.text || '';
    const summary = text.trim() || 'No summary generated.';
    return {
      brief: `${sourceLine}\n\n${summary}`,
      briefSource,
      googleCount: googleTopics.length,
      redditCount: totalRedditPosts,
    };
  } catch (err) {
    console.warn('[cron-sage-trends] Anthropic fetch error:', err.message);
    return {
      brief: 'Trend summarization unavailable. Use evergreen content angles.',
      briefSource: 'fallback',
      googleCount: googleTopics.length,
      redditCount: totalRedditPosts,
    };
  }
}

// ─── Check if sage_trend_briefs table exists ─────────────────────────────────

async function tableExists() {
  // Query the table with limit=1. PostgREST returns:
  //   200/206 = table exists + rows (or empty)
  //   404     = table not found ("relation does not exist")
  // Any other status (401, 500) we treat as "exists" to avoid blocking the run.
  const { status } = await supaFetch(
    'sage_trend_briefs?select=id&limit=1',
  );
  if (status === 404) return false; // table missing
  return true; // exists or unknown error — let the upsert fail with a clearer message
}

// ─── Handler ──────────────────────────────────────────────────────────────────
// NOTE: NOT using withTelemetry wrapper — we need to write rich source meta to
// cron_runs.last_meta so Ridge can detect "brief_source = fallback for >= 2 days".
// The wrapper would auto-record minimal meta and overwrite ours.

module.exports = async function handler(req, res) {
  // Auth: Vercel cron header OR manual Bearer token
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startedAt = Date.now();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // ── Check table exists ─────────────────────────────────────────────────
  const exists = await tableExists();
  if (!exists) {
    const createSql = `
CREATE TABLE IF NOT EXISTS sage_trend_briefs (
  id              BIGSERIAL PRIMARY KEY,
  brief_date      DATE NOT NULL,
  trend_brief     TEXT NOT NULL,
  raw_google_data JSONB,
  raw_reddit_data JSONB,
  brief_source    TEXT,
  source_counts   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS sage_trend_briefs_date_idx
  ON sage_trend_briefs (brief_date);
ALTER TABLE sage_trend_briefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY sage_trend_briefs_service ON sage_trend_briefs
  FOR ALL TO service_role USING (true) WITH CHECK (true);`.trim();

    console.warn('[cron-sage-trends] sage_trend_briefs table does not exist. Run this SQL:\n', createSql);
    await recordCronRun('cron-sage-trends', 'error', { error: 'table_missing' });
    return res.status(503).json({
      error: 'sage_trend_briefs table does not exist',
      action: 'Run the CREATE TABLE SQL from the comment at the top of this file via Supabase SQL editor',
      sql: createSql,
    });
  }

  // ── Fetch trend data (run in parallel) ────────────────────────────────
  const [googleData, redditData] = await Promise.all([
    fetchGoogleTrends(),
    fetchRedditPosts(),
  ]);

  // ── Summarize ─────────────────────────────────────────────────────────
  const { brief: trendBrief, briefSource, googleCount, redditCount } = await summarizeTrends(googleData, redditData);

  const sourceCounts = {
    google_count: googleCount,
    reddit_count: redditCount,
    brief_source: briefSource,
  };

  // ── Upsert into sage_trend_briefs ─────────────────────────────────────
  const row = {
    brief_date: today,
    trend_brief: trendBrief,
    raw_google_data: googleData || null,
    raw_reddit_data: redditData || null,
    brief_source: briefSource,
    source_counts: sourceCounts,
  };

  const { ok, status, data } = await supaFetch(
    'sage_trend_briefs?on_conflict=brief_date',
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(row),
    },
  );

  if (!ok) {
    // If the upsert failed because brief_source / source_counts columns don't
    // exist yet, retry without them. Migration is non-blocking — old schema
    // still works, just without Ridge's monitoring fields.
    let retried = false;
    if (status === 400 || status === 404) {
      console.warn('[cron-sage-trends] Upsert failed with new schema, retrying with legacy schema:', status, JSON.stringify(data).slice(0, 300));
      const legacyRow = {
        brief_date: today,
        trend_brief: trendBrief,
        raw_google_data: googleData || null,
        raw_reddit_data: redditData || null,
      };
      const retryRes = await supaFetch(
        'sage_trend_briefs?on_conflict=brief_date',
        {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify(legacyRow),
        },
      );
      if (retryRes.ok) {
        retried = true;
        console.warn('[cron-sage-trends] Legacy-schema retry succeeded — run migration to add brief_source + source_counts columns');
      } else {
        console.error('[cron-sage-trends] Legacy retry also failed:', retryRes.status, JSON.stringify(retryRes.data));
        await recordCronRun('cron-sage-trends', 'error', {
          error: `upsert_failed_${retryRes.status}`,
          ...sourceCounts,
          duration_ms: Date.now() - startedAt,
        });
        return res.status(500).json({
          error: 'Failed to write trend brief to database',
          supabaseStatus: retryRes.status,
          supabaseData: retryRes.data,
        });
      }
    }
    if (!retried) {
      console.error('[cron-sage-trends] Supabase upsert failed:', status, JSON.stringify(data));
      await recordCronRun('cron-sage-trends', 'error', {
        error: `upsert_failed_${status}`,
        ...sourceCounts,
        duration_ms: Date.now() - startedAt,
      });
      return res.status(500).json({
        error: 'Failed to write trend brief to database',
        supabaseStatus: status,
        supabaseData: data,
      });
    }
  }

  console.log(`[cron-sage-trends] Brief written for ${today} (source=${briefSource}, g=${googleCount}, r=${redditCount}):`, trendBrief.slice(0, 120));

  // Deliver to Sage's chat (DossieSageBot). Per spec #9, frequency is Tue+Fri
  // 7AM CDT (12 UTC) but we always deliver when the cron fires — the schedule
  // gate lives in vercel.json / cron-job.org, not in this handler.
  const TELEGRAM_SAGE_BOT_TOKEN = process.env.TELEGRAM_SAGE_BOT_TOKEN;
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  let sageDelivered = false;
  if (TELEGRAM_SAGE_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    try {
      const msg = `[TREND BRIEF ${today}]\n\n${trendBrief}`;
      const sageRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_SAGE_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, disable_web_page_preview: true }),
      });
      sageDelivered = sageRes.ok;
      if (sageRes.ok) {
        await supaFetch('sage_conversations', {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            chat_id: String(TELEGRAM_CHAT_ID),
            role: 'user',
            text: msg,
          }),
        });
      }
    } catch (err) {
      console.warn('[cron-sage-trends] sage delivery failed:', err && err.message);
    }
  }

  // Telemetry — rich meta so Ridge can detect fallback streaks.
  await recordCronRun('cron-sage-trends', 'ok', {
    google_count: googleCount,
    reddit_count: redditCount,
    brief_source: briefSource,
    sage_delivered: sageDelivered,
    duration_ms: Date.now() - startedAt,
  });

  return res.status(200).json({
    ok: true,
    date: today,
    brief: trendBrief,
    brief_source: briefSource,
    google_count: googleCount,
    reddit_count: redditCount,
    sage_delivered: sageDelivered,
  });
};
