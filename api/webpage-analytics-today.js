/**
 * Webpage Analytics — TODAY endpoint (Jarvis panel top-line card).
 *
 * Returns 4 numbers only:
 *   pageviews_today          — total $pageview since UTC midnight
 *   pageviews_yesterday      — same window one day earlier (for delta)
 *   unique_visitors_today
 *   top_source_today         — utm_source or referring domain
 *   founding_pageviews_today — $pageview on /founding (proxy for "clicks")
 *
 * Fast: one round-trip to PostHog. Cached 60s at the CDN.
 * Auth: any logged-in Supabase user.
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

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=180');

    // Single HogQL round-trip: today's totals + yesterday's pageviews.
    const q = await runHogQL(`
      SELECT
        countIf(event = '$pageview' AND toDate(timestamp) = today()) AS pv_today,
        countIf(event = '$pageview' AND toDate(timestamp) = today() - 1) AS pv_yesterday,
        count(DISTINCT if(toDate(timestamp) = today(), distinct_id, NULL)) AS uniques_today,
        countIf(event = '$pageview' AND toDate(timestamp) = today()
                AND (properties.$pathname = '/founding' OR properties.$pathname = '/founding.html')) AS founding_today
      FROM events
      WHERE timestamp >= today() - 1
    `);

    // Top source today — separate quick query, cheap.
    const src = await runHogQL(`
      SELECT
        coalesce(nullIf(properties.utm_source, ''), nullIf(properties.$referring_domain, ''), 'direct') AS source,
        count() AS hits
      FROM events
      WHERE event = '$pageview'
        AND toDate(timestamp) = today()
      GROUP BY source
      ORDER BY hits DESC
      LIMIT 1
    `);

    const row = q.ok && q.results[0] ? q.results[0] : [0, 0, 0, 0];
    const pvToday = Number(row[0]) || 0;
    const pvYesterday = Number(row[1]) || 0;
    const uniques = Number(row[2]) || 0;
    const foundingToday = Number(row[3]) || 0;
    const topSource = src.ok && src.results[0] ? String(src.results[0][0] || 'direct') : '—';

    // Delta vs yesterday. If yesterday = 0, delta is null (frontend shows "—").
    const delta = pvYesterday > 0
      ? Math.round(((pvToday - pvYesterday) / pvYesterday) * 100)
      : null;

    return res.status(200).json({
      ok: true,
      generated_at: new Date().toISOString(),
      pageviews_today: pvToday,
      pageviews_yesterday: pvYesterday,
      delta_pct_vs_yesterday: delta,
      unique_visitors_today: uniques,
      top_source_today: topSource,
      founding_pageviews_today: foundingToday,
    });
  } catch (err) {
    console.error('[webpage-analytics-today] error:', err && err.message);
    return res.status(500).json({ error: 'Failed to fetch today analytics', detail: String(err && err.message || err) });
  }
}
