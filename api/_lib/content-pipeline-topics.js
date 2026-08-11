'use strict';

// api/_lib/content-pipeline-topics.js
//
// Topic source-of-truth + dedup for the nightly content-page pipeline
// (api/cron-generate-pages.js). Two jobs:
//
//   1. Read what's already live (marketing/guides-data, features-data,
//      answers-data — the exact dirs scripts/build-*.js consume) so the
//      picker never proposes something already covered.
//   2. Hold a curated candidate list per page_type. These are STARTING
//      POINTS, not verified facts — every candidate topic is a real TREC
//      form / Texas statute / plausible Dossie feature area to the best of
//      Atlas's knowledge at the time this list was written, but the
//      generating agent (hadley for guide/answer, carter for feature) MUST
//      independently verify via primary source (trec.texas.gov, Texas
//      statutes) or the live product before writing a single word, and
//      report BLOCKED if a candidate turns out to be non-existent, already
//      effectively covered, or (for features) not actually built/live. That
//      verification step is where the real quality bar lives — this file
//      only prevents the picker from wasting a night's slot on an obvious
//      duplicate.
//
// Round-robin: each candidate list is walked in order. A candidate is
// "claimed" the moment ANY content_pipeline_queue row exists for it
// (any status, including rejected/failed) — once Heath rejects a topic, or
// generation fails on it, it is NEVER auto-resurfaced. If a whole list is
// exhausted, that night's slot for that page_type is skipped (not forced).
//
// Owner: Atlas, 2026-08-11 (SV-ENG-NIGHTLY-CONTENT-PIPELINE)

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIRS = {
  guide: path.join(ROOT, 'marketing', 'guides-data'),
  feature: path.join(ROOT, 'marketing', 'features-data'),
  answer: path.join(ROOT, 'marketing', 'answers-data'),
};

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Reads slug + title (+ a few keyword-bearing fields) for every existing
// JSON page of a given type. Never throws — missing dir = empty list.
function loadExistingPages(pageType) {
  const dir = DATA_DIRS[pageType];
  if (!dir || !fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      const data = JSON.parse(raw);
      out.push({
        slug: data.slug || f.replace(/\.json$/, ''),
        title: data.title || '',
        topic_text: normalize(`${data.title || ''} ${data.meta_description || ''} ${data.deck || ''}`),
      });
    } catch (e) {
      // Malformed JSON shouldn't crash topic selection — skip it, the build
      // scripts will surface the real error separately.
    }
  }
  return out;
}

// ─── Candidate topics ────────────────────────────────────────────────────
// Slugs here are PROPOSED (what the generating agent should aim to produce)
// -- the agent is free to adjust the final slug slightly to match its
// actual title, as long as it stays genuinely distinct from every slug in
// existingSlugs (passed in the task brief).

const GUIDE_CANDIDATES = [
  {
    slug: 'texas-iabs-information-about-brokerage-services-guide',
    topic: 'Texas IABS (Information About Brokerage Services) disclosure form -- what it is, when it must be given, and what happens if an agent skips it',
    hint: 'TREC-required IABS/OP-K notice under TRELA. Verify current form number and delivery-timing rule directly on trec.texas.gov before writing.',
  },
  {
    slug: 'texas-trec-coastal-area-addendum-guide',
    topic: "TREC Addendum for Property Located Seaward of the Gulf Intracoastal Waterway (coastal area addendum) -- when it's required and what it discloses",
    hint: 'Verify the current TREC form number and its required disclosures (open beaches act, dune protection, erosion) on trec.texas.gov before writing.',
  },
  {
    slug: 'texas-propane-gas-system-service-area-addendum-guide',
    topic: "TREC Addendum for Property in a Propane Gas System Service Area -- what it discloses and when it's required",
    hint: 'Verify current TREC form number and applicability on trec.texas.gov before writing.',
  },
  {
    slug: 'texas-environmental-endangered-species-wetlands-addendum-guide',
    topic: 'TREC Environmental Assessment, Threatened or Endangered Species, and Wetlands Addendum -- what it covers and when agents need it',
    hint: 'Verify current TREC form number and scope on trec.texas.gov before writing.',
  },
  {
    slug: 'texas-condominium-resale-certificate-chapter-82-guide',
    topic: "Texas Condominium Resale Certificate under the Uniform Condominium Act (Property Code Chapter 82) -- how it's genuinely different from a standard HOA resale certificate (Chapter 207, already covered)",
    hint: 'Read Property Code Ch. 82 directly (statutes.capitol.texas.gov) and confirm this is materially distinct from the existing texas-hoa-resale-certificate-guide before writing -- if it is not meaningfully different, report BLOCKED instead of publishing a near-duplicate.',
  },
  {
    slug: 'texas-on-site-sewer-facility-disclosure-guide',
    topic: "TREC's Information About On-Site Sewer Facility notice (septic system disclosure) -- when it's required and what it must contain",
    hint: 'Verify current TREC form and the Health & Safety Code / Property Code trigger for when this notice is required on trec.texas.gov and statutes.capitol.texas.gov.',
  },
  {
    slug: 'texas-intermediary-dual-agency-disclosure-guide',
    topic: 'Texas intermediary (dual agency) status disclosure under TRELA Section 1101.559 -- what agents must disclose and when consent is required',
    hint: 'Verify current statute text at statutes.capitol.texas.gov (Occupations Code Ch. 1101) before writing.',
  },
  {
    slug: 'texas-contract-notices-paragraph-21-delivery-guide',
    topic: "How notice delivery actually works under the TREC contract's Notices paragraph -- email vs. fax vs. hand delivery, and when a notice legally counts as delivered",
    hint: 'Read the current TREC 20-19 Notices paragraph directly on trec.texas.gov and cross-check against Texas e-sign/e-delivery law before writing.',
  },
];

const ANSWER_CANDIDATES = [
  {
    slug: 'what-is-a-t47-survey-affidavit-texas',
    topic: 'What is a T-47 survey affidavit in a Texas real estate closing?',
    hint: 'Verify current T-47 form requirements (title company practice + Procedural Rule P-50 survey coverage) before writing.',
  },
  {
    slug: 'who-pays-owners-title-policy-texas',
    topic: "Who customarily pays for the owner's title policy in a Texas home sale?",
    hint: 'Ground this in TREC 20-19 Paragraph 6B and note it is negotiable custom, not statute -- do not overstate it as a legal requirement.',
  },
  {
    slug: 'what-is-the-effective-date-texas-contract',
    topic: 'What is the "Effective Date" of a Texas real estate contract and why does it matter?',
    hint: "Quote the TREC 20-19 execution/signature block definition directly -- this anchors every other TREC deadline, so get the exact 'last party signs and delivers' language right.",
  },
  {
    slug: 'can-seller-accept-backup-offer-texas',
    topic: 'Can a Texas seller accept a backup offer while already under contract with another buyer?',
    hint: 'Ground this in the existing texas-back-up-contract-addendum-guide -- this answer should be the short-form companion, not a restatement; verify no near-duplicate wording.',
  },
  {
    slug: 'is-attorney-required-at-closing-texas',
    topic: 'Is a real estate attorney legally required at a Texas residential closing?',
    hint: 'Texas is not an attorney-closing state -- verify this against current TDI/title industry practice before writing so the answer is not overstated either direction.',
  },
  {
    slug: 'what-happens-financing-addendum-deadline-passes-texas',
    topic: "What happens under a Texas contract if the buyer's financing approval deadline (Third Party Financing Addendum) passes with no lender notice?",
    hint: 'Cross-check against the existing texas-third-party-financing-addendum guide -- keep this short-form and distinct, verify current TPFA 40-11 paragraph language on trec.texas.gov.',
  },
  {
    slug: 'difference-active-option-vs-pending-texas-mls',
    topic: 'What is the difference between "Active Option Contract" and "Pending" status on a Texas MLS?',
    hint: 'Verify against a current Texas MLS (e.g. SABOR, per docs/CUSTOMERS.md-adjacent context) status-code legend rather than assuming -- status abbreviations vary by MLS.',
  },
  {
    slug: 'how-is-earnest-money-held-texas-escrow',
    topic: 'How is earnest money actually held in escrow on a Texas real estate deal, and who can release it?',
    hint: 'Ground this in TREC 20-19 Paragraph 5, the escrow agent role, and TREC Rule requirements for broker trust accounts -- verify release-of-earnest-money mechanics (mutual release vs. TREC Form 38-8) precisely.',
  },
];

// Feature candidates are the highest-uncertainty lane -- CLAUDE.md's
// documented feature list is not fully visible to this file, and the
// content-verifier agent's mandate exists specifically because plausible-
// sounding features get fabricated. Every candidate here is a GUESS at an
// undocumented-but-real feature; carter must confirm it's actually live
// (read the real Dossie source + a real Playwright pass against staging,
// per CLAUDE.md's "verify in a real browser before handoff" rule) before
// writing, and must capture a genuine product screenshot the same way the
// 7 existing feature pages did (assets/product/*.png). BLOCKED is the
// correct outcome if a candidate isn't real or a screenshot can't be
// captured honestly.
const FEATURE_CANDIDATES = [
  {
    slug: 'how-dossie-handles-document-upload',
    topic: 'How Dossie handles document upload and storage inside a dossier',
    hint: 'Confirm this is a real, live, currently-shipped feature (read Dossie app source + Playwright the real workspace) before writing. If it does not exist as described, BLOCKED.',
  },
  {
    slug: 'how-dossie-handles-action-items',
    topic: "How Dossie handles action items / task checklists (distinct from the closing-milestones feature, already covered)",
    hint: 'Verify this is materially distinct from the existing how-dossie-handles-closing-checklist and how-dossie-handles-closing-milestones pages before writing -- if it is the same feature under a different name, BLOCKED rather than a near-duplicate page.',
  },
  {
    slug: 'how-dossie-handles-the-dashboard',
    topic: 'How Dossie handles the main dashboard / active-deals overview',
    hint: 'Confirm this is a real, live, currently-shipped feature (read Dossie app source + Playwright the real workspace) before writing. If it does not exist as described, BLOCKED.',
  },
];

const CANDIDATES = {
  guide: GUIDE_CANDIDATES,
  feature: FEATURE_CANDIDATES,
  answer: ANSWER_CANDIDATES,
};

/**
 * Picks the next unclaimed candidate for a page_type.
 * @param {string} pageType 'guide'|'feature'|'answer'
 * @param {Array<{slug:string, topic:string}>} claimedTopics -- every
 *   content_pipeline_queue row ever created for this page_type (any status).
 * @param {Array<{slug:string, title:string, topic_text:string}>} existingPages
 *   -- live pages from loadExistingPages().
 * @returns {{slug, topic, hint}|null}
 */
function pickNextCandidate(pageType, claimedTopics, existingPages) {
  const list = CANDIDATES[pageType] || [];
  const claimedSlugs = new Set((claimedTopics || []).map((c) => normalize(c.slug || c.topic)));
  const existingSlugs = new Set((existingPages || []).map((p) => normalize(p.slug)));
  const existingTitleWords = (existingPages || []).map((p) => p.topic_text);

  for (const cand of list) {
    const nSlug = normalize(cand.slug);
    if (claimedSlugs.has(nSlug) || claimedSlugs.has(normalize(cand.topic))) continue;
    if (existingSlugs.has(nSlug)) continue;
    // Loose overlap guard: if the candidate slug's significant words are
    // already fully contained in an existing page's normalized text, skip
    // it too -- catches "already effectively covered under a different slug".
    const candWords = nSlug.split(' ').filter((w) => w.length > 4);
    const looksCovered = existingTitleWords.some((t) => candWords.length > 2 && candWords.every((w) => t.includes(w)));
    if (looksCovered) continue;
    return cand;
  }
  return null;
}

module.exports = {
  DATA_DIRS,
  normalize,
  loadExistingPages,
  pickNextCandidate,
  CANDIDATES,
};
