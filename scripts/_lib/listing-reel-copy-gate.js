'use strict';

// scripts/_lib/listing-reel-copy-gate.js
//
// Copy gate for R1 "Ken Burns Listing Reel" surfaces (hook, eyebrow, spec
// line, price pill, closing card, voiceover script, post caption).
//
// This is NOT a replacement for scripts/_lib/listing-post-compliance-gate.js
// -- that one governs the TEXT post body (TREC attribution string in the
// body, owner disclosure, virtual-staging label, urgency fabrication). This
// one governs what gets BURNED INTO A VIDEO, where the failure is permanent
// and public. The two overlap deliberately; both must independently pass.
//
// Three independent blocking layers:
//
//  1. FAIR HOUSING / DO-NOT-WRITE (docs/CONTENT-DO-NOT-WRITE-LIST.md).
//     The doc's machine-readable index is the AUTHORITY for which topics
//     are blocked; this file supplies the DETECTOR for each. If the doc
//     grows a HARD_BLOCK/ATTORNEY_REVIEW topic that has no detector here,
//     the gate FAILS CLOSED rather than silently letting the new topic
//     through -- the doc can never outrun the code. If the doc is missing
//     or its table doesn't parse, nothing renders. (memory:
//     feedback_silent-failure-is-the-enemy.md)
//
//  2. WEAKNESS COPY (memory: listing-copy-never-signal-weakness.md).
//     No price-cut reference, no "motivated seller", no "priced to sell",
//     no DOM emphasis, no apologising for price, no hint of a future
//     reduction. Heath represents the seller -- copy that invites lowballs
//     is a FIDUCIARY problem, not a style problem. A price change is a
//     legitimate REFRESH TRIGGER, but the copy must never reference the
//     change itself.
//
//     Live example this was written against -- scripts/listing-video-configs/
//     23-nopalito.json + 23-nopalito-script.txt, both shipped, both fail
//     this gate today:
//       eyebrow: "NEW PRICE"
//       hook:    "Now under\n$1 million."
//       script:  "...new price. Nine ninety-nine, down from one two nine
//                 five... Reach out before the price does that again."
//     That last sentence tells every buyer watching that another cut is
//     coming. Do not reuse those two files as templates.
//
//  3. PRICE / STATUS TRUTH. Every surviving price mention must equal the
//     LIVE list price from the same-process connectMLS read (reuses
//     extractPriceMentions() from listing-post-compliance-gate.js -- the
//     function that actually catches the 23 Nopalito $1,195,000-vs-$999,000
//     incident). A sold listing NEVER shows a price anywhere (memory:
//     dossie-post-closing-testimonial-request.md). MLS status is the sole
//     source of truth for active/under-contract/sold.
//
// Plus: TREC advertising compliance. The BROKER NAME must appear on the
// closing card. The string is derived from TREC_ATTRIBUTION in
// listing-marketing-facts.js -- never hand-written -- and this gate
// verifies it actually landed on the card surface.
//
// Owner: R1 trigger build, 2026-09-16.

const fs = require('fs');
const path = require('path');

const { TREC_ATTRIBUTION, OWNER_DISCLOSURE } = require('./listing-marketing-facts');
const { extractPriceMentions } = require('./listing-post-compliance-gate');
const { OFF_MARKET, UNDER_CONTRACT_ACTIVE_FAMILY, isPostableActive } = require('./mls-status-taxonomy');

// ─── TREC attribution, parsed (never hand-written) ──────────────────────────
//
// TREC_ATTRIBUTION is pipe-delimited:
//   'Heath Shepard, REALTOR (R) | Keller Williams City View | TX Lic #751964'
// generate-listing-video.js's closing card takes {agentName, brokerage,
// phone} -- so agentName and brokerage BOTH come out of this parse. The
// broker name ("Keller Williams City View") is the TREC-required element
// (22 TAC 535.154/535.155: social media and video ARE advertisements; the
// broker name must be readily noticeable at >= half the size of the largest
// agent contact info). Never type that string into a config by hand.
function parseTrecAttribution(attribution = TREC_ATTRIBUTION) {
  const parts = String(attribution).split('|').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) {
    throw new Error(
      `listing-reel-copy-gate: TREC_ATTRIBUTION is not parseable ("${attribution}"). `
      + 'Expected "<agent> | <brokerage> | <license>". Refusing to build a card without a verified broker name.',
    );
  }
  const [agentName, brokerage, license = null] = parts;
  if (!brokerage) {
    throw new Error('listing-reel-copy-gate: no brokerage segment in TREC_ATTRIBUTION -- cannot satisfy TREC broker-name rule.');
  }
  return { agentName, brokerage, license, full: String(attribution) };
}

// ─── Layer 1: docs/CONTENT-DO-NOT-WRITE-LIST.md ─────────────────────────────

// Resolved per CALL, not at module load -- reading process.env once at import
// time silently ignores a CONTENT_BLOCK_LIST_PATH set by the caller after the
// require, which is a nasty way to have a compliance gate look configured and
// not be.
function defaultBlockListPaths() {
  return [
    process.env.CONTENT_BLOCK_LIST_PATH,
    path.join(__dirname, '..', '..', 'docs', 'CONTENT-DO-NOT-WRITE-LIST.md'),
  ].filter(Boolean);
}

/**
 * Parse the "Machine-readable index" table out of CONTENT-DO-NOT-WRITE-LIST.md.
 * Throws (fail-closed) if the file is missing or the table yields zero rows --
 * a render must never proceed without the block list actually loaded.
 */
function loadBlockList(explicitPath) {
  const defaults = defaultBlockListPaths();
  const candidates = explicitPath ? [explicitPath, ...defaults] : defaults;
  let docPath = null;
  for (const c of candidates) {
    if (c && fs.existsSync(c)) { docPath = c; break; }
  }
  if (!docPath) {
    throw new Error(
      'listing-reel-copy-gate: docs/CONTENT-DO-NOT-WRITE-LIST.md not found (looked at: '
      + candidates.join(', ') + '). The block list IS the gate -- refusing to render anything without it. '
      + 'Set CONTENT_BLOCK_LIST_PATH to point at it.',
    );
  }
  const text = fs.readFileSync(docPath, 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').map((c) => c.trim());
    // ['', topic_id, topic, block_level, reason, '']
    if (cells.length < 5) continue;
    const [, topicId, topic, blockLevel, reason] = cells;
    if (!topicId || topicId === 'topic_id' || /^-+$/.test(topicId)) continue;
    if (!['HARD_BLOCK', 'CORRECTION_REQUIRED', 'ATTORNEY_REVIEW'].includes(blockLevel)) continue;
    rows.push({ topicId, topic, blockLevel, reason });
  }
  if (!rows.length) {
    throw new Error(
      `listing-reel-copy-gate: parsed ZERO rows out of ${docPath}. The machine-readable index `
      + 'shape changed. Failing closed rather than rendering against an empty block list.',
    );
  }
  return { docPath, rows };
}

// Detector per topic_id. The DOC decides which topics are blocked; this map
// only decides HOW to spot one in copy. Every HARD_BLOCK and ATTORNEY_REVIEW
// topic in the doc MUST have an entry here (see assertDetectorCoverage) --
// add a detector when you add a row, or the gate halts.
//
// CORRECTION_REQUIRED topics are also detected and BLOCKED here, on purpose:
// a 30-second listing reel has no business making a claim about dual agency,
// earnest money handling, as-is liability, attorneys at closing, transfer
// taxes, title premiums, foreclosure mechanics, community property, STR
// rules, or who pays commission. "Publishable with the correct framing"
// applies to a long-form explainer, not to a burned-in video overlay.
const TOPIC_DETECTORS = {
  escalation_clauses: [
    /escalation\s+clause/i,
    /escalat\w*\s+(clause|addendum|language)/i,
    /relative\s+bid/i,
    /sharp\s+offer/i,
  ],
  agent_drafted_contingency_language: [
    /special\s+provisions?[^.]{0,60}(clause|language|write|draft|add)/i,
    /(draft|write|add)\w*\s+(your\s+own|custom|my\s+own)\s+(clause|language|contingency|addendum)/i,
    /custom\s+contingency\s+language/i,
  ],
  dual_agency_illegal: [/dual\s+agency\s+is\s+illegal/i, /texas\s+bans?\s+dual\s+agency/i],
  attorney_review_period: [/attorney[\s-]review\s+(period|window)/i],
  option_period_mislabeled: [
    /option\s+period[^.]{0,40}(due\s+diligence|contingenc)/i,
    /(due\s+diligence\s+period|inspection\s+contingency)[^.]{0,40}\(?option/i,
  ],
  earnest_money_to_broker: [
    /earnest\s+money[^.]{0,40}(to|with|held\s+by)\s+(the\s+)?(agent|realtor|broker(age)?)/i,
    /option\s+(money|fee)[^.]{0,40}(to|with|held\s+by)\s+(the\s+)?(agent|realtor|broker(age)?)/i,
  ],
  as_is_no_recourse: [
    /as[\s-]is[^.]{0,60}(no\s+liability|zero\s+liability|waives?\s+(the\s+)?inspection|no\s+recourse)/i,
  ],
  attorney_required_at_closing: [/(need|require)\w*\s+an?\s+attorney\s+to\s+close/i],
  transfer_tax: [/transfer\s+tax/i, /mortgage\s+recording\s+tax/i],
  title_insurance_shop_rate: [/shop\s+(around\s+)?for[^.]{0,40}title\s+(insurance|rate|premium)/i],
  squatters_fast_takeover: [/squatters?\b[^.]{0,60}(take|claim|own|keep)\b/i],
  foreclosure_judicial_slow: [/foreclosure[^.]{0,60}(court|judicial|takes\s+years)/i],
  foreclosure_redemption_general: [
    /right\s+of\s+redemption/i,
    /redeem\w*\b[^.]{0,50}(after|post)[\s-]?(foreclosure|sale)/i,
  ],
  verbal_deal_binding: [
    /(verbal|oral|handshake)\s+(agreement|contract|counter\w*|offer)[^.]{0,40}(binding|enforceable|counts)/i,
  ],
  community_property_ignored: [/equitable\s+distribution/i, /marital\s+property\s+split/i],
  seller_financing_casual: [
    /seller\s+financ\w*/i,
    /owner\s+financ\w*/i,
    /rent[\s-]to[\s-]own/i,
    /lease[\s-](purchase|option)/i,
    /wrap(around)?\s+(note|mortgage)/i,
    /contract\s+for\s+deed/i,
  ],
  str_blanket_rule: [
    /texas\s+(allows|bans|prohibits|permits)\s+short[\s-]term\s+rentals/i,
    /short[\s-]term\s+rentals?\s+are\s+(legal|illegal)\s+in\s+texas/i,
  ],
  public_legal_opinion: [
    /(is|are)\s+(this|that|these|those)\s+(clause|provision|contract|addendum)s?\s+enforceable/i,
    /legally\s+speaking,?\s+you\s+(can|can't|cannot|should)/i,
  ],
  // The one that matters most for a listing reel. Applies nationally, and
  // these exact terms are named in the doc + docs/CONTENT-FORMAT-LIBRARY.md
  // section 2 as a HARD_BLOCK for Heath's realtor page.
  fair_housing_steering_language: [
    /\b(good|great|top[\s-]rated|excellent|best|award[\s-]winning)\s+schools?\b/i,
    /\bschool\s+(rating|score)s?\b/i,
    /\bfamily[\s-](friendly|oriented)\b/i,
    /\bfamily\s+neighborhood\b/i,
    /\bperfect\s+for\s+(families|a\s+family|kids|children)\b/i,
    /\bgreat\s+for\s+(families|kids|children)\b/i,
    /\bsafe\s+(area|neighborhood|community|part\s+of\s+town|street)\b/i,
    /\bup[\s-]and[\s-]coming\b/i,
    /\bexclusive\s+(neighborhood|community|area)\b/i,
    /\bdesirable\s+(area|neighborhood)\b/i,
    /\bwalking\s+distance\s+to\s+(church|churches|synagogue|temple|mosque)\b/i,
    /\b(christian|catholic|jewish|muslim)\s+(community|neighborhood|area)\b/i,
    /\bno\s+(kids|children)\b/i,
    /\b(singles|adults|seniors|mature\s+\w+)\s+only\b/i,
    /\bethnic\b/i,
    /\bintegrated\s+(neighborhood|community)\b/i,
  ],
  generic_national_commission_claim: [
    /seller\s+(always\s+)?pays?\s+(the\s+)?buyer'?s?\s+agent'?s?\s+commission/i,
  ],
};

/**
 * If the doc lists a HARD_BLOCK / ATTORNEY_REVIEW topic we have no detector
 * for, we cannot claim to have checked it. Fail closed and name it.
 */
function assertDetectorCoverage(blockList) {
  const missing = blockList.rows
    .filter((r) => r.blockLevel === 'HARD_BLOCK' || r.blockLevel === 'ATTORNEY_REVIEW')
    .filter((r) => !TOPIC_DETECTORS[r.topicId])
    .map((r) => r.topicId);
  if (missing.length) {
    throw new Error(
      `listing-reel-copy-gate: ${blockList.docPath} lists ${missing.length} blocking topic(s) with no detector `
      + `in TOPIC_DETECTORS: ${missing.join(', ')}. Add a regex for each before any reel renders -- `
      + 'refusing to claim a check we did not run.',
    );
  }
  // Sanity anchor: fair housing must still be a HARD_BLOCK in the doc. If
  // someone downgrades it, that should break the build loudly.
  const fh = blockList.rows.find((r) => r.topicId === 'fair_housing_steering_language');
  if (!fh || fh.blockLevel !== 'HARD_BLOCK') {
    throw new Error(
      'listing-reel-copy-gate: fair_housing_steering_language is missing or no longer HARD_BLOCK in '
      + `${blockList.docPath}. That is the single most important rule for public listing content -- halting.`,
    );
  }
}

// ─── Layer 2: weakness copy ─────────────────────────────────────────────────
//
// memory: listing-copy-never-signal-weakness.md. Grouped so a failure names
// WHICH kind of weakness it was, not just "blocked".
const WEAKNESS_PATTERNS = [
  // Referencing a price change at all -- the change may TRIGGER the reel,
  // the copy may never mention it.
  { id: 'price_change_reference', re: /\bnew\s+price\b/i },
  { id: 'price_change_reference', re: /\bprice\s+(cut|drop|reduction|reduced|change|adjust\w*|improvement|update)\b/i },
  { id: 'price_change_reference', re: /\b(just\s+)?reduced\b/i },
  { id: 'price_change_reference', re: /\bdown\s+from\b/i },
  { id: 'price_change_reference', re: /\b(was|formerly|previously)\s*\$\s*[\d,]/i },
  { id: 'price_change_reference', re: /\bnow\s+(only\s+)?\$\s*[\d,]/i },
  { id: 'price_change_reference', re: /\bre[\s-]?priced\b/i },
  { id: 'price_change_reference', re: /\bprice\s+improved\b/i },
  // Hinting a FUTURE cut. The 23-nopalito script's closing line.
  { id: 'future_cut_hint', re: /before\s+the\s+price[^.]{0,40}(again|changes|drops|moves)/i },
  { id: 'future_cut_hint', re: /(price|it)\s+(may|might|could|will)\s+(come\s+down|drop|be\s+reduced)/i },
  { id: 'future_cut_hint', re: /\bcatch\s+it\s+before\b/i },
  // Seller motivation / desperation.
  { id: 'seller_weakness', re: /motivated\s+seller/i },
  { id: 'seller_weakness', re: /seller\s+(is\s+)?(motivated|anxious|eager|flexible|desperate|relocating|must\s+sell)/i },
  { id: 'seller_weakness', re: /\bmust\s+sell\b/i },
  { id: 'seller_weakness', re: /\bneeds?\s+(a\s+)?(quick|fast)\s+(sale|close)/i },
  { id: 'seller_weakness', re: /seller\s+will\s+(consider|entertain|look\s+at)/i },
  { id: 'seller_weakness', re: /\b(all|any)\s+offers?\s+(considered|welcome|entertained)\b/i },
  { id: 'seller_weakness', re: /\bbring\s+(me\s+|us\s+|your\s+)?(an\s+)?offers?\b/i },
  { id: 'seller_weakness', re: /\bmake\s+(me\s+|us\s+)?an\s+offer\b/i },
  { id: 'seller_weakness', re: /\bopen\s+to\s+offers\b/i },
  { id: 'seller_weakness', re: /\bprice\s+is\s+negotiable\b/i },
  // Apologising for the price / begging on value.
  { id: 'price_apology', re: /priced\s+to\s+(sell|move|go)/i },
  { id: 'price_apology', re: /\bbelow\s+market\b/i },
  { id: 'price_apology', re: /\bunder\s+appraised?\s+value\b/i },
  { id: 'price_apology', re: /\bsteal\b/i },
  { id: 'price_apology', re: /\bbargain\b/i },
  { id: 'price_apology', re: /\bwon'?t\s+find\s+(a\s+)?better\s+(price|deal)\b/i },
  { id: 'price_apology', re: /\bdesperate\b/i },
  // Days on market / staleness.
  { id: 'dom_emphasis', re: /\b\d+\s*(\+\s*)?days?\s+on\s+(the\s+)?market\b/i },
  { id: 'dom_emphasis', re: /\bDOM\b/ },
  { id: 'dom_emphasis', re: /\bback\s+on\s+(the\s+)?market\b/i },
  { id: 'dom_emphasis', re: /\bstill\s+(available|on\s+the\s+market|looking\s+for)\b/i },
  { id: 'dom_emphasis', re: /\b(didn'?t|did\s+not|hasn'?t|has\s+not)\s+sell/i },
  { id: 'dom_emphasis', re: /\bbuyer\s+(fell|backed)\s+(through|out)\b/i },
  { id: 'dom_emphasis', re: /\bfinancing\s+fell\s+through\b/i },
  { id: 'dom_emphasis', re: /\bsecond\s+chance\b/i },
  { id: 'dom_emphasis', re: /\bstill\s+here\b/i },
];

// A listing carrying a conditionCaveat in listing-marketing-facts.js (702
// Fawndale's pending make-ready, 130 Senisa's tenant occupancy) may describe
// PERMANENT, already-done facts -- the 2024 renovation, the 2021 rehab -- but
// never the present-moment walk-through condition. The fact pack says so in
// its own words: 'NEVER write "move-in ready today" or "immaculate" ... while
// this caveat is active'. Nothing enforced that for video until now.
const CONDITION_CLAIM_PATTERNS = [
  /\bmove[\s-]?in[\s-]?ready\b/i,
  /\bimmaculate\b/i,
  /\bpristine\b/i,
  /\bturn[\s-]?key\b/i,
  /\bspotless\b/i,
  /\bflawless\b/i,
  /\bmint\s+condition\b/i,
  /\bready\s+(to|for)\s+move\b/i,
  /\bnothing\s+to\s+do\s+but\s+move\s+in\b/i,
];

// ─── The gate ───────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Array<{name: string, text: string}>} opts.surfaces
 *   Every human-visible surface of the reel -- eyebrow, hook, spec line,
 *   price pill, lower third, closing-card lines, voiceover script, post
 *   caption. A surface omitted here is a surface NOT checked; pass them all.
 * @param {object} opts.status  the LIVE listing_marketing_status row from the
 *   same-process connectMLS read: { mls_number, list_price, mls_status,
 *   last_verified_at }. Required -- there is no "no status" path.
 * @param {boolean} opts.showPrice  whether the render will display a price
 * @param {string}  [opts.closingCardSurfaceName='closing_card'] which surface
 *   carries the TREC broker name
 * @param {string}  [opts.blockListPath]
 * @returns {{allowed: boolean, reasons: string[], trec: object, blockListPath: string}}
 */
function checkReelCopy(opts) {
  const reasons = [];
  const surfaces = Array.isArray(opts.surfaces) ? opts.surfaces : [];
  const status = opts.status;

  if (!surfaces.length) {
    return { allowed: false, reasons: ['no_surfaces_supplied'], trec: null, blockListPath: null };
  }
  if (!status || !status.mls_status) {
    return { allowed: false, reasons: ['no_live_status_supplied'], trec: null, blockListPath: null };
  }

  // Layer 1 + coverage assertion. These THROW rather than returning a
  // reason: a missing block list is an environment fault, not a copy fault,
  // and the caller must halt the whole run rather than skip one listing.
  const blockList = loadBlockList(opts.blockListPath);
  assertDetectorCoverage(blockList);

  const levelByTopic = Object.fromEntries(blockList.rows.map((r) => [r.topicId, r.blockLevel]));

  for (const surface of surfaces) {
    const text = String((surface && surface.text) || '');
    const name = (surface && surface.name) || 'unnamed';
    if (!text.trim()) continue;

    // Layer 1 -- do-not-write topics
    for (const [topicId, patterns] of Object.entries(TOPIC_DETECTORS)) {
      if (!levelByTopic[topicId]) continue; // topic no longer in the doc -- doc is the authority
      for (const re of patterns) {
        if (re.test(text)) {
          reasons.push(`do_not_write:${levelByTopic[topicId]}:${topicId}:${name}`);
          break;
        }
      }
    }

    // Layer 2 -- weakness copy
    const hit = new Set();
    for (const { id, re } of WEAKNESS_PATTERNS) {
      if (hit.has(id)) continue;
      if (re.test(text)) {
        hit.add(id);
        reasons.push(`weakness_copy:${id}:${name}:${re.source.slice(0, 60)}`);
      }
    }

    // Layer 2b -- present-condition claims on a listing with an active
    // conditionCaveat in the fact pack.
    if (opts.listing && opts.listing.conditionCaveat) {
      for (const re of CONDITION_CLAIM_PATTERNS) {
        if (re.test(text)) {
          reasons.push(`condition_claim_against_caveat:${name}:${re.source.slice(0, 40)}`);
          break;
        }
      }
    }
  }

  // Layer 3 -- price / status truth
  const soldOrOffMarket = OFF_MARKET.has(status.mls_status);
  const underContract = UNDER_CONTRACT_ACTIVE_FAMILY.has(status.mls_status);

  const allText = surfaces.map((s) => String((s && s.text) || '')).join('\n');
  const mentions = extractPriceMentions(allText);

  if (soldOrOffMarket || underContract) {
    // Never show a sale price on a just-sold, and never quote a list price
    // against an under-contract listing as if it were buyable.
    if (opts.showPrice) {
      reasons.push(`price_shown_on_non_active_status:${status.mls_status}`);
    }
    if (mentions.length) {
      reasons.push(`price_mentioned_on_non_active_status:${status.mls_status}:${mentions.join('|')}`);
    }
  } else if (status.list_price != null) {
    const expected = Number(status.list_price);
    const wrong = mentions.filter((n) => n !== expected);
    if (wrong.length) {
      reasons.push(`price_mismatch:surfaces_have_${wrong.join('|')}_live_is_${expected}`);
    }
  }

  if (!isPostableActive(status.mls_status) && !soldOrOffMarket && !underContract) {
    reasons.push(`unrecognised_mls_status:${status.mls_status}`);
  }

  // TREC owner/agent disclosure. Heath owns 130 Senisa and 702 Fawndale
  // (is_agent_owned=true, confirmed live). A license holder advertising his
  // OWN property must disclose it -- this is a compliance requirement, not a
  // nicety, and it is the one path 23 Nopalito (is_agent_owned=false) never
  // exercises. Checked against the caption surface (the post body), matching
  // where listing-marketing-generator.js's ownerLine() already puts it.
  if (opts.listing && opts.listing.isAgentOwned) {
    const captionSurface = surfaces.find((s) => s && s.name === 'caption');
    if (!captionSurface) {
      reasons.push('missing_caption_surface_for_owner_disclosure');
    } else if (!String(captionSurface.text).includes(OWNER_DISCLOSURE)) {
      reasons.push(`missing_owner_disclosure:agent_owned_listing_requires_"${OWNER_DISCLOSURE}"`);
    }
  }

  // TREC broker name on the card, derived from TREC_ATTRIBUTION.
  const trec = parseTrecAttribution();
  const cardName = opts.closingCardSurfaceName || 'closing_card';
  const card = surfaces.find((s) => s && s.name === cardName);
  if (!card) {
    reasons.push(`missing_closing_card_surface:${cardName}`);
  } else if (!String(card.text).includes(trec.brokerage)) {
    reasons.push(`missing_trec_broker_name:expected_"${trec.brokerage}"_on_${cardName}`);
  }

  return { allowed: reasons.length === 0, reasons, trec, blockListPath: blockList.docPath };
}

module.exports = {
  checkReelCopy,
  loadBlockList,
  assertDetectorCoverage,
  parseTrecAttribution,
  TOPIC_DETECTORS,
  WEAKNESS_PATTERNS,
  CONDITION_CLAIM_PATTERNS,
};
