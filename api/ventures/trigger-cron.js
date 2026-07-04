/**
 * POST /api/ventures/trigger-cron
 * Manually fires a cron endpoint from the ventures dashboard.
 * The dashboard sends the cron name; this endpoint looks up the path and calls it
 * with the CRON_SECRET server-side so the secret never touches the browser.
 *
 * Auth: Bearer JWT from the logged-in user (heath emails only).
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET
 */

import { isPaused, pauseReason } from '../_lib/paused-crons.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const AUTHORIZED_EMAILS = new Set([
  'heath.shepard@kw.com',
  'heath@meetdossie.com',
  'heath.shepard@gmail.com',
  'heathshepard@meetdossie.com',
]);

const ALLOWED_ORIGINS = new Set(['https://meetdossie.com', 'https://www.meetdossie.com']);
const PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;
const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function applyCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin) || PREVIEW_RE.test(origin) || LOCAL_RE.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
}

async function verifyAuth(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return AUTHORIZED_EMAILS.has(u.email) ? u : null;
}

// Whitelist of allowed cron names to their API paths
const CRON_MAP = {
  'cron-generate-posts':     '/api/cron-generate-posts',
  'cron-send-for-approval':  '/api/cron-send-for-approval',
  'cron-publish-approved':   '/api/cron-publish-approved',
  'cron-morning-brief':      '/api/cron-morning-brief',
  'cron-pipeline-check':     '/api/cron-pipeline-check',
  'cron-deadline-reminders': '/api/cron-deadline-reminders',
  'cron-email-digest':       '/api/cron-email-digest',
  'cron-followup':           '/api/cron-followup',
  'cron-content-brief':      '/api/cron-content-brief',
  'cron-coverage-check':     '/api/cron-coverage-check',
  'cron-analytics-sync':     '/api/cron-analytics-sync',
  'cron-video-approval':     '/api/cron-video-approval',
  'cron-post-videos':        '/api/cron-post-videos',
  'cron-verify-posts':       '/api/cron-verify-posts',
  'cron-generate-skit':      '/api/cron-generate-skit',
  'alert-health':            '/api/alert-health',
  'cron-pipeline-health':    '/api/cron-pipeline-health',
  'cron-calculator-deadline-reminders': '/api/cron-calculator-deadline-reminders',
};

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch {}

  const { cronName } = body;
  const cronPath = CRON_MAP[cronName];
  if (!cronPath) {
    return res.status(400).json({ error: `Unknown cron: ${cronName}` });
  }

  if (!CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET not configured' });
  }

  // 2026-07-04 (Atlas) — PAUSE-AWARE GUARD.
  // The ventures dashboard "trigger cron" button used to fire paused crons
  // silently, defeating the cost freeze. Refuse by default. Heath can still
  // force through by POSTing { cronName, force: true } if a manual run is
  // deliberate and cost-approved.
  if (isPaused(cronPath) && !body.force) {
    const reason = pauseReason(cronPath) || 'paused';
    return res.status(423).json({
      error: `Cron ${cronName} is paused (${reason}). POST { force: true } to override the freeze.`,
      paused: true,
      reason,
    });
  }

  try {
    // Call the cron endpoint server-side with the CRON_SECRET
    const base = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'https://meetdossie.com';
    const cronRes = await fetch(`${base}${cronPath}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });

    const status = cronRes.status;
    let result = {};
    try { result = await cronRes.json(); } catch {}

    return res.status(200).json({ triggered: true, cronName, cronStatus: status, result });
  } catch (e) {
    console.error('[trigger-cron] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
