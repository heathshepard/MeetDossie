#!/usr/bin/env node
// scripts/claude-code-worker.js
//
// Claude Code CLI Worker — the "Heath's laptop as a Max-billed worker" loop.
// Companion to api/claude-code-enqueue.js.
//
// WHAT IT DOES
//   Polls /api/agent-queue-peek for rows with metadata.task_type set (the
//   claude-code-enqueue producer stamps these). For each match:
//     1. POST /api/agent-queue-claim to atomically claim the row
//     2. Look up the handler for metadata.task_type in ./claude-code-task-handlers/
//     3. Invoke the handler with metadata.payload — the handler may run any
//        node code, may spawn `claude --print` for LLM steps (which runs on
//        Heath's Max subscription — free at the margin), and returns a
//        result object
//     4. POST /api/agent-queue-complete with the result
//     5. Sleep POLL_MS, loop
//
// WHY THIS EXISTS (separate from scripts/agent-queue-poller.js)
//   The existing agent-queue-poller spawns full Claude Code sub-agents
//   (Carter/Atlas/etc) with the `claude --print --agent <name>` CLI. That's
//   the right pattern for open-ended agent work — "Carter, ship this diff."
//   THIS worker is for STRUCTURED batch tasks — deterministic JS handlers
//   that happen to call `claude --print` for LLM subgens. Different concern.
//   Both workers can run side-by-side without stepping on each other because
//   the peek endpoint filters by autonomous flag (both) and this worker
//   further filters by task_type presence (only its rows).
//
// COST WIN
//   Every task this worker completes is one that would have burned the
//   pay-per-token Anthropic API. Under Max ($200/mo flat), the marginal
//   cost is $0. Currently identified savings across the batch caller set:
//   ~$17-21/mo (see Engineering/INDEX.md row SV-API-VS-MAX-SPLIT-2026-07-03).
//
// RUN
//   Foreground:  node scripts/claude-code-worker.js --loop
//   Once:        node scripts/claude-code-worker.js --once   (drain up to N)
//   Windows:     Task Scheduler entry — see scripts/register-claude-code-worker.ps1
//                (companion to scripts/register-agent-queue-poller.ps1)
//
// ENV (loaded from MeetDossie/.env.local OR ~/.claude/claude-code-worker.env)
//   CRON_SECRET                — required, Bearer for the queue endpoints
//   CLAUDE_CODE_WORKER_API_BASE  optional, default https://meetdossie.com
//   POLL_MS                    — optional, default 30000
//   MAX_PER_TICK               — optional, default 3 (per-tick claim cap)
//   ANTHROPIC_API_KEY          — NOT needed for the worker itself; handlers
//                                 that shell out to `claude --print` inherit
//                                 Heath's login state from the CLI directly
//
// LOGS
//   C:\Users\Heath Shepard\.claude\claude-code-worker.log (rolling)
//
// OWNER: Atlas, 2026-07-07 (SV-CLAUDE-CODE-CLI-WORKER).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- Paths -----------------------------------------------------------------

const REPO_DIR = path.resolve(__dirname, '..');
const ENV_LOCAL = path.join(REPO_DIR, '.env.local');
const HOME_DIR = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Heath Shepard';
const ENV_FALLBACK = path.join(HOME_DIR, '.claude', 'claude-code-worker.env');
const LOG_PATH = path.join(HOME_DIR, '.claude', 'claude-code-worker.log');
const STATE_PATH = path.join(HOME_DIR, '.claude', 'claude-code-worker.state.json');
const LOG_MAX_LINES = 5000;

const HANDLERS_DIR = path.join(__dirname, 'claude-code-task-handlers');

// ---- Env loader ------------------------------------------------------------

function loadEnvFile(p) {
  try {
    const txt = fs.readFileSync(p, 'utf8');
    txt.split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*"?([^"#\r\n]*)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    });
  } catch (e) {
    // Missing env file is fine — may be provided via system env.
  }
}

loadEnvFile(ENV_LOCAL);
loadEnvFile(ENV_FALLBACK);

const CRON_SECRET = process.env.CRON_SECRET;
const API_BASE = (process.env.CLAUDE_CODE_WORKER_API_BASE || 'https://meetdossie.com').replace(/\/$/, '');
const POLL_MS = Math.max(5000, parseInt(process.env.POLL_MS || '30000', 10));
const MAX_PER_TICK = Math.max(1, parseInt(process.env.MAX_PER_TICK || '3', 10));
const SESSION_ID = `ccworker_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

// ---- Logging ---------------------------------------------------------------

let _lines = 0;
function log(msg, level = 'INFO') {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  process.stdout.write(line + '\n');
  try {
    fs.appendFileSync(LOG_PATH, line + '\n');
    _lines += 1;
    if (_lines >= 50) { rollLog(); _lines = 0; }
  } catch (e) {
    process.stderr.write(`[ccworker] log write failed: ${e.message}\n`);
  }
}

function rollLog() {
  try {
    const txt = fs.readFileSync(LOG_PATH, 'utf8');
    const lines = txt.split(/\r?\n/);
    if (lines.length > LOG_MAX_LINES) {
      fs.writeFileSync(LOG_PATH, lines.slice(-LOG_MAX_LINES).join('\n'));
    }
  } catch { /* best effort */ }
}

// ---- HTTP helpers ----------------------------------------------------------

async function get(pathname) {
  if (!CRON_SECRET) throw new Error('CRON_SECRET not set');
  const res = await fetch(`${API_BASE}${pathname}`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  if (!res.ok) throw new Error(`GET ${pathname} -> ${res.status}: ${(json && json.error) || text || res.statusText}`);
  return json || {};
}

async function post(pathname, body) {
  if (!CRON_SECRET) throw new Error('CRON_SECRET not set');
  const res = await fetch(`${API_BASE}${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CRON_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  if (!res.ok) throw new Error(`POST ${pathname} -> ${res.status}: ${(json && json.error) || text || res.statusText}`);
  return json || {};
}

// ---- Handler registry ------------------------------------------------------

// Handlers are require()'d lazily so a broken handler for one task_type
// doesn't kill the whole worker.
const _handlerCache = new Map();

function loadHandler(taskType) {
  if (_handlerCache.has(taskType)) return _handlerCache.get(taskType);
  const p = path.join(HANDLERS_DIR, `${taskType}.js`);
  if (!fs.existsSync(p)) {
    _handlerCache.set(taskType, null);
    return null;
  }
  try {
    // Bust node's own require cache too so live-editing during dev works
    delete require.cache[require.resolve(p)];
    const mod = require(p);
    if (typeof mod !== 'function' && typeof (mod && mod.run) !== 'function') {
      throw new Error(`handler ${p} must export a function or {run:function}`);
    }
    const fn = typeof mod === 'function' ? mod : mod.run;
    _handlerCache.set(taskType, fn);
    return fn;
  } catch (err) {
    log(`FAILED to load handler ${taskType}: ${err.message}`, 'ERROR');
    _handlerCache.set(taskType, null);
    return null;
  }
}

// ---- Task lifecycle --------------------------------------------------------

async function peekMyTasks() {
  // Pull the top N autonomous-tagged tasks and filter to ones that carry
  // metadata.task_type (i.e. produced by claude-code-enqueue, not by the
  // agent-queue-poller flow). Anything without task_type is not ours.
  const r = await get('/api/agent-queue-peek?autonomous_only=1&limit=50');
  const tasks = Array.isArray(r.tasks) ? r.tasks : [];
  return tasks.filter((t) => t && t.metadata && typeof t.metadata.task_type === 'string');
}

async function claim(agentName, taskId) {
  // Prefer explicit task_id claim (added 2026-07-07) so we grab the row we
  // peeked at instead of "whatever's at the top of this agent's queue" —
  // which could be a non-task_type row belonging to the agent-queue-poller.
  const body = { agent: agentName, session_id: SESSION_ID };
  if (taskId) body.task_id = taskId;
  const r = await post('/api/agent-queue-claim', body);
  return r.task || null;
}

async function complete(taskId, status, resultSummary, extraMeta) {
  return await post('/api/agent-queue-complete', {
    id: taskId,
    status,
    result_summary: resultSummary,
    completed_by_agent_session: SESSION_ID,
    metadata: extraMeta || {},
  });
}

async function runOne(task) {
  const taskType = task.metadata && task.metadata.task_type;
  const payload = (task.metadata && task.metadata.payload) || {};
  const startedAt = Date.now();

  log(`RUN task=${task.id} task_type=${taskType} agent=${task.agent_name}`);

  const handler = loadHandler(taskType);
  if (!handler) {
    const msg = `no handler for task_type=${taskType} (looked at ${path.join(HANDLERS_DIR, taskType + '.js')})`;
    log(msg, 'ERROR');
    await complete(task.id, 'blocked', `BLOCKED: ${msg}`, {
      _worker_session: SESSION_ID,
      _worker_finished_at: new Date().toISOString(),
      _duration_ms: Date.now() - startedAt,
    });
    return { id: task.id, status: 'blocked', reason: 'no_handler' };
  }

  let result;
  try {
    result = await Promise.resolve(handler({
      payload,
      task_id: task.id,
      task_subject: task.task_subject,
      task_brief: task.task_brief,
      agent_name: task.agent_name,
      log: (msg) => log(`  [handler:${taskType}:${task.id.slice(0,8)}] ${msg}`),
    }));
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    const stack = (err && err.stack) ? err.stack.split('\n').slice(0, 5).join(' | ') : '';
    log(`HANDLER THREW task=${task.id} task_type=${taskType}: ${msg}`, 'ERROR');
    await complete(task.id, 'blocked', `BLOCKED: handler threw: ${msg.slice(0, 400)}`, {
      _worker_session: SESSION_ID,
      _worker_finished_at: new Date().toISOString(),
      _duration_ms: Date.now() - startedAt,
      _error_stack: stack,
    });
    return { id: task.id, status: 'blocked', reason: 'handler_threw', error: msg };
  }

  const durationMs = Date.now() - startedAt;

  // Normalize handler return.
  //   Preferred:  { ok: true, summary: string, result: any }
  //   Also OK:    { ok: false, summary: string, error: string }
  //   Loose:      just a string       → treated as summary + ok=true
  let normalized;
  if (typeof result === 'string') {
    normalized = { ok: true, summary: result, result: null };
  } else if (result && typeof result === 'object') {
    normalized = {
      ok: result.ok !== false,
      summary: String(result.summary || result.message || '(no summary)').slice(0, 4000),
      result: result.result === undefined ? null : result.result,
      error: result.error || null,
    };
  } else {
    normalized = { ok: false, summary: '(handler returned nothing)', result: null };
  }

  const finalStatus = normalized.ok ? 'completed' : 'blocked';
  const finalSummary = normalized.ok
    ? normalized.summary
    : `BLOCKED: ${normalized.summary}${normalized.error ? ' — ' + String(normalized.error).slice(0, 400) : ''}`;

  const extraMeta = {
    _worker_session: SESSION_ID,
    _worker_finished_at: new Date().toISOString(),
    _duration_ms: durationMs,
    task_type: taskType,
  };
  // Stash the handler's structured result on the row so downstream consumers
  // (crons, admin views) can read it without re-parsing result_summary.
  if (normalized.result !== null && normalized.result !== undefined) {
    extraMeta.result = normalized.result;
  }

  await complete(task.id, finalStatus, finalSummary, extraMeta);
  log(`${finalStatus.toUpperCase()} task=${task.id} task_type=${taskType} duration=${Math.round(durationMs/1000)}s`);
  return { id: task.id, status: finalStatus, task_type: taskType, duration_ms: durationMs };
}

// ---- Main loop -------------------------------------------------------------

let shuttingDown = false;
let tickCount = 0;

function writeState(inflight) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      session_id: SESSION_ID,
      tick: tickCount,
      inflight,
      last_update: new Date().toISOString(),
    }, null, 2));
  } catch { /* best effort */ }
}

async function tick() {
  tickCount += 1;
  if (shuttingDown) return;

  let candidates;
  try {
    candidates = await peekMyTasks();
  } catch (err) {
    log(`peek error: ${err.message}`, 'WARN');
    return;
  }

  if (candidates.length === 0) {
    writeState([]);
    return;
  }

  // Claim + run up to MAX_PER_TICK sequentially. Sequential (not parallel)
  // because handlers often shell out to `claude --print` which itself is a
  // heavy child; parallelizing would hammer Heath's laptop.
  const results = [];
  for (let i = 0; i < candidates.length && results.length < MAX_PER_TICK; i++) {
    if (shuttingDown) break;
    const c = candidates[i];

    let claimed;
    try {
      // Explicit task_id claim — we peeked this row specifically because it
      // has metadata.task_type. Grab that exact row, not "top of agent queue".
      claimed = await claim(c.agent_name, c.id);
    } catch (err) {
      log(`claim error agent=${c.agent_name} task=${c.id}: ${err.message}`, 'WARN');
      continue;
    }
    if (!claimed) continue;

    // Defense in depth — if for any reason claim returned a row that lost its
    // task_type (shouldn't happen with explicit id claim, but…), release it.
    const claimedType = claimed.metadata && claimed.metadata.task_type;
    if (!claimedType) {
      log(`released agent=${c.agent_name} task=${claimed.id} — no task_type (defense-in-depth)`, 'WARN');
      try {
        await complete(claimed.id, 'blocked', 'Released by claude-code-worker — no task_type set.', {
          _released_by: 'claude-code-worker',
          _released_at: new Date().toISOString(),
        });
      } catch (err) {
        log(`release-via-complete failed task=${claimed.id}: ${err.message}`, 'ERROR');
      }
      continue;
    }

    writeState([{ id: claimed.id, task_type: claimedType, started_at: new Date().toISOString() }]);
    const r = await runOne(claimed);
    results.push(r);
  }

  writeState([]);
  if (results.length > 0) {
    log(`TICK ${tickCount} processed=${results.length} results=${JSON.stringify(results)}`);
  }
}

async function mainLoop() {
  log(`Claude Code CLI Worker starting. session=${SESSION_ID} api=${API_BASE} poll=${POLL_MS}ms max_per_tick=${MAX_PER_TICK}`);

  process.on('SIGINT', () => {
    log('SIGINT received — shutting down after current tick', 'WARN');
    shuttingDown = true;
    setTimeout(() => process.exit(0), 5000);
  });

  // First tick immediately.
  try { await tick(); } catch (err) { log(`tick error: ${err.message}`, 'ERROR'); }

  setInterval(async () => {
    if (shuttingDown) return;
    try { await tick(); } catch (err) { log(`tick error: ${err.message}`, 'ERROR'); }
  }, POLL_MS);
}

async function mainOnce() {
  log(`Claude Code CLI Worker ONE-SHOT. session=${SESSION_ID} api=${API_BASE} max=${MAX_PER_TICK}`);
  try { await tick(); } catch (err) { log(`tick error: ${err.message}`, 'ERROR'); process.exit(1); }
  log('one-shot complete');
  process.exit(0);
}

function main() {
  if (!CRON_SECRET) {
    log('FATAL: CRON_SECRET not set. Add to MeetDossie/.env.local or ~/.claude/claude-code-worker.env', 'FATAL');
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const mode = args.includes('--once') ? 'once' : 'loop';
  if (mode === 'once') return mainOnce();
  return mainLoop();
}

main();
