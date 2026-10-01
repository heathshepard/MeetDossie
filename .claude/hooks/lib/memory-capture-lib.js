'use strict';
/**
 * Shared logic for the memory-capture hook (memory-capture.js), fired on
 * PreCompact and SessionEnd. See CLAUDE.md §17 "COLE'S MEMORY RULES" for the
 * policy this mechanizes: every correction, decision, named person, and
 * dated fact should land in memory WITHOUT depending on an agent deciding
 * in-the-moment that it's worth keeping.
 *
 * Split deliberately from memory-capture.js: this file has no stdin/hook
 * contract awareness, so it can be unit/CLI-tested directly against any
 * transcript path without simulating a real hook invocation.
 *
 * Architecture (why the LLM sub-call never writes memory files itself):
 * the spawned `claude -p` turn's ONLY job is to read a transcript excerpt +
 * the existing memory index and propose structured JSON candidates to a
 * throwaway output file. Everything after that — secret scanning, junk
 * filtering, dedup-by-filename, the MEMORY.md hard size cap, and the actual
 * file writes — happens in plain deterministic Node code in this file. An
 * LLM asked to "please don't write secrets" is a suggestion; a regex gate
 * run on its output before anything touches disk is a control.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { findSecrets } = require('./secret-patterns.js');

const MEMORY_DIR = '/home/heath/.claude/projects/-mnt-c-Users-Heath-Projects-MeetDossie/memory';
const MEMORY_INDEX_PATH = path.join(MEMORY_DIR, 'MEMORY.md');
const CAPTURE_LOG_DIR = path.join(MEMORY_DIR, '.capture-sessions'); // outside repo — may contain names
const PENDING_INDEX_PATH = path.join(MEMORY_DIR, '.pending-index-entries.md');

const MEMORY_INDEX_MAX_LINES = 200;
const MEMORY_INDEX_MAX_BYTES = 25000; // "25KB" per spec; conservative under 25*1024
// NOT copied from precompact-handoff.js's 24000-char cap on purpose: that
// cap is sized for a HANDOFF.md *summary* (some loss is fine, it's a status
// note). This is an EXTRACTION pass whose whole job is to not lose content —
// measured against a real 93MB/1.78M-filtered-char session, the delta
// between two real compaction points ran 90-140k chars, comfortably inside
// a 200k-token model's context window but well past 24k. 150k chars keeps a
// wide safety margin under that budget while covering realistic deltas; see
// `truncated` on the return value for when even this isn't enough.
const MAX_EXCERPT_CHARS = 150000;
const MAX_CANDIDATES_PER_RUN = 12;
const CLAUDE_MD_PATH_DEFAULT = '/mnt/c/Users/Heath/Projects/MeetDossie/CLAUDE.md';

const VALID_CATEGORIES = new Set(['feedback', 'decision', 'person', 'fact']);
// Underscores allowed (not just hyphens): the entire existing corpus uses
// the feedback_xxx-xxx underscore-prefix convention (100+ real files), and
// rejecting on that was an early bug caught by testing against real output.
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{2,80}[a-z0-9]$/;

function log(...args) {
  // Only for interactive/manual CLI runs — the hook itself uses appendLog
  // from hook-utils for its repo-local metadata-only log.
  if (process.env.MEMORY_CAPTURE_VERBOSE) {
    // eslint-disable-next-line no-console
    console.error('[memory-capture]', ...args);
  }
}

/**
 * Pull only real user/assistant TEXT content out of a transcript JSONL,
 * starting after byte offset `sinceOffset`. Deliberately drops tool_use and
 * tool_result blocks entirely — this is "routine tool output", exactly the
 * junk category the spec calls out, and it dwarfs real conversation in
 * token count on an agentic session.
 *
 * Returns { excerpt, newOffset, hadContent, truncated, fullChars }. newOffset
 * is persisted as the next call's sinceOffset — this is how repeated
 * PreCompact firings across one long session only ever process the NEW
 * delta instead of re-scanning (and re-proposing) the same material.
 *
 * IMPORTANT correctness property: newOffset only advances past what was
 * ACTUALLY included in `excerpt`. If the delta is bigger than `maxChars`,
 * only the most recent chunks are kept (oldest-first truncation — a
 * compaction is about to bury the newest material first) and newOffset
 * stops at the byte position where the kept portion begins. An earlier
 * version of this function advanced newOffset to end-of-file even when
 * truncating, which would have permanently skipped the untruncated older
 * portion of the delta instead of merely deferring it to the next run —
 * exactly the silent-loss failure mode this hook exists to prevent.
 */
function extractNewExcerpt(transcriptPath, sinceOffset, maxChars = MAX_EXCERPT_CHARS) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { excerpt: '', newOffset: sinceOffset || 0, hadContent: false, truncated: false, fullChars: 0 };
  }
  const stat = fs.statSync(transcriptPath);
  const startOffset = Math.max(0, Math.min(sinceOffset || 0, stat.size));
  if (startOffset >= stat.size) {
    return { excerpt: '', newOffset: stat.size, hadContent: false, truncated: false, fullChars: 0 };
  }
  const len = stat.size - startOffset;
  const fd = fs.openSync(transcriptPath, 'r');
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, startOffset);
  fs.closeSync(fd);

  const rawLines = buf.toString('utf-8').split('\n');
  // Track each kept chunk alongside the file byte-offset immediately AFTER
  // its source line, so truncation can compute a precise, safe resume point
  // instead of jumping straight to end-of-file.
  const chunks = []; // { text, lineEndByte }
  let cursor = startOffset;
  for (const line of rawLines) {
    // +1 for the '\n' the split() consumed; last line (no trailing \n) is
    // harmless to overcount by one byte since nothing reads past EOF.
    cursor += Buffer.byteLength(line, 'utf-8') + 1;
    const lineEndByte = cursor;
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (e) { continue; }
    const type = obj.type;
    if (type !== 'user' && type !== 'assistant') continue;
    const content = obj.message && obj.message.content;
    const speaker = type === 'user' ? 'Heath' : 'assistant';
    if (typeof content === 'string') {
      if (content.trim()) chunks.push({ text: `[${speaker}] ${content}`, lineEndByte });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === 'text' && block.text && block.text.trim()) {
          chunks.push({ text: `[${speaker}] ${block.text}`, lineEndByte });
        }
        // tool_use / tool_result blocks intentionally dropped.
      }
    }
  }

  const fullChars = chunks.reduce((n, c) => n + c.text.length + 1, 0);
  if (fullChars <= maxChars || chunks.length === 0) {
    return {
      excerpt: chunks.map((c) => c.text).join('\n'),
      newOffset: stat.size,
      hadContent: chunks.length > 0,
      truncated: false,
      fullChars,
    };
  }

  // Oversized: keep chunks OLDEST-FIRST until the budget is hit, at CHUNK
  // granularity (never split mid-chunk). This is a deliberate trade-off:
  // newest-first would surface the material most at risk of being buried by
  // THIS compaction, but a forward-only watermark can never "go back" for
  // whatever got left out — so newest-first guarantees the middle of a big
  // backlog is silently skipped forever, while oldest-first guarantees every
  // run makes real, bounded forward progress and nothing is permanently
  // lost, just deferred a run or two. PreCompact recurs through a session
  // and SessionEnd is the final catch-net, so completeness wins over
  // recency-priority here.
  let kept = [];
  let runningLen = 0;
  for (let i = 0; i < chunks.length; i++) {
    const addLen = chunks[i].text.length + 1;
    if (runningLen + addLen > maxChars && kept.length > 0) break;
    kept.push(chunks[i]);
    runningLen += addLen;
  }
  const resumeByte = kept[kept.length - 1].lineEndByte;
  return {
    excerpt: kept.map((c) => c.text).join('\n'),
    newOffset: resumeByte, // real forward progress, not stat.size — see comment above
    hadContent: true,
    truncated: true,
    fullChars,
  };
}

function readExistingMemoryFilenames() {
  try {
    return fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  } catch (e) {
    return [];
  }
}

function readMemoryIndexText() {
  try {
    return fs.readFileSync(MEMORY_INDEX_PATH, 'utf-8');
  } catch (e) {
    return '';
  }
}

function readClaudeMdText(claudeMdPath = CLAUDE_MD_PATH_DEFAULT) {
  try {
    return fs.readFileSync(claudeMdPath, 'utf-8');
  } catch (e) {
    return '(CLAUDE.md not readable — proceed without it)';
  }
}

/**
 * Builds the prompt for the one-shot `claude -p` extraction turn. The turn's
 * ONLY allowed action is to Write the JSON array to `outFile` — no other
 * tool use, no commentary, no direct memory writes.
 */
function buildExtractionPrompt({ excerpt, memoryIndexText, existingFilenames, claudeMdText, outFile, sessionDate }) {
  return `You are extracting durable, long-term memory from a slice of a Claude Code
conversation transcript between Heath Shepard and an AI agent. This is a MECHANICAL
extraction pass, not a summary — your only output is a JSON file written to a fixed
path. Do not edit, create, or touch any other file. Do not use any tool other than
Write, and only once, to the exact path given at the end.

## What counts as capture-worthy (four categories only)

1. **feedback** — Heath explicitly correcting the agent, telling it to do something
   differently, or stating a rule/preference going forward. Must be something HE said,
   not the agent's own inference that it made a mistake. Requires his own words
   (verbatim_quote) plus a short why.
2. **decision** — a real choice that got made (by Heath, or agreed with him) and the
   reason for it. Not a still-open question, not a proposal awaiting his answer.
3. **person** — any individual named for the first time (lead, customer, partner,
   vendor contact) who is not already covered in the existing memory index below. If
   they ARE already covered, propose action:"update" with only the new information.
4. **fact** — something stated as true right now that could go stale later (a price, a
   count, a status, a deadline, an MRR figure, a headcount) — the kind of thing that
   needs a valid_at date attached because it will eventually be wrong.

## What must NOT be captured (be aggressive about excluding this)

- Routine tool output, file contents, command results, or anything that is just
  "what happened" rather than "what was decided or corrected."
- The agent's own narration of its process ("Let me check...", "I've now...",
  "Verified, 0 broken").
- Transient state: which file is currently open, in-progress step counts, anything
  true only for the duration of this session.
- Anything already stated in CLAUDE.md below — if CLAUDE.md already documents it,
  do not propose it again, even if it appears in the excerpt.
- Anything already covered by an existing memory file per the index below — propose
  action:"update" on the existing file instead of a near-duplicate new one.
- Greetings, acknowledgements, small talk, and anything you are not confident rises
  to the bar above. When genuinely unsure, DO NOT include it. A missed capture costs
  nothing here (PreCompact and SessionEnd both run repeatedly); a junk capture costs
  Heath's trust in the whole system.

Propose at most ${MAX_CANDIDATES_PER_RUN} candidates. If there is truly nothing
capture-worthy in this excerpt, output an empty array — that is a correct, expected
result, not a failure.

## Existing memory index (MEMORY.md) — check this before proposing anything

${memoryIndexText || '(empty or unreadable)'}

## Existing memory filenames (for exact-match dedup on action:"update")

${existingFilenames.join(', ') || '(none)'}

## CLAUDE.md (do not re-propose anything already documented here)

${claudeMdText.slice(0, 20000)}

## Output schema — write EXACTLY this JSON shape to the file path below, nothing else

A JSON array. Each element:
{
  "category": "feedback" | "decision" | "person" | "fact",
  "action": "new" | "update",
  "name": "lowercase-dash-slug-no-dot-md",
  "target_file": "existing-filename.md (REQUIRED and must be an exact match from the
                  filenames list above if action is 'update'; omit/null if action is 'new')",
  "description": "one line, under 160 characters, third person, for the memory index",
  "valid_at": "YYYY-MM-DD or null",
  "verbatim_quote": "Heath's exact words, required for category:feedback, else null",
  "why": "one to three sentences on why this matters / what rule it becomes",
  "body_markdown": "the full markdown body for a new file, OR the markdown to APPEND
                     under a dated subsection for an update — write real prose, not a
                     restatement of the schema",
  "related": ["existing-filename-stem-without-dot-md", "..."]
}

## Transcript excerpt (session date: ${sessionDate}, oldest first)

${excerpt || '(no new content since the last capture run)'}

## Write your answer now

Write the JSON array (or [] if nothing qualifies) to this exact path using the Write
tool, then stop. No other output, no explanation, no other tool calls:

${outFile}`;
}

/** Spawns the one-shot extraction turn and returns the parsed JSON array (or []). */
function runExtraction({ cwd, prompt, outFile, timeoutMs, model }) {
  try { fs.unlinkSync(outFile); } catch (e) { /* fine if it didn't exist */ }
  const args = ['-p'];
  if (model) args.push('--model', model);
  const result = spawnSync('claude', args, {
    cwd,
    input: prompt,
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) {
    return { candidates: [], error: `spawn failed: ${result.error.message}`, raw: null };
  }
  if (!fs.existsSync(outFile)) {
    return { candidates: [], error: `extraction turn did not write ${outFile} (exit ${result.status})`, raw: result.stdout };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
  } catch (e) {
    return { candidates: [], error: `output file was not valid JSON: ${e.message}`, raw: null };
  }
  if (!Array.isArray(parsed)) {
    return { candidates: [], error: 'output was not a JSON array', raw: null };
  }
  return { candidates: parsed, error: null, raw: null };
}

/**
 * Deterministic gate: schema check, secret scan, junk heuristics, dedup
 * against real filenames on disk. Runs regardless of report/live mode —
 * report mode should show Heath exactly what WOULD survive this gate.
 */
function validateAndFilterCandidates(rawCandidates, { existingFilenames }) {
  const accepted = [];
  const rejected = [];
  const filenameSet = new Set(existingFilenames);

  for (const c of Array.isArray(rawCandidates) ? rawCandidates : []) {
    const reasons = [];
    if (!c || typeof c !== 'object') { rejected.push({ candidate: c, reasons: ['not an object'] }); continue; }
    if (!VALID_CATEGORIES.has(c.category)) reasons.push(`bad category: ${c.category}`);
    if (!['new', 'update'].includes(c.action)) reasons.push(`bad action: ${c.action}`);
    if (typeof c.name !== 'string' || !SLUG_RE.test(c.name)) reasons.push(`bad slug: ${c.name}`);
    if (typeof c.description !== 'string' || c.description.length < 8 || c.description.length > 200) {
      reasons.push('description missing or wrong length');
    }
    if (typeof c.body_markdown !== 'string' || c.body_markdown.trim().length < 40) {
      reasons.push('body_markdown missing or too thin (< 40 chars — likely junk)');
    }
    if (c.category === 'feedback' && (typeof c.verbatim_quote !== 'string' || c.verbatim_quote.trim().length < 8)) {
      reasons.push('feedback category requires a real verbatim_quote');
    }
    if (c.valid_at && !/^\d{4}-\d{2}-\d{2}$/.test(c.valid_at)) reasons.push(`bad valid_at: ${c.valid_at}`);

    // action:"update" must point at a real, existing file — otherwise force to "new"
    // rather than reject outright (a hallucinated target_file shouldn't kill an
    // otherwise-good candidate).
    let action = c.action;
    let targetFile = c.target_file || null;
    if (action === 'update') {
      if (!targetFile || !filenameSet.has(targetFile)) {
        action = 'new';
        targetFile = null;
      }
    }
    if (action === 'new') {
      targetFile = `${c.name}.md`;
      if (filenameSet.has(targetFile)) {
        // Model proposed "new" but a file with this exact slug already exists —
        // safer to treat as an update than silently overwrite or duplicate.
        action = 'update';
      }
    }

    // Secret scan across every string field — reject the WHOLE candidate on any hit.
    // Never partially write a redacted version; that still requires trusting the
    // redaction was complete.
    const scanFields = [c.description, c.verbatim_quote, c.why, c.body_markdown, c.name].filter((v) => typeof v === 'string');
    const secretHits = [];
    for (const field of scanFields) {
      for (const hit of findSecrets(field)) secretHits.push(hit);
    }
    if (secretHits.length) reasons.push(`SECRET DETECTED (${[...new Set(secretHits)].join(',')}) — candidate dropped, not redacted`);

    if (reasons.length) {
      rejected.push({ candidate: { name: c.name, category: c.category }, reasons });
      continue;
    }

    accepted.push({
      category: c.category,
      action,
      name: c.name,
      target_file: targetFile,
      description: c.description.trim(),
      valid_at: c.valid_at || null,
      verbatim_quote: c.verbatim_quote || null,
      why: c.why || '',
      body_markdown: c.body_markdown.trim(),
      related: Array.isArray(c.related) ? c.related.filter((r) => typeof r === 'string') : [],
    });
    if (accepted.length >= MAX_CANDIDATES_PER_RUN) break;
  }
  return { accepted, rejected };
}

function frontmatterFor(c, { sessionId, todayIso }) {
  const emoji = c.category === 'feedback' ? '⚠️ ' : '';
  return `---
name: ${c.name}
description: "${c.description.replace(/"/g, '\\"')}"
metadata:
  type: ${c.category === 'person' ? 'user' : c.category === 'feedback' ? 'feedback' : 'project'}
  originSessionId: ${sessionId}
  modified: ${todayIso}
${c.valid_at ? `valid_at: ${c.valid_at}\n` : ''}---

${c.why ? `${c.why}\n\n` : ''}${c.verbatim_quote ? `Heath's own words: "${c.verbatim_quote}"\n\n` : ''}${c.body_markdown}
${c.related && c.related.length ? `\nRelated: ${c.related.map((r) => `[[${r}]]`).join(', ')}\n` : ''}`;
}

/** Applies accepted candidates to disk (new file / append-to-existing). No-op if !live. */
function applyCaptures(accepted, { live, sessionId }) {
  const applied = [];
  const todayIso = new Date().toISOString().slice(0, 10);
  for (const c of accepted) {
    const filePath = path.join(MEMORY_DIR, c.target_file);
    if (c.action === 'new') {
      const content = frontmatterFor(c, { sessionId, todayIso });
      if (live) fs.writeFileSync(filePath, content);
      applied.push({ ...c, filePath, indexLineNeeded: true });
    } else {
      const appendBlock = `\n\n---\n## Update ${todayIso}\n\n${c.why ? `${c.why}\n\n` : ''}${c.verbatim_quote ? `Heath's own words: "${c.verbatim_quote}"\n\n` : ''}${c.body_markdown}\n`;
      if (live) fs.appendFileSync(filePath, appendBlock);
      applied.push({ ...c, filePath, indexLineNeeded: false });
    }
  }
  return applied;
}

/**
 * Hard cap enforcement on MEMORY.md. Never silently overflows: if appending
 * the new index lines would push the file past the line/byte cap, it writes
 * NOTHING to MEMORY.md and instead appends to a pending-entries file that a
 * human (or a dedicated consolidation session) works through.
 */
function updateMemoryIndex(appliedNew, { live }) {
  const linesToAdd = appliedNew
    .filter((a) => a.indexLineNeeded)
    .map((a) => {
      const emoji = a.category === 'feedback' ? '⚠️ ' : '';
      // Title = first ~8 words of the description, not split on sentence
      // punctuation (a description mentioning "MEMORY.md" or "v2.1" should
      // not get truncated mid-word at that period).
      const title = a.description.split(/\s+/).slice(0, 8).join(' ').slice(0, 60);
      let line = `- ${emoji}[${title}](${a.target_file}) — ${a.description}`;
      if (line.length > 200) line = line.slice(0, 197) + '...';
      return line;
    });

  if (!linesToAdd.length) return { added: 0, pending: 0, capHit: false };

  const current = readMemoryIndexText();
  const currentLines = current ? current.split('\n').length : 0;
  const currentBytes = Buffer.byteLength(current, 'utf-8');
  const addBytes = Buffer.byteLength(linesToAdd.join('\n') + '\n', 'utf-8');
  const wouldBeLines = currentLines + linesToAdd.length;
  const wouldBeBytes = currentBytes + addBytes;

  if (wouldBeLines > MEMORY_INDEX_MAX_LINES || wouldBeBytes > MEMORY_INDEX_MAX_BYTES) {
    if (live) {
      const pendingBlock = linesToAdd.map((l) => `${l}  <!-- pending, added ${new Date().toISOString().slice(0, 10)}, MEMORY.md at cap -->`).join('\n') + '\n';
      fs.appendFileSync(PENDING_INDEX_PATH, pendingBlock);
    }
    return { added: 0, pending: linesToAdd.length, capHit: true, wouldBeLines, wouldBeBytes };
  }

  if (live) {
    fs.appendFileSync(MEMORY_INDEX_PATH, linesToAdd.join('\n') + '\n');
  }
  return { added: linesToAdd.length, pending: 0, capHit: false, wouldBeLines, wouldBeBytes };
}

/** Human-readable session capture log, written OUTSIDE the repo (memory dir). */
function writeCaptureSessionLog({ sessionId, event, trigger, live, accepted, rejected, indexResult, error, truncated, fullChars }) {
  try { fs.mkdirSync(CAPTURE_LOG_DIR, { recursive: true }); } catch (e) { /* ignore */ }
  const shortId = (sessionId || 'unknown').slice(0, 8);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fname = path.join(CAPTURE_LOG_DIR, `${stamp}-${shortId}-${event}.md`);
  const lines = [];
  lines.push(`# Memory capture — ${event}${trigger ? ` (${trigger})` : ''} — ${live ? 'LIVE' : 'REPORT MODE (nothing written)'}`);
  lines.push(`Session ${sessionId} — ${new Date().toISOString()}`);
  if (error) lines.push(`\nERROR: ${error}`);
  if (truncated) lines.push(`\nWARNING: delta was ${fullChars} chars, only the oldest ${MAX_EXCERPT_CHARS} were sent for extraction this run — the newer remainder is deferred to the next firing, not lost.`);
  lines.push(`\n## ${live ? 'Captured' : 'Would capture'} (${accepted.length})`);
  for (const a of accepted) {
    lines.push(`- [${a.category}/${a.action}] ${a.target_file} — ${a.description}`);
    if (a.verbatim_quote) lines.push(`  quote: "${a.verbatim_quote}"`);
  }
  lines.push(`\n## Rejected (${rejected.length})`);
  for (const r of rejected) {
    lines.push(`- ${r.candidate && r.candidate.name ? r.candidate.name : '(unnamed)'}: ${r.reasons.join('; ')}`);
  }
  if (indexResult) {
    lines.push(`\n## MEMORY.md index`);
    lines.push(`- lines added: ${indexResult.added}, pending (cap hit): ${indexResult.pending}, capHit: ${indexResult.capHit}`);
  }
  try { fs.writeFileSync(fname, lines.join('\n') + '\n'); } catch (e) { /* best effort */ }
  return fname;
}

/**
 * ===========================================================================
 * GLOBAL COST-CONTROL GATE — added 2026-10-01 after a real incident.
 * ===========================================================================
 *
 * Background: the first version of this hook gated per-`session_id`. On
 * 2026-09-28, within ~2.5 minutes, 5 DISTINCT session_ids fired the hook
 * from a single active worktree (this is a multi-agent dispatch environment
 * — every subagent/worktree-internal dispatch gets its own session_id, so a
 * per-session lock provides no bound across them at all), 2 concurrent
 * `claude -p` extraction processes had to be `kill -9`'d, and the hook was
 * hotfixed out of settings.json entirely (see
 * memory/memory-capture-hook-token-drain-2026-09-28.md).
 *
 * Heath's explicit rebuild spec (memory/feedback_memory-capture-cost-control-
 * requirements.md): a MACHINE-WIDE lock (not per-session), stale-lock
 * recoverable, a real rate limit independent of the lock (30 min default), a
 * hard daily ceiling (12/day default, rolling 24h), both numbers
 * configurable in guard-config.json, and — critically — the gate must sit in
 * front of the EXPENSIVE `claude -p` spawn itself, not just the write, so
 * report mode becomes genuinely cheap (log that it would have extracted,
 * don't actually extract) instead of costing the same as a live run.
 *
 * "Machine-wide" here means: one shared state per cwd/worktree, keyed by
 * nothing session-specific, so every firing from every session_id in that
 * worktree contends for the exact same lock/rate-limit/daily-budget. (A
 * worktree's hook state directory is not visible to other worktrees anyway —
 * see hook-utils.js's hooksDir(cwd) — so "machine-wide" in practice means
 * "worktree-wide," which is exactly the scope the incident needed bounded.)
 *
 * Order of checks (cheapest/least-stateful first): rate limit -> daily
 * ceiling -> lock. Only once the lock is actually acquired does this record
 * the firing (consuming the rate-limit slot and the daily budget) — so a
 * rejected attempt never falsely consumes budget meant for a real run.
 */

const GLOBAL_LOCK_FILE = 'memory-capture-global-lock.txt';
const GLOBAL_LAST_FIRED_FILE = 'memory-capture-global-last-fired.txt';
const GLOBAL_DAILY_LOG_FILE = 'memory-capture-global-daily-log.json';
const GUARD_CONFIG_DEFAULTS = Object.freeze({
  rateLimitMinutes: 30,
  dailyCeiling: 12,
  staleLockMinutes: 3,
});

function hooksStateDir(cwd) {
  return path.join(cwd, '.claude', 'hooks', 'state');
}

function ensureStateDir(cwd) {
  try { fs.mkdirSync(hooksStateDir(cwd), { recursive: true }); } catch (e) { /* ignore */ }
}

/**
 * Reads `.claude/hooks/guard-config.json`'s `memory_capture` section. Never
 * throws — any missing file, missing key, or bad value silently falls back
 * to GUARD_CONFIG_DEFAULTS, because a malformed config must never be the
 * reason this hook fails open into unbounded spawning.
 */
function readMemoryCaptureConfig(cwd) {
  try {
    const raw = fs.readFileSync(path.join(cwd, '.claude', 'hooks', 'guard-config.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    const mc = (parsed && parsed.memory_capture) || {};
    const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
    return {
      rateLimitMinutes: num(mc.rate_limit_minutes, GUARD_CONFIG_DEFAULTS.rateLimitMinutes),
      dailyCeiling: num(mc.daily_ceiling, GUARD_CONFIG_DEFAULTS.dailyCeiling),
      staleLockMinutes: num(mc.stale_lock_minutes, GUARD_CONFIG_DEFAULTS.staleLockMinutes),
    };
  } catch (e) {
    return { ...GUARD_CONFIG_DEFAULTS };
  }
}

/** Rolling-window rate limit, independent of (checked before) the lock. */
function checkGlobalRateLimit(cwd, nowMs, rateLimitMinutes) {
  let lastFired = 0;
  try {
    lastFired = Number(fs.readFileSync(path.join(hooksStateDir(cwd), GLOBAL_LAST_FIRED_FILE), 'utf-8').trim()) || 0;
  } catch (e) { /* no prior firing recorded = allowed */ }
  const sinceMs = nowMs - lastFired;
  return { allowed: sinceMs >= rateLimitMinutes * 60000, sinceMs, lastFired };
}

/** Hard ceiling on firings in the trailing 24h, independent of calendar day. */
function checkGlobalDailyCeiling(cwd, nowMs, dailyCeiling) {
  let timestamps = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(hooksStateDir(cwd), GLOBAL_DAILY_LOG_FILE), 'utf-8'));
    if (Array.isArray(parsed)) timestamps = parsed;
  } catch (e) { /* no log yet = empty */ }
  const cutoff = nowMs - 24 * 60 * 60 * 1000;
  const recent = timestamps.filter((t) => typeof t === 'number' && t > cutoff);
  return { allowed: recent.length < dailyCeiling, countLast24h: recent.length, recent };
}

/**
 * Machine-wide (per-cwd, NOT per-session) mutex. Uses an atomic exclusive
 * create (`flag: 'wx'`) for the uncontended case — true OS-level atomicity,
 * closing the TOCTOU race a plain read-then-write would have under the
 * exact multi-process conditions that caused the original incident. The
 * stale-lock steal path (lock exists but is older than staleLockMinutes)
 * has a small residual race window; worst case under genuine staleness is
 * two processes proceeding together once every staleLockMinutes, not the
 * original unbounded pileup.
 */
function tryAcquireGlobalLock(cwd, nowMs, staleLockMinutes) {
  ensureStateDir(cwd);
  const p = path.join(hooksStateDir(cwd), GLOBAL_LOCK_FILE);
  try {
    fs.writeFileSync(p, String(nowMs), { flag: 'wx' });
    return true;
  } catch (e) {
    // EEXIST (or any other write failure) — fall through to the stale check.
  }
  try {
    const existing = Number(fs.readFileSync(p, 'utf-8').trim());
    const age = nowMs - existing;
    if (Number.isFinite(age) && age < staleLockMinutes * 60000) return false;
  } catch (e2) {
    // Unreadable lock file — treat as stale/corrupt and steal it below.
  }
  try {
    fs.writeFileSync(p, String(nowMs));
    return true;
  } catch (e3) {
    return false;
  }
}

function releaseGlobalLock(cwd) {
  try { fs.unlinkSync(path.join(hooksStateDir(cwd), GLOBAL_LOCK_FILE)); } catch (e) { /* ignore */ }
}

/**
 * Single entry point for "may this firing proceed at all" — rate limit,
 * then daily ceiling, then lock, in that order. Only on a true `allowed`
 * does it record the firing (rate-limit timestamp + daily log entry),
 * consuming budget. Applies uniformly to REPORT and LIVE firings: the
 * original incident did not distinguish between them, and splitting the
 * gate by mode would just be a second, less-tested bound.
 *
 * Returns { allowed, reason, detail }. `reason` is one of 'RATE_LIMIT',
 * 'DAILY_CEILING', 'LOCKED', or null when allowed.
 */
function acquireCaptureSlot(cwd, nowMs, config) {
  const rate = checkGlobalRateLimit(cwd, nowMs, config.rateLimitMinutes);
  if (!rate.allowed) return { allowed: false, reason: 'RATE_LIMIT', detail: rate };

  const daily = checkGlobalDailyCeiling(cwd, nowMs, config.dailyCeiling);
  if (!daily.allowed) return { allowed: false, reason: 'DAILY_CEILING', detail: daily };

  if (!tryAcquireGlobalLock(cwd, nowMs, config.staleLockMinutes)) {
    return { allowed: false, reason: 'LOCKED', detail: null };
  }

  ensureStateDir(cwd);
  try { fs.writeFileSync(path.join(hooksStateDir(cwd), GLOBAL_LAST_FIRED_FILE), String(nowMs)); } catch (e) { /* best effort */ }
  try { fs.writeFileSync(path.join(hooksStateDir(cwd), GLOBAL_DAILY_LOG_FILE), JSON.stringify([...daily.recent, nowMs])); } catch (e) { /* best effort */ }

  return { allowed: true, reason: null, detail: { rate, daily } };
}

function releaseCaptureSlot(cwd) {
  releaseGlobalLock(cwd);
}

module.exports = {
  MEMORY_DIR,
  MEMORY_INDEX_PATH,
  CAPTURE_LOG_DIR,
  PENDING_INDEX_PATH,
  MEMORY_INDEX_MAX_LINES,
  MEMORY_INDEX_MAX_BYTES,
  MAX_EXCERPT_CHARS,
  MAX_CANDIDATES_PER_RUN,
  extractNewExcerpt,
  readExistingMemoryFilenames,
  readMemoryIndexText,
  readClaudeMdText,
  buildExtractionPrompt,
  runExtraction,
  validateAndFilterCandidates,
  applyCaptures,
  updateMemoryIndex,
  writeCaptureSessionLog,
  // Global cost-control gate (2026-10-01 rebuild)
  GUARD_CONFIG_DEFAULTS,
  readMemoryCaptureConfig,
  checkGlobalRateLimit,
  checkGlobalDailyCeiling,
  tryAcquireGlobalLock,
  releaseGlobalLock,
  acquireCaptureSlot,
  releaseCaptureSlot,
};
