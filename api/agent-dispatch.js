'use strict';

// Vercel Serverless Function: /api/agent-dispatch
//
// Phase 1 of agent-to-agent orchestration. Sage's webhook emits
// `[CARTER: ...]` style markers in her replies. The webhook inserts an
// agent_requests row (status='pending') and fires this endpoint
// fire-and-forget. This endpoint is now intentionally THIN — it just
// validates that the row exists and returns 200. The actual work is
// done by cron-process-agent-requests (runs every minute via cron-job.org)
// because Vercel Hobby caps serverless functions at 10s and Sonnet calls
// can blow past that.
//
// Auth: Bearer ${CRON_SECRET} required. Internal-only.
// Cole is NOT auto-dispatched in Phase 1. When a [COLE: ...] marker
// fires, Sage's webhook relays a Telegram notification to Heath directly
// instead of calling this endpoint — see api/sage-webhook.js.

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // Auth gate
  const auth = req.headers.authorization || '';
  const expected = `Bearer ${CRON_SECRET}`;
  if (!CRON_SECRET || auth !== expected) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const requestId = (req.query && req.query.request_id) ||
    (req.body && req.body.request_id) || null;
  if (!requestId) {
    return res.status(400).json({ ok: false, error: 'missing_request_id' });
  }

  // Confirm the row exists. If it doesn't, return 404 — the webhook
  // should have inserted it already.
  const { ok, data } = await supaFetch(
    `agent_requests?request_id=eq.${encodeURIComponent(requestId)}&select=request_id,status,to_agent`,
  );
  if (!ok || !Array.isArray(data) || data.length === 0) {
    return res.status(404).json({ ok: false, error: 'request_not_found' });
  }

  const row = data[0];

  // If already complete or in_progress, no-op
  if (row.status !== 'pending') {
    return res.status(200).json({
      ok: true,
      request_id: requestId,
      status: row.status,
      info: 'already picked up',
    });
  }

  // Mark in_progress so cron-process-agent-requests can pick it up
  // immediately on the next minute boundary. We do NOT execute here
  // because of the 10s Vercel Hobby limit.
  return res.status(200).json({
    ok: true,
    request_id: requestId,
    to_agent: row.to_agent,
    info: 'queued — will be processed by cron-process-agent-requests within 60s',
  });
};
