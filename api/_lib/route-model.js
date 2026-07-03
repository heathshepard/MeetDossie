// api/_lib/route-model.js
// ============================================================================
// Model routing helper.
//
// Takes a task description + role + optional complexity override and returns
// the right Anthropic model name. Cuts costs by sending mechanical tasks to
// Haiku, reserving Opus for hard problems.
//
// Pricing (per 1M tokens, in/out):
//   Haiku  4.5 — $0.80 / $4.00     (~13% of Sonnet's cost)
//   Sonnet 4.6 — $3.00 / $15.00    (default for normal builds)
//   Opus   4.8 — $15.00 / $75.00   (5x Sonnet, reserve for architecture)
//
// Decision tree:
//   1) explicit override → use it
//   2) role-default override (e.g. Sage = Sonnet by default)
//   3) task text contains "complexity" signal:
//        - "architecture" / "design" / "research" / "debug" / "novel" / "post-mortem"
//          / "investigation" / "diagnose" / "root cause" → Opus
//        - "scan" / "copy" / "migrate" / "regex" / "extract" / "status" / "lint"
//          / "format" / "transform" / "JSON" / "CSV" / "rename" / "list" / "audit"
//          → Haiku
//   4) default → Sonnet
//
// Usage:
//   const { routeModel } = require('./_lib/route-model');
//   const model = routeModel({ role: 'atlas', task: 'copy logs from S3 to local' });
//
// Owner: Atlas (atlas_5, 2026-06-20 Agent Speed Unlock).
// ============================================================================

const MODEL_OPUS   = 'claude-opus-4-8';
const MODEL_SONNET = 'claude-sonnet-5';
const MODEL_HAIKU  = 'claude-haiku-4-5-20251001';

// Role defaults — what the agent uses if no per-task signal applies.
// Most roles default to Sonnet (general builds). Sage uses Haiku for high-
// volume social drafting. Hadley uses Sonnet for legal reasoning. Quinn
// uses Haiku for fast QA scans.
const ROLE_DEFAULTS = {
  atlas:    MODEL_SONNET,
  carter:   MODEL_SONNET,
  hadley:   MODEL_SONNET,
  pierce:   MODEL_SONNET,
  sage:     MODEL_HAIKU,
  ridge:    MODEL_HAIKU,
  quinn:    MODEL_HAIKU,
  sterling: MODEL_SONNET,
  jarvis:   MODEL_SONNET,
};

// Patterns. Each match is a single literal substring (lowercase compare).
// We use lowercase substring matching rather than regex for predictability +
// minor speed win on 10k+ calls/day.
const OPUS_SIGNALS = [
  'architecture',
  'system design',
  'novel',
  'investigate',
  'investigation',
  'diagnose',
  'root cause',
  'post-mortem',
  'postmortem',
  'security review',
  'rethink',
  'redesign',
  'multi-step reasoning',
  'reason through',
  'plan the migration',
  'design the schema',
  'design the api',
  'high-stakes',
];

const HAIKU_SIGNALS = [
  'scan logs',
  'log scan',
  'tail logs',
  'copy file',
  'copy the file',
  'rename',
  'list files',
  'list the',
  'count rows',
  'count the',
  'extract',
  'regex',
  'json transform',
  'csv to json',
  'json to csv',
  'status update',
  'quick status',
  'status check',
  'lint',
  'format the',
  'format this',
  'reformat',
  'mechanical',
  'crud',
  'simple migration',
  'one-off script',
  'one off script',
  'pull the latest',
  'pull latest',
  'check if exists',
  'verify the file',
  'verify file exists',
];

function containsAny(haystack, needles) {
  for (const n of needles) {
    if (haystack.includes(n)) return n;
  }
  return null;
}

/**
 * Route a task to the best-fit model.
 *
 * @param {object} opts
 * @param {string} [opts.role]       agent role (atlas/carter/...)
 * @param {string} [opts.task]       task description / spawn prompt
 * @param {string} [opts.override]   explicit model override (wins all)
 * @param {string} [opts.complexity] 'simple' | 'standard' | 'hard' (shortcut)
 * @returns {{ model: string, reason: string }}
 */
function routeModel(opts = {}) {
  const { role, task = '', override, complexity } = opts;

  // 1) Explicit override always wins.
  if (override) {
    if (override === 'haiku')  return { model: MODEL_HAIKU,  reason: 'override:haiku' };
    if (override === 'sonnet') return { model: MODEL_SONNET, reason: 'override:sonnet' };
    if (override === 'opus')   return { model: MODEL_OPUS,   reason: 'override:opus' };
    // raw model id
    if (override.startsWith('claude-')) return { model: override, reason: 'override:raw' };
  }

  // 2) Complexity shortcut (lets callers say "this is hard" without writing prose).
  if (complexity === 'simple') return { model: MODEL_HAIKU,  reason: 'complexity:simple' };
  if (complexity === 'hard')   return { model: MODEL_OPUS,   reason: 'complexity:hard' };
  if (complexity === 'standard') return { model: MODEL_SONNET, reason: 'complexity:standard' };

  // 3) Text-signal routing.
  const text = String(task || '').toLowerCase();
  const opusHit = containsAny(text, OPUS_SIGNALS);
  if (opusHit) return { model: MODEL_OPUS, reason: `opus_signal:${opusHit}` };

  const haikuHit = containsAny(text, HAIKU_SIGNALS);
  if (haikuHit) return { model: MODEL_HAIKU, reason: `haiku_signal:${haikuHit}` };

  // 4) Role default.
  if (role && ROLE_DEFAULTS[role]) {
    return { model: ROLE_DEFAULTS[role], reason: `role_default:${role}` };
  }

  // 5) Global default.
  return { model: MODEL_SONNET, reason: 'global_default' };
}

module.exports = {
  routeModel,
  MODEL_OPUS,
  MODEL_SONNET,
  MODEL_HAIKU,
  ROLE_DEFAULTS,
  OPUS_SIGNALS,
  HAIKU_SIGNALS,
};
