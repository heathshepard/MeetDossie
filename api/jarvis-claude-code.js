'use strict';

// api/jarvis-claude-code.js
// =============================================================================
// The phone-facing half of the Jarvis -> Claude Code bridge.
//
// Every other jarvis-* endpoint asks the Anthropic API a question server-side.
// That Claude can talk but cannot act — no filesystem, no repo, no git. This
// endpoint instead queues the message for the claude-code-worker running on
// Heath's PC, so the answer comes from a Claude that can actually read the
// code and change it.
//
// POST /api/jarvis-claude-code
//   Authorization: Bearer <supabase user JWT>   (Heath only)
//   Body: { message, session_id?, project?, model? }
//   -> 202 { ok, queue_id, poll_url }
//
// GET /api/jarvis-claude-code?id=<queue_id>
//   Authorization: Bearer <supabase user JWT>
//   -> { ok, status, answer?, session_id?, error? }
//
// Deliberately asynchronous. Claude Code can take minutes on a real task and
// Vercel functions cannot; the queue row is the handoff. The phone polls.
//
// If the PC is off, the row simply waits — that is the intended behaviour, not
// a failure. `pc_online` on the POST response tells the UI whether to expect an
// answer soon or say "your computer is asleep".

const { verifySupabaseToken } = require('./_middleware/auth');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// This endpoint runs arbitrary Claude Code with --dangerously-skip-permissions
// on Heath's machine. It is his and nobody else's, regardless of what other
// authenticated users exist.
const OWNER_EMAIL = 'heath.shepard@kw.com';

const VALID_PROJECTS = new Set(['meetdossie', 'sawyer', 'rust']);
const MAX_MESSAGE = 8000;

// agent_queue.venture has its own CHECK constraint (dossie / paralegal /
// personal-agents / shepard-ventures / general) that does NOT include our
// project keys directly. Every Build-mode request was inserting
// venture='meetdossie' and failing this constraint at the DB layer — 100%
// failure rate, for every account, since the day this endpoint shipped.
// Found 2026-08-04 by testing a direct insert.
const PROJECT_TO_VENTURE = {
  meetdossie: 'dossie',
  sawyer: 'shepard-ventures',
  rust: 'general',
};

// Heartbeat older than this and we assume the PC is off, so the UI can say so
// instead of leaving him watching a spinner.
const PC_STALE_MS = 10 * 60 * 1000;

async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
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
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
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

async function pcOnline() {
  try {
    const r = await sb('pc_heartbeats?select=last_seen&order=last_seen.desc&limit=1');
    const row = r.data && r.data[0];
    if (!row || !row.last_seen) return null;      // null = unknown, not offline
    return (Date.now() - new Date(row.last_seen).getTime()) < PC_STALE_MS;
  } catch {
    return null;
  }
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
      error: `Build mode only works signed in as ${OWNER_EMAIL} — this session is signed in as ${authUser.email || 'someone else'}.`,
    });
  }

  // ---- poll for an answer -------------------------------------------------
  if (req.method === 'GET') {
    const id = String((req.query && req.query.id) || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id_required' });

    const r = await sb(
      `agent_queue?id=eq.${encodeURIComponent(id)}`
      + '&select=id,status,result_summary,metadata,created_at,completed_at&limit=1'
    );
    const row = r.data && r.data[0];
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });

    if (row.status === 'completed') {
      const result = (row.metadata && row.metadata.result) || {};
      return res.status(200).json({
        ok: true,
        status: 'completed',
        answer: row.result_summary || result.answer || '',
        session_id: result.session_id || null,
        session_reset: Boolean(result.session_reset),
        duration_ms: result.duration_ms || null,
      });
    }

    if (row.status === 'failed' || row.status === 'blocked') {
      return res.status(200).json({
        ok: false,
        status: row.status,
        error: row.result_summary || 'task did not complete',
      });
    }

    return res.status(200).json({
      ok: true,
      status: row.status,           // pending | in_progress
      waiting_ms: Date.now() - new Date(row.created_at).getTime(),
    });
  }

  // ---- ask ----------------------------------------------------------------
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

  const project = String(body.project || 'meetdossie').toLowerCase();
  if (!VALID_PROJECTS.has(project)) {
    return res.status(400).json({
      ok: false, error: 'invalid_project', valid: [...VALID_PROJECTS],
    });
  }

  const ins = await sb('agent_queue', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      agent_name: 'cole',
      // Shown in any queue UI, so make it readable rather than a uuid.
      task_subject: `Jarvis: ${message.slice(0, 80)}`,
      task_brief: message,
      // Ahead of background batch work (which sits at 4) — Heath is waiting on
      // this one with a phone in his hand.
      priority: 1,
      venture: PROJECT_TO_VENTURE[project] || 'general',
      status: 'pending',
      metadata: {
        task_type: 'jarvis_chat',
        autonomous: true,
        source: 'jarvis',
        payload: {
          message,
          project,
          session_id: body.session_id || null,
          model: body.model || 'sonnet',
        },
      },
    }]),
  });

  if (!ins.ok || !ins.data || !ins.data[0]) {
    return res.status(502).json({ ok: false, error: 'enqueue_failed', detail: ins.data });
  }

  const queueId = ins.data[0].id;
  return res.status(202).json({
    ok: true,
    queue_id: queueId,
    poll_url: `/api/jarvis-claude-code?id=${queueId}`,
    pc_online: await pcOnline(),
  });
};
