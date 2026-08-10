// api/_lib/internal-task-filter.js
// ============================================================================
// Heuristic filter for internal QA/verification noise leaking into
// agent_queue rows that Heath sees on the Jarvis dashboard.
//
// ROOT CAUSE (2026-08-10 dashboard teardown): Carter/Quinn/Atlas write
// agent_queue rows for their OWN test/verification runs (e.g. "BL panel
// verify 1786381769910") using the exact same table Heath's personal
// dashboard reads from. There's no schema-level distinction between
// "real business work" and "an agent testing its own change" — both land
// in agent_queue with a task_subject and a status.
//
// THIS IS A STOPGAP, NOT THE FIX. It pattern-matches on task_subject text
// and silently drops anything that looks like internal engineering noise.
// It will have false negatives (noise that doesn't match a pattern) and,
// in theory, false positives (a genuinely user-facing task that happens to
// contain the word "verify"). The real fix is a schema-level
// `is_internal` / `visible_to_user` boolean on agent_queue, set at
// insert-time by whichever agent is queuing the work, so filtering happens
// at the source instead of being guessed at display time. That's bigger
// infra work — Atlas's domain — tracked as a follow-up, not done here.
//
// Used by:
//   - api/jarvis-in-flight-work.js (In-Flight Work panel item list)
//   - api/jarvis-agent-throughput.js (Agents panel "N blocked" badge count)
// ============================================================================

const NOISE_PATTERNS = [
  /\bverify\b/i,
  /\bverification\b/i,
  /\bqa[\s-]?gate\b/i,
  /\bpanel[\s-]?verify\b/i,
  /\bcache[\s-]?hit\b/i,
  /\bsmoke[\s-]?test\b/i,
  /\bdry[\s-]?run\b/i,
  /\bapv\b/i,
  // Internal task subjects are frequently suffixed with an epoch
  // millisecond/second timestamp to make them unique (e.g.
  // "bl-panel-verify-1786381769910") — real user-facing task subjects
  // don't carry a raw 10+ digit number.
  /\d{10,}/,
];

function isInternalTaskNoise(taskSubject) {
  if (!taskSubject || typeof taskSubject !== 'string') return false;
  return NOISE_PATTERNS.some((re) => re.test(taskSubject));
}

module.exports = { isInternalTaskNoise, NOISE_PATTERNS };
