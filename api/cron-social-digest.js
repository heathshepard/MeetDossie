// Vercel Serverless Function: /api/cron-social-digest
// Sends a daily Telegram digest of yesterday's social posting activity.
// Runs at 12:00 UTC (7AM CDT) every day via cron.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — 0 12 * * *

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

const PLATFORMS = ['facebook', 'instagram', 'twitter', 'linkedin', 'tiktok'];

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

module.exports = async function handler(req, res) {
  // Auth: accept Vercel's built-in cron header OR manual Bearer token.
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  if (!TELEGRAM_BOT_TOKEN) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'TELEGRAM_BOT_TOKEN not configured' });
  }

  // Query social_posts for the last 24 hours
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, ok } = await supabaseFetch(
    `/rest/v1/social_posts?select=platform,status&created_at=gte.${encodeURIComponent(since)}`,
  );

  if (!ok || !Array.isArray(data)) {
    console.error('[cron-social-digest] failed to query social_posts');
    return res.status(502).json({ ok: false, error: 'failed to query social_posts' });
  }

  // Tally by platform + status
  const tally = {};
  for (const plat of PLATFORMS) {
    tally[plat] = { posted: 0, approved: 0, draft: 0, rejected: 0, failed: 0, pending: 0 };
  }
  for (const row of data) {
    const p = row.platform;
    if (!tally[p]) continue;
    const s = row.status;
    if (s === 'posted') tally[p].posted++;
    else if (s === 'approved') tally[p].approved++;
    else if (s === 'draft') tally[p].draft++;
    else if (s === 'rejected') tally[p].rejected++;
    else if (s === 'failed') tally[p].failed++;
    else tally[p].pending++;
  }

  const today = new Date().toISOString().slice(0, 10);
  const lines = [`Daily social status - ${today} (last 24h)`, ''];

  for (const plat of PLATFORMS) {
    const t = tally[plat];
    const parts = [];
    if (t.posted) parts.push(`${t.posted} posted`);
    if (t.approved) parts.push(`${t.approved} approved`);
    if (t.draft) parts.push(`${t.draft} draft`);
    if (t.rejected) parts.push(`${t.rejected} rejected`);
    if (t.failed) parts.push(`${t.failed} failed`);
    if (t.pending) parts.push(`${t.pending} pending`);
    const summary = parts.length ? parts.join(', ') : 'no activity';
    lines.push(`${plat.charAt(0).toUpperCase() + plat.slice(1)}: ${summary}`);
  }

  // Add gap alerts if critical platforms have nothing published or queued
  const alerts = [];
  if (tally.linkedin.posted === 0 && tally.linkedin.approved === 0 && tally.linkedin.draft === 0) {
    alerts.push('WARNING: LinkedIn has nothing published or queued today');
  }
  if (tally.tiktok.posted === 0 && tally.tiktok.pending === 0 && tally.tiktok.pending_video === 0) {
    alerts.push('NOTE: TikTok has no activity (video pipeline needed)');
  }
  if (tally.instagram.failed > 0) {
    alerts.push(`WARNING: ${tally.instagram.failed} Instagram post(s) failed - check media_url`);
  }
  if (tally.twitter.failed > 0) {
    alerts.push(`WARNING: ${tally.twitter.failed} Twitter post(s) failed`);
  }
  if (alerts.length) {
    lines.push('');
    lines.push(...alerts);
  }

  const text = lines.join('\n');
  console.log('[cron-social-digest] sending digest:', text);

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
    const tgText = await tgRes.text();
    if (!tgRes.ok) {
      console.error('[cron-social-digest] Telegram send failed:', tgText);
      return res.status(200).json({ ok: false, error: 'Telegram send failed', detail: tgText.slice(0, 200) });
    }
  } catch (err) {
    console.error('[cron-social-digest] Telegram exception:', err && err.message);
    return res.status(200).json({ ok: false, error: err && err.message });
  }

  return res.status(200).json({
    ok: true,
    date: today,
    tally,
    alerts,
    rows_found: data.length,
  });
};
