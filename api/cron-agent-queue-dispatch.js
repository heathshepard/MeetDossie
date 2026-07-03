'use strict';

// api/cron-agent-queue-dispatch.js
// =============================================================================
// Vercel Serverless Function: /api/cron-agent-queue-dispatch
//
// The MISSING CONSUMER PIECE for the agent_queue. The existing
// cron-agent-queue-tick is a stale-sweeper only; cron-process-agent-requests
// drains agent_requests (different table, fed by Sage webhook). NOTHING was
// actually CALLING ANTHROPIC for agent_queue rows. This cron fixes that.
//
// HOW IT WORKS
//   1. SELECT FROM agent_queue_ready (the view that already filters pending +
//      deps satisfied) ORDER BY priority ASC, created_at ASC, LIMIT MAX_PER_RUN.
//   2. For each row:
//        a. Mark in_progress + started_at (single-row atomic; prevents double-pick
//           if two ticks overlap).
//        b. Load the agent system prompt from ./_lib/agent-prompts/<agent>.js.
//        c. POST to Anthropic /v1/messages with task_subject + task_brief as the
//           user message.
//        d. On success: write result_summary, status='completed', completed_at.
//        e. On failure: status back to 'pending' with metadata._last_error set
//           (so we retry next tick, but with visibility).
//   3. Cap each tick at MAX_PER_RUN to stay inside Vercel's 60s function budget.
//
// AUTH
//   Bearer ${CRON_SECRET} OR x-vercel-cron header.
//
// SCHEDULE
//   Every 2 minutes via vercel.json. Aggressive enough to keep agents busy,
//   slow enough that one stuck task doesn't burn the worker budget.
//
// OWNER
//   Atlas, 2026-06-25 (SV-ENG-AGENT-QUEUE-PRODUCER).

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY         = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;

const SONNET_MODEL = 'claude-sonnet-5';
const MAX_PER_RUN  = 4;        // bounded so each cron tick stays under 60s
const MAX_TOKENS   = 1500;
const FETCH_TIMEOUT_MS = 45000;

const AGENT_PROMPTS = {
  carter:   require('./_lib/agent-prompts/carter.js'),
  atlas:    require('./_lib/agent-prompts/atlas.js'),
  pierce:   require('./_lib/agent-prompts/pierce.js'),
  hadley:   require('./_lib/agent-prompts/hadley.js'),
  quinn:    require('./_lib/agent-prompts/quinn.js'),
  sage:     require('./_lib/agent-prompts/sage.js'),
  ridge:    require('./_lib/agent-prompts/ridge.js'),
  sterling: require('./_lib/agent-prompts/sterling.js'),
};

const SUPPORTED = new Set(Object.keys(AGENT_PROMPTS));

// ─── Supabase REST helper ─────────────────────────────────────────────────────

async function sb(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// ─── Anthropic call with timeout ──────────────────────────────────────────────

async function callAgent(agentName, taskSubject, taskBrief, metadata) {
  const systemPrompt = AGENT_PROMPTS[agentName];
  if (!systemPrompt) throw new Error(`no_prompt_for_agent:${agentName}`);

  const userMessage = [
    `# Task: ${taskSubject || '(no subject)'}`,
    '',
    taskBrief || '(no brief provided)',
    metadata && metadata.source ? `\n_Source: ${metadata.source}_` : '',
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`anthropic_${res.status}:${text.slice(0, 200)}`);
    }
    const data = JSON.parse(text);
    const reply = data?.content?.[0]?.text || '';
    return reply;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Single-row processor ─────────────────────────────────────────────────────

async function processOne(row) {
  const agentName = String(row.agent_name || '').toLowerCase();

  if (!SUPPORTED.has(agentName)) {
    // Mark as failed without burning Anthropic budget.
    await sb(`agent_queue?id=eq.${row.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'blocked',
        metadata: {
          ...(row.metadata || {}),
          _last_error: `unsupported_agent:${agentName}`,
          _failed_at: new Date().toISOString(),
        },
      }),
    });
    return { id: row.id, status: 'unsupported', agent: agentName };
  }

  // 1. Atomic claim: pending → in_progress. If somebody else flipped it,
  //    skip silently (only updates rows still in pending).
  const claim = await sb(`agent_queue?id=eq.${row.id}&status=eq.pending`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      status: 'in_progress',
      started_at: new Date().toISOString(),
    }),
  });
  if (!claim.ok || !Array.isArray(claim.data) || claim.data.length === 0) {
    return { id: row.id, status: 'already_claimed' };
  }

  // 2. Call Anthropic with the agent's prompt.
  let replyText;
  try {
    replyText = await callAgent(agentName, row.task_subject, row.task_brief, row.metadata);
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    // Reset to pending so next tick retries; record the error.
    await sb(`agent_queue?id=eq.${row.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'pending',
        started_at: null,
        metadata: {
          ...(row.metadata || {}),
          _last_error: msg.slice(0, 500),
          _last_error_at: new Date().toISOString(),
          _retry_count: ((row.metadata && row.metadata._retry_count) || 0) + 1,
        },
      }),
    });
    return { id: row.id, status: 'error', agent: agentName, error: msg.slice(0, 200) };
  }

  if (!replyText) {
    await sb(`agent_queue?id=eq.${row.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'pending',
        started_at: null,
        metadata: {
          ...(row.metadata || {}),
          _last_error: 'empty_reply',
          _last_error_at: new Date().toISOString(),
        },
      }),
    });
    return { id: row.id, status: 'empty', agent: agentName };
  }

  // 3. Write result + mark completed.
  await sb(`agent_queue?id=eq.${row.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'completed',
      completed_at: new Date().toISOString(),
      result_summary: replyText.slice(0, 10000),
      completed_by_agent_session: 'cron-agent-queue-dispatch',
    }),
  });

  // 4. If the queue row referenced a jarvis_future_builds source, mark that
  //    source row as 'shipped' so the HUD reflects reality.
  if (row.metadata && row.metadata.source_table === 'jarvis_future_builds' && row.metadata.source_id) {
    await sb(`jarvis_future_builds?id=eq.${row.metadata.source_id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'shipped',
        archived_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    }).catch(() => {}); // soft fail
  }

  return { id: row.id, status: 'completed', agent: agentName };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

async function handler(req, res) {
  const auth = req.headers.authorization || '';
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const isCronSecret = CRON_SECRET && auth === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isCronSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (missing.length) {
    return res.status(500).json({ ok: false, error: `missing_env:${missing.join(',')}` });
  }

  // Pull from the ready view (deps satisfied). Priority ASC so 1 ships before 5.
  const { ok, data, status } = await sb(
    `agent_queue_ready?select=id,agent_name,task_subject,task_brief,priority,depends_on,metadata,venture` +
    `&order=priority.asc,created_at.asc&limit=${MAX_PER_RUN}`,
  );
  if (!ok) {
    return res.status(500).json({ ok: false, error: `supabase_${status}` });
  }
  if (!Array.isArray(data) || data.length === 0) {
    return res.status(200).json({ ok: true, processed: 0, results: [] });
  }

  const results = [];
  for (const row of data) {
    try {
      const r = await processOne(row);
      results.push(r);
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      console.error('[cron-agent-queue-dispatch] processOne crashed:', msg);
      results.push({ id: row.id, status: 'crashed', error: msg.slice(0, 200) });
    }
  }

  return res.status(200).json({
    ok: true,
    processed: results.length,
    results,
    at: new Date().toISOString(),
  });
}

module.exports = withTelemetry('cron-agent-queue-dispatch', handler);
