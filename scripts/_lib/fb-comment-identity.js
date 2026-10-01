'use strict';

// scripts/_lib/fb-comment-identity.js
//
// Shared identity + reply-target helpers for Facebook comment harvesting and
// threaded replies. EVERYTHING HERE IS PURE — no DOM, no network, no env — so
// the logic that actually decides "which comment do we reply to" is unit
// testable without a browser (see scripts/regression-fb-nested-reply-target.js).
//
// ─── THE BUG THIS FIXES (2026-10-01) ────────────────────────────────────────
// A reply to a reply-to-a-reply in "Transaction Coordinators and Virtual
// Assistants for Real Estate" failed with:
//     could not locate Reply button for comment by 2w
// and the pipeline then asked Heath to post it by hand.
//
// "2w" is not a person — it is Facebook's relative timestamp. Two independent
// defects stacked:
//
//  1. HARVEST (harvest-tc-discovery-responses.js). It parsed the author from
//     the article's aria-label ("Reply by <name> 2w"), which was CORRECT, and
//     then unconditionally overwrote it with the text of the first
//     `a[role="link"] span` inside the article:
//         if (authorLink && authorLink.innerText.trim()) author = <that text>;
//     For a NESTED reply, the first such link is the timestamp permalink
//     ("2w"), not the profile link. So commenter_name was stored as "2w".
//     Six rows in tc_discovery_responses carry timestamp names from this
//     ("1d", "1w", "22h", "23h", "2d", "2w") — so this was never specific to
//     one URL. pickAuthorName() below makes the link candidate win only when
//     it is plausibly a name.
//
//  2. REPLY (fb-group-commenter.js postReplyToComment). Its locator REQUIRED
//     the stored name to appear in the article's aria-label:
//         if (!label.toLowerCase().includes(name.toLowerCase())) continue;
//     With name="2w" nothing could ever match, so the Reply button was never
//     found. The name was a hard gate on a field the harvester can get wrong.
//     chooseReplyTarget() below demotes the name to a TIEBREAK, and only when
//     the name is trustworthy, while anchoring primarily on the comment id
//     from the permalink — which is exact and never ambiguous.
//
// ─── THE NESTING TRAP (why "match on the comment text" is not enough) ───────
// Facebook renders a nested reply's div[role="article"] INSIDE its parent
// comment's div[role="article"]. So the parent's innerText CONTAINS the
// child's text, and a naive text match matches BOTH — with the parent first in
// document order. Clicking the parent's Reply button posts at the wrong
// nesting level. Hence: candidates are scored, the DEEPEST match wins, and
// buttons/anchors/text are attributed to their OWN article only
// (el.closest('div[role="article"]') === article).

// ─── Name plausibility ──────────────────────────────────────────────────────

// "2w", "5 h", "3 days", "about an hour ago", "Just now", "Yesterday".
const RELATIVE_TS_RE = new RegExp(
  '^(?:'
  + 'just now|now|yesterday'
  + '|\\d+\\s*(?:s|m|h|d|w|y|min|mins|hr|hrs|sec|secs)'
  + '|\\d+\\s*(?:second|minute|hour|day|week|month|year)s?(?:\\s+ago)?'
  + '|(?:about\\s+)?(?:an?|\\d+)\\s+(?:second|minute|hour|day|week|month|year)s?\\s+ago'
  + ')$',
  'i',
);

// Facebook UI chrome that is never a person's name.
const UI_CHROME_RE = new RegExp(
  '^(?:like|reply|replies|share|follow|edited|author|top contributor'
  + '|most relevant|all comments|newest|see more|see translation'
  + '|admin|moderator|group member|view \\d+ repl(?:y|ies))$',
  'i',
);

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** A relative timestamp masquerading as a name. */
function isRelativeTimestampLike(s) {
  const t = norm(s);
  return !!t && RELATIVE_TS_RE.test(t);
}

/** Facebook UI chrome text. */
function isUiChromeText(s) {
  const t = norm(s);
  return !!t && UI_CHROME_RE.test(t);
}

/**
 * True when a stored commenter_name cannot be trusted to identify a human.
 * Callers MUST NOT use such a name as a hard DOM match requirement — that is
 * precisely what broke the nested reply.
 */
function looksLikeHarvestArtifactName(name) {
  const t = norm(name);
  if (!t) return true;
  if (isRelativeTimestampLike(t)) return true;
  if (isUiChromeText(t)) return true;
  if (!/[a-z]/i.test(t)) return true; // digits / punctuation / emoji only
  return false;
}

/** Strip the trailing relative-time phrase FB appends to comment aria-labels. */
function authorFromAriaLabel(label) {
  const m = String(label || '').match(/^(?:Comment|Reply) by (.+)$/i);
  if (!m) return null;
  const stripped = m[1]
    .replace(/\s+(?:about\s+)?(?:an?|\d+)\s+(?:second|minute|hour|day|week|month|year)s?\s+ago$/i, '')
    .replace(/\s+\d+\s*(?:s|m|h|d|w|y)$/i, '')
    .trim();
  return stripped || null;
}

/**
 * Best author string for a comment article.
 *
 * aria-label is the BASELINE; a profile-link candidate only wins when it is
 * plausibly a name. The old code had this backwards — any link text won,
 * including "2w".
 */
function pickAuthorName(ariaLabel, linkCandidate) {
  const fromLabel = authorFromAriaLabel(ariaLabel);
  const cand = norm(linkCandidate);
  if (cand && !looksLikeHarvestArtifactName(cand)) return cand;
  if (fromLabel && !looksLikeHarvestArtifactName(fromLabel)) return fromLabel;
  return fromLabel || cand || null;
}

// ─── Permalink anchoring ────────────────────────────────────────────────────

/**
 * The comment id a permalink actually points AT.
 *
 * A nested reply's permalink carries BOTH comment_id (its PARENT) and
 * reply_comment_id (ITSELF), e.g.
 *   .../posts/1377239757730412/?comment_id=1377246844396370&reply_comment_id=1377253981062323
 * The deepest id is the target. Using comment_id here would aim one level too
 * high and reply under the wrong comment.
 */
function extractCommentAnchorId(permalink) {
  const s = String(permalink || '');
  const reply = s.match(/[?&]reply_comment_id=(\d+)/);
  if (reply) return reply[1];
  const top = s.match(/[?&]comment_id=(\d+)/);
  return top ? top[1] : null;
}

/** True when the permalink describes a reply nested under another comment. */
function isNestedReplyPermalink(permalink) {
  return /[?&]reply_comment_id=\d+/.test(String(permalink || ''));
}

/** Every comment id mentioned by a URL (used to attribute anchors to articles). */
function commentIdsInUrl(url) {
  const out = [];
  const re = /[?&](?:reply_)?comment_id=(\d+)/g;
  let m;
  while ((m = re.exec(String(url || '')))) out.push(m[1]);
  return out;
}

// ─── Reply-target selection ─────────────────────────────────────────────────

/**
 * Decide which harvested comment article to reply to, and whose Reply button
 * to click. PURE — operates on plain descriptors extracted from the DOM.
 *
 * NOTE: fb-group-commenter.js carries an INLINE COPY of this function inside
 * page.evaluate(), because a page.evaluate() callback cannot close over Node
 * scope and Facebook's CSP rules out shipping it as eval'd source. This file
 * is the canonical version and the one under test — keep the two in sync.
 *
 * @param {Array<object>} candidates each:
 *   { idx, depth, ariaLabel, ownAnchorIds[], ownText, articleText,
 *     hasOwnReplyButton, ancestorArticleIdxs[] }  (ancestors nearest-first)
 * @param {object} target { anchorId, commenterName, snippet }
 * @returns {object} { ok, idx, replyButtonFrom, tier, buttonSource, reason, ... }
 */
function chooseReplyTarget(candidates, target = {}) {
  const list = (candidates || []).filter((c) => /^(?:Comment|Reply) by /i.test(String(c.ariaLabel || '')));
  const anchorId = target.anchorId ? String(target.anchorId) : null;
  const snippet = norm(target.snippet);
  const name = norm(target.commenterName);
  const nameTrusted = !!name && !looksLikeHarvestArtifactName(name);

  if (list.length === 0) {
    return { ok: false, reason: 'no_comment_articles', tier: null, candidateCount: 0, nameTrusted };
  }

  // Tier 1 — exact comment id from the permalink. Unambiguous, and immune to
  // both a bad commenter_name and edited comment text.
  let tier = null;
  let matches = [];
  if (anchorId) {
    matches = list.filter((c) => (c.ownAnchorIds || []).map(String).includes(anchorId));
    if (matches.length) tier = 'comment_id';
  }

  // Tier 2 — the comment's OWN text (excludes nested replies' text, so a
  // parent no longer matches on its child's words).
  if (!matches.length && snippet) {
    matches = list.filter((c) => norm(c.ownText).includes(snippet));
    if (matches.length) tier = 'own_text';
  }

  // Tier 3 — whole-article text. Legacy behaviour, kept only as a last resort;
  // this is the tier where a parent can match its child, which is why the
  // deepest-wins rule below matters.
  if (!matches.length && snippet) {
    matches = list.filter((c) => norm(c.articleText).includes(snippet));
    if (matches.length) tier = 'article_text';
  }

  if (!matches.length) {
    return {
      ok: false,
      reason: 'no_article_match',
      tier: null,
      candidateCount: list.length,
      nameTrusted,
    };
  }

  // Name is a TIEBREAK, never a gate — and only when it is trustworthy.
  let narrowedByName = false;
  if (matches.length > 1 && nameTrusted) {
    const byName = matches.filter((c) => String(c.ariaLabel || '').toLowerCase().includes(name.toLowerCase()));
    if (byName.length) { matches = byName; narrowedByName = true; }
  }

  // Deepest match wins: a nested reply is deeper than the ancestor comment
  // that merely contains it. Ties break on document order.
  matches = matches.slice().sort((a, b) => (b.depth - a.depth) || (a.idx - b.idx));
  const chosen = matches[0];

  // Reply button: prefer the comment's own. Facebook does not always render one
  // on a deeply nested reply; in that case the nearest ancestor comment's Reply
  // button opens the SAME reply thread, which is the correct destination.
  let replyButtonFrom = null;
  let buttonSource = null;
  if (chosen.hasOwnReplyButton) {
    replyButtonFrom = chosen.idx;
    buttonSource = 'own';
  } else {
    const byIdx = new Map(list.map((c) => [c.idx, c]));
    for (const ancIdx of chosen.ancestorArticleIdxs || []) {
      const anc = byIdx.get(ancIdx);
      if (anc && anc.hasOwnReplyButton) { replyButtonFrom = anc.idx; buttonSource = 'ancestor'; break; }
    }
  }

  if (replyButtonFrom === null) {
    return {
      ok: false,
      reason: 'no_reply_button',
      tier,
      idx: chosen.idx,
      depth: chosen.depth,
      ariaLabel: chosen.ariaLabel,
      candidateCount: list.length,
      nameTrusted,
    };
  }

  return {
    ok: true,
    tier,
    idx: chosen.idx,
    depth: chosen.depth,
    ariaLabel: chosen.ariaLabel,
    replyButtonFrom,
    buttonSource,
    matchCount: matches.length,
    narrowedByName,
    nameTrusted,
    candidateCount: list.length,
  };
}

module.exports = {
  isRelativeTimestampLike,
  isUiChromeText,
  looksLikeHarvestArtifactName,
  authorFromAriaLabel,
  pickAuthorName,
  extractCommentAnchorId,
  isNestedReplyPermalink,
  commentIdsInUrl,
  chooseReplyTarget,
};
