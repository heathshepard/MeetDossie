'use strict';

// api/jarvis-push-send.js
// =============================================================================
// Server-side Web Push sender. Fires an OS-level notification to every
// browser/device Heath has subscribed (public.push_subscriptions) so a real
// bridge reply reaches him even when the Jarvis PWA tab is backgrounded or
// (on Android) fully suspended. See
// supabase/migrations/20260822_push_subscriptions.sql for the table and
// api/jarvis-push-subscribe.js for how rows get there.
//
// Trigger point: scripts/jarvis-bridge/server.ts's `reply` tool handler,
// right after it writes a turn to status:'answered' (final:true only — an
// interim 'working' ack does NOT push, only the real final answer does).
// That process runs locally on Heath's machine, outside Vercel, so this has
// to be a real HTTP endpoint it can call rather than an in-process function.
//
// Auth: internal service-to-service, not a Heath user session — server.ts
// already holds SUPABASE_SERVICE_ROLE_KEY (it needs it to read/write the
// jarvis-bridge Storage bucket) so reusing that as the bearer here needs no
// new secret provisioned/distributed anywhere. This endpoint never accepts a
// Supabase user JWT — it's not a user-facing route.
//
// POST /api/jarvis-push-send
//   Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}
//   Body: { title?, body, url?, tag? }
//   -> 200 { ok: true, sent, failed, removed }

const webpush = require('web-push');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:heath@meetdossie.com';

const MAX_BODY_CHARS = 500; // notification body — keep it a preview, not the whole reply

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
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return res.status(503).json({ ok: false, error: 'vapid_env_missing' });
  }

  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (authHeader !== `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    return res.status(400).json({ ok: false, error: 'invalid_json' });
  }

  const notifBody = String(body.body || '').trim();
  if (!notifBody) return res.status(400).json({ ok: false, error: 'body_required' });

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const payload = JSON.stringify({
    title: String(body.title || 'Jarvis').slice(0, 100),
    body: notifBody.slice(0, MAX_BODY_CHARS),
    data: {
      url: body.url ? String(body.url) : '/myjarvis',
      tag: body.tag ? String(body.tag) : undefined,
    },
  });

  const listRes = await supabaseFetch('/rest/v1/push_subscriptions?select=id,endpoint,p256dh,auth_key');
  if (!listRes.ok) {
    return res.status(502).json({ ok: false, error: 'subscription_lookup_failed', detail: listRes.data });
  }
  const subs = Array.isArray(listRes.data) ? listRes.data : [];
  if (subs.length === 0) {
    return res.status(200).json({ ok: true, sent: 0, failed: 0, removed: 0, note: 'no subscriptions on file' });
  }

  let sent = 0;
  let failed = 0;
  const removeIds = [];
  const sentIds = [];

  await Promise.all(subs.map(async (row) => {
    const pushSub = {
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth_key },
    };
    try {
      await webpush.sendNotification(pushSub, payload);
      sent += 1;
      sentIds.push(row.id);
    } catch (err) {
      failed += 1;
      // 404/410 = the push service says this subscription is gone for good
      // (browser data cleared, permission revoked, etc) — stop trying it.
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        removeIds.push(row.id);
      }
    }
  }));

  if (removeIds.length > 0) {
    await supabaseFetch(`/rest/v1/push_subscriptions?id=in.(${removeIds.join(',')})`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    }).catch(() => {});
  }
  if (sentIds.length > 0) {
    // Touch last_used_at for the ones that worked — best-effort, not worth
    // failing the request over. uuid ids need no quoting for PostgREST's
    // in.() filter.
    supabaseFetch(`/rest/v1/push_subscriptions?id=in.(${sentIds.join(',')})`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ last_used_at: new Date().toISOString() }),
    }).catch(() => {});
  }

  return res.status(200).json({ ok: true, sent, failed, removed: removeIds.length });
};
