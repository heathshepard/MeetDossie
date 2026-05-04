// Vercel Serverless Function: /api/notify-sales-lead
// Sends a Telegram notification to TELEGRAM_CHAT_ID for a freshly inserted
// sales_leads row. The browser POSTs the lead's email; the server looks up
// the most recent matching row (within RECENT_WINDOW_MS) via the service
// role and uses the DB's authoritative content for the message — so a
// caller cannot spoof message bodies, and a Telegram ping cannot fire
// without a corresponding DB row actually existing.
//
// POST { email }   (no auth — public from the marketing site, CORS-restricted)
//
// Why email not id: the browser inserts with Prefer: return=minimal because
// the RLS policy on sales_leads grants anon INSERT only (no SELECT), so
// return=representation cannot read the inserted id back. Looking up by
// email + recency is the next-best correlation key.
//
// Environment:
//   SUPABASE_URL              — Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY — service-role JWT (server-side only)
//   TELEGRAM_BOT_TOKEN        — bot token
//   TELEGRAM_CHAT_ID          — chat id to deliver the notification to

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const VERCEL_PREVIEW_ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// How recent the matching row must be to fire a notification. Generous so a
// slow client that POSTs notify a few seconds after insert still hits.
const RECENT_WINDOW_MS = 5 * 60 * 1000;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  let allowOrigin = null;
  if (typeof origin === 'string' && origin.length > 0) {
    if (
      ALLOWED_ORIGINS.has(origin) ||
      LOCALHOST_ORIGIN_RE.test(origin) ||
      VERCEL_PREVIEW_ORIGIN_RE.test(origin)
    ) {
      allowOrigin = origin;
    }
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  return Boolean(allowOrigin) || !origin;
}

function escTelegram(s) {
  // We send with parse_mode="HTML"; Telegram requires &, <, > to be escaped.
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatNumber(n) {
  if (n == null || n === '') return '—';
  const x = Number(n);
  if (!Number.isFinite(x)) return '—';
  return String(x);
}

function buildMessage(lead) {
  const lines = [
    '🆕 <b>New Sales Lead</b>',
    '',
    `<b>Name:</b> ${escTelegram(lead.name)}`,
    `<b>Email:</b> ${escTelegram(lead.email)}`,
  ];
  if (lead.brokerage) lines.push(`<b>Brokerage:</b> ${escTelegram(lead.brokerage)}`);
  if (lead.agent_count != null) lines.push(`<b>Agents:</b> ${escTelegram(formatNumber(lead.agent_count))}`);
  if (lead.monthly_transactions != null) lines.push(`<b>Monthly transactions:</b> ${escTelegram(formatNumber(lead.monthly_transactions))}`);
  if (lead.source_page) lines.push(`<b>Source:</b> /${escTelegram(lead.source_page)}`);
  if (lead.message) {
    lines.push('');
    lines.push('<b>Looking for:</b>');
    lines.push(escTelegram(lead.message));
  }
  lines.push('');
  lines.push(`<i>Lead id: ${escTelegram(lead.id)}</i>`);
  return lines.join('\n');
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (!corsAllowed) return res.status(403).json({ ok: false, error: 'Origin not allowed.' });

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Server not configured (supabase).' });
  }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    // Don't fail the user-facing flow if Telegram is unconfigured — log and
    // return ok so the success state still renders. Heath can pull from DB.
    console.warn('[notify-sales-lead] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — skipping notification.');
    return res.status(200).json({ ok: true, skipped: true, reason: 'telegram not configured' });
  }

  const body = req.body || {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 320) {
    return res.status(400).json({ ok: false, error: 'Invalid email.' });
  }

  // Look up the most recent row matching that email. Service role bypasses
  // RLS. We require the row to be within RECENT_WINDOW_MS so an attacker
  // can't trigger a re-notify for any old row by guessing emails.
  const sinceIso = new Date(Date.now() - RECENT_WINDOW_MS).toISOString();
  let lead;
  try {
    const url =
      `${SUPABASE_URL}/rest/v1/sales_leads` +
      `?email=eq.${encodeURIComponent(email)}` +
      `&created_at=gte.${encodeURIComponent(sinceIso)}` +
      `&select=*&order=created_at.desc&limit=1`;
    const r = await fetch(url, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error('[notify-sales-lead] supabase lookup failed', r.status, text.slice(0, 300));
      return res.status(502).json({ ok: false, error: 'Lead lookup failed.' });
    }
    const rows = await r.json().catch(() => []);
    lead = Array.isArray(rows) ? rows[0] : null;
  } catch (err) {
    console.error('[notify-sales-lead] supabase fetch threw', err && err.message);
    return res.status(502).json({ ok: false, error: 'Lead lookup failed.' });
  }

  if (!lead || !lead.id) {
    return res.status(404).json({ ok: false, error: 'No recent lead matches that email.' });
  }

  const text = buildMessage(lead);

  try {
    const tg = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const tgText = await tg.text();
    let tgData = null;
    try { tgData = tgText ? JSON.parse(tgText) : null; } catch { tgData = null; }
    if (!tg.ok || tgData?.ok !== true) {
      console.error('[notify-sales-lead] telegram send failed', tg.status, tgText.slice(0, 300));
      return res.status(502).json({ ok: false, error: 'Notification failed.' });
    }
    return res.status(200).json({ ok: true, message_id: tgData.result?.message_id || null });
  } catch (err) {
    console.error('[notify-sales-lead] telegram threw', err && err.message);
    return res.status(502).json({ ok: false, error: 'Notification failed.' });
  }
};
