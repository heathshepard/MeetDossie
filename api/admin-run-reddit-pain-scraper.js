// One-off/manual trigger: runs scripts/reddit-pain-scraper.js's scrapeAll()
// from Vercel's egress instead of a local machine. Built 2026-08-18 because
// this sandbox's outbound IP got rate-limited/blocked by Reddit (403/429 on
// every subreddit, even via a fresh Chromium — an IP-level block, not a
// code bug) right after an initial clean run had already proven the scraper
// works (16 real matches). Vercel's egress IP is a different route to the
// same result — cron-reddit-scanner.js already hits reddit.com successfully
// from this same Vercel project, so this is worth trying before reaching for
// ZenRows (also provisioned, but costs credits and is really meant for
// harder JS-rendered/authenticated targets).
//
// GET/POST /api/admin-run-reddit-pain-scraper
//   Authorization: Bearer ${CRON_SECRET}
//
// For future scheduling: promote this to a real vercel.json cron once a
// cadence is picked (daily is plenty — pain-language on these subs doesn't
// churn hour to hour).

const { scrapeAll, upsertToSupabase, buildRedditPainBlock } = require('../scripts/reddit-pain-scraper');

const CRON_SECRET = process.env.CRON_SECRET;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  // ?probe=1 — single fast no-retry fetch against r/realtors/new.rss to check
  // whether Vercel's egress IP is blocked by Reddit at all, before spending
  // the full multi-subreddit + backoff run against the 60s function budget.
  if (req.query && req.query.probe === '1') {
    try {
      const r = await fetch('https://www.reddit.com/r/realtors/new.rss?limit=5', {
        headers: { 'Accept': 'application/rss+xml, application/xml, text/xml', 'User-Agent': USER_AGENT },
      });
      const text = await r.text();
      return res.status(200).json({ ok: true, probe: true, status: r.status, body_head: text.slice(0, 300) });
    } catch (err) {
      return res.status(200).json({ ok: false, probe: true, error: err && err.message });
    }
  }

  const logs = [];
  const log = (...args) => { logs.push(args.join(' ')); console.log(...args); };
  const warn = (...args) => { logs.push('[warn] ' + args.join(' ')); console.warn(...args); };

  try {
    const { deduped, scanStats } = await scrapeAll({ log, warn });
    const dryRun = req.query && req.query.dry_run === '1';
    let upsert = { attempted: 0, ok: 0 };
    if (!dryRun) {
      upsert = await upsertToSupabase(deduped);
    }
    return res.status(200).json({
      ok: true,
      scan_stats: scanStats,
      matched_count: deduped.length,
      top_5: deduped.slice(0, 5).map((r) => ({ subreddit: r.subreddit, title: r.title, rank_score: r.rankScore, categories: r.categories })),
      content_fuel_preview: buildRedditPainBlock(deduped, 5),
      upsert,
      logs,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err && err.message, logs });
  }
};
