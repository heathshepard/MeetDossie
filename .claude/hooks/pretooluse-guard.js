#!/usr/bin/env node
'use strict';
/**
 * PreToolUse guard hook — mechanizes a handful of Heath's repeated-mistake
 * rules from CLAUDE.md / MEMORY.md as code instead of hoping the model
 * remembers them. SHIP MODE IS CONTROLLED BY guard-config.json ("mode":
 * "shadow" | "enforce"). In shadow mode this NEVER blocks a tool call — it
 * only logs what it would have denied, to .claude/hooks/logs/pretooluse-guard.log
 * (JSONL). Flip guard-config.json to "enforce" only after reviewing that log
 * against real work and confirming no false positives.
 *
 * Hard requirements this file follows on purpose (see CLAUDE.md hook traps):
 *  - Exit 1 does NOT block. Only exit 2 blocks. Every code path below either
 *    exits 0 (allow, with or without a note) or, in enforce mode, exit 2.
 *    Nothing here can accidentally exit 1 — all logic is wrapped in
 *    try/catch, and any internal error falls through to exit 0 + a loud
 *    ERROR log line (fail open, never fail silent).
 *  - A heartbeat file is touched on every single invocation (regardless of
 *    outcome) so an "is this hook even still running" check is a file-mtime
 *    read, not a guess.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const util = require(path.join(__dirname, 'lib', 'hook-utils.js'));
const { findSecrets } = require(path.join(__dirname, 'lib', 'secret-patterns.js'));

const HEARTBEAT_FILE = 'pretooluse-guard-heartbeat.txt';
const LOG_FILE = 'pretooluse-guard.log';
const SEND_HISTORY_FILE = 'send-history.json';
const REANCHOR_MARKER = 'reanchor-pending.txt';

function loadConfig(cwd) {
  const defaults = {
    mode: 'shadow',
    rules: {
      no_push_main_without_merge_it: true,
      no_literal_secrets: true,
      worktree_isolation_required: true,
      browser_preflight_required: true,
      no_unverified_send_retry: true,
    },
  };
  try {
    const raw = fs.readFileSync(path.join(cwd, '.claude', 'hooks', 'guard-config.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed, rules: { ...defaults.rules, ...(parsed.rules || {}) } };
  } catch (e) {
    return defaults;
  }
}

function isGitIgnored(cwd, filePath) {
  try {
    const r = spawnSync('git', ['check-ignore', '-q', filePath], { cwd, timeout: 3000 });
    return r.status === 0;
  } catch (e) {
    return false; // if we can't tell, treat it as trackable and scan it
  }
}

function checkReanchorGate(cwd, toolName) {
  if (!['Bash', 'Edit', 'Write'].includes(toolName)) return null;
  const marker = util.readState(cwd, REANCHOR_MARKER);
  if (!marker) return null;
  return {
    rule: 'postcompact_reanchor',
    reason: `Context was just compacted (marker set ${marker}). Read CLAUDE.md before running Bash/Edit/Write again — this re-anchors the hard rules that compaction just summarized away. (.claude/hooks/postcompact-reanchor.js / this gate)`,
  };
}

function isMeetDossieRepo(cwd) {
  try {
    const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf-8', timeout: 3000 });
    if (r.status === 0 && r.stdout) return /meetdossie/i.test(r.stdout);
  } catch (e) { /* ignore */ }
  return true; // unknown → assume it might be MeetDossie rather than silently skipping the check
}

function checkPushMain(cwd, toolName, toolInput, transcriptPath) {
  if (toolName !== 'Bash') return null;
  const cmd = String((toolInput && toolInput.command) || '');

  // Real replay data (2026-09-28) turned up two false-positive classes this
  // guards against: (1) `git push` appearing as plain PROSE inside a quoted
  // printf/heredoc argument writing a memory file, not an actual invocation;
  // (2) legitimate pushes to *other* repos (Rust etc.) that happen to run in
  // the same session. Both would have been noise in shadow mode.

  // 1. Only match `git push` at the start of a command segment (after &&, ;,
  //    |, a literal newline, or the start of the string), optionally preceded
  //    by env-var assignments or `timeout N`. This excludes it appearing
  //    inside an unrelated quoted string later in the command.
  // Real replay data also turned up a heredoc trap: a `cat >> file.md <<'EOF'`
  // body is literal text data, and a markdown bullet like "- [git push fails
  // from worktrees]" sitting at the start of its own line inside that body
  // matches a naive newline-as-separator rule even though no command runs.
  // If the string contains a heredoc marker at all, only treat &&/;/| and
  // start-of-string as real command separators (not bare newlines) — safer,
  // if slightly more conservative about legitimate multi-line scripts.
  const hasHeredoc = /<<[-~]?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.test(cmd);
  const segmentRe = hasHeredoc
    ? /(^|&&|;|\|)\s*(?:[A-Z_][A-Z0-9_]*=\S+\s+)*(?:timeout\s+\d+\s+)?git\s+push\b/
    : /(^|&&|;|\n|\|)\s*(?:[A-Z_][A-Z0-9_]*=\S+\s+)*(?:timeout\s+\d+\s+)?git\s+push\b/;
  const m = cmd.match(segmentRe);
  if (!m) return null;

  // 2. An existing recognized override convention (observed in real usage):
  //    ALLOW_DIRECT_MAIN=1 on the same command line. Respect it rather than
  //    re-litigating an already-authorized direct-to-main push.
  if (/\bALLOW_DIRECT_MAIN\s*=\s*(1|true)\b/i.test(cmd)) return null;

  // 3. Repo scope: this rule is specifically CLAUDE.md Section 3's MeetDossie
  //    staging-first workflow. Skip if the command clearly cd's into a
  //    different named project directory without also mentioning MeetDossie,
  //    or if the session's own git remote isn't MeetDossie.
  const cdOther = /Projects\/(?!MeetDossie\b)[A-Za-z0-9_.-]+/.test(cmd) && !/MeetDossie/i.test(cmd);
  if (cdOther) return null;
  if (!isMeetDossieRepo(cwd)) return null;

  const explicitMain = /\b(origin\s+)?(main|master)\b/.test(cmd.slice(m.index));
  let targetsMain = explicitMain;
  if (!targetsMain) {
    // Bare `git push` / `git push origin` — depends on current branch.
    const branch = util.gitBranch(cwd);
    if (branch && (branch === 'main' || branch === 'master')) targetsMain = true;
  }
  if (!targetsMain) return null;

  const prompts = util.recentUserPrompts(transcriptPath);
  const saidMergeIt = util.containsPhrase(prompts, /\bmerge it\b/i);
  if (saidMergeIt) return null;

  return {
    rule: 'no_push_main_without_merge_it',
    reason: 'git push appears to target main/master in the MeetDossie repo and no "merge it" from Heath was found in this session\'s recent prompts. CLAUDE.md Section 3: "Heath says \'merge it\' before Cole touches main. No exceptions."',
  };
}

function checkLiteralSecrets(cwd, toolName, toolInput) {
  if (toolName !== 'Edit' && toolName !== 'Write') return null;
  const filePath = (toolInput && toolInput.file_path) || '';
  const content = toolName === 'Write' ? (toolInput && toolInput.file_text) : (toolInput && toolInput.new_str);
  const hits = findSecrets(content || '');
  if (hits.length === 0) return null;
  if (filePath && isGitIgnored(cwd, filePath)) return null; // .env.local etc — expected to hold real secrets
  return {
    rule: 'no_literal_secrets',
    reason: `Possible literal secret (${hits.join(', ')}) being written into a tracked file (${filePath}). CLAUDE.md Section 15: never hardcode auth tokens/API keys/secrets in source code; secrets live in Vercel env vars only.`,
  };
}

function checkWorktreeIsolation(cwd, toolName, toolInput) {
  if (!/^(Task|Agent)$/i.test(toolName || '')) return null;
  const text = JSON.stringify(toolInput || {});
  const touchesRepo = /\b(git |commit|merge|deploy|npm run build|edit .*file|write .*file|patch|migration|push origin)\b/i.test(text);
  if (!touchesRepo) return null;
  const hasIsolation = /isolation["']?\s*[:=]\s*["']?worktree/i.test(text);
  if (hasIsolation) return null;
  return {
    rule: 'worktree_isolation_required',
    reason: 'Dispatch text looks repo-touching (git/edit/build/deploy) but no isolation:"worktree" found in the tool input. Heuristic only — exact dispatch tool schema not confirmed, so this is best-effort. MEMORY: feedback_isolate-agents-in-worktrees.md.',
    heuristic: true,
  };
}

function checkBrowserPreflight(cwd, toolName, toolInput, transcriptPath) {
  if (!/^(Task|Agent)$/i.test(toolName || '')) return null;
  const text = JSON.stringify(toolInput || {});
  const looksBrowser = /playwright|chromium|chrome profile|zipform|connectmls|dossiebot|facebook.*(post|comment)|instagram|linkedin.*engag/i.test(text);
  if (!looksBrowser) return null;
  const prompts = util.recentUserPrompts(transcriptPath, 200000, 150);
  const ranPreflight = prompts.some((p) => /agent-dispatch-preflight\.js|preflight-check\.js/.test(p))
    || (() => {
      // also check tool_result/assistant Bash calls in the transcript tail, not just user prompts
      try {
        if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;
        const stat = fs.statSync(transcriptPath);
        const start = Math.max(0, stat.size - 300000);
        const fd = fs.openSync(transcriptPath, 'r');
        const buf = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        return /agent-dispatch-preflight\.js|preflight-check\.js/.test(buf.toString('utf-8'));
      } catch (e) { return false; }
    })();
  if (ranPreflight) return null;
  return {
    rule: 'browser_preflight_required',
    reason: 'Dispatch text looks browser-driving (Playwright/Chrome/zipForm/connectMLS/social) with no recent agent-dispatch-preflight.js or preflight-check.js call found in this session. CLAUDE.md §25 reference table.',
    heuristic: true,
  };
}

function checkUnverifiedSendRetry(cwd, toolName, toolInput) {
  if (toolName !== 'Bash') return null;
  const cmd = String((toolInput && toolInput.command) || '');
  const looksLikeSend = /\bsend-trec-|kw-mail\.py send|node scripts\/.*send.*\.js|telegram.*send|resend\.emails\.send/i.test(cmd);
  if (!looksLikeSend) return null;

  const stateDir = path.join(util.hooksDir(cwd), 'state');
  util.ensureDir(stateDir);
  const histPath = path.join(stateDir, SEND_HISTORY_FILE);
  let history = [];
  try { history = JSON.parse(fs.readFileSync(histPath, 'utf-8')); } catch (e) { history = []; }

  const now = Date.now();
  const norm = cmd.replace(/\s+/g, ' ').trim();
  const RETRY_WINDOW_MS = 15 * 60 * 1000;
  const recentSame = history.find((h) => h.cmd === norm && (now - h.ts) < RETRY_WINDOW_MS);

  history.push({ cmd: norm, ts: now });
  if (history.length > 50) history = history.slice(-50);
  try { fs.writeFileSync(histPath, JSON.stringify(history)); } catch (e) { /* ignore */ }

  if (!recentSame) return null;
  return {
    rule: 'no_unverified_send_retry',
    reason: `Identical send-like command run again within 15 minutes. MEMORY: feedback_never-retry-an-unverified-send.md — one attempt, then stop; a send reporting failure may have gone out.`,
    heuristic: true,
  };
}

function main() {
  let input;
  try {
    input = util.readStdinJSON();
  } catch (e) {
    // Can't even parse our own input — allow silently, but this is exactly
    // the kind of failure that must not be silent, so log it hard.
    try {
      fs.appendFileSync(
        path.join(process.cwd(), '.claude', 'hooks', 'logs', LOG_FILE),
        JSON.stringify({ ts: new Date().toISOString(), level: 'ERROR', msg: `stdin parse failed: ${e.message}` }) + '\n'
      );
    } catch (e2) { /* nowhere left to report this */ }
    process.exit(0);
  }

  const cwd = input.cwd || process.cwd();
  const toolName = input.tool_name;
  const toolInput = input.tool_input || {};
  const transcriptPath = input.transcript_path;

  util.heartbeat(cwd, HEARTBEAT_FILE);

  let config;
  try {
    config = loadConfig(cwd);
  } catch (e) {
    util.appendLog(cwd, LOG_FILE, { level: 'ERROR', msg: `config load failed: ${e.message}` });
    process.exit(0);
  }

  const checks = [
    ['reanchor', () => checkReanchorGate(cwd, toolName)], // not gated by rules config — always on, see postcompact-reanchor.js
    ['no_push_main_without_merge_it', () => config.rules.no_push_main_without_merge_it && checkPushMain(cwd, toolName, toolInput, transcriptPath)],
    ['no_literal_secrets', () => config.rules.no_literal_secrets && checkLiteralSecrets(cwd, toolName, toolInput)],
    ['worktree_isolation_required', () => config.rules.worktree_isolation_required && checkWorktreeIsolation(cwd, toolName, toolInput)],
    ['browser_preflight_required', () => config.rules.browser_preflight_required && checkBrowserPreflight(cwd, toolName, toolInput, transcriptPath)],
    ['no_unverified_send_retry', () => config.rules.no_unverified_send_retry && checkUnverifiedSendRetry(cwd, toolName, toolInput)],
  ];

  let hit = null;
  for (const [name, fn] of checks) {
    let result;
    try {
      result = fn();
    } catch (e) {
      util.appendLog(cwd, LOG_FILE, { level: 'ERROR', rule: name, msg: e.message });
      continue;
    }
    if (result) { hit = result; break; }
  }

  if (!hit) process.exit(0);

  const isReanchor = hit.rule === 'postcompact_reanchor';
  const effectiveMode = isReanchor ? 'enforce' : config.mode; // the reanchor gate is meant to actually block; the mechanized rules ship in shadow mode

  util.appendLog(cwd, LOG_FILE, {
    level: 'WOULD_DENY',
    mode: effectiveMode,
    rule: hit.rule,
    tool: toolName,
    reason: hit.reason,
    heuristic: !!hit.heuristic,
  });

  if (effectiveMode === 'enforce') {
    util.deny(`[guard:${hit.rule}] ${hit.reason}`);
  } else {
    // shadow mode: allow, but leave a visible (not blocking) breadcrumb
    util.allowWithNote(`[guard:shadow] would have denied (${hit.rule}): ${hit.reason}`);
  }
}

try {
  main();
} catch (e) {
  try {
    fs.appendFileSync(
      path.join((process.env.CWD || process.cwd()), '.claude', 'hooks', 'logs', LOG_FILE),
      JSON.stringify({ ts: new Date().toISOString(), level: 'FATAL', msg: e.message }) + '\n'
    );
  } catch (e2) { /* nowhere left to report this */ }
  process.exit(0); // fail open, never accidentally exit 1
}
