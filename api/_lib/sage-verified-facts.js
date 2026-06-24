'use strict';

// Shared verified-facts block for Sage's autonomous reviewer (Cole-as-Sonnet).
//
// These facts are LOCKED in:
//   - CLAUDE.md Section 5 (pricing)
//   - CLAUDE.md Section 6 (customer roster)
//   - docs/CUSTOMERS.md (named customers + brokerages)
//   - .claude/projects/.../memory/project_heath_founder_pain_stories.md (founder pain)
//
// Anything in this block must NEVER be flagged as "fabricated" or "unverified."
// If the only objection is one of these, the correct verdict is APPROVE.
//
// Built by sage_4 (2026-06-22) to fix the 53% Haiku reject-rate Ridge_3 found.
// History:
//   - 2026-06-20 sage_1: first VERIFIED_FACTS block, inline in cron-sage-autonomous-review.js
//   - 2026-06-22 carter_6: switched reviewer from Haiku to Sonnet w/ Cole persona (c8450e9)
//   - 2026-06-22 sage_4: extracted to shared lib + added pain-point whitelist + demoted
//                        Dossie Mention Rule (FB-group-only, not all platforms)

// ---------------------------------------------------------------------------
// VERIFIED_PAIN_POINTS — Heath's documented founder pain stories.
// These are facts. NOT fabrication. NOT to be sent back.
// ---------------------------------------------------------------------------
const VERIFIED_PAIN_POINTS = [
  // The Italy TC quit incident — documented in project_heath_founder_pain_stories.md
  'TC quit mid-deal while Heath was on a trip (specifically Italy)',
  'Active escrows + 7-8 hour time difference + no clean handoff',
  '"Vacation is the stress test your systems fail"',

  // The 4:30am stress — documented across multiple memory files
  '4:30 in the morning, mental checklist of open files',
  'Wondering if the option fee receipt went out, repair amendment, lender follow-up',
  'Paying for a TC and still losing sleep — the TC was not failing; the system was',

  // TC cost references — $300-400/file is the documented going rate
  '$400 per file (the going rate Heath paid for TC services)',
  '$300-400 per file (TC industry pricing range)',

  // Volume agent math — these aren't fabricated, they're math
  '50 deals × $400/file = $20,000/year in TC fees',
  '30 deals × $400/file = $12,000/year',
];

// ---------------------------------------------------------------------------
// VERIFIED_PRICING — locked in CLAUDE.md Section 5
// ---------------------------------------------------------------------------
const VERIFIED_PRICING = [
  '$29/month founding price (locked while subscription stays active)',
  '50 founding spots total',
  '$79/mo Solo tier monthly, $39/mo annual',
  '$199/mo Team tier (3 seats, max 8 at $35/seat extra), $119/mo annual',
  'Brokerage tier custom',
];

// ---------------------------------------------------------------------------
// VERIFIED_CUSTOMERS — pulled from docs/CUSTOMERS.md, current MRR $349/mo
// As of sage_4 build: 12 founding @ $29 + 1 friend @ $1 = $349/mo MRR
// ---------------------------------------------------------------------------
const VERIFIED_CUSTOMERS = [
  '12 founding members on the $29 plan (as of 2026-06-22)',
  '1 founding friend on $1/mo (Suzanne Page)',
  'Brittney YBarbo (customer #3, broker, ~80 tx/yr SE Texas — the Control pillar customer)',
  'Lisa Nilsson (customer #12, Boerne / Hill Country SA, Premier Hill Country Properties)',
  'Multiple markets represented: San Antonio (Heath/Brittney/Lisa), Houston (Terry/Zelda), Austin (Cecilia/Natalie), RGV (Miki)',
];

// ---------------------------------------------------------------------------
// VERIFIED_FEATURES — actually shipped, visible in production
// ---------------------------------------------------------------------------
const VERIFIED_FEATURES = [
  'Contract scan + auto-deadline calc with paragraph citations (~8 seconds)',
  'Pipeline view with per-deal deadline badges',
  'Morning brief (voice, Luna narration for brenda/patricia personas; Bill for victor)',
  'Email draft queue (review-and-send, not auto-send)',
  'Closing milestone cards',
  'Talk-to-Dossie voice conversation interface',
];

// ---------------------------------------------------------------------------
// VERIFIED_BRAND — locked language
// ---------------------------------------------------------------------------
const VERIFIED_BRAND = [
  'Tagline: "Your deals. Her job."',
  'Name "dossier" → "Dossie" (the AI as she/her)',
  'Texas REALTOR audience — San Antonio launch, statewide expansion',
  'Valid persona tags: brenda, patricia, victor, dossie (all 4 are valid; dossie is brand-voice persona)',
];

// ---------------------------------------------------------------------------
// Build the prompt block — injected verbatim into Cole's system prompt.
// ---------------------------------------------------------------------------
function buildVerifiedFactsBlock() {
  return `
## VERIFIED FACTS — DO NOT FLAG THESE AS FABRICATED

The following are LOCKED facts (CLAUDE.md, persistent memory, live product, customer roster).
Anything in this block must NEVER be sent back as "fabricated" or "unverified specifics."
If your only objection is one of these, the correct decision is APPROVE.

### Founder pain points (real, lived, documented)
${VERIFIED_PAIN_POINTS.map((p) => `- ${p}`).join('\n')}

### Pricing (locked in CLAUDE.md Section 5)
${VERIFIED_PRICING.map((p) => `- ${p}`).join('\n')}

### Customer roster (verified, ${new Date().toISOString().slice(0, 10)})
${VERIFIED_CUSTOMERS.map((c) => `- ${c}`).join('\n')}

### Shipped product features
${VERIFIED_FEATURES.map((f) => `- ${f}`).join('\n')}

### Brand & audience
${VERIFIED_BRAND.map((b) => `- ${b}`).join('\n')}

### TREC rules (already pre-validated by deterministic verifier)
- Option period runs from executed date
- Earnest money typically due within 3 days of execution to title company
- Title commitment window per TREC contract paragraph
- Third-party financing contingency window
- All TREC paragraph cites have already passed verifier_result.verdict='approve' before reaching this review

### Persona rules (all 4 personas are valid — never reject for persona mismatch alone)
- 'brenda' / 'patricia' / 'victor' — agent personas
- 'dossie' — brand voice persona (she/her, warm, capable). FULLY VALID.
- Tagged persona dictates tone but does NOT determine validity.

IF YOUR ONLY OBJECTION IS ONE OF THE ABOVE, THE CORRECT VERDICT IS APPROVE.
`.trim();
}

// ---------------------------------------------------------------------------
// Demoted policies — facts about which rules apply to which surface.
// Built into Cole's prompt so she doesn't apply FB-group rules to FB Page posts.
// ---------------------------------------------------------------------------
const POLICY_SURFACE_MATRIX = `
## SURFACE-SPECIFIC RULES — DO NOT CROSS-APPLY

### Facebook GROUP posts (private groups like The Founding Files)
- Post body must NEVER mention Dossie (hard-block if violated)
- First comment MUST name Dossie + one shipped capability
- Tone: agent-to-agent in a private group, warm, casual, first-person

### Facebook PAGE posts (the Dossie public Facebook page)
- Dossie mention in caption IS ALLOWED AND EXPECTED
- This is the brand's own page — naming the product is correct
- DO NOT apply the FB-group "no Dossie in body" rule here

### Twitter / X posts
- Dossie mention in caption IS ALLOWED AND EXPECTED
- Hashtags: 2-3 is ideal; up to 5 is acceptable — NEVER send back for hashtag count alone
- DO NOT apply the FB-group "no Dossie in body" rule here

### LinkedIn posts
- Dossie mention in caption IS ALLOWED AND EXPECTED
- Hashtags: 3-5 professional tags is the norm — 5 hashtags is FINE on LinkedIn, NEVER a send-back trigger
- Authority tone, longer-form OK
- DO NOT apply the FB-group "no Dossie in body" rule here
- DO NOT cross-apply Twitter's hashtag cap to LinkedIn

### Instagram posts
- Dossie mention in caption IS ALLOWED AND EXPECTED
- Hashtags: 8-10 is the norm — up to 30 is acceptable, NEVER a send-back trigger
- Hook in first 125 chars
- DO NOT apply the FB-group "no Dossie in body" rule here

If the post is a group post (post_body field present), apply group rules.
If the post is a main social post (content field, platform=facebook|twitter|linkedin|instagram),
the Dossie-in-first-comment rule DOES NOT APPLY. Treat any Dossie mention objection as a
WARNING (auto-approve with note) — NOT a send_back or reject.
`.trim();

module.exports = {
  VERIFIED_PAIN_POINTS,
  VERIFIED_PRICING,
  VERIFIED_CUSTOMERS,
  VERIFIED_FEATURES,
  VERIFIED_BRAND,
  buildVerifiedFactsBlock,
  POLICY_SURFACE_MATRIX,
};
