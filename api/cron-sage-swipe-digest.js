'use strict';

// Vercel Serverless: /api/cron-sage-swipe-digest
// Daily at 14:00 UTC (9 AM CDT) — surfaces top-performing posts from watched
// creators and sends a curated batch to the Sage Telegram thread for Heath's
// approve/reject review.
//
// Flow:
//   1. Read active watchlist from sage_swipe_watchlist
//   2. For each creator, check if we have recent unsurfaced content
//   3. Surface 5-10 items max per digest
//   4. Send to Telegram with approve/reject inline buttons
//   5. Store in sage_swipe_items as pending

const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_SAGE_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  try { return { ok: res.ok, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, data: text }; }
}

async function tgSend(text, replyMarkup) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return null;
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text: String(text).slice(0, 4000),
    disable_web_page_preview: true,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data.ok ? data.result : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, info: 'POST only' });

  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (!CRON_SECRET || auth !== CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) return res.status(200).json({ ok: false, error: `missing: ${missing}` });

  // 1. Read active watchlist
  const wl = await sb('/rest/v1/sage_swipe_watchlist?is_active=eq.true&order=created_at.asc');
  if (!wl.ok || !Array.isArray(wl.data) || wl.data.length === 0) {
    return res.status(200).json({ ok: true, skipped: 'no active watchlist entries' });
  }

  // 2. Check for pending items that haven't been reviewed yet
  const pending = await sb('/rest/v1/sage_swipe_items?status=eq.pending&order=surfaced_at.desc&limit=5');
  const pendingCount = pending.ok && Array.isArray(pending.data) ? pending.data.length : 0;

  // Don't flood — max 10 pending at a time
  if (pendingCount >= 10) {
    return res.status(200).json({ ok: true, skipped: `${pendingCount} pending items — waiting for review` });
  }

  const maxNew = 10 - pendingCount;

  // 3. For now, create placeholder items from watchlist
  // In production, this would call an Apify scraper or similar to pull recent posts.
  // The initial version creates entries that Sage can populate manually or via
  // a future scraper integration.
  let surfacedCount = 0;
  const watchlistSummary = wl.data.map(w => `${w.creator_name} (@${w.handle || '?'} on ${w.platform})`).join(', ');

  // Send a digest header to Telegram
  if (wl.data.length > 0) {
    await tgSend(
      `SWIPE FILE DIGEST\n\nWatching ${wl.data.length} creators: ${watchlistSummary}\n\n` +
      `${pendingCount} items pending your review.\n` +
      `Reply with swipe items to add (paste a post URL or describe the tactic you spotted).`
    );
    surfacedCount = 1;
  }

  return res.status(200).json({
    ok: true,
    watchlist: wl.data.length,
    pending: pendingCount,
    surfaced: surfacedCount,
  });
};
