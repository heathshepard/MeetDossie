// Weekly newsletter hard-gate filter — locked 2026-07-02 after the 2nd time
// non-customer items (Jarvis panel status, future-builds ops panel) leaked into
// the Friday customer email.
//
// See: .claude/projects/C--Users-Heath-Shepard-Desktop-MeetDossie/memory/feedback_weekly_newsletter_hard_gate.md
//
// STRATEGY (Option B — allowlist + blocklist at parse time):
//
//   1. Only bullets tagged "(customer)" or "(both)" flow through. Bullets
//      without a tag or tagged "(internal)"/"(ops)" are dropped.
//   2. Even a "(customer)"-tagged bullet is dropped if it contains a
//      blocklisted term (Jarvis, future builds, ops panel, cron, Vercel,
//      Supabase, telemetry, watchdog, agent queue, PostHog, workflow, etc.).
//   3. The extractor logs every drop with a reason so we can audit misses.
//
// Why not a schema column? WEEKLY-IMPROVEMENTS.md is a markdown file, not a
// table. The existing `(customer)` marker convention is already the source of
// truth — enforcing it at the parser is the shortest path to a hard gate.

// Terms that immediately disqualify a bullet from the customer newsletter,
// even when the bullet is tagged (customer).
//
// TYPES:
//   substrings:  simple case-insensitive .includes() match (multi-word tokens).
//   words:       whole-word regex match — required for short agent names
//                that appear inside common English words (Sage → mesSAGE,
//                Cole → moleCUle, etc.).
const BLOCKLIST_SUBSTRINGS = [
  'jarvis',           // Heath's internal ops UI — never customer-facing
  'future builds',    // Ops panel
  'future-builds',
  'ops panel',
  'agent queue',
  'watchdog',
  'followups panel',  // Ops-side followups view
  'posthog',          // Analytics wiring
  'auto-map',         // Internal-only inference term (customer sees "auto-fill")
  'automap',
  'telemetry',
  'workflow engine',
  'agent infra',
  'agent-infra',
  'edge function',
  'edge-function',
  'worktree',
  'commit sha',
];

// Whole-word matches — case-insensitive, must be bounded by non-alphanumerics.
const BLOCKLIST_WORDS = [
  'cron',
  'crons',
  'vercel',
  'supabase',
  'staging',
  'apv',
  // Agent codenames — whole word only so "message" doesn't match "sage".
  'quinn',
  'carter',
  'atlas',
  'hadley',
  'pierce',
  'sage',
  'cole',
];

const BLOCKLIST_WORD_REGEX = new RegExp(
  `(?:^|[^a-z0-9])(${BLOCKLIST_WORDS.join('|')})(?=[^a-z0-9]|$)`,
  'i',
);

// Legacy export kept for tests/debugging.
const BLOCKLIST_TERMS = [...BLOCKLIST_SUBSTRINGS, ...BLOCKLIST_WORDS];

// Categories/tags that mark a bullet as internal-only.
const INTERNAL_TAG_PATTERN = /\((?:internal|ops|infra|admin|dev|telemetry|jarvis|agent[- ]infra)\)/i;

// Categories/tags that mark a bullet as customer-facing.
// NOTE: bullets untagged are treated as customer-facing IF they don't hit the
// blocklist. This preserves legacy entries pre-tagging, while still catching
// jarvis/ops mentions.
const CUSTOMER_TAG_PATTERN = /\((?:customer|both|user|customer[- ]facing)\)/i;

/**
 * Filter a raw week-section body (bullet block from WEEKLY-IMPROVEMENTS.md).
 *
 * Bullets in the file look like:
 *   **Header text** (customer)
 *   - Body sentence.
 *
 * OR the older shape:
 *   - We fixed X (customer)
 *
 * We parse header-line + following bullet lines as a group. A group is kept
 * only if the header is tagged customer/both AND no line in the group hits
 * the blocklist.
 *
 * Returns { filtered, dropped } where filtered is the sanitized markdown
 * body ready for the Haiku prompt, and dropped is an array of {reason, text}
 * pairs used for logging/audit.
 */
function filterCustomerVisible(body) {
  if (!body || typeof body !== 'string') {
    return { filtered: '', dropped: [] };
  }

  const lines = body.split('\n');
  const groups = [];
  let current = null;

  const isHeaderLine = (l) => /^\*\*.+?\*\*/.test(l.trim());
  const isBulletLine = (l) => /^-\s+/.test(l.trim());

  for (const line of lines) {
    const trimmed = line.trim();
    if (isHeaderLine(trimmed)) {
      // flush previous
      if (current) groups.push(current);
      current = { header: trimmed, lines: [line], keep: true, reason: null };
    } else if (current) {
      current.lines.push(line);
    } else {
      // Line before any header — treat as its own group so it can be filtered
      // rather than silently included.
      if (trimmed.length > 0) {
        groups.push({ header: '', lines: [line], keep: true, reason: null });
      }
    }
  }
  if (current) groups.push(current);

  const dropped = [];
  const kept = [];

  for (const g of groups) {
    const combined = g.lines.join('\n');
    const combinedLower = combined.toLowerCase();

    // Gate A: explicit internal tag = drop.
    if (INTERNAL_TAG_PATTERN.test(g.header)) {
      dropped.push({ reason: 'internal_tag', text: g.header });
      continue;
    }

    // Gate B: no customer-facing tag AND header exists = drop (require explicit tag).
    // Untagged legacy bullets (no header) fall through to gate C.
    if (g.header && !CUSTOMER_TAG_PATTERN.test(g.header)) {
      dropped.push({ reason: 'missing_customer_tag', text: g.header });
      continue;
    }

    // Gate C: blocklist scan on the full text (header + bullets).
    // First: multi-word substring hits.
    let blockedTerm = null;
    for (const term of BLOCKLIST_SUBSTRINGS) {
      if (combinedLower.includes(term.toLowerCase())) {
        blockedTerm = term;
        break;
      }
    }
    // Then: whole-word hits (agent names, cron, vercel, etc.).
    if (!blockedTerm) {
      const wordHit = combined.match(BLOCKLIST_WORD_REGEX);
      if (wordHit) blockedTerm = wordHit[1].toLowerCase();
    }
    if (blockedTerm) {
      dropped.push({ reason: `blocklist:${blockedTerm.trim()}`, text: g.header || combined.slice(0, 80) });
      continue;
    }

    kept.push(combined);
  }

  return {
    filtered: kept.join('\n\n').trim(),
    dropped,
  };
}

module.exports = {
  filterCustomerVisible,
  BLOCKLIST_TERMS,
  INTERNAL_TAG_PATTERN,
  CUSTOMER_TAG_PATTERN,
};
