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

const HOME_DIR = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Heath Shepard';
const CLAUDE_EXE_DIRECT = path.join(
  process.env.APPDATA || path.join(HOME_DIR, 'AppData', 'Roaming'),
  'npm', 'node_modules', '@anthropic-ai/claude-code', 'bin', 'claude.exe'
);
const CLAUDE_BIN = (() => {
  try { if (fs.existsSync(CLAUDE_EXE_DIRECT)) return CLAUDE_EXE_DIRECT; } catch {}
  return process.platform === 'win32' ? 'claude.cmd' : 'claude';
})();

function runClaude(prompt, { model = 'sonnet', timeoutMs = 10 * 60 * 1000, log = () => {} } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = [
      '--print',
      '--model', model,
      '--dangerously-skip-permissions',
      '--output-format', 'json',
    ];

    log(`spawn claude --print model=${model} bin=${CLAUDE_BIN}`);

    let stdoutBuf = '';
    let stderrBuf = '';
    let killed = false;

    const child = spawn(CLAUDE_BIN, args, {
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
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
