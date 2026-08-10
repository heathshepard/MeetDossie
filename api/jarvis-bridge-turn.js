'use strict';

// api/jarvis-bridge-turn.js
// =============================================================================
// The phone-facing half of the Jarvis -> live Cole session bridge.
//
// This is deliberately NOT the same thing as api/jarvis-claude-code.js
// ("Build mode"), which spawns a fresh, throwaway `claude` process per
// request via agent_queue + scripts/claude-code-worker.js. This endpoint
// instead hands the message to scripts/jarvis-bridge/server.ts — a channel
// MCP server running inside Heath's ALREADY-RUNNING, ALREADY-LIVE Claude Code
// terminal session — so the reply comes from the same session with the same
// tools, same agent-dispatch, same everything, not a fresh instance that has
// to re-load context from scratch.
//
// Transport is a private Supabase Storage bucket (`jarvis-bridge`), not a
// DB table and not a WebSocket relay. One JSON object per turn at
// turns/<turn_id>.json. Heath's local channel process polls that bucket
// (outbound HTTPS only — no port ever opens on his machine, works through
// any NAT/firewall with zero router config). See
// scripts/jarvis-bridge/server.ts for the full flow diagram.
//
// POST /api/jarvis-bridge-turn
//   Authorization: Bearer <supabase user JWT>   (Heath only)
//   Body: { message }
//   -> 202 { ok, turn_id, poll_url }
//
// GET /api/jarvis-bridge-turn?id=<turn_id>
//   Authorization: Bearer <supabase user JWT>
//   -> { ok, status: pending|delivered|answered|expired, reply? }
//
// Deliberately asynchronous, same reasoning as jarvis-claude-code.js: the
// live session can take anywhere from a second to several minutes to answer
// (it may dispatch Carter/Atlas/etc for real work), and a Vercel function
// can't hold a request open that long. The phone polls.

const { verifySupabaseToken } = require('./_middleware/auth');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Same ownership boundary as Build mode — this reaches a live terminal
// session running with --dangerously-skip-permissions equivalent trust on
// Heath's own machine. His and nobody else's.
const OWNER_EMAIL = 'heath.shepard@kw.com';

const BUCKET = 'jarvis-bridge';
const PREFIX = 'turns/';
const MAX_MESSAGE = 4000;

// If nothing has picked the turn up (delivered_at unset) after this long,
// the local channel process is almost certainly not running — tell the UI
// so it can say "Cole isn't listening right now" instead of spinning forever.
const PICKUP_TIMEOUT_MS = 20 * 1000;
// Absolute turn lifetime — matches the cleanup window in server.ts.
const TURN_EXPIRY_MS = 60 * 60 * 1000;

function storageUrl(path) {
  return `${SUPABASE_URL}/storage/v1/${path}`;
}

function storageHeaders(extra) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(extra || {}),
  };
}

async function putTurn(id, turn) {
  const res = await fetch(storageUrl(`object/${BUCKET}/${PREFIX}${id}.json`), {
    method: 'POST',
    headers: storageHeaders({
      'Content-Type': 'application/json',
      'x-upsert': 'true',
      'cache-control': 'no-cache, no-store, max-age=0, must-revalidate',
    }),
    body: JSON.stringify(turn),
  });
  if (!res.ok) throw new Error(`storage put failed: ${res.status} ${await res.text()}`);
}

// Confirmed 2026-08-10: Supabase Storage's object GET is served through a CDN
// edge cache that can serve a stale copy for seconds to ~90s after a real
// write, on the exact same URL, regardless of cache-control sent on upload.
// Cache-bust every read — see the matching comment in
// scripts/jarvis-bridge/server.ts (the other half of this bridge hits the
// same issue polling the same bucket).
async function getTurn(id) {
  const res = await fetch(storageUrl(`object/${BUCKET}/${PREFIX}${id}.json?_cb=${Date.now()}`), {
    headers: storageHeaders({ 'Cache-Control': 'no-cache' }),
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`storage get failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

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

// Loose uuid-ish check — good enough to reject path traversal in ?id=.
const ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;

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
      error: `This bridges to Heath's live terminal session — signed in as ${authUser.email || 'someone else'}, not ${OWNER_EMAIL}.`,
    });
  }

  // ---- poll for an answer -------------------------------------------------
  if (req.method === 'GET') {
    const id = String((req.query && req.query.id) || '').trim();
    if (!id || !ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'id_required' });

    let turn;
    try {
      turn = await getTurn(id);
    } catch (err) {
      return res.status(502).json({ ok: false, error: 'storage_error', detail: err.message });
    }
    if (!turn) return res.status(404).json({ ok: false, error: 'not_found' });

    const createdMs = new Date(turn.created_at || 0).getTime();
    const ageMs = Date.now() - createdMs;

    if (turn.status === 'answered') {
      return res.status(200).json({ ok: true, status: 'answered', reply: turn.reply_text || '' });
    }
    if (turn.status === 'error') {
      return res.status(200).json({ ok: false, status: 'error', error: turn.reply_text || 'unknown error' });
    }
    if (ageMs > TURN_EXPIRY_MS) {
      return res.status(200).json({ ok: false, status: 'expired' });
    }
    if (turn.status === 'pending' && ageMs > PICKUP_TIMEOUT_MS) {
      // Nobody's polling the bucket — the local channel process is down.
      return res.status(200).json({ ok: true, status: 'pending', bridge_offline: true, waiting_ms: ageMs });
    }
    return res.status(200).json({ ok: true, status: turn.status, waiting_ms: ageMs });
  }

  // ---- ask ------------------------------------------------------------------
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    return res.status(400).json({ ok: false, error: 'invalid_json' });
  }

  const message = String(body.message || '').trim();
  if (!message) return res.status(400).json({ ok: false, error: 'message_required' });
  if (message.length > MAX_MESSAGE) {
    return res.status(400).json({ ok: false, error: 'message_too_long', max: MAX_MESSAGE });
  }

  const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  try {
    await putTurn(turnId, {
      status: 'pending',
      user_message: message,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'enqueue_failed', detail: err.message });
  }

  return res.status(202).json({
    ok: true,
    turn_id: turnId,
    poll_url: `/api/jarvis-bridge-turn?id=${turnId}`,
  });
};
