/**
 * Webpage Analytics Snapshot API — full dashboard payload.
 *
 * Auth: any logged-in Supabase user (Bearer <access_token>).
 * Data source: PostHog Query API via HogQL, project 500233 (US Cloud).
 *
 * Response cache: 5 minutes at the CDN (s-maxage=300) so refreshing the
 * dashboard doesn't hammer PostHog's rate limit.
 *
 * Payload sections:
 *   summary_7d          — total_pageviews, unique_visitors, avg_session_seconds,
 *                         bounce_rate_pct, top_source
 *   traffic_by_page     — top 20 pages by pageviews (path, pageviews, uniques)
 *   traffic_by_source   — top sources with founding conversion count
 *   geography           — top 10 countries by unique visitors
 *   founding_funnel     — 3-step funnel: homepage → /founding → founding submit
 *   daily_traffic       — 30-day pageview timeseries
 *
 * Every section returns gracefully with an empty array when data is sparse.
 */

import { createClient } from '@supabase/supabase-js';
const { runHogQL } = require('./_lib/posthog-query.js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized - no token' });
  }
  const token = authHeader.replace('Bearer ', '');
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Unauthorized - invalid token' });

    // Cache the whole payload for 5 minutes at the CDN.
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

    // Fire all queries in parallel.
    const [
      summary,
      pages,
      sources,
      geography,
      funnel,
      daily,
    ] = await Promise.all([
      querySummary7d(),
      queryTrafficByPage(),
      queryTrafficBySource(),
      queryGeography(),
      queryFoundingFunnel(),
      queryDailyTraffic(),
    ]);

    return res.status(200).json({
      ok: true,
      generated_at: new Date().toISOString(),
      summary_7d: summary,
      traffic_by_page: pages,
      traffic_by_source: sources,
      geography,
      founding_funnel: funnel,
      daily_traffic: daily,
    });
  } catch (err) {
    console.error('[webpage-analytics-snapshot] error:', err && err.message);
    return res.status(500).json({ error: 'Failed to build analytics snapshot', detail: String(err && err.message || err) });
  }
}

/**
 * 7-day rollup: total pageviews, unique visitors, avg session duration,
 * bounce rate, top traffic source.
 */
async function querySummary7d() {
  // Totals + unique visitors.
  const totals = await runHogQL(`
    SELECT
      countIf(event = '$pageview') AS pageviews,
      count(DISTINCT distinct_id) AS uniques
    FROM events
    WHERE timestamp >= now() - INTERVAL 7 DAY
  `);

  // Avg session duration + bounce rate from $session.
  // A "bounce" = session with exactly 1 pageview.
  const sessions = await runHogQL(`
    SELECT
      avg(dateDiff('second', session_start, session_end)) AS avg_session_seconds,
      countIf(pageview_count = 1) AS bounce_sessions,
      count() AS total_sessions
    FROM (
      SELECT
        $session_id AS sid,
        min(timestamp) AS session_start,
        max(timestamp) AS session_end,
        countIf(event = '$pageview') AS pageview_count
      FROM events
      WHERE timestamp >= now() - INTERVAL 7 DAY
        AND $session_id IS NOT NULL
        AND $session_id != ''
      GROUP BY $session_id
    )
  `);

  // Top source: prefer utm_source, fall back to referring_domain.
  const topSource = await runHogQL(`
    SELECT
      coalesce(nullIf(properties.utm_source, ''), nullIf(properties.$referring_domain, ''), 'direct') AS source,
      count() AS hits
    FROM events
    WHERE event = '$pageview'
      AND timestamp >= now() - INTERVAL 7 DAY
    GROUP BY source
    ORDER BY hits DESC
    LIMIT 1
  `);

  const pageviews = totals.ok && totals.results[0] ? Number(totals.results[0][0]) || 0 : 0;
  const uniques = totals.ok && totals.results[0] ? Number(totals.results[0][1]) || 0 : 0;
  const avgSec = sessions.ok && sessions.results[0] ? Number(sessions.results[0][0]) || 0 : 0;
  const bounces = sessions.ok && sessions.results[0] ? Number(sessions.results[0][1]) || 0 : 0;
  const totalSess = sessions.ok && sessions.results[0] ? Number(sessions.results[0][2]) || 0 : 0;
  const bounceRate = totalSess > 0 ? Math.round((bounces / totalSess) * 100) : 0;
  const top = topSource.ok && topSource.results[0] ? String(topSource.results[0][0] || 'direct') : '—';

  return {
    total_pageviews: pageviews,
    unique_visitors: uniques,
    avg_session_seconds: Math.round(avgSec),
    bounce_rate_pct: bounceRate,
    top_source: top,
  };
}

/**
 * Traffic by page — top 20 paths in the last 7 days.
 */
async function queryTrafficByPage() {
  const r = await runHogQL(`
    SELECT
      properties.$pathname AS path,
      count() AS pageviews,
      count(DISTINCT distinct_id) AS uniques,
      avg(nullIf(properties.$prev_pageview_duration, 0)) AS avg_time_on_page
    FROM events
    WHERE event = '$pageview'
      AND timestamp >= now() - INTERVAL 7 DAY
      AND properties.$pathname IS NOT NULL
    GROUP BY properties.$pathname
    ORDER BY pageviews DESC
    LIMIT 20
  `);
  if (!r.ok) return [];
  return r.results.map(row => ({
    path: String(row[0] || '/'),
    pageviews: Number(row[1]) || 0,
    unique_visitors: Number(row[2]) || 0,
    avg_time_on_page_seconds: Math.round(Number(row[3]) || 0),
  }));
}

/**
 * Traffic by source — utm_source or referring domain, plus a conversion
 * count = sessions that hit /founding.
 */
async function queryTrafficBySource() {
  const r = await runHogQL(`
    SELECT
      coalesce(nullIf(properties.utm_source, ''), nullIf(properties.$referring_domain, ''), 'direct') AS source,
      count(DISTINCT $session_id) AS sessions,
      count(DISTINCT if(properties.$pathname = '/founding', $session_id, NULL)) AS founding_sessions
    FROM events
    WHERE event = '$pageview'
      AND timestamp >= now() - INTERVAL 7 DAY
    GROUP BY source
    ORDER BY sessions DESC
    LIMIT 15
  `);
  if (!r.ok) return [];
  return r.results.map(row => {
    const sessions = Number(row[1]) || 0;
    const founding = Number(row[2]) || 0;
    return {
      source: String(row[0] || 'direct'),
      sessions,
      founding_sessions: founding,
      founding_conversion_pct: sessions > 0 ? Math.round((founding / sessions) * 1000) / 10 : 0,
    };
  });
}

/**
 * Geography — top 10 countries by unique visitors in the last 7 days.
 * PostHog auto-captures $geoip_country_name.
 */
async function queryGeography() {
  const r = await runHogQL(`
    SELECT
      coalesce(nullIf(properties.$geoip_country_name, ''), 'Unknown') AS country,
      count(DISTINCT distinct_id) AS uniques
    FROM events
    WHERE event = '$pageview'
      AND timestamp >= now() - INTERVAL 7 DAY
    GROUP BY country
    ORDER BY uniques DESC
    LIMIT 10
  `);
  if (!r.ok) return [];
  return r.results.map(row => ({
    country: String(row[0] || 'Unknown'),
    unique_visitors: Number(row[1]) || 0,
  }));
}

/**
 * Founding page funnel:
 *   Step 1: any pageview (top of funnel)
 *   Step 2: /founding pageview
 *   Step 3: founding_join_clicked event (from the /founding form CTA)
 *
 * We count sessions at each step. Drop-off = 1 - (step_n / step_n-1).
 */
async function queryFoundingFunnel() {
  const r = await runHogQL(`
    SELECT
      count(DISTINCT $session_id) AS sessions_any,
      count(DISTINCT if(properties.$pathname = '/founding' OR properties.$pathname = '/founding.html', $session_id, NULL)) AS sessions_founding,
      count(DISTINCT if(event = 'founding_join_clicked', $session_id, NULL)) AS sessions_join
    FROM events
    WHERE timestamp >= now() - INTERVAL 7 DAY
  `);
  if (!r.ok || !r.results[0]) {
    return [
      { step: 'Site visit', sessions: 0, dropoff_from_prev_pct: 0 },
      { step: '/founding view', sessions: 0, dropoff_from_prev_pct: 0 },
      { step: 'Join clicked', sessions: 0, dropoff_from_prev_pct: 0 },
    ];
  }
  const [any, founding, join] = r.results[0].map(v => Number(v) || 0);
  return [
    { step: 'Site visit', sessions: any, dropoff_from_prev_pct: 0 },
    {
      step: '/founding view',
      sessions: founding,
      dropoff_from_prev_pct: any > 0 ? Math.round((1 - founding / any) * 1000) / 10 : 0,
    },
    {
      step: 'Join clicked',
      sessions: join,
      dropoff_from_prev_pct: founding > 0 ? Math.round((1 - join / founding) * 1000) / 10 : 0,
    },
  ];
}

/**
 * Daily traffic for the last 30 days — used to render the SVG line chart.
 */
async function queryDailyTraffic() {
  const r = await runHogQL(`
    SELECT
      toDate(timestamp) AS day,
      count() AS pageviews,
      count(DISTINCT distinct_id) AS uniques
    FROM events
    WHERE event = '$pageview'
      AND timestamp >= now() - INTERVAL 30 DAY
    GROUP BY day
    ORDER BY day ASC
  `);
  if (!r.ok) return [];
  return r.results.map(row => ({
    date: String(row[0]),
    pageviews: Number(row[1]) || 0,
    unique_visitors: Number(row[2]) || 0,
  }));
}
