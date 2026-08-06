// api/jarvis-mark-complete.js
// ============================================================================
// POST /api/jarvis-mark-complete
//
// Closes the "auto-update as we talk through it" gap: Heath (or Jarvis on his
// behalf) says a thing is done, and this resolves + closes the right row in
// heath_todo / agent_queue / merge_queue without Heath having to know which
// table it lives in.
//
// Body (one of two modes):
//   { source: "heath_todo"|"agent_queue"|"merge_queue", id: "uuid" }
//     -> deterministic, no matching needed. Used by the HUD's per-item
//        "Done" button in the IN-FLIGHT WORK panel.
//   { reference: "the vercel cron fix" }
//     -> plain-language mode. Scores against all open rows across the three
//        tables; completes the row only if there's a clear single winner.
//        Otherwise returns { ambiguous: true, candidates: [...] } and takes
//        NO action — never guesses on Heath's behalf.
//
// Response:
//   200 { ok: true, source, id, title, action }
//   200 { ok: true, ambiguous: true, candidates: [...] }
//   404 { ok: false, error: "no_match" }
//   400 { ok: false, error: "..." }
//
// Auth: Bearer Supabase JWT (heath.shepard@kw.com) OR Bearer ${CRON_SECRET}.
//
// Owner: Atlas — Jarvis mission-control consolidation, 2026-08-06.
// ============================================================================

const { completeRow, resolveReference } = require('./_lib/mark-complete-core.js');

const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ALLOWED_EMAIL = 'heath.shepard@kw.com';

const VALID_SOURCES = new Set(['heath_todo', 'agent_queue', 'merge_queue']);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function authorize(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return { ok: false, status: 401, error: 'no token' };
  const token = h.slice('Bearer '.length).trim();

  if (CRON_SECRET && token === CRON_SECRET) return { ok: true, principal: 'cron' };

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, status: 500, error: 'auth not configured' };
  }
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { ok: false, status: 401, error: 'invalid token' };
  const user = await res.json().catch(() => null);
  if (!user || !user.email) return { ok: false, status: 401, error: 'invalid token' };
  if (user.email !== ALLOWED_EMAIL) return { ok: false, status: 403, error: 'forbidden' };
  return { ok: true, principal: 'heath' };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase env not configured' });
  }

  const auth = await authorize(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  try {
    // ── Deterministic id mode ────────────────────────────────────────────
    if (body.source && body.id) {
      const source = String(body.source);
      if (!VALID_SOURCES.has(source)) {
        return res.status(400).json({ ok: false, error: `source must be one of: ${Array.from(VALID_SOURCES).join(', ')}` });
      }
      const result = await completeRow(source, String(body.id));
      if (!result.ok) return res.status(404).json({ ok: false, error: result.error });
      return res.status(200).json({
        ok: true,
        source,
        id: body.id,
        title: result.row.title || result.row.commit_sha || null,
        action: result.action,
      });
    }

    // ── Plain-language reference mode ────────────────────────────────────
    if (body.reference && typeof body.reference === 'string') {
      const resolved = await resolveReference(body.reference);
      if (!resolved.ok) {
        if (resolved.reason === 'ambiguous') {
          return res.status(200).json({ ok: true, ambiguous: true, candidates: resolved.candidates });
        }
        return res.status(404).json({ ok: false, error: resolved.reason });
      }
      const { source, id, title } = resolved.match;
      const result = await completeRow(source, id);
      if (!result.ok) return res.status(404).json({ ok: false, error: result.error });
      return res.status(200).json({ ok: true, source, id, title, action: result.action });
    }

    return res.status(400).json({ ok: false, error: 'provide either {source,id} or {reference}' });
  } catch (err) {
    console.error('[jarvis-mark-complete] error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
