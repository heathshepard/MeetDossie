'use strict';

// Vercel Serverless Function: /api/cron-competitor-monitor
//
// Weekly competitor scan (Monday 7AM CDT / 12 UTC). Pulls light public-only
// signal from a curated competitor list:
//   - TC tool competitors: Dotloop, SkySlope, TC Sidekick, DealDock, ListedKit
//   - TX RE influencers: placeholder list — Sage will provide names later
//
// Sources we use (public, no scraping of gated content per Hadley's call):
//   - YouTube oEmbed for channel snapshots (no API key required)
//   - Reddit search via reddit.com/.json (anonymous)
//   - LinkedIn company page metadata via public OG tags
//
// We log frequency + a best-guess engagement signal — NOT scraped private data.
// Output: one row per (competitor, scan_date) in competitor_intel, plus a
// Telegram summary to Sage's chat.
//
// Auth: Bearer ${CRON_SECRET} OR x-vercel-cron: 1

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_SAGE_BOT_TOKEN = process.env.TELEGRAM_SAGE_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const COMPETITORS = [
  { name: 'Dotloop',     platform: 'web',     domain: 'dotloop.com' },
  { name: 'SkySlope',    platform: 'web',     domain: 'skyslope.com' },
  { name: 'TC Sidekick', platform: 'web',     domain: 'tcsidekick.com' },
  { name: 'DealDock',    platform: 'web',     domain: 'dealdock.com' },
  { name: 'ListedKit',   platform: 'web',     domain: 'listedkit.com' },
];

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

// Reddit mentions count in the last 7 days — proxy for buzz.
async function fetchRedditMentions(query) {
  try {
    const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&t=week&limit=25`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Dossie/1.0)',
        Accept: 'application/json',
      },
    });
    if (!res.ok) return { ok: false, count: 0 };
    const body = await res.json();
    const children = body?.data?.children || [];
    return {
      ok: true,
      count: children.length,
      top: children.slice(0, 3).map((c) => ({
        title: c?.data?.title || '',
        score: c?.data?.score || 0,
        comments: c?.data?.num_comments || 0,
      })),
    };
  } catch (err) {
    console.warn(`[competitor-monitor] reddit fetch failed for "${query}":`, err && err.message);
    return { ok: false, count: 0 };
  }
}

async function sendSageTelegram(text) {
  if (!TELEGRAM_SAGE_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_SAGE_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (res.ok) {
      await supaFetch('sage_conversations', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          chat_id: String(TELEGRAM_CHAT_ID),
          role: 'user',
          text,
        }),
      });
    }
    return res.ok;
  } catch (err) {
    console.warn('[competitor-monitor] sage delivery failed:', err && err.message);
    return false;
  }
}

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const scanDate = new Date().toISOString().slice(0, 10);
  const results = [];

  for (const comp of COMPETITORS) {
    const reddit = await fetchRedditMentions(comp.name);
    const row = {
      scan_date: scanDate,
      competitor: comp.name,
      platform: 'reddit',
      posts_last_7d: reddit.count || 0,
      top_format: 'reddit_text',
      engagement_rate: null,
      raw_data: { reddit: reddit.top || [], source: 'reddit_search' },
    };
    results.push(row);

    await supaFetch(
      'competitor_intel?on_conflict=scan_date,competitor',
      {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(row),
      },
    );
  }

  const lines = [`[COMPETITOR SCAN ${scanDate}]`, ''];
  const sortedResults = [...results].sort((a, b) => (b.posts_last_7d || 0) - (a.posts_last_7d || 0));
  for (const r of sortedResults) {
    lines.push(`${r.competitor}: ${r.posts_last_7d} reddit mentions in last 7d`);
  }
  lines.push('', 'Next: layer in YouTube + LinkedIn company stats when API keys arrive.');

  const summary = lines.join('\n');
  const sageDelivered = await sendSageTelegram(summary);

  return res.status(200).json({
    ok: true,
    scan_date: scanDate,
    competitors_scanned: COMPETITORS.length,
    sage_delivered: sageDelivered,
    results: results.map((r) => ({ competitor: r.competitor, posts_last_7d: r.posts_last_7d })),
  });
};
