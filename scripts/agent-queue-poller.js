#!/usr/bin/env node
// scripts/agent-queue-poller.js
//
// Agent Queue Poller (Atlas, 2026-06-17)
//
// Heath's directive: agents constantly working, never idle. As soon as one
// finishes, they pick up the next task. Heath is not the bottleneck.
//
// This script is the local pump that makes that real. It loops every POLL_MS,
// claims the next ready task from agent_queue via the /api/agent-queue-claim
// HTTP endpoint, spawns the matching agent locally via the `claude` CLI in
// --print mode, waits for completion, then reports back via
// /api/agent-queue-complete. Concurrency capped at MAX_CONCURRENT so Heath's
// laptop doesn't melt.
//
// v1 pattern: pure-headless local spawn. Each agent is invoked as:
//   claude --print --agent <name> --dangerously-skip-permissions \
//          --output-format json --max-budget-usd 5 "<task_brief>"
// stdout is captured as the result_summary.
//
// Why local spawn (vs Cole-reads-queue):
//   Local agents have full tool access (Edit, Bash, MCP servers). Cole reading
//   a queue inbox would still need to spawn locally anyway — the poller just
//   cuts Cole out of the relay loop.
//
// Run via Windows Task Scheduler — see scripts/register-agent-queue-poller.ps1.
//
// Env requirements (read from MeetDossie/.env.local OR ~/.claude/agent-poller.env):
//   CRON_SECRET           — required, Bearer header for queue endpoints
//   AGENT_POLLER_API_BASE — optional, default https://meetdossie.com
//   POLL_MS               — optional, default 60000
//   MAX_CONCURRENT        — optional, default 3
//   ANTHROPIC_API_KEY     — required for spawned claude --print calls
//                            (claude CLI reads this from env automatically;
//                             the poller does NOT need it directly)
//
// Logs to C:\Users\Heath Shepard\.claude\agent-poller.log (rolling).

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

// ---- Paths ------------------------------------------------------------------

const REPO_DIR = path.resolve(__dirname, '..');
const ENV_LOCAL = path.join(REPO_DIR, '.env.local');
const HOME_DIR = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Heath Shepard';
const ENV_FALLBACK = path.join(HOME_DIR, '.claude', 'agent-poller.env');
const LOG_PATH = path.join(HOME_DIR, '.claude', 'agent-poller.log');
const STATE_PATH = path.join(HOME_DIR, '.claude', 'agent-poller.state.json');
const LOG_MAX_LINES = 5000;

// ---- Env loader -------------------------------------------------------------

function loadEnvFile(p) {
  try {
    const txt = fs.readFileSync(p, 'utf8');
    txt.split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*"?([^"#\r\n]*)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    });
  } catch (e) {
    // Missing file is fine; we may have what we need via system env.
  }
}

loadEnvFile(ENV_LOCAL);
loadEnvFile(ENV_FALLBACK);

const CRON_SECRET = process.env.CRON_SECRET;
const API_BASE = (process.env.AGENT_POLLER_API_BASE || 'https://meetdossie.com').replace(/\/$/, '');
const POLL_MS = Math.max(15000, parseInt(process.env.POLL_MS || '60000', 10));
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.MAX_CONCURRENT || '3', 10));
const SESSION_ID = `poller_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

// Per-agent timeout — most tasks should not run >25 min. Carter rules cap diffs
// at ~20 lines so even big builds wrap quickly. Watchdog kills past this.
const SPAWN_TIMEOUT_MS = parseInt(process.env.SPAWN_TIMEOUT_MS || `${25 * 60 * 1000}`, 10);
const SPAWN_MAX_BUDGET_USD = parseFloat(process.env.SPAWN_MAX_BUDGET_USD || '5');

// Agents the poller will spawn locally. Cole intentionally not here — Cole is
// the user-facing chief of staff and is always interactive.
const SPAWNABLE_AGENTS = new Set(['carter', 'atlas', 'sage', 'pierce', 'hadley', 'quinn', 'sterling', 'ridge']);

// Resolve claude.exe direct (avoid the .cmd shim — shell:true on Windows
// mangles argv via cmd.exe quoting). Falls back to PATH lookup if the well-
// known npm-global path isn't there.
const CLAUDE_EXE_DIRECT = path.join(
  process.env.APPDATA || path.join(HOME_DIR, 'AppData', 'Roaming'),
  'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'
);
const CLAUDE_BIN = (() => {
  try { if (fs.existsSync(CLAUDE_EXE_DIRECT)) return CLAUDE_EXE_DIRECT; } catch {}
  return process.platform === 'win32' ? 'claude.cmd' : 'claude';
})();

// Safety gate: only auto-spawn tasks explicitly marked autonomous. Heath wants
// "agents never idle" but many queued tasks require approvals / customer
// contact / browser sessions the headless agent can't do. Tasks must have
// metadata.autonomous=true OR metadata.is_smoke_test=true to be claimed.
// Cole + Heath can still hand-walk the rest interactively.
const AUTONOMOUS_ONLY = (process.env.AUTONOMOUS_ONLY || 'true').toLowerCase() !== 'false';

// ---- Logging ----------------------------------------------------------------

let _logBuffer = [];
function log(msg, level = 'INFO') {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  // Echo to stdout so Task Scheduler / interactive runs see it.
  process.stdout.write(line + '\n');
  try {
    fs.appendFileSync(LOG_PATH, line + '\n');
    _logBuffer.push(line);
    if (_logBuffer.length > 50) rollLog();
  } catch (e) {
    process.stderr.write(`[poller] log write failed: ${e.message}\n`);
  }
}

function rollLog() {
  try {
    const txt = fs.readFileSync(LOG_PATH, 'utf8');
    const lines = txt.split(/\r?\n/);
    if (lines.length > LOG_MAX_LINES) {
      fs.writeFileSync(LOG_PATH, lines.slice(-LOG_MAX_LINES).join('\n'));
    }
    _logBuffer = [];
  } catch {
    // best effort
  }
}

// ---- HTTP helpers (Node 18+ fetch) ------------------------------------------

async function post(pathname, body) {
  if (!CRON_SECRET) throw new Error('CRON_SECRET not set');
  const url = `${API_BASE}${pathname}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CRON_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  if (!res.ok) {
    const errMsg = (json && json.error) || text || `HTTP ${res.status}`;
    const err = new Error(`POST ${pathname} -> ${res.status}: ${errMsg}`);
    err.status = res.status;
    throw err;
  }
  return json || {};
}

// ---- Local spawn ------------------------------------------------------------

// Heartbeat for in-flight tasks: every 2 min, push last_heartbeat_at by
// updating agent_state via /api/agent-queue-claim is wrong — that endpoint
// claims. Instead we touch via /api/agent-queue-tick which the cron also
// uses for sweeps. Simpler: include the heartbeat as a metadata patch on
// complete. The stale-sweep timeout is 30 min and Claude tasks usually
// finish well inside that window; if not, the watchdog cleans up.

async function spawnAgent(task) {
  // task: { id, agent_name, task_subject, task_brief, priority, venture, metadata }
  if (!SPAWNABLE_AGENTS.has(task.agent_name)) {
    return {
      ok: false,
      summary: `agent '${task.agent_name}' not in poller spawn list (Cole/interactive-only)`,
      duration_ms: 0,
    };
  }

  const started = Date.now();

  // Build the prompt — embed the subject + brief + meta context so the agent
  // has full task framing without having to query the queue.
  const prompt = [
    `# Agent Queue Task`,
    ``,
    `**Task ID:** ${task.id}`,
    `**Subject:** ${task.task_subject}`,
    `**Venture:** ${task.venture}`,
    `**Priority:** ${task.priority} (1=critical, 5=background)`,
    ``,
    `## Brief`,
    ``,
    task.task_brief,
    ``,
    `## Reporting`,
    ``,
    `When done, end your final assistant message with a 1-3 sentence result summary the poller will record back to the queue. Format:`,
    ``,
    `RESULT_SUMMARY: <your summary here>`,
    ``,
    `If you cannot complete because of a hard blocker, start your summary with BLOCKED: and explain.`,
  ].join('\n');

  return new Promise((resolve) => {
    // claude CLI args. --dangerously-skip-permissions because the poller runs
    // unattended; --print to exit after one turn; --agent picks the right
    // sub-agent identity from ~/.claude/agents/*.md.
    // Model selection: default sonnet (5-10x cheaper than opus per task).
    // Override per-task via metadata.model = 'opus' for genuine deep-work
    // (Carter complex refactors, Atlas architecture decisions).
    const model = (task.metadata && task.metadata.model) ? String(task.metadata.model) : 'sonnet';

    // No prompt in argv — pipe via stdin so we don't trip Windows cmd.exe
    // quoting rules or argv length limits on long briefs.
    // Fallback must differ from primary (claude.exe errors otherwise).
    const fallback = model === 'sonnet' ? 'opus' : 'sonnet';
    const args = [
      '--print',
      '--agent', task.agent_name,
      '--model', model,
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      '--max-budget-usd', String(SPAWN_MAX_BUDGET_USD),
      '--fallback-model', fallback,
    ];

    log(`SPAWN ${task.agent_name} task=${task.id} model=${model} subject="${task.task_subject.slice(0, 60)}"`);

    let stdoutBuf = '';
    let stderrBuf = '';
    let killed = false;

    const child = spawn(CLAUDE_BIN, args, {
      cwd: REPO_DIR,
      env: process.env,
      shell: false,                // crucial — avoid cmd.exe argv mangling
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Pipe prompt via stdin then close.
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (e) {
      log(`stdin write failed: ${e.message}`, 'ERROR');
    }

    const timer = setTimeout(() => {
      killed = true;
      log(`TIMEOUT ${task.agent_name} task=${task.id} after ${SPAWN_TIMEOUT_MS}ms — killing`, 'WARN');
      try { child.kill('SIGKILL'); } catch { /* swallow */ }
    }, SPAWN_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdoutBuf += d.toString(); });
    child.stderr.on('data', (d) => { stderrBuf += d.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      log(`SPAWN ERROR ${task.agent_name} task=${task.id}: ${err.message}`, 'ERROR');
      resolve({
        ok: false,
        summary: `claude CLI spawn error: ${err.message}`,
        duration_ms: Date.now() - started,
        stdout: '',
        stderr: stderrBuf,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const duration_ms = Date.now() - started;
      const stdout = stdoutBuf.slice(-20000); // cap
      const stderr = stderrBuf.slice(-4000);

      if (killed) {
        return resolve({
          ok: false,
          summary: `BLOCKED: poller timed out after ${Math.round(SPAWN_TIMEOUT_MS / 60000)}min and killed the agent.`,
          duration_ms, stdout, stderr,
        });
      }

      let summary = '';
      // Try to parse JSON output (--output-format json wraps the response).
      try {
        const parsed = JSON.parse(stdout);
        if (parsed && parsed.result) summary = String(parsed.result).trim();
      } catch {
        summary = stdout.trim();
      }

      // Extract RESULT_SUMMARY: tag if present (more reliable than full body).
      const tagMatch = summary.match(/RESULT_SUMMARY:\s*([^\n]+(?:\n(?!RESULT_SUMMARY)[^\n]+)*)/);
      let resultSummary;
      if (tagMatch) {
        resultSummary = tagMatch[1].trim();
      } else {
        // Fall back to last 800 chars of stdout (usually contains final message).
        resultSummary = summary.slice(-800).trim();
      }

      const blocked = /^BLOCKED:/i.test(resultSummary);
      const ok = code === 0 && !blocked && resultSummary.length > 0;

      log(`DONE ${task.agent_name} task=${task.id} code=${code} blocked=${blocked} duration=${Math.round(duration_ms / 1000)}s`);
      // Surface stderr/stdout on non-zero exits — silent failures eat hours.
      if (code !== 0) {
        if (stderr) log(`  stderr: ${stderr.replace(/\n/g, ' | ').slice(0, 400)}`, 'WARN');
        if (stdout && !stderr) log(`  stdout: ${stdout.replace(/\n/g, ' | ').slice(0, 400)}`, 'WARN');
      }

      resolve({
        ok,
        blocked,
        summary: resultSummary || `(no result, exit code ${code})`,
        duration_ms,
        stdout, stderr,
      });
    });
  });
}

// ---- Queue ops --------------------------------------------------------------

async function peekReady() {
  // /api/agent-queue-peek returns ready tasks with metadata. If the endpoint
  // is not deployed yet (404 on prod before staging→main), return null so
  // claimNext can fall back gracefully.
  try {
    const r = await fetch(`${API_BASE}/api/agent-queue-peek?autonomous_only=1&limit=20`, {
      headers: { 'Authorization': `Bearer ${CRON_SECRET}` },
    });
    if (!r.ok) {
      if (r.status === 404) return null; // not deployed yet
      log(`peek HTTP ${r.status}: ${await r.text()}`, 'WARN');
      return null;
    }
    const j = await r.json();
    return j.tasks || [];
  } catch (e) {
    log(`peek error: ${e.message}`, 'WARN');
    return null;
  }
}

async function claimNext() {
  if (AUTONOMOUS_ONLY) {
    const candidates = await peekReady();
    if (candidates === null) {
      // peek endpoint not available yet. Sleep rather than rampage through
      // non-autonomous tasks. Deploy /api/agent-queue-peek to enable.
      log('AUTONOMOUS_ONLY but peek endpoint unavailable — sleeping (deploy /api/agent-queue-peek)', 'WARN');
      return null;
    }
    if (candidates.length === 0) return null;

    const next = candidates[0];
    const r = await post('/api/agent-queue-claim', {
      agent: next.agent_name,
      session_id: SESSION_ID,
    });
    const claimed = r.task;
    if (!claimed) return null;
    const cm = claimed.metadata || {};
    if (!(cm.autonomous === true || cm.is_smoke_test === true)) {
      // Concurrent insert or stale peek — release back to pending via complete
      // with a 'released' note. The cron-tick will set it back to pending on
      // its next sweep (stale-sweep treats blocked rows w/ note as releasable).
      log(`claim race: got non-autonomous row ${claimed.id} — marking blocked for re-review`, 'WARN');
      try {
        await post('/api/agent-queue-complete', {
          id: claimed.id,
          status: 'blocked',
          result_summary: 'Released by poller — task not tagged autonomous. Cole/Heath to retag if safe.',
          completed_by_agent_session: SESSION_ID,
          metadata: { _released_by_poller: true },
        });
      } catch (e) {
        log(`release-via-complete failed: ${e.message}`, 'ERROR');
      }
      return null;
    }
    return claimed;
  }

  // AUTONOMOUS_ONLY=false: any-task mode (sensitive — only when entire queue
  // is known autonomous-safe). Reserved for diagnostics.
  const r = await post('/api/agent-queue-claim', {
    agent: 'any',
    session_id: SESSION_ID,
  });
  return r.task || null;
}

async function complete(taskId, result) {
  const status = result.ok ? 'completed' : (result.blocked ? 'blocked' : 'blocked');
  await post('/api/agent-queue-complete', {
    id: taskId,
    status,
    result_summary: result.summary,
    completed_by_agent_session: SESSION_ID,
    metadata: {
      duration_ms: result.duration_ms,
      _poller_session: SESSION_ID,
      _poller_finished_at: new Date().toISOString(),
    },
  });
}

// ---- State (for visibility/debug) ------------------------------------------

function writeState(s) {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); } catch { /* swallow */ }
}

// ---- Main loop --------------------------------------------------------------

const inflight = new Map(); // taskId -> { agent_name, started_at }
let shuttingDown = false;
let tickCount = 0;

async function tick() {
  tickCount += 1;
  if (shuttingDown) return;

  // Don't pull more if at concurrency cap.
  while (inflight.size < MAX_CONCURRENT && !shuttingDown) {
    let task;
    try {
      task = await claimNext();
    } catch (err) {
      log(`claim error: ${err.message}`, 'ERROR');
      break;
    }
    if (!task) break;

    inflight.set(task.id, {
      agent_name: task.agent_name,
      subject: task.task_subject,
      started_at: new Date().toISOString(),
    });

    // Fire-and-forget — spawn, wait, complete.
    (async () => {
      let result;
      try {
        result = await spawnAgent(task);
      } catch (err) {
        log(`spawn caught: ${err.message}`, 'ERROR');
        result = { ok: false, summary: `poller crash during spawn: ${err.message}`, duration_ms: 0 };
      }
      try {
        await complete(task.id, result);
      } catch (err) {
        log(`complete error task=${task.id}: ${err.message}`, 'ERROR');
      } finally {
        inflight.delete(task.id);
        writeState({
          session_id: SESSION_ID,
          tick: tickCount,
          inflight: [...inflight.entries()].map(([id, m]) => ({ id, ...m })),
          last_update: new Date().toISOString(),
        });
      }
    })();
  }

  writeState({
    session_id: SESSION_ID,
    tick: tickCount,
    inflight: [...inflight.entries()].map(([id, m]) => ({ id, ...m })),
    last_update: new Date().toISOString(),
  });
}

async function main() {
  if (!CRON_SECRET) {
    log('FATAL: CRON_SECRET not set. Add to .env.local or ~/.claude/agent-poller.env', 'FATAL');
    process.exit(2);
  }

  log(`Agent Queue Poller starting. session=${SESSION_ID} api=${API_BASE} poll=${POLL_MS}ms concurrency=${MAX_CONCURRENT}`);

  process.on('SIGINT', async () => {
    log('SIGINT received — draining', 'WARN');
    shuttingDown = true;
    // Wait up to 30s for inflight to drain.
    const deadline = Date.now() + 30000;
    while (inflight.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    log(`shutdown. ${inflight.size} still inflight (queue rows will be auto-recovered by stale-sweep cron).`);
    process.exit(0);
  });

  // First tick now.
  await tick();

  // Then on interval.
  setInterval(() => { tick().catch((e) => log(`tick error: ${e.message}`, 'ERROR')); }, POLL_MS);
}

main().catch((err) => {
  log(`FATAL main: ${err.stack || err.message}`, 'FATAL');
  process.exit(1);
});
