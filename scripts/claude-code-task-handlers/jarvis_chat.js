// scripts/claude-code-task-handlers/jarvis_chat.js
//
// The Jarvis -> Claude Code bridge. This is what makes Jarvis actually *be*
// Claude Code rather than a separate chatbot.
//
// Everything else Jarvis does (jarvis-quick-ask, the specialists) calls the
// Anthropic API server-side. That Claude has no filesystem, no repo, no git —
// it can talk, but it cannot do. This handler runs on Heath's PC, so the reply
// comes from a Claude that can read the code, run commands, and change things.
//
// Flow:
//   phone -> POST /api/jarvis-claude-code  -> agent_queue row (task_type=jarvis_chat)
//         -> claude-code-worker claims it  -> THIS handler -> claude --print
//         -> agent_queue.result_summary    -> GET /api/jarvis-claude-code?id=
//
// Multi-turn: the JSON envelope carries a session_id. We return it, the API
// hands it back to the phone, and the phone sends it on the next message as
// payload.session_id. Claude resumes with full context instead of starting
// cold every turn.
//
// Contract:
//   { payload: {
//       message: string,          // required — what Heath asked
//       session_id?: string,      // continue a prior conversation
//       project?: string,         // 'meetdossie' | 'sawyer' | 'rust'
//       model?: string,           // default 'sonnet'
//     } }
//
// Returns:
//   { ok, summary, result: { answer, session_id, project, duration_ms } }

'use strict';

const path = require('path');
const { runClaude } = require('./_lib/claude-spawn');

// Where each project lives, so "fix the Sawyer connector" runs in the Sawyer
// repo instead of MeetDossie. Worker cwd is MeetDossie, hence the default.
//
// The worker normally runs under Windows node, but the same repo is reachable
// from WSL at a different path — and handing a "C:\..." cwd to a Linux spawn()
// fails in a way that looks like Claude itself broke. Resolve per platform.
const WIN = process.platform === 'win32';
const ROOT = WIN ? 'C:\\Users\\Heath\\Projects' : '/mnt/c/Users/Heath/Projects';
const join = (name) => (WIN ? `${ROOT}\\${name}` : `${ROOT}/${name}`);

const PROJECTS = {
  meetdossie: join('MeetDossie'),
  sawyer: join('Sawyer'),
  rust: join('Rust'),
};

const MAX_MESSAGE = 8000;

module.exports = async function jarvisChatHandler({ payload, task_id, log }) {
  const message = payload && typeof payload.message === 'string'
    ? payload.message.trim()
    : '';
  if (!message) {
    return { ok: false, summary: 'jarvis_chat: no message in payload' };
  }

  const project = String(payload.project || 'meetdossie').toLowerCase();
  const cwd = PROJECTS[project];
  if (!cwd) {
    return {
      ok: false,
      summary: `jarvis_chat: unknown project "${project}" (have ${Object.keys(PROJECTS).join(', ')})`,
    };
  }

  const sessionId = payload.session_id && typeof payload.session_id === 'string'
    ? payload.session_id
    : null;

  // Heath reads these on a phone, out loud as often as not. The length rule is
  // stricter here than in a terminal — a wall of text spoken back is worse than
  // useless. Same instruction he gives in person.
  const prompt = [
    'You are answering Heath through Jarvis on his phone. He is likely away',
    'from the computer and may be listening rather than reading.',
    '',
    'Keep the answer under about six sentences unless he explicitly asks for',
    'detail. No preamble, no restating the question, no bullet-point walls.',
    'If you change files or run commands, say plainly what you changed and',
    'whether it worked. If something failed, lead with that.',
    '',
    'His message:',
    message.slice(0, MAX_MESSAGE),
  ].join('\n');

  log(`jarvis_chat project=${project} resume=${sessionId || 'new'} chars=${message.length}`);

  const out = await runClaude(prompt, {
    model: payload.model || 'sonnet',
    timeoutMs: 10 * 60 * 1000,
    resumeSessionId: sessionId,
    cwd,
    log,
  });

  if (!out.ok) {
    // A dead session id is the common failure once history is pruned. Retry
    // once cold rather than handing back an error Heath can do nothing with.
    if (sessionId) {
      log(`resume failed (${out.error}); retrying without session`, 'WARN');
      const retry = await runClaude(prompt, {
        model: payload.model || 'sonnet',
        timeoutMs: 10 * 60 * 1000,
        cwd,
        log,
      });
      if (retry.ok) {
        return done(retry, project, task_id, true);
      }
      return { ok: false, summary: failSummary(retry) };
    }
    return { ok: false, summary: failSummary(out) };
  }

  return done(out, project, task_id, false);
};

// runClaude() returns stdout on failure too, but the earlier version of this
// file only surfaced `error` (stderr) — dropping whatever Claude Code itself
// printed to stdout, which is often where the actual explanation lives
// (auth warnings, tool errors). Include both so a failure is fully visible
// on first read instead of needing a follow-up dig.
function failSummary(out) {
  const stdoutTail = (out.stdout || '').trim().slice(-800);
  return `jarvis_chat failed: ${out.error}`
    + (stdoutTail ? `\n\n[stdout]\n${stdoutTail}` : '');
}

function done(out, project, task_id, sessionReset) {
  const answer = String(out.raw || '').trim();
  const newSession = out.envelope && out.envelope.session_id
    ? out.envelope.session_id
    : null;

  return {
    ok: true,
    // result_summary is what the phone polls for, so the answer goes HERE —
    // not buried in result, which the API does not surface.
    summary: answer,
    result: {
      answer,
      session_id: newSession,
      session_reset: sessionReset,
      project,
      task_id,
      duration_ms: out.duration_ms,
    },
  };
}
