// scripts/claude-code-task-handlers/_lib/claude-spawn.js
//
// Shared "spawn claude --print" utility for Claude Code CLI worker task
// handlers. Mirrors the runClaude() closure originally inlined in
// fable_script_gen.js so every new handler doesn't reinvent the wheel.
//
// Owner: Atlas, 2026-07-08 (Phase 5/6 social overhaul).

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// The Windows profile is "Heath", not "Heath Shepard" — that path has not
// existed since the machine was rebuilt.
const HOME_DIR = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Heath';

// Checked in order. The native installer puts claude.exe under
// %USERPROFILE%\.local\bin, which is where it actually lives on this machine;
// the npm-global location is the older layout and is kept as a fallback.
// Neither is on the Windows PATH, so bare "claude.cmd" does not resolve —
// that failure surfaces as "not recognized as an internal or external command"
// long after the spawn appears to succeed.
const CLAUDE_CANDIDATES = [
  path.join(HOME_DIR, '.local', 'bin', 'claude.exe'),
  path.join(
    process.env.APPDATA || path.join(HOME_DIR, 'AppData', 'Roaming'),
    'npm', 'node_modules', '@anthropic-ai/claude-code', 'bin', 'claude.exe'
  ),
];

const CLAUDE_BIN = (() => {
  for (const c of CLAUDE_CANDIDATES) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return process.platform === 'win32' ? 'claude.cmd' : 'claude';
})();

// Node 18.20 / 20.12 closed CVE-2024-27980 by refusing to spawn .cmd and .bat
// without a shell — it throws EINVAL. When we fall back to claude.cmd (i.e.
// the .exe wasn't found) we therefore MUST pass shell:true, or every handler
// dies before Claude ever starts. The failure reads like Claude is broken
// rather than like a spawn problem, which is what makes it worth a comment.
const NEEDS_SHELL = process.platform === 'win32' && /\.(cmd|bat)$/i.test(CLAUDE_BIN);

// This whole worker exists so batch/agent work runs under Heath's Max
// subscription instead of pay-per-token API billing (see the COST WIN note
// in api/claude-code-enqueue.js). If ANTHROPIC_API_KEY (or a couple of other
// known auth-override vars) is sitting in the parent shell's environment for
// ANY reason, the CLI silently prefers it over the claude.ai login and bills
// the API key instead — the opposite of the entire point of this file.
// Strip them from the child's env specifically, rather than relying on
// Heath's shell never having one set.
const AUTH_OVERRIDE_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
function childEnv() {
  const env = { ...process.env };
  for (const k of AUTH_OVERRIDE_VARS) delete env[k];
  return env;
}

// opts.resumeSessionId — continue a prior --print session so multi-turn chat
//   keeps its context. The session id comes back on the JSON envelope
//   (envelope.session_id) of the previous call; pass it here next turn.
// opts.cwd — which repo Claude runs in. Defaults to the worker's cwd, which is
//   MeetDossie. Point it elsewhere for Sawyer/Rust tasks.
function runClaude(prompt, {
  model = 'sonnet',
  timeoutMs = 10 * 60 * 1000,
  log = () => {},
  resumeSessionId = null,
  cwd = undefined,
} = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = [
      '--print',
      '--model', model,
      '--dangerously-skip-permissions',
      '--output-format', 'json',
    ];
    if (resumeSessionId) args.push('--resume', String(resumeSessionId));

    log(`spawn claude --print model=${model} bin=${CLAUDE_BIN}`
      + (resumeSessionId ? ` resume=${resumeSessionId}` : '')
      + (cwd ? ` cwd=${cwd}` : ''));

    let stdoutBuf = '';
    let stderrBuf = '';
    let killed = false;

    const child = spawn(CLAUDE_BIN, args, {
      env: childEnv(),
      shell: NEEDS_SHELL,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
    });

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (e) {
      return resolve({ ok: false, error: `stdin write failed: ${e.message}`, duration_ms: 0 });
    }

    const timer = setTimeout(() => {
      killed = true;
      log(`TIMEOUT after ${timeoutMs}ms — killing`);
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdoutBuf += d.toString(); });
    child.stderr.on('data', (d) => { stderrBuf += d.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `claude spawn error: ${err.message}`, duration_ms: Date.now() - started, stderr: stderrBuf });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const duration_ms = Date.now() - started;

      if (killed) {
        return resolve({ ok: false, error: `timeout after ${Math.round(timeoutMs/60000)}min`, duration_ms, stderr: stderrBuf.slice(-2000) });
      }

      if (code !== 0) {
        return resolve({
          ok: false,
          error: `claude exited ${code}: ${stderrBuf.slice(-500) || '(no stderr)'}`,
          duration_ms,
          stdout: stdoutBuf.slice(-2000),
          stderr: stderrBuf.slice(-2000),
        });
      }

      let envelope = null;
      try { envelope = JSON.parse(stdoutBuf); } catch {}
      const rawText = (envelope && typeof envelope.result === 'string') ? envelope.result : stdoutBuf;
      resolve({ ok: true, raw: rawText, envelope, duration_ms });
    });
  });
}

function extractJsonTail(text) {
  const trimmed = String(text || '').trim();
  try { return JSON.parse(trimmed); } catch {}
  const lastBrace = trimmed.lastIndexOf('{');
  if (lastBrace >= 0) {
    const candidate = trimmed.slice(lastBrace);
    try { return JSON.parse(candidate); } catch {}
    const lastClose = candidate.lastIndexOf('}');
    if (lastClose > 0) {
      try { return JSON.parse(candidate.slice(0, lastClose + 1)); } catch {}
    }
  }
  return null;
}

async function sbFetch(path, init = {}) {
  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = {
    'Content-Type': 'application/json',
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, data };
}

module.exports = { runClaude, extractJsonTail, sbFetch };
