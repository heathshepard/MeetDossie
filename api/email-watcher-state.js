// Vercel Serverless Function: /api/email-watcher-state
//
// Bridge between Anthropic-cloud watcher routines and Supabase. The cloud
// routine cannot hold the SUPABASE_SERVICE_ROLE_KEY (per
// reference_scheduled_routines.md — no secrets in routine prompts), so this
// endpoint serves the small set of queries it needs.
//
// SV-EMAIL-001 (Atlas, 2026-05-23).
//
// GET  /api/email-watcher-state?tier=tier1
//   Public. Returns:
//     {
//       ok: true,
//       tier: "tier1",
//       last_check_ts: "2026-05-23T12:34:56Z",
//       now: "2026-05-23T12:39:56Z",
//       senders: [{ pattern, label, notes }, ...]
//     }
//
// POST /api/email-watcher-state
//   Headers:  Content-Type: application/json
//             X-Watcher-Secret: <EMAIL_WATCHER_SECRET>
//   Body:     {
//               tier: "tier1",
//               new_last_check_ts: "2026-05-23T12:39:50Z",   // ISO
//               matches_found: 0,                            // integer
//               status: "ok" | "error" | "skipped",
//               notes: "optional one-liner"
//             }
//   Returns:  { ok: true, updated: true }
//
// Security:
//   - GET is intentionally public. The senders + last-check-ts are not
//     sensitive (no email bodies, no PII beyond email addresses Heath
//     already advertises in MeetDossie CLAUDE.md).
//   - POST requires the shared secret EMAIL_WATCHER_SECRET. The routine
//     stores this in Anthropic-cloud routine env (secrets store), NOT in
//     the routine prompt body.
//   - Tier validation prevents path-traversal-style writes.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL_WATCHER_SECRET = process.env.EMAIL_WATCHER_SECRET;

const VALID_TIERS = new Set(['tier1', 'tier2']);

async function supaFetch(path, init = {}) {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Watcher-Secret');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase_env_missing' });
  }

  if (req.method === 'GET') {
    const tier = String(req.query.tier || '').trim();
    if (!VALID_TIERS.has(tier)) {
      return res.status(400).json({ ok: false, error: 'invalid_tier' });
    }

    try {
      const [stateResp, sendersResp] = await Promise.all([
        supaFetch(
          `email_watcher_state?tier=eq.${encodeURIComponent(tier)}&select=tier,last_check_ts`,
          { method: 'GET' },
        ),
        supaFetch(
          `email_watcher_senders?tier=eq.${encodeURIComponent(tier)}&active=eq.true&select=sender_pattern,label,notes&order=label.asc`,
          { method: 'GET' },
        ),
      ]);

      if (!stateResp.ok) {
        return res.status(502).json({ ok: false, error: 'state_fetch_failed', status: stateResp.status });
      }
      if (!sendersResp.ok) {
        return res.status(502).json({ ok: false, error: 'senders_fetch_failed', status: sendersResp.status });
      }

      const stateRows = await stateResp.json();
      const senderRows = await sendersResp.json();
      const state = Array.isArray(stateRows) && stateRows[0] ? stateRows[0] : null;
      const senders = Array.isArray(senderRows) ? senderRows : [];

      const fallback = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      return res.status(200).json({
        ok: true,
        tier,
        last_check_ts: state?.last_check_ts || fallback,
        now: new Date().toISOString(),
        senders: senders.map((s) => ({
          pattern: s.sender_pattern,
          label: s.label,
          notes: s.notes || null,
        })),
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'unexpected', message: String(err && err.message) });
    }
  }

  if (req.method === 'POST') {
    if (!EMAIL_WATCHER_SECRET) {
      return res.status(500).json({ ok: false, error: 'watcher_secret_not_configured' });
    }
    const provided = req.headers['x-watcher-secret'];
    if (provided !== EMAIL_WATCHER_SECRET) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ ok: false, error: 'body_required' });
    }

    const tier = String(body.tier || '').trim();
    if (!VALID_TIERS.has(tier)) {
      return res.status(400).json({ ok: false, error: 'invalid_tier' });
    }

    const newTs = typeof body.new_last_check_ts === 'string' ? body.new_last_check_ts : null;
    if (!newTs || Number.isNaN(Date.parse(newTs))) {
      return res.status(400).json({ ok: false, error: 'invalid_new_last_check_ts' });
    }

    const matches = Number.isFinite(body.matches_found) ? Math.max(0, Math.floor(body.matches_found)) : 0;
    const status = typeof body.status === 'string' ? body.status.slice(0, 32) : 'ok';
    const notes = typeof body.notes === 'string' ? body.notes.slice(0, 500) : null;

    try {
      const patch = {
        last_check_ts: newTs,
        last_run_at: new Date().toISOString(),
        last_run_status: status,
        last_run_notes: notes,
        matches_last_run: matches,
        updated_at: new Date().toISOString(),
      };
      const resp = await supaFetch(
        `email_watcher_state?tier=eq.${encodeURIComponent(tier)}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify(patch),
        },
      );
      if (!resp.ok) {
        const text = await resp.text();
        return res.status(502).json({ ok: false, error: 'state_update_failed', status: resp.status, body: text });
      }
      const rows = await resp.json();
      return res.status(200).json({ ok: true, updated: true, row: Array.isArray(rows) ? rows[0] : null });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'unexpected', message: String(err && err.message) });
    }
  }

  res.setHeader('Allow', 'GET, POST, OPTIONS');
  return res.status(405).json({ ok: false, error: 'method_not_allowed' });
};
