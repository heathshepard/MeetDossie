// Vercel Serverless Function: /api/cron-sage-intelligence
// Sage's daily intelligence layer — runs BEFORE content generation (06:00 UTC = 1am CST)
// so cron-generate-posts (11:00 UTC) has fresh intelligence to consume.
//
// Five tasks:
//   A. Pull Zernio analytics for the last 7 days, write to post_analytics
//   B. Scan material inventory (video_library + LIBRARY.md recording count + queue depth)
//   C. Identify what's working (top platform / pillar / persona / format from post_analytics)
//   D. Trend brief via Claude Haiku (pulls from sage_trend_briefs if available, else generates)
//   E. Low-material alert to Heath via Telegram if videos_ready < 3 OR recordings < 2
//
// Output: one sage_intelligence row per run.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Triggered by: cron-job.org JOB-005 at "0 6 * * *" (NOT in vercel.json — Vercel is at 20/20 cap)
//
// DB tables used:
//   post_analytics     — existing table (cron-analytics-sync.js owns weekly bulk sync)
//   sage_intelligence  — created by migration 2026-05-29
//   sage_trend_briefs  — created by cron-sage-trends.js
//   video_library      — existing table
//   social_posts       — existing table (queue depth)
//
// Self-report snippet (paste into subagent context to update status):
//   await fetch('/api/ventures/agent-status', { method: 'POST', headers: { 'Authorization': 'Bearer CRON_SECRET', 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_name: 'sage', status: 'active', task: 'Daily intelligence run', heartbeat: new Date().toISOString() }) });

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

const ANTHROPIC_HAIKU = 'claude-haiku-4-5-20251001';
const ZERNIO_BASE = 'https://zernio.com/api/v1';

// Content pillars map: topic key -> pillar name. Must stay in sync with TOPICS in cron-generate-posts.js.
const TOPIC_TO_PILLAR = {
  cost_math:            'cost',
  pain_points:          'control',
  day_in_the_life:      'speed',
  capability_oneliners: 'visibility',
  control_freak_agent:  'control',
  build_in_public:      'visibility',
  feature_reveal:       'visibility',
  community_movement:   'visibility',
  trec_education:       'visibility',
};

// Zernio account IDs from CLAUDE.md section 22
const ZERNIO_ACCOUNTS = [
  { platform: 'facebook',  accountId: '69f253c3985e734bf3d8f9bc' },
  { platform: 'instagram', accountId: '69f25431985e734bf3d8fcbe' },
  { platform: 'twitter',   accountId: '69f255c6985e734bf3d90ba1' },
  { platform: 'linkedin',  accountId: '69fccd7392b3d8e85f8f12be' },
  // TikTok omitted: analytics data is sparse and unreliable without native API access
];

// ─── Supabase helper ─────────────────────────────────────────────────────────

async function supaFetch(path, opts = {}) {
  const url = path.startsWith('http') ? path : `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// ─── TASK A: Zernio analytics pull ───────────────────────────────────────────
// Pulls last 7 days of analytics from Zernio and upserts into post_analytics.
// This is a lightweight daily version of what cron-analytics-sync.js does weekly
// (which covers 90 days). Daily run keeps recent data fresh for Sage's analysis.

async function pullZernioAnalytics() {
  const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const toDate   = new Date().toISOString().slice(0, 10);
  const syncDate = toDate;

  let totalFetched = 0;
  let totalUpserted = 0;
  const platformResults = [];

  // Load recent posted rows from Supabase for matching
  const { data: postedRows, ok: loadOk } = await supaFetch(
    `social_posts?status=eq.posted&select=id,post_id,platform,zernio_post_id,posted_at,zernio_account_id,persona,topic,hook&order=posted_at.desc&limit=200`,
  );
  if (!loadOk || !Array.isArray(postedRows)) {
    console.warn('[sage-intel] could not load posted rows from Supabase');
    return { totalFetched: 0, totalUpserted: 0, platformResults: [], error: 'supabase load failed' };
  }

  // Build lookup maps for matching
  const byZernioId = new Map();
  const byAccountAndTime = [];
  for (const row of postedRows) {
    if (row.zernio_post_id) byZernioId.set(String(row.zernio_post_id), row);
    if (row.zernio_account_id && row.posted_at) {
      byAccountAndTime.push({
        accountId: row.zernio_account_id,
        postedAt: new Date(row.posted_at).getTime(),
        row,
      });
    }
  }

  for (const account of ZERNIO_ACCOUNTS) {
    let zPosts = [];
    let fetchError = null;

    try {
      const params = new URLSearchParams({
        accountId: account.accountId,
        fromDate,
        toDate,
        limit: '50',
        page: '1',
        order: 'desc',
      });

      const res = await fetch(`${ZERNIO_BASE}/analytics?${params}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${ZERNIO_API_KEY}`,
          'Content-Type': 'application/json',
        },
      });

      const text = await res.text();
      console.log(`[sage-intel] Zernio ${account.platform} status=${res.status} body_head=${text.slice(0, 150)}`);

      if (!res.ok) {
        fetchError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
      } else {
        let body;
        try { body = JSON.parse(text); } catch { body = null; }
        zPosts = Array.isArray(body) ? body
          : Array.isArray(body?.posts) ? body.posts
          : Array.isArray(body?.data)  ? body.data
          : [];
      }
    } catch (err) {
      fetchError = err && err.message;
      console.warn(`[sage-intel] Zernio ${account.platform} fetch error:`, fetchError);
    }

    totalFetched += zPosts.length;
    let platformUpserted = 0;

    for (const zPost of zPosts) {
      const zId = String(zPost.postId || zPost.id || zPost.latePostId || '');
      const zPublishedAt = zPost.publishedAt || zPost.createdAt || zPost.scheduledAt;
      const raw = zPost.analytics || zPost;

      const metrics = {
        likes:           safeInt(raw.likes),
        comments:        safeInt(raw.comments),
        shares:          safeInt(raw.shares),
        saves:           safeInt(raw.saves),
        clicks:          safeInt(raw.clicks),
        views:           safeInt(raw.views ?? raw.videoViews),
        impressions:     safeInt(raw.impressions),
        reach:           safeInt(raw.reach),
        engagement_rate: safeFloat(raw.engagementRate),
      };

      // Match to a social_posts row
      let matchedRow = zId ? byZernioId.get(zId) : null;
      if (!matchedRow && zPublishedAt) {
        const zTime = new Date(zPublishedAt).getTime();
        if (!isNaN(zTime)) {
          const candidate = byAccountAndTime.find(
            (e) => e.accountId === account.accountId && Math.abs(e.postedAt - zTime) <= 5 * 60 * 1000,
          );
          if (candidate) matchedRow = candidate.row;
        }
      }

      if (!matchedRow) continue;

      // engagement_score is a generated column — Postgres computes it from the metric fields.
      // Do not include it in the insert payload.
      const analyticsRow = {
        social_post_id:  matchedRow.id,
        zernio_post_id:  zId || matchedRow.zernio_post_id || null,
        platform:        account.platform,
        persona:         matchedRow.persona || null,
        topic:           matchedRow.topic || null,
        hook:            matchedRow.hook || null,
        synced_at:       new Date().toISOString(),
        sync_date:       syncDate,
        fetched_at:      new Date().toISOString(),
        ...metrics,
      };

      const upRes = await supaFetch(`post_analytics?on_conflict=social_post_id,sync_date`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(analyticsRow),
      });

      if (upRes.ok) {
        platformUpserted++;
        totalUpserted++;
      } else {
        console.warn(`[sage-intel] analytics upsert failed for ${matchedRow.post_id}:`, upRes.status);
      }
    }

    platformResults.push({
      platform: account.platform,
      fetched: zPosts.length,
      upserted: platformUpserted,
      error: fetchError,
    });
  }

  return { totalFetched, totalUpserted, platformResults };
}

function safeInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}
function safeFloat(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0;
}

// ─── TASK B: Material inventory scan ─────────────────────────────────────────

async function scanMaterialInventory() {
  // Count video_library rows by status
  const { data: videoRows, ok: videoOk } = await supaFetch(
    `video_library?select=status`,
  );

  let videosReady = 0;
  const videoCounts = {};
  if (videoOk && Array.isArray(videoRows)) {
    for (const row of videoRows) {
      const s = row.status || 'unknown';
      videoCounts[s] = (videoCounts[s] || 0) + 1;
    }
    // "ready" = heath_approved (approved but not yet posted)
    videosReady = videoCounts['heath_approved'] || 0;
  }

  // Count available screen recordings from LIBRARY.md by counting non-header rows.
  // We use a simple heuristic: count .mp4 entries in the video_library with type='screen_recording',
  // OR fall back to a known floor from the LIBRARY.md (9 entries as of 2026-05-29).
  // Rationale: LIBRARY.md is a flat file not in the DB. We can't read the filesystem from
  // a Vercel serverless function. We use the video_library to count screen recording type rows,
  // and fall back to the known count from LIBRARY.md (9) if the table has no such rows.
  const { data: screenRows, ok: screenOk } = await supaFetch(
    `video_library?type=eq.screen_recording&select=id`,
  );
  let recordingsAvailable;
  if (screenOk && Array.isArray(screenRows) && screenRows.length > 0) {
    recordingsAvailable = screenRows.length;
  } else {
    // Fall back to known count from LIBRARY.md as of last audit (2026-05-29)
    recordingsAvailable = 9;
  }

  // Queue depth: draft + pending_video posts not yet published
  const { data: queueRows, ok: queueOk } = await supaFetch(
    `social_posts?status=in.(draft,pending_video)&select=id`,
  );
  const queueDepth = (queueOk && Array.isArray(queueRows)) ? queueRows.length : 0;

  return {
    videosReady,
    videoCounts,
    recordingsAvailable,
    queueDepth,
    materialLow: videosReady < 3 || recordingsAvailable < 2,
  };
}

// ─── TASK C: Performance analysis ────────────────────────────────────────────
// Pulls last 14 days of post_analytics and finds top platform/pillar/persona/format.

async function analyzePerformance() {
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data: rows, ok } = await supaFetch(
    `post_analytics?sync_date=gte.${cutoff}&engagement_score=gt.0&select=platform,persona,topic,engagement_score`,
  );

  if (!ok || !Array.isArray(rows) || rows.length === 0) {
    return {
      topPlatform: null,
      topPillar: null,
      topPersona: null,
      topFormat: null,
      rowsAnalyzed: 0,
    };
  }

  // Aggregate by platform, persona, and pillar (derived from topic)
  const byPlatform = {};
  const byPersona  = {};
  const byPillar   = {};

  for (const row of rows) {
    const score = Number(row.engagement_score || 0);
    const platform = row.platform || 'unknown';
    const persona  = row.persona  || 'unknown';
    const pillar   = TOPIC_TO_PILLAR[row.topic] || 'visibility';

    if (!byPlatform[platform]) byPlatform[platform] = { total: 0, count: 0 };
    byPlatform[platform].total += score;
    byPlatform[platform].count++;

    if (!byPersona[persona]) byPersona[persona] = { total: 0, count: 0 };
    byPersona[persona].total += score;
    byPersona[persona].count++;

    if (!byPillar[pillar]) byPillar[pillar] = { total: 0, count: 0 };
    byPillar[pillar].total += score;
    byPillar[pillar].count++;
  }

  const topOf = (map) => {
    let best = null;
    let bestAvg = -1;
    for (const [key, { total, count }] of Object.entries(map)) {
      if (count < 2) continue; // need at least 2 data points to trust
      const avg = total / count;
      if (avg > bestAvg) { bestAvg = avg; best = key; }
    }
    return best;
  };

  return {
    topPlatform: topOf(byPlatform),
    topPillar:   topOf(byPillar),
    topPersona:  topOf(byPersona),
    topFormat:   null, // format data not yet stored in post_analytics; placeholder for future
    rowsAnalyzed: rows.length,
    platformBreakdown: byPlatform,
    personaBreakdown:  byPersona,
    pillarBreakdown:   byPillar,
  };
}

// ─── TASK D: Intelligence brief via Claude Haiku ──────────────────────────────

async function generateIntelligenceBrief(analytics, inventory, trendBrief) {
  // Build a concise context for Haiku to reason about
  const analyticsBlock = analytics.rowsAnalyzed > 0
    ? [
        `Top-performing platform (last 14 days): ${analytics.topPlatform || 'insufficient data'}`,
        `Top-performing content pillar: ${analytics.topPillar || 'insufficient data'}`,
        `Top-performing persona: ${analytics.topPersona || 'insufficient data'}`,
        `Posts analyzed: ${analytics.rowsAnalyzed}`,
        `Platform breakdown (avg engagement score): ${
          Object.entries(analytics.platformBreakdown || {})
            .map(([k, v]) => `${k}=${v.count > 0 ? Math.round(v.total / v.count) : 0}`)
            .join(', ')
        }`,
      ].join('\n')
    : 'No analytics data yet (first week of operation). Default to evergreen TREC + cost-savings content.';

  const inventoryBlock = [
    `Videos ready to post (heath_approved): ${inventory.videosReady}`,
    `Screen recordings available: ${inventory.recordingsAvailable}`,
    `Posts in queue (draft + pending_video): ${inventory.queueDepth}`,
    `Material low warning: ${inventory.materialLow ? 'YES' : 'no'}`,
  ].join('\n');

  const trendBlock = trendBrief
    ? `Today's trend brief from Sage's trend scanner:\n${trendBrief}`
    : 'No trend brief available today. Use evergreen angles.';

  const prompt = `You are Sage, Head of Social Media for Dossie - a Texas SaaS tool that replaces real estate transaction coordinators. Your audience: Texas REALTORS, primarily female, 30-50 years old, mix of solo agents and team leads.

Content pillars in order of proven effectiveness:
1. Control - "you stay in the loop without doing the work" (strongest for high-volume agents)
2. Cost - "$400/file vs $29/month" (works for agents who've used TCs)
3. Visibility - "know exactly where every deal stands" (team leads + brokers)
4. Speed - "Dossie handles follow-ups so you don't have to" (part-timers)

ANALYTICS (last 14 days):
${analyticsBlock}

MATERIAL INVENTORY:
${inventoryBlock}

TREND DATA:
${trendBlock}

Given this data, write a concise intelligence brief for today's content generation run. In 3-4 sentences:
1. Which content angle should the generator prioritize today and why (cite the analytics if available)?
2. Which persona should be weighted higher today?
3. One specific content hook that is primed to perform based on the data.

Be specific. Reference actual numbers when available. No preamble or sign-off.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_HAIKU,
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn('[sage-intel] Anthropic error:', res.status, errText.slice(0, 200));
      return 'Intelligence brief unavailable. Default to Control pillar + Victor persona — historically strongest performers for Dossie.';
    }

    const body = await res.json();
    // Sonnet 5 extended thinking prepends `thinking` block; iterate all text blocks.
    const brief = ((body?.content || [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim());
    return brief || 'No brief generated.';
  } catch (err) {
    console.warn('[sage-intel] Anthropic fetch error:', err && err.message);
    return 'Intelligence brief unavailable due to API error. Default to evergreen TREC + Control pillar content.';
  }
}

// ─── TASK E: Low-material alert ───────────────────────────────────────────────

async function sendLowMaterialAlert(inventory, analytics) {
  if (!inventory.materialLow) return;
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('[sage-intel] TELEGRAM_BOT_TOKEN not set — skipping low-material alert');
    return;
  }

  // Build specific recording suggestions based on what's performing
  const topPillar = analytics.topPillar || 'control';
  const PILLAR_TO_FEATURE = {
    control:    'the pipeline dashboard showing all deadlines at once',
    cost:       'the founding pricing page at meetdossie.com/founding',
    visibility: 'the Morning Brief audio feature',
    speed:      'Talk to Dossie - the voice/text deal update feature',
  };
  const topFeature = PILLAR_TO_FEATURE[topPillar] || 'the pipeline dashboard';

  const suggestions = [
    `A 45-second recording of ${topFeature} - the "${topPillar}" pillar is your top performer right now.`,
    `A 30-second mobile recording of the dossier detail view showing deadline badges.`,
    `A 60-second desktop recording of the document upload and scan workflow.`,
  ];

  const alertText = [
    'Sage here - I am running low on video material.',
    '',
    `Videos ready to post: ${inventory.videosReady} (need 3+)`,
    `Screen recordings available: ${inventory.recordingsAvailable} (need 2+)`,
    '',
    'To keep posting strong this week, I need:',
    ...suggestions.map((s, i) => `${i + 1}. ${s}`),
    '',
    'Which of these can you record this week? Reply with the topic and I will generate the content brief.',
  ].join('\n');

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: alertText,
      }),
    });
    console.log('[sage-intel] low-material alert sent to Heath');
  } catch (err) {
    console.warn('[sage-intel] Telegram alert failed:', err && err.message);
  }
}

// ─── Fetch today's trend brief from sage_trend_briefs ────────────────────────

async function fetchTrendBrief() {
  const today = new Date().toISOString().slice(0, 10);
  const { data, ok } = await supaFetch(
    `sage_trend_briefs?brief_date=eq.${today}&select=trend_brief&limit=1`,
  );
  if (ok && Array.isArray(data) && data.length > 0) {
    return String(data[0].trend_brief || '').trim();
  }
  // Yesterday's brief is better than nothing
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const { data: d2, ok: ok2 } = await supaFetch(
    `sage_trend_briefs?brief_date=eq.${yesterday}&select=trend_brief&limit=1`,
  );
  if (ok2 && Array.isArray(d2) && d2.length > 0) {
    return String(d2[0].trend_brief || '').trim();
  }
  return null;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = withTelemetry('cron-sage-intelligence', async function handler(req, res) {
  // Auth: Vercel cron header OR Bearer token (for cron-job.org + manual trigger)
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });
  }

  const runStart = Date.now();
  console.log('[sage-intel] starting intelligence run at', new Date().toISOString());

  // ── A. Pull Zernio analytics ──────────────────────────────────────────────
  let analyticsResult = { totalFetched: 0, totalUpserted: 0, platformResults: [], zernioSkipped: false };

  if (!ZERNIO_API_KEY) {
    console.warn('[sage-intel] ZERNIO_API_KEY not set — skipping analytics pull');
    analyticsResult.zernioSkipped = true;
  } else {
    try {
      analyticsResult = await pullZernioAnalytics();
      console.log(`[sage-intel] Zernio: fetched ${analyticsResult.totalFetched}, upserted ${analyticsResult.totalUpserted}`);
    } catch (err) {
      console.error('[sage-intel] pullZernioAnalytics failed:', err && err.message);
      analyticsResult.error = err && err.message;
    }
  }

  // ── B. Scan material inventory ────────────────────────────────────────────
  let inventory = { videosReady: 0, recordingsAvailable: 9, queueDepth: 0, materialLow: false };
  try {
    inventory = await scanMaterialInventory();
    console.log(`[sage-intel] inventory: videos_ready=${inventory.videosReady} recordings=${inventory.recordingsAvailable} queue=${inventory.queueDepth} material_low=${inventory.materialLow}`);
  } catch (err) {
    console.error('[sage-intel] scanMaterialInventory failed:', err && err.message);
  }

  // ── C. Performance analysis ───────────────────────────────────────────────
  let analytics = { topPlatform: null, topPillar: null, topPersona: null, topFormat: null, rowsAnalyzed: 0 };
  try {
    analytics = await analyzePerformance();
    console.log(`[sage-intel] analysis: top_platform=${analytics.topPlatform} top_pillar=${analytics.topPillar} top_persona=${analytics.topPersona} rows=${analytics.rowsAnalyzed}`);
  } catch (err) {
    console.error('[sage-intel] analyzePerformance failed:', err && err.message);
  }

  // ── D. Trend brief ────────────────────────────────────────────────────────
  let trendBrief = null;
  try {
    trendBrief = await fetchTrendBrief();
    console.log(`[sage-intel] trend brief: ${trendBrief ? trendBrief.slice(0, 80) + '...' : 'none available'}`);
  } catch (err) {
    console.warn('[sage-intel] fetchTrendBrief failed:', err && err.message);
  }

  // Generate Haiku intelligence brief
  let dailyBrief = '';
  try {
    dailyBrief = await generateIntelligenceBrief(analytics, inventory, trendBrief);
    console.log(`[sage-intel] daily brief generated: ${dailyBrief.slice(0, 100)}...`);
  } catch (err) {
    console.error('[sage-intel] generateIntelligenceBrief failed:', err && err.message);
    dailyBrief = 'Brief generation failed. Default to Control pillar and Victor persona.';
  }

  // Build trending_topics JSONB from analysis data
  const trendingTopics = {
    platform_breakdown: analytics.platformBreakdown || {},
    persona_breakdown:  analytics.personaBreakdown  || {},
    pillar_breakdown:   analytics.pillarBreakdown    || {},
    trend_brief:        trendBrief,
    zernio_pull:        analyticsResult.platformResults || [],
  };

  // ── Write sage_intelligence row ───────────────────────────────────────────
  const intelligenceRow = {
    created_at:           new Date().toISOString(),
    top_platform:         analytics.topPlatform,
    top_pillar:           analytics.topPillar,
    top_persona:          analytics.topPersona,
    top_format:           analytics.topFormat,
    videos_ready:         inventory.videosReady,
    recordings_available: inventory.recordingsAvailable,
    queue_depth:          inventory.queueDepth,
    material_low:         inventory.materialLow,
    trending_topics:      trendingTopics,
    daily_brief:          dailyBrief,
  };

  const insertRes = await supaFetch(`sage_intelligence`, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(intelligenceRow),
  });

  if (!insertRes.ok) {
    console.error('[sage-intel] sage_intelligence insert failed:', insertRes.status, JSON.stringify(insertRes.data).slice(0, 200));
  } else {
    const row = Array.isArray(insertRes.data) ? insertRes.data[0] : insertRes.data;
    console.log(`[sage-intel] sage_intelligence row inserted: id=${row?.id}`);
  }

  // ── E. Low-material alert ─────────────────────────────────────────────────
  try {
    await sendLowMaterialAlert(inventory, analytics);
  } catch (err) {
    console.warn('[sage-intel] sendLowMaterialAlert failed:', err && err.message);
  }

  const runMs = Date.now() - runStart;
  console.log(`[sage-intel] complete in ${runMs}ms`);

  return res.status(200).json({
    ok: true,
    run_ms: runMs,
    analytics: {
      zernio_fetched: analyticsResult.totalFetched,
      zernio_upserted: analyticsResult.totalUpserted,
      zernio_skipped: analyticsResult.zernioSkipped || false,
      platform_results: analyticsResult.platformResults,
    },
    inventory: {
      videos_ready: inventory.videosReady,
      recordings_available: inventory.recordingsAvailable,
      queue_depth: inventory.queueDepth,
      material_low: inventory.materialLow,
    },
    performance: {
      top_platform: analytics.topPlatform,
      top_pillar:   analytics.topPillar,
      top_persona:  analytics.topPersona,
      rows_analyzed: analytics.rowsAnalyzed,
    },
    daily_brief: dailyBrief,
    material_low_alert_sent: inventory.materialLow && !!TELEGRAM_BOT_TOKEN,
  });
});
