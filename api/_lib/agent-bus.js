// ============================================================================
// agent-bus.js — Shepard Ventures shared agent bus (Phase A)
//
// The data substrate for cross-agent observability. Every agent (Cole, Sage,
// Carter, Atlas, Pierce, Sterling, Hadley, Ridge) and Heath writes their
// inputs/outputs/dispatches here. Before a sub-agent starts a build, it reads
// recent context so it knows what the team has been working on.
//
// Phase A: just writes/reads. No long-polling, no realtime, no streaming.
// Phase B will add persistent agent sessions that react to dispatches.
//
// Service-role-only — never expose this lib to client code.
//
// Owner: Atlas (SV-ENG-AGENT-BUS-PHASE-A / 2026-06-12)
// ============================================================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VALID_AGENTS = new Set([
  'cole', 'sage', 'carter', 'atlas', 'pierce',
  'sterling', 'hadley', 'ridge', 'quinn', 'heath',
]);

const VALID_ROLES = new Set(['input', 'output', 'status', 'dispatch', 'observation']);

let _client = null;
function client() {
  if (_client) return _client;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('agent-bus: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  }
  _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

/**
 * Write a message to the shared bus.
 *
 * @param {object} opts
 * @param {string} opts.agent          One of: cole, sage, carter, atlas, pierce, sterling, hadley, ridge, quinn, heath
 * @param {string} opts.role           One of: input, output, status, dispatch, observation
 * @param {string} opts.content        The message body (trimmed, no length cap — JSONB-friendly)
 * @param {string} [opts.in_reply_to]  Optional UUID of the parent message
 * @param {string} [opts.routing_target] Required if role='dispatch' — the target agent name
 * @param {object} [opts.metadata]     Optional JSONB blob (commit_sha, file_paths, tags, etc.)
 * @returns {Promise<{ok: boolean, id?: string, error?: string}>}
 */
async function writeMessage({ agent, role, content, in_reply_to, routing_target, metadata }) {
  if (!agent || !VALID_AGENTS.has(agent)) {
    return { ok: false, error: `invalid agent: ${agent}` };
  }
  if (!role || !VALID_ROLES.has(role)) {
    return { ok: false, error: `invalid role: ${role}` };
  }
  if (typeof content !== 'string' || !content.trim()) {
    return { ok: false, error: 'content must be a non-empty string' };
  }
  if (role === 'dispatch' && (!routing_target || !VALID_AGENTS.has(routing_target))) {
    return { ok: false, error: `dispatch requires valid routing_target, got: ${routing_target}` };
  }

  const row = {
    agent_name: agent,
    role,
    content: content.trim(),
    metadata: metadata || {},
  };
  if (in_reply_to) row.in_reply_to = in_reply_to;
  if (routing_target) row.routing_target = routing_target;

  const { data, error } = await client()
    .from('agent_messages')
    .insert(row)
    .select('id')
    .single();

  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true, id: data.id };
}

/**
 * Read the most recent N messages relevant to an agent — anything
 * authored by it OR dispatched TO it OR an observation/status note.
 *
 * Use this at the START of a sub-agent's task so it knows what the team
 * has been doing.
 *
 * @param {object} opts
 * @param {string} opts.agent      Required — name of the requesting agent
 * @param {number} [opts.limit=50] Max rows
 * @param {string} [opts.since]    ISO timestamp — only messages created at-or-after this
 * @returns {Promise<{ok: boolean, messages?: Array, error?: string}>}
 */
async function readRecentContext({ agent, limit = 50, since }) {
  if (!agent || !VALID_AGENTS.has(agent)) {
    return { ok: false, error: `invalid agent: ${agent}` };
  }
  const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);

  let q = client()
    .from('agent_messages')
    .select('id, agent_name, role, content, in_reply_to, routing_target, metadata, created_at')
    .or(`agent_name.eq.${agent},routing_target.eq.${agent}`)
    .order('created_at', { ascending: false })
    .limit(cap);

  if (since) {
    q = q.gte('created_at', since);
  }

  const { data, error } = await q;
  if (error) {
    return { ok: false, error: error.message };
  }
  // Reverse so the caller gets chronological order (oldest first) — easier
  // to read as a transcript.
  return { ok: true, messages: (data || []).reverse() };
}

/**
 * Read dispatches waiting for a target agent (Phase A: it's just a list,
 * no acknowledgement / consume semantics — that's Phase B).
 *
 * @param {object} opts
 * @param {string} opts.target     Agent name
 * @param {number} [opts.limit=20]
 * @param {string} [opts.since]    ISO timestamp
 * @returns {Promise<{ok: boolean, dispatches?: Array, error?: string}>}
 */
async function readDispatches({ target, limit = 20, since }) {
  if (!target || !VALID_AGENTS.has(target)) {
    return { ok: false, error: `invalid target: ${target}` };
  }
  const cap = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);

  let q = client()
    .from('agent_messages')
    .select('id, agent_name, role, content, routing_target, metadata, created_at')
    .eq('role', 'dispatch')
    .eq('routing_target', target)
    .order('created_at', { ascending: true })
    .limit(cap);

  if (since) {
    q = q.gte('created_at', since);
  }

  const { data, error } = await q;
  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true, dispatches: data || [] };
}

module.exports = {
  writeMessage,
  readRecentContext,
  readDispatches,
  VALID_AGENTS,
  VALID_ROLES,
};
