'use strict';

// api/jarvis-push-subscribe.js
// =============================================================================
// Stores/removes a browser's Web Push subscription for the Jarvis PWA so a
// real bridge reply (scripts/jarvis-bridge/server.ts's `reply` tool,
// final:true) can wake Heath up via a real OS-level notification even when
// the Jarvis tab is backgrounded/suspended. See
// supabase/migrations/20260822_push_subscriptions.sql for the table design
// and api/jarvis-push-send.js for the sending half.
//
// Same owner-gating as api/jarvis-bridge-turn.js — only heath.shepard@kw.com's
// Supabase session may write here.
//
// POST /api/jarvis-push-subscribe
//   Authorization: Bearer <supabase user JWT>
//   Body: { subscription: <PushSubscription.toJSON() shape>, user_agent? }
//   -> 200 { ok: true }
//   Upserts on `endpoint` — re-subscribing (e.g. after a permission
//   re-grant) updates the existing row instead of piling up dead ones.
//
// DELETE /api/jarvis-push-subscribe
//   Authorization: Bearer <supabase user JWT>
//   Body: { endpoint }
//   -> 200 { ok: true }
//   Called client-side when Heath explicitly turns notifications off, or
//   when the browser reports the subscription is no longer valid.

const { verifySupabaseToken } = require('./_middleware/auth');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Same ownership boundary as the bridge itself.
const OWNER_EMAIL = 'heath.shepard@kw.com';

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return await new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function supabaseFetch(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { ok: res.ok, status: res.status, data };
}

module.exports = async function handler(req, res) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  let authUser;
  try {
    authUser = await verifySupabaseToken(req);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, error: err.message });
  }
  if ((authUser.email || '').toLowerCase() !== OWNER_EMAIL) {
    return res.status(403).json({
      ok: false,
      error: `Push subscriptions are Heath-only — signed in as ${authUser.email || 'someone else'}, not ${OWNER_EMAIL}.`,
    });
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    return res.status(400).json({ ok: false, error: 'invalid_json' });
  }

  if (req.method === 'POST') {
    const sub = body.subscription;
    const endpoint = sub && String(sub.endpoint || '').trim();
    const p256dh = sub && sub.keys && String(sub.keys.p256dh || '').trim();
    const authKey = sub && sub.keys && String(sub.keys.auth || '').trim();
    if (!endpoint || !p256dh || !authKey) {
      return res.status(400).json({ ok: false, error: 'invalid_subscription' });
    }

    const result = await supabaseFetch('/rest/v1/push_subscriptions?on_conflict=endpoint', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{
        user_id: authUser.userId,
        endpoint,
        p256dh,
        auth_key: authKey,
        user_agent: body.user_agent ? String(body.user_agent).slice(0, 500) : null,
        last_used_at: new Date().toISOString(),
      }]),
    });

    if (!result.ok) {
      return res.status(502).json({ ok: false, error: 'subscribe_failed', detail: result.data });
    }
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const endpoint = String(body.endpoint || '').trim();
    if (!endpoint) return res.status(400).json({ ok: false, error: 'endpoint_required' });

    const result = await supabaseFetch(`/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    });

    if (!result.ok) {
      return res.status(502).json({ ok: false, error: 'unsubscribe_failed', detail: result.data });
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: 'method_not_allowed' });
};
