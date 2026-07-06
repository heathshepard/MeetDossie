'use strict';

// api/cron-stale-action-escalation.js
// =============================================================================
// Individual stale-item escalation — daily 10 AM CDT (15:00 UTC).
//
// Reads heath_actions where status='pending' AND age >= 7d AND
// (payload->last_escalated_at is null OR older than 3d).
// Sends ONE Telegram message per stale item (max 3 per run to avoid spam).
// After send, stamps payload.last_escalated_at = now() on the row.
//
// Heath can reply "kill <id>" / "doing <id>" / "snooze <id> 7d" — parsed in
// api/telegram-webhook.js.
//
// AUTH: Bearer ${CRON_SECRET} OR x-vercel-cron
// SCHEDULE: "0 15 * * *"  (10 AM CDT = 15 UTC)
// =============================================================================

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID          = process.env.TELEGRAM_CHAT_ID;

const MAX_PER_RUN               = 3;
const STALE_MS                  = 7 * 24 * 60 * 60 * 1000;
const RE_ESCALATE_MS            = 3 * 24 * 60 * 60 * 1000;

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
    console.error('[stale-escalation] tg error:', err && err.message);
    return { ok: false };
  }
}

function daysAgo(iso) {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function safeEsc(s) {
  return String(s || '')
    .replace(/&(?!lt;|gt;|amp;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

  const dryRun     = String(req.query?.dryRun || '') === '1';
  const forceId    = req.query?.forceId ? String(req.query.forceId) : null;   // test hook: escalate one specific row
  const nowMs      = Date.now();
  const staleCutoff = new Date(nowMs - STALE_MS).toISOString();

  // Pull candidates. We can't easily filter on payload->>last_escalated_at
  // freshness in one PostgREST query, so we grab all stale pending rows and
  // apply the re-escalate window in-app.
  let query = 'heath_actions?select=id,title,body,priority,created_at,snoozed_until,payload'
    + '&status=eq.pending'
    + `&created_at=lt.${encodeURIComponent(staleCutoff)}`
    + '&order=created_at.asc'
    + '&limit=100';
  if (forceId) {
    // Override: bypass staleness + escalation window for test row.
    query = `heath_actions?select=id,title,body,priority,created_at,snoozed_until,payload&id=eq.${encodeURIComponent(forceId)}&limit=1`;
  }

  const r = await sb(query);
  if (!r.ok) {
    return res.status(500).json({ ok: false, error: 'supabase_read_failed', status: r.status });
  }

  const candidates = (r.data || []).filter((a) => {
    // Skip active snoozes
    if (a.snoozed_until && new Date(a.snoozed_until).getTime() > nowMs) return false;
    if (forceId) return true;
    // Skip if escalated within RE_ESCALATE_MS
    const last = a.payload && a.payload.last_escalated_at ? new Date(a.payload.last_escalated_at).getTime() : 0;
    if (last && (nowMs - last) < RE_ESCALATE_MS) return false;
    return true;
  });

  // Take up to MAX_PER_RUN (or 1 if forceId).
  const cap = forceId ? 1 : MAX_PER_RUN;
  const toEscalate = candidates.slice(0, cap);

  if (toEscalate.length === 0) {
    return res.status(200).json({ ok: true, escalated: 0, skipped: 'no_eligible', candidate_count: candidates.length });
  }

  const results = [];
  for (const a of toEscalate) {
    const d = daysAgo(a.created_at);
    const title = safeEsc(a.title || '(untitled)').slice(0, 200);
    const idShort = String(a.id).slice(0, 8);
    const bodyLine = a.body ? `\n<i>${safeEsc(a.body).slice(0, 180)}</i>` : '';
    const text =
      `<b>STALE ${d}d — ${title}</b>${bodyLine}\n\n`
      + `Reply: <code>kill ${idShort}</code> / <code>doing ${idShort}</code> / <code>snooze ${idShort} 7d</code>`;

    let tgOk = false;
    let stampOk = false;

    if (!dryRun) {
      const tgRes = await tg(text);
      tgOk = tgRes.ok === true;

      // Stamp payload.last_escalated_at = now(). Merge into existing payload
      // to avoid clobbering other keys.
      if (tgOk) {
        const nextPayload = Object.assign({}, a.payload || {}, {
          last_escalated_at: new Date().toISOString(),
        });
        const upd = await sb(`heath_actions?id=eq.${encodeURIComponent(a.id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ payload: nextPayload }),
        });
        stampOk = upd.ok;
      }
    }

    results.push({
      id: a.id,
      id_short: idShort,
      days: d,
      title: a.title,
      preview: text,
      sent: tgOk,
      stamped: stampOk,
    });
  }

  return res.status(200).json({
    ok: true,
    dry_run: dryRun,
    escalated: results.filter((r) => r.sent).length,
    candidate_count: candidates.length,
    results,
  });
};
