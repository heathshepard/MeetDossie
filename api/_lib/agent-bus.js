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

// agent_queue ventures (mirrors api/queue-task.js VALID_VENTURES)
const VALID_VENTURES = new Set([
  'dossie', 'paralegal', 'personal-agents', 'shepard-ventures', 'general',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * Enqueue a task for an agent in agent_queue — the canonical server-side
 * helper for task dispatch. Call this from any API route or server lib
 * instead of raw-fetching /api/queue-task.
 *
 * Writes directly to Supabase (service-role) — no HTTP round-trip.
 * Retries 3× on transient Supabase errors (network / 5xx).
 *
 * @param {object} opts
 * @param {string}   opts.agent        Target agent name (cole|atlas|carter|…)
 * @param {string}   opts.subject      Short task subject (max 200 chars)
 * @param {string}   opts.brief        Full task brief / prompt
 * @param {number}   [opts.priority=3] 1 (critical) – 5 (background)
 * @param {string[]} [opts.depends_on] Array of prerequisite task UUIDs
 * @param {string}   [opts.venture]    One of VALID_VENTURES (default 'general')
 * @param {object}   [opts.metadata]   Arbitrary JSONB payload
 * @returns {Promise<{ok: boolean, id?: string, queued_at?: string, position_in_agent_queue?: number, error?: string}>}
 */
async function queueTask({
  agent,
  subject,
  brief,
  priority = 3,
  depends_on = [],
  venture = 'general',
  metadata = {},
} = {}) {
  // --- Validate inputs ---
  const agentNorm = String(agent || '').toLowerCase().trim();
  if (!VALID_AGENTS.has(agentNorm)) {
    return { ok: false, error: `queueTask: invalid agent '${agent}'. Must be one of: ${[...VALID_AGENTS].join(', ')}` };
  }

  const task_subject = String(subject || '').trim();
  if (!task_subject) {
    return { ok: false, error: 'queueTask: subject is required' };
  }
  if (task_subject.length > 200) {
    return { ok: false, error: `queueTask: subject exceeds 200 chars (got ${task_subject.length})` };
  }

  const task_brief = String(brief || '').trim();
  if (!task_brief) {
    return { ok: false, error: 'queueTask: brief is required' };
  }

  const pri = Number.isFinite(Number(priority)) ? Math.floor(Number(priority)) : 3;
  if (pri < 1 || pri > 5) {
    return { ok: false, error: `queueTask: priority must be 1-5, got ${priority}` };
  }

  const ventureNorm = String(venture || 'general').toLowerCase().trim();
  if (!VALID_VENTURES.has(ventureNorm)) {
    return { ok: false, error: `queueTask: invalid venture '${venture}'. Must be one of: ${[...VALID_VENTURES].join(', ')}` };
  }

  const deps = Array.isArray(depends_on) ? depends_on.filter(Boolean) : [];
  for (const u of deps) {
    if (typeof u !== 'string' || !UUID_RE.test(u)) {
      return { ok: false, error: `queueTask: depends_on contains invalid UUID: ${u}` };
    }
  }

  const meta = (metadata && typeof metadata === 'object' && !Array.isArray(metadata))
    ? metadata
    : {};

  // --- Insert with retry ---
  const MAX_ATTEMPTS = 3;
  const BASE_DELAY_MS = 500;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let data, error;
    try {
      ({ data, error } = await client()
        .from('agent_queue')
        .insert({
          agent_name: agentNorm,
          task_subject,
          task_brief,
          priority: pri,
          depends_on: deps,
          venture: ventureNorm,
          metadata: meta,
        })
        .select('id, created_at')
        .single());
    } catch (networkErr) {
      lastError = `network error: ${networkErr.message}`;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, BASE_DELAY_MS * Math.pow(2, attempt - 1)));
        continue;
      }
      return { ok: false, error: `queueTask: ${lastError}` };
    }

    if (error) {
      lastError = error.message;
      // Only retry on transient errors (not constraint / validation errors)
      const isTransient = error.code === 'PGRST' || error.message?.includes('timeout') || error.message?.includes('503');
      if (isTransient && attempt < MAX_ATTEMPTS) {
        console.warn(`[agent-bus] queueTask attempt ${attempt} failed (${error.message}), retrying…`);
        await new Promise(r => setTimeout(r, BASE_DELAY_MS * Math.pow(2, attempt - 1)));
        continue;
      }
      return { ok: false, error: `queueTask: insert failed: ${error.message}` };
    }

    // Success — fetch position (how many pending tasks ahead for this agent)
    const { count: ahead } = await client()
      .from('agent_queue')
      .select('id', { count: 'exact', head: true })
      .eq('agent_name', agentNorm)
      .eq('status', 'pending')
      .or(`priority.lt.${pri},and(priority.eq.${pri},created_at.lt.${data.created_at})`);

    return {
      ok: true,
      id: data.id,
      queued_at: data.created_at,
      agent: agentNorm,
      priority: pri,
      venture: ventureNorm,
      position_in_agent_queue: (ahead || 0) + 1, // 1-indexed
    };
  }

  return { ok: false, error: `queueTask: failed after ${MAX_ATTEMPTS} attempts: ${lastError}` };
}

module.exports = {
  writeMessage,
  readRecentContext,
  readDispatches,
  queueTask,
  VALID_AGENTS,
  VALID_ROLES,
  VALID_VENTURES,
};
