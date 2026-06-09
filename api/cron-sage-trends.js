// Vercel Serverless Function: /api/cron-sage-trends
// Sage's daily trend scanner — fetches real estate trending topics and writes
// a brief to sage_trend_briefs so cron-generate-posts can pull it for context.
//
// Auth: Authorization: Bearer ${CRON_SECRET} OR x-vercel-cron: 1
// Triggered by: cron-job.org external cron (NOT in vercel.json — Vercel is at limit)
// Suggested schedule: 30 10 * * * (10:30 UTC = 5:30am CST, 30 min before cron-generate-posts)
//
// Sources:
//   1. Google Trends dailytrends for Texas real estate
//   2. Reddit r/realestate + r/RealEstateTechnology top posts (past day)
//
// Output: sage_trend_briefs row with trend_brief summarizing top 3 angles.
//
// DB NOTE: sage_trend_briefs table must be created before this runs. SQL:
//
//   CREATE TABLE IF NOT EXISTS sage_trend_briefs (
//     id              BIGSERIAL PRIMARY KEY,
//     brief_date      DATE NOT NULL,
//     trend_brief     TEXT NOT NULL,
//     raw_google_data JSONB,
//     raw_reddit_data JSONB,
//     created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
//   );
//   -- Unique on date so we can UPSERT safely on re-runs
//   CREATE UNIQUE INDEX IF NOT EXISTS sage_trend_briefs_date_idx
//     ON sage_trend_briefs (brief_date);
//   -- RLS: service role only (internal table, no customer access)
//   ALTER TABLE sage_trend_briefs ENABLE ROW LEVEL SECURITY;

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'; // Trend summarization is lightweight

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

// ─── Trend data fetchers ──────────────────────────────────────────────────────

// Google Trends dailytrends for Texas real estate.
// Response starts with )]}'  which must be stripped before JSON.parse.
async function fetchGoogleTrends() {
  const url = 'https://trends.google.com/trends/api/dailytrends?hl=en-US&tz=-300&geo=TX&ns=15';
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Dossie/1.0)',
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      console.warn(`[cron-sage-trends] Google Trends HTTP ${res.status}`);
      return null;
    }
    const text = await res.text();
    // Strip the XSSI guard prefix: )]}'\n
    const jsonStart = text.indexOf('{');
    if (jsonStart === -1) {
      console.warn('[cron-sage-trends] Google Trends: no JSON object found in response');
      return null;
    }
    const parsed = JSON.parse(text.slice(jsonStart));
    // Extract trending search titles. Path: default.trendingSearchesDays[0].trendingSearches[].title.query
    const days = parsed?.default?.trendingSearchesDays;
    if (!Array.isArray(days) || days.length === 0) return null;
    const searches = days[0]?.trendingSearches || [];
    const topics = searches.slice(0, 10).map((s) => ({
      query: s?.title?.query || '',
      traffic: s?.formattedTraffic || '',
      relatedQueries: (s?.relatedQueries || []).slice(0, 3).map((q) => q?.query || ''),
    })).filter((t) => t.query);
    return { topics, fetchedAt: new Date().toISOString() };
  } catch (err) {
    console.warn('[cron-sage-trends] Google Trends fetch error:', err.message);
    return null;
  }
}

// Reddit r/realestate + r/RealEstateTechnology top posts (past day).
async function fetchRedditPosts() {
  const subreddits = ['realestate', 'RealEstateTechnology'];
  const results = {};
  for (const sub of subreddits) {
    try {
      const url = `https://www.reddit.com/r/${sub}/top.json?limit=5&t=day`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Dossie/1.0)',
          Accept: 'application/json',
        },
      });
      if (!res.ok) {
        console.warn(`[cron-sage-trends] Reddit r/${sub} HTTP ${res.status}`);
        results[sub] = null;
        continue;
      }
      const body = await res.json();
      const posts = (body?.data?.children || []).map((c) => ({
        title: c?.data?.title || '',
        score: c?.data?.score || 0,
        numComments: c?.data?.num_comments || 0,
        url: `https://reddit.com${c?.data?.permalink || ''}`,
      })).filter((p) => p.title);
      results[sub] = posts;
    } catch (err) {
      console.warn(`[cron-sage-trends] Reddit r/${sub} error:`, err.message);
      results[sub] = null;
    }
  }
  return results;
}

// ─── Summarize with Claude ───────────────────────────────────────────────────

async function summarizeTrends(googleData, redditData) {
  // Build a compact context string for Claude to summarize.
  const parts = [];

  if (googleData && googleData.topics && googleData.topics.length > 0) {
    const topicLines = googleData.topics.slice(0, 8).map(
      (t) => `- ${t.query}${t.traffic ? ` (${t.traffic})` : ''}${t.relatedQueries.length ? ` [related: ${t.relatedQueries.join(', ')}]` : ''}`,
    ).join('\n');
    parts.push(`GOOGLE TRENDS (Texas, today):\n${topicLines}`);
  }

  for (const [sub, posts] of Object.entries(redditData || {})) {
    if (!posts || posts.length === 0) continue;
    const postLines = posts.map(
      (p) => `- "${p.title}" (${p.score} upvotes, ${p.numComments} comments)`,
    ).join('\n');
    parts.push(`REDDIT r/${sub} (top today):\n${postLines}`);
  }

  if (parts.length === 0) {
    return 'No trend data available today. Default to evergreen TREC deadline and cost-savings content angles.';
  }

  const context = parts.join('\n\n');

  const prompt = `You are Sage, Head of Social Media for Dossie — a Texas real estate transaction management app. Your audience is Texas REALTORS.

Below is today's real estate trend data from Google Trends (Texas) and Reddit. Identify the top 3 content angles that are most relevant to Texas agents using a transaction management tool. Each angle should be a 1-2 sentence hook Sage can use to shape today's social posts.

Focus on: pain points agents face, compliance/deadline stress, time savings, technology adoption. Avoid: national macro news, mortgage rates (not our angle), political content.

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
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn('[cron-sage-trends] Anthropic error:', res.status, errText.slice(0, 200));
      return 'Trend summarization failed. Use evergreen TREC deadline and cost-savings angles today.';
    }

    const body = await res.json();
    const text = body?.content?.[0]?.text || '';
    return text.trim() || 'No summary generated.';
  } catch (err) {
    console.warn('[cron-sage-trends] Anthropic fetch error:', err.message);
    return 'Trend summarization unavailable. Use evergreen content angles.';
  }
}

// ─── Check if sage_trend_briefs table exists ─────────────────────────────────

async function tableExists() {
  // Query the table with limit=1. PostgREST returns:
  //   200/206 = table exists + rows (or empty)
  //   404     = table not found ("relation does not exist")
  // Any other status (401, 500) we treat as "exists" to avoid blocking the run.
  const { ok, status } = await supaFetch(
    'sage_trend_briefs?select=id&limit=1',
  );
  if (status === 404) return false; // table missing
  return true; // exists or unknown error — let the upsert fail with a clearer message
}

// ─── Handler ──────────────────────────────────────────────────────────────────

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
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS sage_trend_briefs_date_idx
  ON sage_trend_briefs (brief_date);
ALTER TABLE sage_trend_briefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY sage_trend_briefs_service ON sage_trend_briefs
  FOR ALL TO service_role USING (true) WITH CHECK (true);`.trim();

    console.warn('[cron-sage-trends] sage_trend_briefs table does not exist. Run this SQL:\n', createSql);
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
  const trendBrief = await summarizeTrends(googleData, redditData);

  // ── Upsert into sage_trend_briefs ─────────────────────────────────────
  const row = {
    brief_date: today,
    trend_brief: trendBrief,
    raw_google_data: googleData || null,
    raw_reddit_data: redditData || null,
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
    console.error('[cron-sage-trends] Supabase upsert failed:', status, JSON.stringify(data));
    return res.status(500).json({
      error: 'Failed to write trend brief to database',
      supabaseStatus: status,
      supabaseData: data,
    });
  }

  console.log(`[cron-sage-trends] Brief written for ${today}:`, trendBrief.slice(0, 120));

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

  return res.status(200).json({
    ok: true,
    date: today,
    brief: trendBrief,
    sage_delivered: sageDelivered,
    googleTopics: googleData?.topics?.length || 0,
    redditPosts: Object.values(redditData || {}).reduce((sum, p) => sum + (p ? p.length : 0), 0),
  });
};
