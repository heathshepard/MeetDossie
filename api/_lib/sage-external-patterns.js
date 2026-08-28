// api/_lib/sage-external-patterns.js
//
// PREPARED BUT NOT WIRED IN. Per Heath's explicit "review real output before
// this runs unsupervised" instruction (2026-08-28 task brief), nothing in
// this file is currently imported/called by api/cron-generate-posts.js or
// any cron. It exists so the logic can be reviewed and tested against real
// data now, then wired in with a single import + block-concatenation change
// once Heath says go.
//
// Purpose: give cron-generate-posts.js's prompt-builder a block that draws
// on BOTH external swipe-file patterns (sage_swipe_rules, source='external',
// see scripts/sage-external-swipe-research.js) and Dossie's own real post
// performance (post_analytics, already wired via buildTopPerformerBlock() in
// cron-generate-posts.js), and states which pattern(s) it's drawing from and
// why — so Heath can see the reasoning, not just the output.
//
// To activate later: in api/cron-generate-posts.js,
//   const { fetchExternalSwipeRules, buildCrossReferencedStrategyBlock } = require('./_lib/sage-external-patterns');
//   const externalRules = await fetchExternalSwipeRules();
//   const crossRefBlock = buildCrossReferencedStrategyBlock(externalRules, topHooks);
// then splice `crossRefBlock` into buildPrompt(...)'s inputs the same way
// topPerformerBlock/sageIntelBlock/redditPainBlock already are.

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supabaseFetch(path) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// Fetch active, external-source distilled rules from sage_swipe_rules.
// Fails gracefully — returns [] until the table has rows or on any error,
// same shape as fetchTopPerformerHooks()/fetchRedditPainLanguage() in
// cron-generate-posts.js.
async function fetchExternalSwipeRules(limit = 10) {
  try {
    const { data, ok } = await supabaseFetch(
      `sage_swipe_rules?select=id,rule_text,rule_type,source_creator,source_url,times_used,avg_performance&source=eq.external&status=eq.active&order=created_at.desc&limit=${limit}`,
    );
    if (!ok || !Array.isArray(data)) return [];
    return data;
  } catch (err) {
    console.warn('[sage-external-patterns] fetchExternalSwipeRules failed:', err && err.message);
    return [];
  }
}

// Also fetch the raw external swipe_items (for counting "N external examples
// showed X" claims — a rule can be backed by more than one item).
async function fetchExternalSwipeItems(limit = 20) {
  try {
    const { data, ok } = await supabaseFetch(
      `sage_swipe_items?select=id,creator_name,platform,hook_type,engagement_score,pattern_notes&source=eq.external&order=engagement_score.desc.nullslast&limit=${limit}`,
    );
    if (!ok || !Array.isArray(data)) return [];
    return data;
  } catch (err) {
    console.warn('[sage-external-patterns] fetchExternalSwipeItems failed:', err && err.message);
    return [];
  }
}

// Rough keyword overlap between an external rule's rule_type/text and an
// internal top hook's hook_type/platform — enough to decide whether they're
// worth citing together. Not fuzzy-matching the actual copy (never should),
// just the STRUCTURAL label.
const RULE_TYPE_TO_HOOK_TYPE = {
  'hook-format': ['bold_claim', 'question', 'story_open', 'contrast', 'curiosity-gap', 'curiosity_gap'],
  'cta-pattern': ['bold_claim'],
  'copywriting': [],
  'trend': [],
  'edit-technique': [],
};

function findCrossReference(rule, internalHooks) {
  const candidateTypes = RULE_TYPE_TO_HOOK_TYPE[rule.rule_type] || [];
  const platformFromRule = (rule.rule_text.match(/\b(instagram|tiktok|facebook|linkedin)\b/i) || [])[1];

  // Require an ACTUAL constraint to check (a known hook-type mapping or a
  // platform explicitly named in the rule text) before ever claiming a
  // cross-reference. Without this guard, a rule_type with no mapped hook
  // types (e.g. 'trend') and no platform mention would match ANY internal
  // hook by default — a false-positive "similar structure" claim. Silence
  // (no cross-reference) is always preferable to a misleading one here.
  if (candidateTypes.length === 0 && !platformFromRule) return null;

  const matches = internalHooks.filter((h) => {
    const typeMatch = candidateTypes.length === 0 ? true : candidateTypes.includes(String(h.hook_type || '').toLowerCase());
    const platformMatch = platformFromRule ? String(h.platform || '').toLowerCase() === platformFromRule.toLowerCase() : true;
    return typeMatch && platformMatch;
  });
  return matches[0] || null;
}

// Build the prompt-injectable block. Every claim explicitly names its
// source count and (when available) an internal cross-reference, matching
// the format Heath asked for: "proposing X here, based on N external
// examples showing Y, cross-referenced against our own [post] which got Z."
function buildCrossReferencedStrategyBlock(externalRules, internalTopHooks, externalItems = []) {
  if (!externalRules || externalRules.length === 0) return '';

  const lines = [
    '',
    '## EXTERNAL PATTERN INTELLIGENCE (cross-referenced with our own real performance)',
    'These are STRUCTURAL patterns distilled from real high-engagement examples',
    'outside Dossie (never verbatim copy — see sage_swipe_items/sage_swipe_rules).',
    'Each line states what is being proposed, how many external examples support',
    'it, and whether our own post_analytics history backs the same pattern.',
    '',
  ];

  for (const rule of externalRules) {
    const backingItems = externalItems.filter((i) => (i.creator_name || '') === rule.source_creator);
    const exampleCount = backingItems.length > 0 ? backingItems.length : 1;
    const internalMatch = findCrossReference(rule, internalTopHooks || []);

    let line = `- [${rule.rule_type}] ${rule.rule_text} (${exampleCount} external example${exampleCount === 1 ? '' : 's'}: ${rule.source_creator})`;
    if (internalMatch) {
      line += ` — CROSS-REFERENCED: our own ${internalMatch.platform}/${internalMatch.persona || 'unlabeled'} post using a similar structure scored ${internalMatch.score ?? internalMatch.engagement_score}, supporting this pattern with our real audience too.`;
    } else {
      line += ' — no matching internal post_analytics data yet to cross-reference (external-only signal for now, treat as a hypothesis to test, not a proven local result).';
    }
    lines.push(line);
  }
  lines.push('');
  lines.push('Do not reuse any external example verbatim — apply the STRUCTURE only, in Dossie\'s own voice.');
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  fetchExternalSwipeRules,
  fetchExternalSwipeItems,
  buildCrossReferencedStrategyBlock,
};
