'use strict';

// Vercel Serverless Function: /api/cron-content-pipeline-review
// Sends every content_pipeline_queue row that's finished generation
// (status='pending_review', not yet sent) to Heath via Telegram
// (DossieMarketingBot) with topic, excerpt, sources, and Approve/Reject
// buttons. Mirrors api/cron-send-for-approval.js's pattern for social posts.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json -- "*/20 * * * *"
//
// Owner: Atlas, 2026-08-11 (SV-ENG-NIGHTLY-CONTENT-PIPELINE)

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const MAX_PER_RUN = 6;

const PAGE_TYPE_LABEL = { guide: 'GUIDE', feature: 'FEATURE', answer: 'ANSWER' };
const PAGE_TYPE_URL_SEGMENT = { guide: 'guides', feature: 'features', answer: 'answers' };

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

async function tgSend(text, replyMarkup) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
  const respText = await res.text();
  let data = null;
  try { data = respText ? JSON.parse(respText) : null; } catch { data = null; }
  return { ok: res.ok && data?.ok === true, data, raw: respText };
}

function formatSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return '(no sources recorded)';
  return sources.slice(0, 8).map((s) => `- ${s.label || 'source'}: ${s.url || '(no url)'}`).join('\n');
}

function formatMessage(row) {
  const label = PAGE_TYPE_LABEL[row.page_type] || row.page_type.toUpperCase();
  const title = (row.json_data && row.json_data.title) || row.topic;
  const slug = row.slug || '(no slug)';
  const urlSegment = PAGE_TYPE_URL_SEGMENT[row.page_type] || row.page_type;
  const excerpt = String(row.excerpt || '').slice(0, 600);

  return [
    `NIGHTLY CONTENT PIPELINE -- ${label}`,
    '',
    `Topic: ${row.topic}`,
    `Title: ${title}`,
    `Slug: /${urlSegment}/${slug}`,
    '',
    'Excerpt:',
    excerpt || '(no excerpt)',
    '',
    'Sources:',
    formatSources(row.sources),
    '',
    'Approve = lands on staging (build scripts run, commit pushed) for you to spot-check before merging to main.',
    'Reject = discarded, never retried for this topic.',
  ].join('\n');
}

function inlineKeyboard(id) {
  return {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `cpage_approve_${id}` },
      { text: '❌ Reject', callback_data: `cpage_reject_${id}` },
    ]],
  };
}

module.exports = withTelemetry('cron-content-pipeline-review', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('[cron-content-pipeline-review] Telegram env not configured — skipping run.');
    return res.status(200).json({ ok: true, skipped: true, reason: 'telegram env not configured' });
  }

  const { data: rows, ok: loadOk } = await sb(
    `content_pipeline_queue?status=eq.pending_review&telegram_sent_at=is.null&order=created_at.asc&limit=${MAX_PER_RUN}`
  );
  if (!loadOk) {
    return res.status(502).json({ ok: false, error: 'failed to load content_pipeline_queue' });
  }
  const items = Array.isArray(rows) ? rows : [];

  let sent = 0;
  const errors = [];
  for (const row of items) {
    const text = formatMessage(row);
    const result = await tgSend(text, inlineKeyboard(row.id));
    if (!result.ok) {
      console.error('[cron-content-pipeline-review] send failed for', row.id, result.raw?.slice(0, 200));
      errors.push({ id: row.id, error: result.raw?.slice(0, 200) });
      continue;
    }
    const messageId = result.data?.result?.message_id || null;
    const patch = await sb(`content_pipeline_queue?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ telegram_sent_at: new Date().toISOString(), telegram_message_id: messageId }),
    });
    if (patch.ok) sent++;
    else errors.push({ id: row.id, error: 'patch failed' });
  }

  console.log('[cron-content-pipeline-review] done — sent', sent, 'of', items.length, 'errors:', errors.length);
  return res.status(200).json({ ok: true, sent, total: items.length, errors });
});
