'use strict';

// api/_lib/backlog-parser.js
// =============================================================================
// Shared parsing for the autonomous loop's document-backed signal sources.
//
// Three things live here, all pure functions over text (no I/O, no network),
// so they can be unit-tested without Supabase or Vercel:
//
//   1. classifyClosed(line)      — is this backlog line already closed?
//   2. parseTechDebt(text)       — active items from docs/TECH-DEBT.md
//   3. parseBacklogDoc(text, …)  — items from docs/BACKLOG-{ENGINEERING,BUSINESS}.md
//                                  with their `Blocked by:` eligibility decided here.
//
// WHY THIS EXISTS (2026-09-17)
// ---------------------------
// `cron-autonomous-loop.js` used to read TECH-DEBT.md with
//   lines.filter(l => l.startsWith('- ')).slice(0, 10)
// and no closed-item filter at all. The very first line of the
// "NOT DONE / ACTIVE BLOCKERS" section is
//   `- ~~cron-comment-opp-approval never left staging~~ — RESOLVED 2026-09-09 …`
// so the loop's top tech-debt candidate was a closed item. It was dispatched to
// carter on 2026-09-13 and again on 2026-09-15 with the word RESOLVED literally
// in the task title. See docs/BACKLOG-ENGINEERING.md E1.
//
// THE `Blocked by` CONTRACT
// ------------------------
// Every item in the two backlog docs carries a `Blocked by` field. It is the
// field an automated loop reads, and its vocabulary is fixed:
//   `agent`                      → completable with no input from Heath.  ELIGIBLE
//   `agent, Heath gates merge`   → agent does all the work; Heath approves the
//                                  merge under the normal staging→main rule.  ELIGIBLE
//   `mixed — …`                  → an agent does part, Heath owns a specific
//                                  step (a login, a send, an approval).  NOT eligible
//   `Heath …`                    → credential, payment, legal call, physical
//                                  action, or a judgment only he can make.  NOT eligible
//   `gated on …`                 → parked behind a named trigger.  NOT eligible
//
// Anything that is not confidently `agent` is NOT eligible. This is enforced
// here, at parse time, and never delegated to the agent that receives the task.
// =============================================================================

// ─── 1. Closed-item detection ────────────────────────────────────────────────

// Status words these docs actually use to close an item. Matched as whole words.
// Deliberately narrow: only markers observed in the real files, plus the
// obvious siblings. Prose like "the fix resolved the crash" is guarded against
// by requiring the marker to sit at a clause boundary (start of line, or right
// after a dash / paren / colon / arrow), which is how the docs always write it.
const CLOSED_WORDS =
  'RESOLVED|FIXED|DONE|SHIPPED|CLOSED|COMPLETE|COMPLETED|OBSOLETE|SUPERSEDED|DEPRECATED|WONTFIX|MOOT|DROPPED';

// Clause-boundary + status word, e.g. "— RESOLVED 2026-08-10", "(done)", ": FIXED".
//
// The boundary set is deliberately tight, because two looser versions of this
// regex produced live false positives against the real docs:
//   • a bare `-` in the class closed A4, whose title reads "…migration is
//     half-done and the app still writes base64" — an OPEN item. So a hyphen
//     only counts as a boundary when it is not gluing two words together.
//   • an `\bis\s` boundary closed F10, "Plate breakdown is dropped whenever a
//     weight is edited by hand" — also open, and plain prose. Verb-phrase
//     boundaries are gone entirely; these docs always write a status marker
//     after a dash, paren, colon or at the start of the line.
const CLOSED_AT_BOUNDARY = new RegExp(
  `(?:^|[—–(\\[:>|]|(?<![A-Za-z0-9])-)\\s*(?:${CLOSED_WORDS})\\b`,
  'i'
);

// Phrases that close an item without a status word.
const CLOSED_PHRASES = [
  /\bstale entry\b/i,
  /\bdo not re-?open\b/i,
  /\bno longer (?:an? )?(?:issue|gap|problem|needed|required)\b/i,
  /\bnot a gap\b/i,
  /\balready (?:built|fixed|shipped|done|live)\b/i,
  /\bverified resolved\b/i,
];

/**
 * Decide whether a single markdown list line describes closed work.
 * @param {string} line raw line, with or without its `- ` bullet
 * @returns {{closed: boolean, reason: string|null}}
 */
function classifyClosed(line) {
  const raw = String(line == null ? '' : line);
  // Strip the bullet / numbering so markers at the start of the content are seen.
  const body = raw.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').trim();
  if (!body) return { closed: false, reason: null };

  // (a) GitHub task-list checkbox already ticked: "- [x] …"
  if (/^\[[xX✓✔]\]/.test(body)) return { closed: true, reason: 'checkbox_checked' };

  // (b) Leading completion glyph: "- ✅ …", "- ✔ …", "- ☑ …"
  if (/^(?:\*\*)?[✅✔☑]/.test(body)) return { closed: true, reason: 'checkmark' };

  // The status region: the title plus the first sentence after it. These docs
  // always put an item's status right there — `**Title** — RESOLVED 2026-08-10`.
  // Everything past it is explanatory body, and the body routinely mentions
  // completed SUB-parts of work that is still open:
  //   "**SMS escalation (Twilio)** — … Needs phone capture (done) + opt-in toggle."
  //   "MCP server registry submissions: MCPT / OpenTools (Smithery ✅ live)"
  // Scanning the whole line closed both of those. They are open items.
  const region = statusRegion(body);

  // (c) Strikethrough. The docs strike the *title* and then explain, e.g.
  //     `~~Fill-and-sign Phase 2~~ — RESOLVED (already built…)`.
  //     A `~~…~~` span anywhere in the title region (before the first em-dash,
  //     or the first 160 chars if there is none) closes the item.
  const titleRegion = body.split(/\s[—–]\s/)[0].slice(0, 160);
  if (/~~[^~]+~~/.test(titleRegion)) return { closed: true, reason: 'strikethrough' };
  // A line that is struck end-to-end counts too.
  if (/^(?:\*\*)?~~[\s\S]+~~(?:\*\*)?$/.test(body)) return { closed: true, reason: 'strikethrough' };

  // (d) An explicit status word at a clause boundary, inside the status region.
  if (CLOSED_AT_BOUNDARY.test(region)) {
    const m = region.match(new RegExp(`\\b(?:${CLOSED_WORDS})\\b`, 'i'));
    return { closed: true, reason: `status_word:${(m ? m[0] : 'unknown').toUpperCase()}` };
  }

  // (e) A closing phrase in the status region.
  for (const re of CLOSED_PHRASES) {
    if (re.test(region)) return { closed: true, reason: `phrase:${re.source.slice(0, 40)}` };
  }

  // (f) "— LIVE" / "- LIVE" straight after the title means it shipped.
  //     Case-sensitive on purpose: lowercase "live" appears inside active items
  //     (e.g. "Smithery ✅ live" as a sub-status of an open item).
  if (/\s[—–-]\s+LIVE\b/.test(region)) return { closed: true, reason: 'status_word:LIVE' };

  return { closed: false, reason: null };
}

/**
 * Title + first sentence. Capped at 240 chars for lines that never terminate a
 * sentence. A decimal point ("~$0.0075/msg") is not a sentence end, because the
 * terminator must be followed by whitespace or end-of-string.
 */
function statusRegion(body) {
  const m = body.match(/\.(?=\s|$)/);
  const end = m ? m.index + 1 : body.length;
  return body.slice(0, Math.min(end, 240));
}

// ─── 2. Heath-owned detection (TECH-DEBT.md) ─────────────────────────────────

// TECH-DEBT.md has no structured `Blocked by` field, so these items are
// screened by pattern. Kept from the original implementation and widened a
// little; the backlog docs are the structured replacement.
const HEATH_OWNED_PATTERNS =
  /\b(Form TX LLC|\bEIN\b|personal action|Heath[^.]{0,40}must|attorney review before live|licensed attorney|business bank|sign(?:s|ature) required)\b/i;

// ─── 3. TECH-DEBT.md ─────────────────────────────────────────────────────────

/**
 * Parse docs/TECH-DEBT.md "NOT DONE / ACTIVE BLOCKERS" into open items.
 * @param {string} text file contents
 * @param {{limit?: number}} [opts]
 * @returns {{items: Array, skipped: Array}}
 */
function parseTechDebt(text, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 10;
  const items = [];
  const skipped = [];

  const activeMatch = String(text || '').match(
    /## NOT DONE \/ ACTIVE BLOCKERS\s+([\s\S]*?)(?=\n## |\n---)/
  );
  if (!activeMatch) return { items, skipped };

  const lines = activeMatch[1].split('\n').filter(l => l.trim().startsWith('- '));

  for (const line of lines) {
    const closed = classifyClosed(line);
    if (closed.closed) {
      skipped.push({ line, reason: `closed:${closed.reason}` });
      continue;
    }
    if (HEATH_OWNED_PATTERNS.test(line)) {
      skipped.push({ line, reason: 'heath_owned' });
      continue;
    }

    const boldMatch = line.match(/\*\*(.+?)\*\*/);
    const title = boldMatch ? boldMatch[1] : line.replace(/^\s*-\s*/, '').slice(0, 100);

    items.push({
      title: title.trim(),
      line: line.trim(),
      urgent: /🚨|\bURGENT\b/.test(line),
    });

    // Cap AFTER filtering, not before — the old code sliced the first 10 raw
    // lines and then filtered, so closed items ate slots from real work.
    if (items.length >= limit) break;
  }

  return { items, skipped };
}

// ─── 4. Blocked-by classification ────────────────────────────────────────────

/** Strip markdown emphasis / code ticks / leading dashes so the value can be read. */
function normalizeBlockedBy(raw) {
  return String(raw || '')
    .replace(/[`*_]/g, '')
    .replace(/^\s*[—–-]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '')
    .trim();
}

// The one Heath-touch an `agent` item is allowed to carry: the normal
// staging→main merge approval that EVERY change goes through anyway.
const MERGE_GATE_ONLY = /\bheath\s+(?:gates|approves|gate)\b[^;]*\bmerge\b|\bmerge[^;]*\bheath\s+(?:gates|approves)\b/i;

/**
 * Decide whether a `Blocked by` value describes work an agent can do unattended.
 * @param {string} raw the raw field text
 * @returns {{raw: string, normalized: string, eligible: boolean, reason: string}}
 */
function classifyBlockedBy(raw) {
  const normalized = normalizeBlockedBy(raw);
  const lower = normalized.toLowerCase();
  const out = { raw: String(raw || '').trim(), normalized, eligible: false, reason: '' };

  if (!normalized) { out.reason = 'missing_blocked_by'; return out; }

  // Explicit non-agent leads. Checked first so "mixed — agent can …" can never
  // be read as an agent item.
  if (/^mixed\b/.test(lower))  { out.reason = 'mixed'; return out; }
  if (/^gated\b/.test(lower))  { out.reason = 'gated'; return out; }
  if (/^heath\b/.test(lower))  { out.reason = 'heath'; return out; }

  if (!/^agent\b/.test(lower)) { out.reason = 'unrecognized'; return out; }

  // Starts with "agent". Any *further* mention of Heath disqualifies it unless
  // the only thing he does is gate the merge.
  const afterAgent = normalized.slice(5);
  if (/\bheath\b/i.test(afterAgent)) {
    // Remove every merge-gate clause, then see if Heath is still mentioned.
    const residual = afterAgent
      .split(/[;,]/)
      .filter(clause => /\bheath\b/i.test(clause))
      .filter(clause => !MERGE_GATE_ONLY.test(clause));
    if (residual.length > 0) {
      out.reason = 'agent_then_heath';
      return out;
    }
  }

  out.eligible = true;
  out.reason = 'agent';
  return out;
}

// ─── 5. BACKLOG-*.md ─────────────────────────────────────────────────────────

// `## ` sections that hold no actionable work. Matched case-insensitively on a
// substring so heading punctuation drift doesn't silently re-open them.
const NON_ACTIONABLE_SECTIONS = [
  'verified resolved',
  'do not re-open',
  'do not reopen',
  'things that are closed',
  'open questions',
  'how to read this',
  'note for the autonomous loop',
  'top 5',
];

function isNonActionableSection(heading) {
  const h = String(heading || '').toLowerCase();
  return NON_ACTIONABLE_SECTIONS.some(s => h.includes(s));
}

/**
 * Parse a BACKLOG-*.md file into items.
 *
 * Item shape in both files is an H3 whose text starts with a short id:
 *   `### A1. anon can execute 19 SECURITY DEFINER functions…`   (engineering)
 *   `### M1 — Heath's personal LinkedIn has failed 20 times…`   (business)
 * followed by `- **Field.** value` / `- **Field** — value` bullets, one of
 * which is `Blocked by`.
 *
 * @param {string} text file contents
 * @returns {{items: Array, skipped: Array}} items are ELIGIBLE only; every
 *          rejected item lands in `skipped` with the reason.
 */
function parseBacklogDoc(text) {
  const items = [];
  const skipped = [];
  const lines = String(text || '').split('\n');

  let section = '';
  let current = null;

  const flush = () => {
    if (!current) return;
    const rec = finalizeBacklogItem(current);
    if (rec.eligible) items.push(rec.item);
    else skipped.push({ id: current.id, title: current.title, reason: rec.reason });
    current = null;
  };

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2 && !/^###/.test(line)) {
      flush();
      section = h2[1].trim();
      continue;
    }

    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) {
      flush();
      if (isNonActionableSection(section)) continue;

      const heading = h3[1].trim();
      // id is the leading token: "A1." or "M1 —" or "BA12 —"
      const idMatch = heading.match(/^([A-Z]{1,3}\d{1,3})\b[.\s—–-]*/);
      const id = idMatch ? idMatch[1] : null;
      const title = idMatch ? heading.slice(idMatch[0].length).trim() : heading;

      current = { id, title, heading, section, body: [], blockedByRaw: null };
      continue;
    }

    if (!current) continue;
    current.body.push(line);

    // `- **Blocked by.** value` or `- **Blocked by** — value`
    const bb = line.match(/^\s*[-*]\s*\*\*Blocked by[.:]?\*\*[.:]?\s*(.*)$/i);
    if (bb && current.blockedByRaw === null) {
      current.blockedByRaw = bb[1];
      current._blockedByOpen = true;
      continue;
    }
    // Continuation lines of the Blocked-by bullet (indented, not a new bullet).
    if (current._blockedByOpen) {
      if (/^\s*[-*]\s/.test(line) || /^\s*$/.test(line) || /^#{2,}/.test(line)) {
        current._blockedByOpen = false;
      } else {
        current.blockedByRaw += ' ' + line.trim();
      }
    }
  }
  flush();

  return { items, skipped };
}

function finalizeBacklogItem(cur) {
  const closed = classifyClosed(cur.heading);
  if (closed.closed) {
    return { eligible: false, reason: `closed:${closed.reason}` };
  }
  if (cur.blockedByRaw === null) {
    // No `Blocked by` field at all → we cannot prove an agent may take it.
    return { eligible: false, reason: 'missing_blocked_by' };
  }

  const verdict = classifyBlockedBy(cur.blockedByRaw);
  if (!verdict.eligible) {
    return { eligible: false, reason: `blocked_by:${verdict.reason}` };
  }

  // Trim the body to the evidence/impact bullets — enough for an agent to act.
  const body = cur.body.join('\n').trim().slice(0, 4000);

  return {
    eligible: true,
    item: {
      id: cur.id,
      title: cur.title,
      section: cur.section,
      blocked_by: verdict.normalized,
      body,
    },
  };
}

module.exports = {
  classifyClosed,
  classifyBlockedBy,
  normalizeBlockedBy,
  parseTechDebt,
  parseBacklogDoc,
  HEATH_OWNED_PATTERNS,
};
