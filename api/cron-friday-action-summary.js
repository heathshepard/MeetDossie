'use strict';

// api/cron-friday-action-summary.js
// =============================================================================
// Weekend Action List — Friday 5 PM CST (22:00 UTC).
//
// Reads heath_actions where status='pending', sorted by age DESC (stalest first).
// Sends ONE Telegram message listing the top 5 stalest items so Heath knows
// what's still hanging over the weekend and can prep to knock them out Monday.
//
// AUTH: Bearer ${CRON_SECRET} OR x-vercel-cron
// SCHEDULE: "0 22 * * 5"  (Fri 5 PM CST = 22 UTC)
// =============================================================================

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID          = process.env.TELEGRAM_CHAT_ID;

async function sb(pathAndQuery, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { ok: false, skipped: 'no_env' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text.slice(0, 4090),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    return { ok: r.ok };
  } catch (err) {
    console.error('[friday-summary] tg error:', err && err.message);
    return { ok: false };
  }
}

function daysAgo(iso) {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function isAuthorized(req) {
  if (req.headers['x-vercel-cron']) return true;
  const auth = req.headers.authorization || '';
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true;
  if (CRON_SECRET && req.query && req.query.secret === CRON_SECRET) return true;
  return false;
}

module.exports = async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase env not configured' });
  }

  // Test mode: dry-run flag skips actual Telegram send + returns the preview.
  const dryRun = String(req.query?.dryRun || '') === '1';

  // Pull pending actions ordered oldest-first so slice(0,5) = 5 stalest.
  // Skip anything that's actively snoozed into the future.
  const nowIso = new Date().toISOString();
  const r = await sb(
    'heath_actions?select=id,title,body,priority,created_at,snoozed_until'
    + '&status=eq.pending'
    + '&order=created_at.asc'
    + '&limit=200'
  );
  if (!r.ok) {
    return res.status(500).json({ ok: false, error: 'supabase_read_failed', status: r.status });
  }

  const all = (r.data || []).filter((a) => {
    if (!a.snoozed_until) return true;
    return new Date(a.snoozed_until).getTime() <= Date.now();
  });

  if (all.length === 0) {
    return res.status(200).json({ ok: true, skipped: 'no_pending' });
  }

  const top5 = all.slice(0, 5);
  const remainder = all.length - top5.length;

  const lines = ['<b>Weekend Action List — Top 5 Stalest</b>', ''];
  for (const a of top5) {
    const d = daysAgo(a.created_at);
    // Title may contain <, >, & — sanitize for HTML parse_mode.
    const title = String(a.title || '(untitled)').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&(?!lt;|gt;|amp;)/g, '&amp;').slice(0, 140);
    lines.push(`🔴 ${d}d — ${title}`);
  }
  lines.push('');
  if (remainder > 0) {
    lines.push(`(${remainder} more pending. Reply <code>list</code> for full set.)`);
  } else {
    lines.push('(No other pending items.)');
  }
  const messageText = lines.join('\n');

  if (dryRun) {
    return res.status(200).json({
      ok: true,
      dry_run: true,
      pending_total: all.length,
      preview: messageText,
      top5_titles: top5.map((a) => ({ id: a.id, days: daysAgo(a.created_at), title: a.title })),
    });
  }

  const tgRes = await tg(messageText);
  return res.status(200).json({
    ok: true,
    sent: tgRes.ok === true,
    pending_total: all.length,
    top5_count: top5.length,
    now: nowIso,
  });
};
