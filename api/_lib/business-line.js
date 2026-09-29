// ============================================================================
// business-line.js — agent_queue.business_line classifier
//
// One lookup, used everywhere a row gets written to agent_queue, so every
// insert path (api/cole-enqueue.js, api/queue-task.js, api/_lib/agent-bus.js
// queueTask()) tags rows the same way. Backs the Jarvis task-viz panel
// (myjarvis) which groups live agent_queue rows by business line.
//
// Fixed agents map straight to their business line. Cole/Warden/
// content-verifier are cross-cutting (Chief of Staff / QA / content-audit
// roles that work across all ventures) — they INHERIT an explicit
// caller-provided business_line if one was passed on the request, otherwise
// they fall back to 'shepard-ventures' (the HQ/uncategorized bucket).
//
// Owner: Atlas, 2026-08-10 (SV-ENG-JARVIS-TASK-VIZ)
// ============================================================================

const VALID_BUSINESS_LINES = Object.freeze([
  'dossie', 'sawyer', 'brokerage', 'trading', 'shepard-ventures',
]);

// null = "inherit" (cross-cutting agent — use explicit override or default)
const AGENT_TO_BUSINESS_LINE = Object.freeze({
  carter: 'dossie',
  atlas: 'dossie',
  hadley: 'dossie',
  pierce: 'dossie',
  sage: 'dossie',
  quinn: 'dossie',
  ridge: 'dossie',
  sawyer: 'sawyer',
  brokerage: 'brokerage',
  sterling: 'trading',
  cole: null,
  warden: null,
  'content-verifier': null,
});

/**
 * Resolve the business_line to stamp on an agent_queue insert.
 *
 * @param {string} agentName        Target agent (e.g. 'carter', 'cole')
 * @param {string} [explicitValue]  Caller-provided override (only honored
 *                                  for inherit-type agents: cole/warden/
 *                                  content-verifier, or an unknown agent)
 * @returns {string} One of VALID_BUSINESS_LINES — never null/empty.
 */
function resolveBusinessLine(agentName, explicitValue) {
  const norm = String(agentName || '').toLowerCase().trim();
  const mapped = AGENT_TO_BUSINESS_LINE[norm];
  if (mapped) return mapped;

  const explicitNorm = explicitValue ? String(explicitValue).toLowerCase().trim() : '';
  if (explicitNorm && VALID_BUSINESS_LINES.includes(explicitNorm)) return explicitNorm;

  return 'shepard-ventures';
}

module.exports = {
  resolveBusinessLine,
  VALID_BUSINESS_LINES,
  AGENT_TO_BUSINESS_LINE,
};
