'use strict';

// api/cron-agent-queue-dispatch.js
// =============================================================================
// Vercel Serverless Function: /api/cron-agent-queue-dispatch
//
// The MISSING CONSUMER PIECE for the agent_queue. The existing
// cron-agent-queue-tick is a stale-sweeper only; cron-process-agent-requests
// drains agent_requests (different table, fed by Sage webhook). This cron
// actually CALLS ANTHROPIC for agent_queue rows (text-only, stateless — no
// file/tool access; that's the poller's job, see scripts/agent-queue-poller.js).
//
// HOW IT WORKS
//   1. SELECT FROM agent_queue_ready (pending + deps satisfied), oldest-first
//      within priority.
//   2. For each row: claim (pending -> in_progress), call Anthropic, then
//      complete via the SHARED core (api/_lib/agent-queue-complete-core.js) —
//      that's what routes a successful completion to 'pending_audit' instead
//      of straight to 'completed' (unless the agent is quinn or the task is
//      tagged metadata.skip_audit=true).
//   3. REAL WORK-STEALING (2026-08-06): completeTask() atomically claims the
//      SAME agent's next ready row before returning. If it got one, we
//      process it immediately too — same invocation, no waiting for the next
//      cron tick — looping until WALL_CLOCK_BUDGET_MS runs out or nothing's
//      left. This is what keeps a productive agent's queue draining fast
//      instead of getting only MAX_PER_RUN rows every 2 minutes.
//
// AUTH
//   Bearer ${CRON_SECRET} OR x-vercel-cron header.
//
// SCHEDULE
//   Every 2 minutes via vercel.json (fixed 2026-08-06 — was drifted to 15min).
//
// OWNER
//   Atlas, 2026-06-25 (SV-ENG-AGENT-QUEUE-PRODUCER). Work-stealing +
//   audit-loop integration 2026-08-06 (SV-ENG-AGENT-QUEUE-AUDIT-LOOP).

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { createClient } = require('@supabase/supabase-js');
const { completeTask } = require('./_lib/agent-queue-complete-core.js');

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY         = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;

const SONNET_MODEL = 'claude-sonnet-5';
const MAX_PER_RUN  = 4;        // rows pulled per ready-view fetch (refilled as the budget allows)
const MAX_TOKENS   = 1500;
const FETCH_TIMEOUT_MS = 45000;
const WALL_CLOCK_BUDGET_MS = 50000; // leaves margin under the 60s function cap (see vercel.json maxDuration)

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

// ─── Supabase REST helper (bulk/raw ops) ──────────────────────────────────────

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
    // Sonnet 5 extended thinking returns content = [thinking_block, text_block].
    // Find the first block(s) with a non-empty .text field.
    const blocks = Array.isArray(data?.content) ? data.content : [];
    const reply = blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return reply;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Single-row processor ─────────────────────────────────────────────────────
//
// `alreadyClaimed`: true when the row was already atomically flipped to
// in_progress by a prior completeTask()'s work-steal — skip re-claiming it.

async function processOne(supabase, row, { alreadyClaimed = false } = {}) {
  const agentName = String(row.agent_name || '').toLowerCase();

  if (!SUPPORTED.has(agentName)) {
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

  let claimedRow = row;
  if (!alreadyClaimed) {
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
    claimedRow = claim.data[0];
  }

  // Call Anthropic with the agent's prompt.
  let replyText;
  try {
    replyText = await callAgent(agentName, claimedRow.task_subject, claimedRow.task_brief, claimedRow.metadata);
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    await sb(`agent_queue?id=eq.${row.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'pending',
        started_at: null,
        metadata: {
          ...(claimedRow.metadata || {}),
          _last_error: msg.slice(0, 500),
          _last_error_at: new Date().toISOString(),
          _retry_count: ((claimedRow.metadata && claimedRow.metadata._retry_count) || 0) + 1,
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
          ...(claimedRow.metadata || {}),
          _last_error: 'empty_reply',
          _last_error_at: new Date().toISOString(),
        },
      }),
    });
    return { id: row.id, status: 'empty', agent: agentName };
  }

  // Complete via the shared core: routes to pending_audit (unless quinn /
  // skip_audit) and atomically steals this agent's next ready row.
  const completion = await completeTask(supabase, {
    id: row.id,
    status: 'completed',
    result_summary: replyText.slice(0, 10000),
    completed_by_agent_session: 'cron-agent-queue-dispatch',
    steal: true,
  });

  // If the queue row referenced a jarvis_future_builds source, mark that
  // source row as 'shipped' so the HUD reflects reality. Only when the task
  // actually reached a terminal 'completed' state (not pending_audit).
  if (
    completion.ok &&
    completion.task &&
    completion.task.status === 'completed' &&
    row.metadata && row.metadata.source_table === 'jarvis_future_builds' && row.metadata.source_id
  ) {
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

  if (!completion.ok) {
    return { id: row.id, status: 'complete_error', agent: agentName, error: completion.error };
  }

  return {
    id: row.id,
    status: completion.task.status, // 'completed' | 'pending_audit'
    agent: agentName,
    stolen_next: completion.stolen_next,
  };
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

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const startedAt = Date.now();

  // ─── Self-healing sweep ──────────────────────────────────────────────────
  // Any row stuck in 'in_progress' for more than STUCK_THRESHOLD_MIN is a
  // dead worker. Split by whether it was an AUDIT claim (metadata
  // ._is_audit_claim) — those must go back to 'pending_audit' (re-enter the
  // audit lane) not 'pending' (which would skip the audit hop entirely).
  //
  // EXEMPTION (Atlas, 2026-08-06, SV-ENG-AGENT-QUEUE-LIVE-DISPATCH): rows
  // tagged metadata._live_dispatch=true (created by api/cole-dispatch-start.js
  // for a live interactive Cole/subagent session, not this dispatcher) are
  // excluded from this 15-minute sweep entirely. A real interactive session
  // routinely runs longer than 15 minutes — this sweep firing on it every
  // ~2 minutes would flip it back to 'pending' out from under an actively
  // running, supervised task, which is wrong (this sweep exists for DEAD
  // workers, not slow live ones). Their safety net is the 4-hour cutoff in
  // cron-agent-queue-orphan-reset.js instead — see that file, unchanged.
  const STUCK_THRESHOLD_MIN = 15;
  const stuckCutoff = new Date(Date.now() - STUCK_THRESHOLD_MIN * 60 * 1000).toISOString();
  const stuckFind = await sb(
    `agent_queue?select=id,metadata&status=eq.in_progress&started_at=lt.${stuckCutoff}&limit=100`,
  );
  const stuckRows = (stuckFind.ok && Array.isArray(stuckFind.data)) ? stuckFind.data : [];
  const liveDispatchIds = stuckRows.filter((r) => r.metadata && r.metadata._live_dispatch === true).map((r) => r.id);
  const auditIds = stuckRows.filter((r) => r.metadata && r.metadata._is_audit_claim === true && r.metadata._live_dispatch !== true).map((r) => r.id);
  const normalIds = stuckRows.filter((r) => !(r.metadata && (r.metadata._is_audit_claim === true || r.metadata._live_dispatch === true))).map((r) => r.id);

  let sweptCount = 0;
  if (normalIds.length > 0) {
    const idList = normalIds.join(',');
    const patch = await sb(`agent_queue?id=in.(${idList})`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'pending', started_at: null }),
    });
    sweptCount += Array.isArray(patch.data) ? patch.data.length : 0;
  }
  if (auditIds.length > 0) {
    for (const id of auditIds) {
      const row = stuckRows.find((r) => r.id === id);
      const meta = { ...(row.metadata || {}), _is_audit_claim: false, _audit_claimed_by: null };
      await sb(`agent_queue?id=eq.${id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'pending_audit', started_at: null, metadata: meta }),
      });
      sweptCount += 1;
    }
  }
  if (sweptCount > 0 || liveDispatchIds.length > 0) {
    console.log(`[cron-agent-queue-dispatch] self-heal swept ${sweptCount} stuck row(s) (${normalIds.length} normal, ${auditIds.length} audit) older than ${STUCK_THRESHOLD_MIN}m; skipped ${liveDispatchIds.length} live-dispatch row(s) (4h orphan-reset covers those)`);
  }

  // ─── Main loop — real work-stealing, bounded by wall-clock budget ────────
  const results = [];
  const seen = new Set();

  async function drainOne(row, alreadyClaimed) {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    const r = await processOne(supabase, row, { alreadyClaimed });
    results.push(r);
    // Chase the stolen row immediately, same invocation, same agent.
    let stolen = r.stolen_next;
    while (stolen && Date.now() - startedAt < WALL_CLOCK_BUDGET_MS && !seen.has(stolen.id)) {
      seen.add(stolen.id);
      const r2 = await processOne(supabase, stolen, { alreadyClaimed: true });
      results.push(r2);
      stolen = r2.stolen_next;
    }
  }

  while (Date.now() - startedAt < WALL_CLOCK_BUDGET_MS) {
    const { ok, data } = await sb(
      `agent_queue_ready?select=id,agent_name,task_subject,task_brief,priority,depends_on,metadata,venture` +
      `&order=priority.asc,created_at.asc&limit=${MAX_PER_RUN}`,
    );
    if (!ok) break;
    const batch = (Array.isArray(data) ? data : []).filter((r) => !seen.has(r.id));
    if (batch.length === 0) break;

    for (const row of batch) {
      if (Date.now() - startedAt >= WALL_CLOCK_BUDGET_MS) break;
      await drainOne(row, false);
    }
  }

  return res.status(200).json({
    ok: true,
    processed: results.length,
    swept: sweptCount,
    swept_audit: auditIds.length,
    results,
    duration_ms: Date.now() - startedAt,
    at: new Date().toISOString(),
  });
}

module.exports = withTelemetry('cron-agent-queue-dispatch', handler);
