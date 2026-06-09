'use strict';

// Agent-to-agent dispatch marker parser.
//
// Sage (and any future agent that gains delegation rights) emits action
// markers like `[CARTER: build me X]` in her Telegram replies. This module
// parses those markers, and rewrites the user-facing reply so Heath sees
// a friendly stub instead of the raw marker.
//
// Supported agents are listed in SUPPORTED_AGENTS. Adding a new agent =
// add it here and add a system prompt in api/_lib/agent-prompts/.
//
// Cole is intentionally NOT auto-dispatched in Phase 1 — see api/agent-dispatch.js
// for the relay-only handling.

const SUPPORTED_AGENTS = ['CARTER', 'ATLAS', 'PIERCE', 'HADLEY', 'QUINN', 'COLE'];

// Match [AGENT: free text] — agent name is case-insensitive, body can span
// to the end of the marker (no newlines inside the body, no nested brackets).
// Body must be at least 3 chars to avoid matching things like "[NOTE: x]" if
// they accidentally collide.
const MARKER_REGEX = new RegExp(
  `\\[\\s*(${SUPPORTED_AGENTS.join('|')})\\s*:\\s*([^\\]\\n]{3,500})\\s*\\]`,
  'gi',
);

/**
 * Find all agent-action markers in the input text.
 *
 * @param {string} text  Raw model output.
 * @returns {Array<{agent: string, task: string, raw: string}>}
 */
function extractMarkers(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = [];
  // RegExp with /g is stateful — use matchAll for clarity.
  for (const m of text.matchAll(MARKER_REGEX)) {
    const agent = String(m[1] || '').trim().toLowerCase();
    const task = String(m[2] || '').trim();
    if (!agent || !task) continue;
    if (!SUPPORTED_AGENTS.includes(agent.toUpperCase())) continue;
    matches.push({ agent, task, raw: m[0] });
  }
  return matches;
}

/**
 * Rewrite the text Heath sees by replacing each marker with a friendly stub.
 * Removes the raw bracket syntax so Heath doesn't see the wire format.
 *
 * @param {string} text
 * @returns {string}
 */
function stripMarkersForHeath(text) {
  if (!text || typeof text !== 'string') return text || '';
  return text.replace(MARKER_REGEX, (_match, agentRaw, taskRaw) => {
    const agent = String(agentRaw || '').trim();
    const task = String(taskRaw || '').trim();
    const agentName = agent.charAt(0).toUpperCase() + agent.slice(1).toLowerCase();
    // Truncate long tasks in the stub so the user-facing text stays readable.
    const short = task.length > 80 ? task.slice(0, 77) + '...' : task;
    return `[asking ${agentName}: ${short}]`;
  });
}

module.exports = {
  SUPPORTED_AGENTS,
  extractMarkers,
  stripMarkersForHeath,
};
