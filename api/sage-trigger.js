'use strict';

// Vercel Serverless Function: /api/sage-trigger
//
// Allows Sage to fire approved cron jobs via marker dispatch from sage-webhook.
// Auth: SAGE_TRIGGER_SECRET (separate from CRON_SECRET for separation of concerns).
//
// POST /api/sage-trigger?name=generate-posts
//   Authorization: Bearer ${SAGE_TRIGGER_SECRET}
//
// Returns { ok: true, trigger, status, response } where status is the upstream
// cron HTTP status. We do NOT proxy the full response body — that goes to
// cron logs. We just confirm success/failure so Sage can report it back.

const { ALLOWED_TRIGGERS } = require('./_lib/sage-triggers.js');

const SAGE_TRIGGER_SECRET = process.env.SAGE_TRIGGER_SECRET;
const CRON_SECRET = process.env.CRON_SECRET;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://meetdossie.com';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!SAGE_TRIGGER_SECRET || authHeader !== `Bearer ${SAGE_TRIGGER_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const name = String(req.query?.name || req.body?.name || '').toLowerCase().trim();
  if (!name) return res.status(400).json({ ok: false, error: 'missing trigger name' });

  const spec = ALLOWED_TRIGGERS[name];
  if (!spec) {
    return res.status(400).json({
      ok: false,
      error: `unknown trigger '${name}'`,
      allowed: Object.keys(ALLOWED_TRIGGERS),
    });
  }

  if (!CRON_SECRET) {
    return res.status(500).json({ ok: false, error: 'CRON_SECRET not configured on server' });
  }

  const targetUrl = `${PUBLIC_BASE_URL}${spec.path}`;
  try {
    const upstream = await fetch(targetUrl, {
      method: spec.method,
      headers: {
        Authorization: `Bearer ${CRON_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: spec.method === 'POST' ? '{}' : undefined,
    });
    const text = await upstream.text();
    console.log(`[sage-trigger] ${name} -> ${spec.path}: status=${upstream.status} body=${text.slice(0, 200)}`);
    return res.status(200).json({
      ok: upstream.ok,
      trigger: name,
      status: upstream.status,
      response_snippet: text.slice(0, 200),
    });
  } catch (err) {
    console.error('[sage-trigger] fetch failed:', err && err.message);
    return res.status(502).json({ ok: false, error: `upstream fetch failed: ${err && err.message}` });
  }
};
