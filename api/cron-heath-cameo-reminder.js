'use strict';

// api/cron-heath-cameo-reminder.js
// =============================================================================
// Friday 8am CDT (13 UTC). Aggregates any pending social_posts where
// requires_heath_voice=true and heath_voice_recorded_at is null. Sends ONE
// consolidated Telegram message to Heath with preview links.
//
// Schedule: "0 13 * * 5"
// Owner: Atlas 2026-07-08.
// =============================================================================

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sb(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function telegramSend(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { ok: false, err: 'no_bot' };
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  return { ok: r.ok, status: r.status };
}

async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  const cameoR = await sb(
    `social_posts?select=id,platform,persona,hook,voiceover_script,scheduled_for&requires_heath_voice=eq.true&heath_voice_recorded_at=is.null&status=in.(draft,pending_approval,approved)&order=scheduled_for.asc.nullsfirst&limit=25`
  );
  if (!cameoR.ok) {
    return res.status(500).json({ ok: false, error: `query_failed:${cameoR.status}` });
  }
  const rows = Array.isArray(cameoR.data) ? cameoR.data : [];

  if (rows.length === 0) {
    return res.status(200).json({ ok: true, cameo_count: 0, notified: false });
  }

  const lines = [
    `<b>Heath voice needed — ${rows.length} post${rows.length === 1 ? '' : 's'} this week</b>`,
    '',
  ];
  for (const r of rows.slice(0, 10)) {
    const when = r.scheduled_for ? new Date(r.scheduled_for).toISOString().slice(0, 10) : 'TBD';
    lines.push(`• <b>${r.platform}</b> ${when} — "${(r.hook || '').slice(0, 60)}"`);
    if (r.voiceover_script) {
      lines.push(`  VO: ${r.voiceover_script.slice(0, 140)}${r.voiceover_script.length > 140 ? '…' : ''}`);
    }
  }
  if (rows.length > 10) lines.push(`… and ${rows.length - 10} more`);
  lines.push('');
  lines.push('Reply DONE with your recordings and Sage attaches them.');

  const tg = await telegramSend(lines.join('\n'));

  return res.status(200).json({
    ok: true,
    cameo_count: rows.length,
    notified: tg.ok,
    telegram_status: tg.status,
  });
}

module.exports = withTelemetry('cron-heath-cameo-reminder', handler);
