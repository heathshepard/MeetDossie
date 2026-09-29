'use strict';
/**
 * capture-lock.js — machine-wide lock + rate limiter for memory-capture.js.
 *
 * WHY THIS EXISTS (2026-09-28, hotfix e7c891c8 unwired the hook after a
 * real, unattended token drain — 5 distinct session_ids fired PreCompact/
 * SessionEnd from ONE active worktree within ~2.5 minutes, 2 concurrent
 * `claude -p` extractions had to be kill -9'd). Two confirmed root causes:
 *
 *   1. session_id is NOT "one Heath session" in this multi-agent dispatch
 *      environment — it's effectively per-turn/per-subagent. The OLD
 *      per-session lock in memory-capture.js (lockKey/tryAcquireLock, keyed
 *      by session_id) bounded nothing, because the thing multiplying WAS
 *      the session_id: 5 sessions = 5 independent lock files, zero
 *      contention between them.
 *   2. That old lock's state also lived under `<cwd>/.claude/hooks/state/`,
 *      which is per-CHECKOUT — every git worktree has its own copy. Two
 *      worktrees firing at once would never see each other's lock either.
 *
 * FIX: one lock file at a fixed, repo/worktree-independent absolute path —
 * placed alongside MEMORY_DIR, which is ALREADY the one fixed path every
 * worktree converges on to write real memory files — plus a rate limiter
 * and a rolling 24h ceiling stored the same way. Every worktree checking
 * out this repo resolves capture-lock's STATE_DIR to the identical absolute
 * path regardless of which worktree or session is asking, which is what
 * makes this "machine-wide" rather than "per-checkout."
 *
 * Lock pattern is modeled on scripts/_lib/chrome-profile-unlock.js (holder
 * detection: dead-PID / stale-timestamp = reclaimable, log every action)
 * and scripts/agent-dispatch-preflight.js (read-only holder checks before
 * a shared resource is touched). One deliberate difference from
 * chrome-profile-unlock's cooperative WAIT-then-kill design: this lock
 * NEVER waits and NEVER retries beyond a single reclaim-if-stale attempt —
 * memory-capture.js's own header already states the policy this enforces:
 * "If held by a live process, skip immediately. Never queue, never wait,
 * never retry — the next firing sees the same material anyway." A queued
 * retry here would just be a slower way to reintroduce the same drain.
 *
 * Also unlike chrome-profile-unlock (which shells out to powershell.exe
 * because Chrome runs as a WINDOWS process reachable only across the WSL
 * boundary), the holder here is always a plain Linux/WSL `node` process —
 * every worktree lives under the same WSL instance and shares one PID
 * namespace, so a plain `process.kill(pid, 0)` liveness check is sufficient
 * and correct. No cross-OS process enumeration needed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MEMORY_DIR } = require('./memory-capture-lib.js');

// Fixed absolute path — NOT derived from cwd/__dirname-relative-to-repo, so
// every worktree/checkout of this repo resolves to the exact same location.
const STATE_DIR = path.join(MEMORY_DIR, '.capture-lock');
const LOCK_FILE = path.join(STATE_DIR, 'lock.json');
const LIMITER_FILE = path.join(STATE_DIR, 'limiter-state.json');
// The ONE file Heath reads to see why capture did or didn't run globally —
// every skip reason (lock held, rate limited, daily cap, disabled) and
// every successful gate-pass lands here, metadata only, append-only.
const REASON_LOG = path.join(STATE_DIR, 'skip-reasons.log');

// guard-config.json lives at .claude/hooks/guard-config.json; this file is
// at .claude/hooks/lib/capture-lock.js, so '..' gets back to hooks/.
const GUARD_CONFIG_PATH = path.join(__dirname, '..', 'guard-config.json');

const DEFAULTS = {
  enabled: true,
  rate_limit_minutes: 30,
  daily_max_extractions: 12,
  // Real extraction spawns measured 46s-220s (see memory-capture.js
  // timeoutMs comment). 5 minutes gives comfortable margin above the
  // worst-case configured spawn timeout (220s) plus prompt-build overhead
  // before a lock is presumed abandoned by a crashed/killed run.
  lock_stale_ms: 5 * 60 * 1000,
};

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(GUARD_CONFIG_PATH, 'utf-8'));
    const mc = (raw && raw.memory_capture) || {};
    return {
      enabled: mc.enabled !== false, // default true unless explicitly false
      rateLimitMs: Math.max(0, Number(mc.rate_limit_minutes ?? DEFAULTS.rate_limit_minutes)) * 60 * 1000,
      dailyMax: Math.max(1, Number(mc.daily_max_extractions ?? DEFAULTS.daily_max_extractions)),
      lockStaleMs: Math.max(30000, Number(mc.lock_stale_ms ?? DEFAULTS.lock_stale_ms)),
    };
  } catch (e) {
    // Missing/unreadable/corrupt config must never disable cost control —
    // fail closed to the conservative defaults, not open to "no limits".
    return {
      enabled: DEFAULTS.enabled,
      rateLimitMs: DEFAULTS.rate_limit_minutes * 60 * 1000,
      dailyMax: DEFAULTS.daily_max_extractions,
      lockStaleMs: DEFAULTS.lock_stale_ms,
    };
  }
}

function ensureDir() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch (e) { /* ignore */ }
}

function logReason(level, reason, extra) {
  try {
    ensureDir();
    const line = JSON.stringify({ ts: new Date().toISOString(), level, reason, ...extra }) + '\n';
    fs.appendFileSync(REASON_LOG, line);
  } catch (e) {
    // Logging must never throw past the caller — there is nowhere safer to
    // report a logging failure from inside a lock module.
  }
}

/** True if `pid` is a live process on this machine. Signal 0 = existence check, does not kill. */
function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: process exists but is owned by another user — still alive.
    // Anything else (ESRCH, etc.): no such process.
    return e.code === 'EPERM';
  }
}

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
  } catch (e) {
    return null;
  }
}

function writeLockAtomic(payload) {
  // 'wx' = O_CREAT|O_EXCL — throws EEXIST if the file already exists. This
  // is the atomic primitive: there is no window between "check if it
  // exists" and "create it" for a second process to slip through, unlike a
  // readFile-then-writeFile check-then-act pattern.
  const fd = fs.openSync(LOCK_FILE, 'wx');
  try {
    fs.writeSync(fd, payload);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Atomic acquire. On contention: inspect the existing holder. A dead PID or
 * a lock older than lockStaleMs is reclaimed (unlink + ONE retry of the
 * atomic create — not a loop). A live, fresh holder fails immediately with
 * no wait and no retry, per the "skip immediately, never queue" policy.
 */
function acquire({ event, sessionId, lockStaleMs }) {
  ensureDir();
  const token = crypto.randomBytes(8).toString('hex');
  const payload = JSON.stringify({
    pid: process.pid,
    token,
    event: event || 'unknown',
    sessionId: (sessionId || 'unknown').slice(0, 12),
    acquiredAt: Date.now(),
    acquiredAtIso: new Date().toISOString(),
  });

  try {
    writeLockAtomic(payload);
    return { ok: true, token };
  } catch (e) {
    if (e.code !== 'EEXIST') {
      logReason('ERROR', 'lock_acquire_error', { msg: e.message });
      return { ok: false, reason: 'error', detail: e.message };
    }
  }

  // Lock file already exists — decide reclaimable vs genuinely held.
  const existing = readLock();
  if (!existing || typeof existing.pid !== 'number') {
    // Unreadable/corrupt lock file: treat as an abandoned artifact.
    logReason('INFO', 'reclaim_corrupt_lock', { raw: existing });
    try { fs.unlinkSync(LOCK_FILE); } catch (e2) { /* ignore */ }
  } else {
    const age = Date.now() - (existing.acquiredAt || 0);
    const dead = !isPidAlive(existing.pid);
    const stale = !Number.isFinite(existing.acquiredAt) || age > lockStaleMs;
    if (!dead && !stale) {
      return { ok: false, reason: 'held', holder: existing };
    }
    logReason('INFO', dead ? 'reclaim_dead_pid' : 'reclaim_stale_lock', { holder: existing, ageMs: age });
    try { fs.unlinkSync(LOCK_FILE); } catch (e2) { /* ignore */ }
  }

  // One reclaim attempt only. If another process wins this exact race, back
  // off cleanly — no loop, no wait, matches the "never retry" policy.
  try {
    writeLockAtomic(payload);
    return { ok: true, token };
  } catch (e) {
    return { ok: false, reason: e.code === 'EEXIST' ? 'held' : 'error', detail: e.message };
  }
}

/** Release only if the lock file still holds OUR token — never delete a lock someone else has since acquired. */
function release(token) {
  try {
    const existing = readLock();
    if (existing && existing.token === token) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (e) { /* best effort */ }
}

function readLimiterState() {
  try {
    const raw = JSON.parse(fs.readFileSync(LIMITER_FILE, 'utf-8'));
    return { runs: Array.isArray(raw.runs) ? raw.runs.filter((t) => Number.isFinite(t)) : [] };
  } catch (e) {
    return { runs: [] };
  }
}

function writeLimiterState(state) {
  try {
    ensureDir();
    fs.writeFileSync(LIMITER_FILE, JSON.stringify(state));
  } catch (e) { /* ignore */ }
}

/**
 * Rolling-24h daily cap + minimum-gap rate limit, checked together. Read-
 * only — does not record anything. Exported separately from gate() so the
 * concurrency test can inspect "would this be allowed" without mutating
 * state.
 */
function checkLimits(cfg) {
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const { runs } = readLimiterState();
  const runsLast24h = runs.filter((t) => t > dayAgo);

  if (runsLast24h.length >= cfg.dailyMax) {
    return { allowed: false, reason: 'daily_cap', detail: { count: runsLast24h.length, max: cfg.dailyMax } };
  }

  const lastRun = runsLast24h.length ? Math.max(...runsLast24h) : 0;
  const sinceLastMs = now - lastRun;
  if (lastRun && sinceLastMs < cfg.rateLimitMs) {
    return { allowed: false, reason: 'rate_limited', detail: { sinceLastMs, requiredMs: cfg.rateLimitMs } };
  }

  return { allowed: true, detail: { runsLast24h: runsLast24h.length, dailyMax: cfg.dailyMax } };
}

/** Record that a real extraction is starting NOW. Call ONLY once gate() has fully passed. Prunes >24h-old entries. */
function recordExtractionStart() {
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const { runs } = readLimiterState();
  const pruned = runs.filter((t) => t > dayAgo);
  pruned.push(now);
  writeLimiterState({ runs: pruned });
}

/**
 * Top-level gate — the ONLY function memory-capture.js should call
 * immediately before spawning `claude -p`. Never call this for report mode
 * (report mode should skip before ever reaching here — it has nothing to
 * gate since it never spawns).
 *
 * On success: returns { allowed: true, release } — caller MUST call
 * release() exactly once when the extraction attempt is done (success OR
 * error), in a finally block. The rate/daily ledger is NOT touched by
 * release() — recordExtractionStart() already ran at gate time, and it's a
 * ledger of attempts (cost incurred), not a mutex.
 *
 * On failure: returns { allowed: false, reason } where reason is one of
 * 'disabled' | 'lock_held' | 'lock_error' | 'rate_limited' | 'daily_cap'.
 * Every outcome (pass or skip) is logged to REASON_LOG.
 */
function gate({ event, sessionId }) {
  const cfg = readConfig();

  if (!cfg.enabled) {
    logReason('SKIP', 'disabled', { event, sessionId });
    return { allowed: false, reason: 'disabled' };
  }

  const lockResult = acquire({ event, sessionId, lockStaleMs: cfg.lockStaleMs });
  if (!lockResult.ok) {
    const reason = lockResult.reason === 'held' ? 'lock_held' : 'lock_error';
    logReason('SKIP', reason, { event, sessionId, holder: lockResult.holder || null, detail: lockResult.detail || null });
    return { allowed: false, reason };
  }

  const limitResult = checkLimits(cfg);
  if (!limitResult.allowed) {
    release(lockResult.token); // don't hold the lock for an attempt that isn't happening
    logReason('SKIP', limitResult.reason, { event, sessionId, ...limitResult.detail });
    return { allowed: false, reason: limitResult.reason };
  }

  // Passed every check — record the attempt BEFORE the caller spawns, so
  // the worst case (a spawn that hangs past its own timeout) still counts
  // against the daily ceiling rather than escaping it.
  recordExtractionStart();
  logReason('RUN', 'gate_passed', { event, sessionId, config: cfg, ...limitResult.detail });

  return { allowed: true, release: () => release(lockResult.token) };
}

module.exports = {
  STATE_DIR, LOCK_FILE, LIMITER_FILE, REASON_LOG,
  DEFAULTS, readConfig, acquire, release, isPidAlive,
  checkLimits, recordExtractionStart, readLimiterState, gate, logReason,
};
