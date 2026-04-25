// Vercel Serverless Function: /api/scan-contract
// Extracts structured deal data from a TREC 20-17 PDF using Claude Sonnet 4.5
// POST { pdfBase64 } -> { ok, extracted, confidence, warnings }

const Anthropic = require('@anthropic-ai/sdk');
const { validatePdfBase64, ValidationError } = require('./_middleware/validate');
const {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = 'claude-sonnet-4-5';
const MAX_TOKENS = 4096;
const MAX_PDF_BYTES = 32 * 1024 * 1024; // 32MB Anthropic doc limit

// CORS allowlist — production domains plus any localhost port for dev.
const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  let allowOrigin = null;
  if (typeof origin === 'string' && origin.length > 0) {
    if (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN_RE.test(origin)) {
      allowOrigin = origin;
    }
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin);
}

const EXTRACTION_PROMPT = `You are extracting structured data from a Texas Real Estate Commission (TREC) Form 20-17 "One to Four Family Residential Contract (Resale)".

FIELD LOCATIONS BY PARAGRAPH (TREC 20-17):
- Paragraph 1 PARTIES: Seller name(s) and Buyer name(s).
- Paragraph 2 PROPERTY: Street address (2A Land/Lot/Block), city, county, state, ZIP. The 2A line typically reads "Lot ___ , Block ___ , of <Subdivision>, in the City of <city>, <county> County, Texas". Capture the legal description verbatim into propertyDetails.legalDescription, and pull lotNumber, blockNumber, subdivision, county into the matching propertyDetails sub-fields. If 2C "Reservations" or any deed restrictions are mentioned, capture them into propertyDetails.restrictions.
- Paragraph 3 SALES PRICE: 3A cash portion, 3B sum financed, 3C TOTAL sales price.
  IMPORTANT: Paragraph 3C is the TOTAL Sales Price — the final number after adding 3A cash + 3B financed amount. Extract ONLY the 3C total into salePrice. Do NOT mistakenly extract 3A or 3B. Convert to plain number, no commas or dollar signs (e.g. "$350,000.00" -> 350000).
  Sanity check: Sales price should typically be between $50,000 and $5,000,000 for Texas residential. If your value falls outside that range, look again at Paragraph 3C — you may have grabbed 3A or 3B by mistake. If after re-reading the value still falls outside that range, keep it but add a warning so the agent can verify.
- Paragraph 4 LICENSE HOLDER DISCLOSURE: usually about agent affiliation, ignore for deal fields.
- Paragraph 5 EARNEST MONEY AND TERMINATION OPTION: earnest money amount, additional earnest money amount and date, option fee amount, option period in days.
  Also pull the "earnest money holder" — the title company / escrow agent named on the 5A line — into paragraph5.earnestMoneyHolder, and the deadline (typically "within X days after the Effective Date") into paragraph5.earnestMoneyDeadlineDays. If the contract calls for additional earnest money on a later date, capture both into paragraph5.additionalEarnestMoney and paragraph5.additionalEarnestMoneyDate (YYYY-MM-DD).
- Paragraph 6 TITLE POLICY AND SURVEY: 6A title company name and address.
- Paragraph 9 CLOSING and POSSESSION: closing date goes into closingDate (top-level) and is mirrored into paragraph9Closing.closingDate. Possession is in 9.B — there are checkbox options for "upon closing and funding", "upon closing", or "according to a temporary residential lease form" / a specific date.
  - "upon closing and funding" or "upon closing" -> possession.type = "closing" (or "funding" if explicitly funding-only)
  - A specific date -> possession.type = "specific_date" and possession.specificDate = YYYY-MM-DD
  Mirror the same values into paragraph9Closing.possessionType and paragraph9Closing.possessionDate.
- Paragraph 10 POSSESSION / FIXTURES (the "items included / not included" list): TREC 20-17 lists standard items (curtains, drapery rods, mounted TV brackets, etc.) and has write-in lines for additional inclusions and for exclusions. Capture each non-default included item into paragraph10.inclusions[] and each excluded item into paragraph10.exclusions[]. Don't enumerate items the form lists as included by default; only capture write-in additions/removals.
- Paragraph 11 SPECIAL PROVISIONS: free-text block. Capture the entire content verbatim (including line breaks as \\n) into paragraph11SpecialProvisions. Trim leading/trailing whitespace. If the field is blank, return null.
- Paragraph 12 SETTLEMENT AND OTHER EXPENSES: 12A.(1)(b) lists the seller's contribution to the buyer's expenses. The line is typically "Seller's Expenses (Buyer's Expenses): An amount not to exceed $___ ..." Capture the dollar amount into paragraph12Expenses.sellerPaysAmount, and any percentage into paragraph12Expenses.sellerPaysPercentage. paragraph12Expenses.buyerPaysClosingCosts is true unless the seller-pays line covers ALL of buyer's typical closing costs (rare).
- Paragraph 22 AGREEMENT OF PARTIES — ATTACHED ADDENDA: a list of checkboxes for every standard TREC addendum. Look at each checkbox and record whether it is marked. Map each to the addenda.* schema below. Standard items in this list:
  - "Third Party Financing Addendum" (TREC 40-x) -> addenda.hasThirdPartyFinancing
  - "Addendum for Property Subject to Mandatory Membership in a Property Owners Association" / HOA disclosure (TREC 36-x) -> addenda.hasHOA
  - "Addendum for Seller's Disclosure of Information on Lead-Based Paint" / Lead-Based Paint Addendum (TREC OP-L) -> addenda.hasLeadBasedPaint
  - "Seller Financing Addendum" (TREC 26-x) -> addenda.hasSellerFinancing
  - "Addendum for Sale of Other Property by Buyer" (TREC 10-x) -> addenda.hasSaleOfOtherProperty
  - "Addendum for Back-Up Contract" (TREC 11-x) -> addenda.hasBackupContract
  - "Addendum Concerning Right to Terminate Due to Lender's Appraisal" (TREC 49-x) -> addenda.hasAppraisalRightToTerminate
  - "Condominium Resale Certificate Addendum" (TREC 32-x) -> addenda.hasCondoResale
  - "Addendum for Coastal Area Property" (TREC 33-x) -> addenda.hasCoastalProperty
  - "Addendum for Reservation of Oil, Gas and Other Minerals" (TREC 44-x) -> addenda.hasMineralsReservation
  - Any "Other" line that is filled in or has its own attached page -> addenda.hasOther (and capture the description in addenda.notes)
- Each addendum is typically a separate page following the contract. When an addendum box is checked, look at the attached page to pull the relevant details:
  - Third Party Financing Addendum -> financing approval days (also goes into addenda.thirdPartyFinancingDays for back-compat with financingDays)
  - Sale of Other Property Addendum -> the date by which the buyer must close on the other property (addenda.saleOfOtherPropertyDeadline, ISO YYYY-MM-DD)
  - Right to Terminate Due to Lender's Appraisal -> number of days notice (addenda.appraisalTerminationDays)
  - Back-Up Contract -> number of days the buyer has to deliver notice once the primary contract terminates (addenda.backupContractNoticeDays)
- Paragraph 23 TERMINATION OPTION: number of option days (also referenced in 5). Mirror into paragraph23TerminationOption.optionDays and paragraph23TerminationOption.optionFee. The option fee is usually payable to Seller, but the contract sometimes names the title company or another party — capture whoever appears on the "payable to" line into paragraph23TerminationOption.optionFeePayableTo.
- Effective Date: bottom of contract near signatures, labeled "Effective Date".
- Broker Information section (last page): two side-by-side blocks — see BROKER BLOCK DISAMBIGUATION below.

BROKER BLOCK DISAMBIGUATION — READ CAREFULLY BEFORE EXTRACTING AGENT FIELDS:

IMPORTANT: On TREC Form 20-17, the broker information page has TWO blocks:
- LEFT block (labeled "Other Broker" or "Buyer's Representative"): This is the BUYER'S agent information → map to buyerAgent, buyerAgentEmail, buyerBrokerage
- RIGHT block (labeled "Listing Broker"): This is the LISTING agent information → map to listingAgent, listingAgentEmail, listingBrokerage
Do NOT confuse the two blocks.

Additional aliases to recognize for the BUYER'S block: "Buyer's Agent", "Buyer's Broker", "Cooperating Broker", "Selling Broker" (because the buyer's agent "sells" the home to the buyer — this is NOT the listing side).
Additional aliases to recognize for the LISTING block: "Listing Agent", "Seller's Broker", "Seller's Representative".

Inside each block, the fields are typically laid out as:
- "Broker/Firm Name" or just "Broker" → buyerBrokerage / listingBrokerage
- "Associate" or "Licensed Supervisor" or "Listing Associate" → buyerAgent / listingAgent (this is the human agent's name, NOT the firm)
- "Email" → buyerAgentEmail / listingAgentEmail
- "Phone" or "Telephone" → buyerAgentPhone / listingAgentPhone

If a block is empty (e.g. a deal where one side is unrepresented), set those fields to null and lower the confidence to 0. Do not fall back to copying values from the other block.

EXTRACT each field and return ONLY valid JSON (no prose, no markdown fences) matching this schema:

{
  "extracted": {
    "propertyAddress": string | null,            // street address only, e.g. "1234 Main St"
    "cityStateZip": string | null,               // "Austin, TX 78701"
    "buyerName": string | null,                  // full buyer name(s), comma-separated if multiple
    "sellerName": string | null,                 // full seller name(s), comma-separated if multiple
    "salePrice": number | null,                  // TOTAL sales price from Paragraph 3C as a number, no $ or commas (NOT 3A or 3B)
    "earnestMoney": number | null,               // earnest money in 5A as a number
    "optionFee": number | null,                  // option fee in 5D as a number
    "optionDays": number | null,                 // termination option period (paragraph 23) as integer
    "financingDays": number | null,              // financing approval days from Third Party Financing Addendum, null if no addendum
    "hasFinancingAddendum": boolean,             // legacy mirror of addenda.hasThirdPartyFinancing — keep both in sync
    "contractEffectiveDate": string | null,      // "YYYY-MM-DD"
    "closingDate": string | null,                // "YYYY-MM-DD"
    "titleCompany": string | null,               // company name from 6A
    "titleOfficer": string | null,               // escrow officer if listed, else null
    "buyerAgent": string | null,                 // buyer's associate/agent name from broker info block
    "listingAgent": string | null,               // listing associate/agent name from broker info block
    "parties": {
      "buyerAgentEmail": string | null,
      "buyerAgentPhone": string | null,
      "buyerBrokerage": string | null,
      "listingAgentEmail": string | null,
      "listingAgentPhone": string | null,
      "listingBrokerage": string | null,
      "lender": string | null
    },
    "addenda": {
      // Each has* boolean = whether the corresponding box in Paragraph 22 is checked.
      // Detail fields below are pulled from the attached addendum page itself when present; null otherwise.
      "hasThirdPartyFinancing": boolean,
      "hasHOA": boolean,
      "hasLeadBasedPaint": boolean,
      "hasSellerFinancing": boolean,
      "hasSaleOfOtherProperty": boolean,
      "hasBackupContract": boolean,
      "hasAppraisalRightToTerminate": boolean,
      "hasCondoResale": boolean,
      "hasCoastalProperty": boolean,
      "hasMineralsReservation": boolean,
      "hasOther": boolean,
      "thirdPartyFinancingDays": number | null,        // mirrors top-level financingDays
      "saleOfOtherPropertyDeadline": string | null,    // ISO YYYY-MM-DD
      "appraisalTerminationDays": number | null,
      "backupContractNoticeDays": number | null,
      "notes": string | null                            // free-form description of any "Other" addendum or unusual terms
    },
    "possession": {
      "type": "closing" | "funding" | "specific_date" | null,
      "specificDate": string | null                     // YYYY-MM-DD when type === "specific_date"
    },
    "propertyDetails": {
      "legalDescription": string | null,                // verbatim from Paragraph 2A
      "lotNumber": string | null,
      "blockNumber": string | null,
      "subdivision": string | null,
      "county": string | null,
      "restrictions": string | null                     // any deed restrictions / HOA references mentioned
    },
    "paragraph5": {
      "earnestMoneyHolder": string | null,              // title company / escrow agent named on 5A
      "earnestMoneyDeadlineDays": number | null,        // days after effective date to deliver earnest money
      "additionalEarnestMoney": number | null,
      "additionalEarnestMoneyDate": string | null       // YYYY-MM-DD
    },
    "paragraph9Closing": {
      "closingDate": string | null,                     // mirror of top-level closingDate
      "possessionType": "closing" | "funding" | "specific_date" | null,
      "possessionDate": string | null                   // YYYY-MM-DD when possessionType === "specific_date"
    },
    "paragraph10": {
      "inclusions": [string],                           // write-in items beyond TREC standard list
      "exclusions": [string]                            // items explicitly excluded from sale
    },
    "paragraph11SpecialProvisions": string | null,      // verbatim text of special provisions, line breaks as \\n
    "paragraph12Expenses": {
      "sellerPaysAmount": number | null,                // dollar amount seller agreed to credit toward buyer expenses
      "sellerPaysPercentage": number | null,            // percentage if expressed that way (e.g. 3 means 3%)
      "buyerPaysClosingCosts": boolean
    },
    "paragraph23TerminationOption": {
      "optionDays": number | null,                      // mirror of top-level optionDays
      "optionFee": number | null,                       // mirror of top-level optionFee
      "optionFeePayableTo": string | null               // usually "Seller"; sometimes title company or named escrow agent
    }
  },
  "confidence": {
    // For EVERY field above (including nested parties.*), include a 0-1 score reflecting how certain you are
    // about the extracted value. 1.0 = clearly printed/typed in the form, 0.5 = handwritten or partially legible,
    // 0.0 = field not filled or could not be read. Use the SAME flat key names as the extracted fields,
    // including "parties.buyerAgentEmail" etc. as flat dotted keys.
    "propertyAddress": number,
    "cityStateZip": number,
    "buyerName": number,
    "sellerName": number,
    "salePrice": number,
    "earnestMoney": number,
    "optionFee": number,
    "optionDays": number,
    "financingDays": number,
    "hasFinancingAddendum": number,
    "contractEffectiveDate": number,
    "closingDate": number,
    "titleCompany": number,
    "titleOfficer": number,
    "buyerAgent": number,
    "listingAgent": number,
    "parties.buyerAgentEmail": number,
    "parties.buyerAgentPhone": number,
    "parties.buyerBrokerage": number,
    "parties.listingAgentEmail": number,
    "parties.listingAgentPhone": number,
    "parties.listingBrokerage": number,
    "parties.lender": number,
    "addenda.hasThirdPartyFinancing": number,
    "addenda.hasHOA": number,
    "addenda.hasLeadBasedPaint": number,
    "addenda.hasSellerFinancing": number,
    "addenda.hasSaleOfOtherProperty": number,
    "addenda.hasBackupContract": number,
    "addenda.hasAppraisalRightToTerminate": number,
    "addenda.hasCondoResale": number,
    "addenda.hasCoastalProperty": number,
    "addenda.hasMineralsReservation": number,
    "addenda.hasOther": number,
    "addenda.thirdPartyFinancingDays": number,
    "addenda.saleOfOtherPropertyDeadline": number,
    "addenda.appraisalTerminationDays": number,
    "addenda.backupContractNoticeDays": number,
    "possession.type": number,
    "possession.specificDate": number,
    "propertyDetails.legalDescription": number,
    "propertyDetails.lotNumber": number,
    "propertyDetails.blockNumber": number,
    "propertyDetails.subdivision": number,
    "propertyDetails.county": number,
    "propertyDetails.restrictions": number,
    "paragraph5.earnestMoneyHolder": number,
    "paragraph5.earnestMoneyDeadlineDays": number,
    "paragraph5.additionalEarnestMoney": number,
    "paragraph5.additionalEarnestMoneyDate": number,
    "paragraph9Closing.closingDate": number,
    "paragraph9Closing.possessionType": number,
    "paragraph9Closing.possessionDate": number,
    "paragraph10.inclusions": number,
    "paragraph10.exclusions": number,
    "paragraph11SpecialProvisions": number,
    "paragraph12Expenses.sellerPaysAmount": number,
    "paragraph12Expenses.sellerPaysPercentage": number,
    "paragraph12Expenses.buyerPaysClosingCosts": number,
    "paragraph23TerminationOption.optionDays": number,
    "paragraph23TerminationOption.optionFee": number,
    "paragraph23TerminationOption.optionFeePayableTo": number
  },
  "warnings": [string]   // human-readable notes: blank form, illegible handwriting, missing signatures, ambiguous dates, etc.
}

RULES:
1. If a field is blank, return null (not "" or 0). Set its confidence to 0.
2. Convert all dollar amounts to plain numbers (e.g. "$350,000.00" -> 350000).
3. Convert all dates to ISO YYYY-MM-DD format. If only month/day is given without a year, use null and add a warning.
4. Do NOT guess. If you can't read a field, return null and add a warning.
5. If the entire form appears blank/unfilled, return all nulls and add the warning "PDF appears to be a blank/unfilled form".
6. If signatures are visible but cannot be cryptographically verified, add the warning "Signatures detected but not verified".
7. Return ONLY the JSON object. No commentary, no markdown code fences.
8. Cross-check broker blocks: if buyerAgent and listingAgent resolve to the same person (same name, or same email, or same phone), DO NOT silently pick one — populate the field that the contract clearly labels and add a warning like "Same name appears in both broker blocks — verify buyer vs listing agent assignment." The same rule applies if buyerBrokerage and listingBrokerage are identical.
9. If the LEFT broker block ("Other Broker" / "Buyer's Representative") is filled, those values ALWAYS go into buyerAgent / buyerBrokerage / buyerAgentEmail / buyerAgentPhone — never into the listing fields, regardless of what role the user holds in the deal.`;

function safeParseJson(text) {
  if (!text || typeof text !== 'string') return null;
  let s = text.trim();
  // Strip markdown fences if Claude added them despite instructions
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  // Try direct parse first
  try {
    return JSON.parse(s);
  } catch (e) {
    // Fallback: extract first {...} block
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1));
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

function emptyResult(warning) {
  return {
    extracted: {
      propertyAddress: null,
      cityStateZip: null,
      buyerName: null,
      sellerName: null,
      salePrice: null,
      earnestMoney: null,
      optionFee: null,
      optionDays: null,
      financingDays: null,
      hasFinancingAddendum: false,
      contractEffectiveDate: null,
      closingDate: null,
      titleCompany: null,
      titleOfficer: null,
      buyerAgent: null,
      listingAgent: null,
      parties: {
        buyerAgentEmail: null,
        buyerAgentPhone: null,
        buyerBrokerage: null,
        listingAgentEmail: null,
        listingAgentPhone: null,
        listingBrokerage: null,
        lender: null,
      },
      addenda: {
        hasThirdPartyFinancing: false,
        hasHOA: false,
        hasLeadBasedPaint: false,
        hasSellerFinancing: false,
        hasSaleOfOtherProperty: false,
        hasBackupContract: false,
        hasAppraisalRightToTerminate: false,
        hasCondoResale: false,
        hasCoastalProperty: false,
        hasMineralsReservation: false,
        hasOther: false,
        thirdPartyFinancingDays: null,
        saleOfOtherPropertyDeadline: null,
        appraisalTerminationDays: null,
        backupContractNoticeDays: null,
        notes: null,
      },
      possession: {
        type: null,
        specificDate: null,
      },
      propertyDetails: {
        legalDescription: null,
        lotNumber: null,
        blockNumber: null,
        subdivision: null,
        county: null,
        restrictions: null,
      },
      paragraph5: {
        earnestMoneyHolder: null,
        earnestMoneyDeadlineDays: null,
        additionalEarnestMoney: null,
        additionalEarnestMoneyDate: null,
      },
      paragraph9Closing: {
        closingDate: null,
        possessionType: null,
        possessionDate: null,
      },
      paragraph10: {
        inclusions: [],
        exclusions: [],
      },
      paragraph11SpecialProvisions: null,
      paragraph12Expenses: {
        sellerPaysAmount: null,
        sellerPaysPercentage: null,
        buyerPaysClosingCosts: true,
      },
      paragraph23TerminationOption: {
        optionDays: null,
        optionFee: null,
        optionFeePayableTo: null,
      },
    },
    confidence: {},
    warnings: warning ? [warning] : [],
  };
}

async function scanContract(pdfBase64) {
  // Centralized validation — throws ValidationError with .status set.
  validatePdfBase64(pdfBase64);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: pdfBase64,
            },
          },
          {
            type: 'text',
            text: EXTRACTION_PROMPT,
          },
        ],
      },
    ],
  });

  const textBlock = (response.content || []).find((b) => b.type === 'text');
  const rawText = textBlock ? textBlock.text : '';
  const parsed = safeParseJson(rawText);

  if (!parsed || typeof parsed !== 'object') {
    const fallback = emptyResult('Claude returned a response that could not be parsed as JSON.');
    fallback.warnings.push(`Raw response (first 300 chars): ${String(rawText).slice(0, 300)}`);
    return fallback;
  }

  // Normalize shape
  const base = emptyResult();
  const extracted = { ...base.extracted, ...(parsed.extracted || {}) };
  const parsedExtracted = parsed.extracted || {};
  extracted.parties = { ...base.extracted.parties, ...(parsedExtracted.parties || {}) };
  extracted.addenda = { ...base.extracted.addenda, ...(parsedExtracted.addenda || {}) };
  extracted.possession = { ...base.extracted.possession, ...(parsedExtracted.possession || {}) };
  extracted.propertyDetails = { ...base.extracted.propertyDetails, ...(parsedExtracted.propertyDetails || {}) };
  extracted.paragraph5 = { ...base.extracted.paragraph5, ...(parsedExtracted.paragraph5 || {}) };
  extracted.paragraph9Closing = { ...base.extracted.paragraph9Closing, ...(parsedExtracted.paragraph9Closing || {}) };
  extracted.paragraph10 = {
    ...base.extracted.paragraph10,
    ...(parsedExtracted.paragraph10 || {}),
    inclusions: Array.isArray(parsedExtracted.paragraph10 && parsedExtracted.paragraph10.inclusions)
      ? parsedExtracted.paragraph10.inclusions.filter((s) => typeof s === 'string')
      : [],
    exclusions: Array.isArray(parsedExtracted.paragraph10 && parsedExtracted.paragraph10.exclusions)
      ? parsedExtracted.paragraph10.exclusions.filter((s) => typeof s === 'string')
      : [],
  };
  extracted.paragraph12Expenses = { ...base.extracted.paragraph12Expenses, ...(parsedExtracted.paragraph12Expenses || {}) };
  extracted.paragraph23TerminationOption = { ...base.extracted.paragraph23TerminationOption, ...(parsedExtracted.paragraph23TerminationOption || {}) };
  if (typeof parsedExtracted.paragraph11SpecialProvisions === 'string') {
    extracted.paragraph11SpecialProvisions = parsedExtracted.paragraph11SpecialProvisions.trim() || null;
  }
  // Keep paragraph9Closing.closingDate / paragraph23TerminationOption.* in sync
  // with the top-level fields when one side is missing.
  if (!extracted.paragraph9Closing.closingDate && extracted.closingDate) {
    extracted.paragraph9Closing.closingDate = extracted.closingDate;
  }
  if (extracted.paragraph23TerminationOption.optionDays == null && typeof extracted.optionDays === 'number') {
    extracted.paragraph23TerminationOption.optionDays = extracted.optionDays;
  }
  if (extracted.paragraph23TerminationOption.optionFee == null && typeof extracted.optionFee === 'number') {
    extracted.paragraph23TerminationOption.optionFee = extracted.optionFee;
  }

  // Keep top-level financing fields in sync with addenda (back-compat for the
  // existing frontend, which reads top-level `financingDays` / `hasFinancingAddendum`).
  if (extracted.addenda.hasThirdPartyFinancing && !extracted.hasFinancingAddendum) {
    extracted.hasFinancingAddendum = true;
  }
  if (extracted.addenda.thirdPartyFinancingDays && !extracted.financingDays) {
    extracted.financingDays = extracted.addenda.thirdPartyFinancingDays;
  }

  const confidence = (parsed.confidence && typeof parsed.confidence === 'object') ? parsed.confidence : {};
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.filter((w) => typeof w === 'string') : [];

  // Sales-price sanity-check warning (50k–5M for Texas residential).
  // The model is instructed to add its own warning when out-of-range; we add
  // one server-side as a backstop in case it doesn't.
  if (typeof extracted.salePrice === 'number' && extracted.salePrice > 0) {
    if (extracted.salePrice < 50000 || extracted.salePrice > 5000000) {
      const already = warnings.some((w) => /sales? price/i.test(w));
      if (!already) {
        warnings.push(`Extracted sales price ($${extracted.salePrice.toLocaleString()}) is outside the typical $50,000–$5,000,000 Texas residential range — verify against Paragraph 3C.`);
      }
    }
  }

  return { extracted, confidence, warnings };
}

async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed. Use POST.' });
  }

  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY not configured');
      return res.status(500).json({ ok: false, error: 'Server configuration error.' });
    }

    // Rate limit by IP — 10 req/hour for scan-contract (heavy/expensive call).
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'scan-contract', 10, 60 * 60 * 1000);

    const body = req.body || {};
    const { pdfBase64 } = body;

    if (!pdfBase64 || typeof pdfBase64 !== 'string') {
      return res.status(400).json({ ok: false, error: 'pdfBase64 (string) is required in JSON body.' });
    }

    const result = await scanContract(pdfBase64);
    return res.status(200).json({
      ok: true,
      extracted: result.extracted,
      confidence: result.confidence,
      warnings: result.warnings,
    });
  } catch (error) {
    // Internal logging keeps the full detail.
    console.error('scan-contract error:', error);

    if (error instanceof ValidationError) {
      return res.status(error.status || 400).json({ ok: false, error: error.message });
    }
    if (error instanceof RateLimitError) {
      if (error.retryAfterSeconds) {
        res.setHeader('Retry-After', String(error.retryAfterSeconds));
      }
      return res.status(429).json({ ok: false, error: 'Rate limit exceeded. Please try again later.' });
    }

    // Map upstream errors to a sanitized public message — do NOT leak SDK
    // stack traces, API keys, prompts, or model details to the client.
    const status = (error && Number.isInteger(error.status) && error.status >= 400 && error.status < 600)
      ? error.status
      : 500;
    const publicMessage = status >= 500
      ? 'Failed to scan contract.'
      : 'Bad request.';
    return res.status(status).json({ ok: false, error: publicMessage });
  }
}

module.exports = handler;
module.exports.default = handler;
module.exports.scanContract = scanContract;
