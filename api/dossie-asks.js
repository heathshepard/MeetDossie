// Vercel Serverless Function: /api/dossie-asks
// The "Dossie asks" action-card feed shown at the top of the app home page.
//
//   GET   /api/dossie-asks   → active asks, ordered by consequence + clock,
//                              plus the empty-state payload (deal names) the
//                              UI needs when nothing is pending.
//   POST  /api/dossie-asks   → create an ask (used by seeding + future
//                              generation; not called by the card UI).
//   PATCH /api/dossie-asks    → resolve / dismiss / snooze / reopen.
//
// Free-text replies live in /api/dossie-ask-respond, not here — they need the
// chat backend and a different failure mode.
//
// Authorization: Bearer <supabase user JWT>. Every query is additionally
// scoped by user_id server-side, so a stolen ask id from another tenant still
// returns nothing.
//
// Owner: Carter, 2026-08-14 (SV-ENG-DOSSIE-ASKS)

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { sortAsks, VISIBLE_LIMIT } = require('./_lib/dossie-ask-priority');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
  'https://staging.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const VALID_URGENCY = new Set(['critical', 'high', 'normal', 'low']);
const TERMINAL_STATUS = new Set(['resolved', 'dismissed']);

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  let allowOrigin = null;
  if (typeof origin === 'string' && origin.length > 0) {
    if (
      ALLOWED_ORIGINS.has(origin) ||
      LOCALHOST_ORIGIN_RE.test(origin) ||
      origin.endsWith('.vercel.app') ||
      origin.endsWith('.meetdossie.com')
    ) {
      allowOrigin = origin;
    }
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin) || !origin;
}

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { ok: res.ok, status: res.status, data };
}

// Short display label for a deal — the street line only. The card header is
// tight, and "104 Wild Cherry Ln, Boerne, TX 78006" wraps to three lines.
function dealLabel(address) {
  if (!address || typeof address !== 'string') return null;
  return address.split(',')[0].trim().toUpperCase();
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);
  if (req.method === 'OPTIONS') {
    return res.status(corsAllowed ? 204 : 403).end();
  }
  if (!corsAllowed) {
    return res.status(403).json({ ok: false, error: 'Origin not allowed.' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured.' });
  }

  let userId;
  try {
    const auth = await verifySupabaseToken(req);
    userId = auth.userId;
  } catch (err) {
    const status = err instanceof AuthError && err.status ? err.status : 401;
    return res.status(status).json({ ok: false, error: 'Unauthorized' });
  }

  // -------------------------------------------------------------------------
  // GET — the feed
  // -------------------------------------------------------------------------
  if (req.method === 'GET') {
    // Pull open + snoozed; the snooze window is evaluated in JS by isActive()
    // so there is exactly one definition of "surfaceable" (shared with the
    // ordering module) rather than a second one encoded in a PostgREST filter.
    const askPath =
      `/rest/v1/dossie_asks` +
      `?select=*,transactions(id,property_address,status,stage,closing_date)` +
      `&user_id=eq.${encodeURIComponent(userId)}` +
      `&status=in.(open,snoozed)`;

    const [asksRes, dealsRes] = await Promise.all([
      supabaseFetch(askPath),
      supabaseFetch(
        `/rest/v1/transactions?select=id,property_address` +
          `&user_id=eq.${encodeURIComponent(userId)}` +
          `&status=eq.active`,
      ),
    ]);

    if (!asksRes.ok) {
      return res.status(500).json({ ok: false, error: 'Could not fetch asks' });
    }

    const now = new Date();
    const ordered = sortAsks(Array.isArray(asksRes.data) ? asksRes.data : [], now);

    // Flatten the embedded transaction so the client never has to know the
    // join shape, and so the address always comes from the live record
    // instead of being copied onto the ask at write time (where it would rot).
    const asks = ordered.map((a) => {
      const tx = a.transactions || null;
      const out = { ...a, deal: null };
      delete out.transactions;
      if (tx) {
        out.deal = {
          id: tx.id,
          address: tx.property_address,
          label: dealLabel(tx.property_address),
          stage: tx.stage,
          closingDate: tx.closing_date,
        };
      }
      return out;
    });

    const activeDeals = (Array.isArray(dealsRes.data) ? dealsRes.data : []).map((d) => ({
      id: d.id,
      label: dealLabel(d.property_address),
      address: d.property_address,
    }));

    return res.status(200).json({
      ok: true,
      asks,
      visibleLimit: VISIBLE_LIMIT,
      // Empty state is a teaching surface, so it needs the agent's real deal
      // names to say "I'm watching your inbox for anything on X and Y".
      activeDeals,
      activeDealCount: activeDeals.length,
    });
  }

  // -------------------------------------------------------------------------
  // POST — create
  // -------------------------------------------------------------------------
  if (req.method === 'POST') {
    const body = req.body || {};
    const { transactionId, urgency, title, askBody, dueAt, dueLabel, suggestedActions, source } =
      body;

    if (!title || !askBody) {
      return res.status(400).json({ ok: false, error: 'title and askBody are required' });
    }
    if (urgency && !VALID_URGENCY.has(urgency)) {
      return res.status(400).json({ ok: false, error: 'invalid urgency' });
    }

    // A transaction_id from the client is only trusted after we confirm it
    // belongs to this user — otherwise an ask could be pinned to someone
    // else's deal and leak its address back through the GET join.
    if (transactionId) {
      const owns = await supabaseFetch(
        `/rest/v1/transactions?select=id&id=eq.${encodeURIComponent(transactionId)}` +
          `&user_id=eq.${encodeURIComponent(userId)}`,
      );
      if (!owns.ok || !Array.isArray(owns.data) || owns.data.length === 0) {
        return res.status(404).json({ ok: false, error: 'Transaction not found' });
      }
    }

    const payload = {
      user_id: userId,
      transaction_id: transactionId || null,
      urgency: urgency || 'normal',
      title: String(title).slice(0, 160),
      body: String(askBody).slice(0, 2000),
      due_at: dueAt || null,
      due_label: dueLabel || null,
      suggested_actions: Array.isArray(suggestedActions) ? suggestedActions : [],
      created_by: 'agent',
      source: source || 'manual',
    };

    const { ok, data } = await supabaseFetch('/rest/v1/dossie_asks', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(payload),
    });
    if (!ok) return res.status(500).json({ ok: false, error: 'Could not create ask' });
    return res.status(201).json({ ok: true, ask: Array.isArray(data) ? data[0] : data });
  }

  // -------------------------------------------------------------------------
  // PATCH — resolve / dismiss / snooze / reopen
  // -------------------------------------------------------------------------
  if (req.method === 'PATCH') {
    const body = req.body || {};
    const { id, status, resolution, resolutionNote, snoozedUntil } = body;

    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    if (!status || !['open', 'snoozed', 'resolved', 'dismissed'].includes(status)) {
      return res.status(400).json({ ok: false, error: 'valid status required' });
    }

    const patch = {};
    patch.status = status;
    if (resolution) patch.resolution = String(resolution).slice(0, 200);
    if (resolutionNote) patch.resolution_note = String(resolutionNote).slice(0, 2000);

    if (TERMINAL_STATUS.has(status)) {
      patch.resolved_at = new Date().toISOString();
    } else if (status === 'open') {
      // Reopening must clear the terminal markers, otherwise a reopened card
      // still reads as resolved everywhere downstream.
      patch.resolved_at = null;
      patch.snoozed_until = null;
    }

    if (status === 'snoozed') {
      patch.snoozed_until = snoozedUntil || new Date(Date.now() + 4 * 3600000).toISOString();
    }

    const { ok, data } = await supabaseFetch(
      `/rest/v1/dossie_asks?id=eq.${encodeURIComponent(id)}` +
        `&user_id=eq.${encodeURIComponent(userId)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      },
    );

    if (!ok) return res.status(500).json({ ok: false, error: 'Could not update ask' });
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(404).json({ ok: false, error: 'Ask not found' });
    }
    return res.status(200).json({ ok: true, ask: data[0] });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, OPTIONS');
  return res.status(405).json({ ok: false, error: 'Method not allowed' });
};
