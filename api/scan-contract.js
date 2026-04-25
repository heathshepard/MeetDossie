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
- Paragraph 2 PROPERTY: Street address (2A Land/Lot/Block), city, county, state, ZIP.
- Paragraph 3 SALES PRICE: 3A cash portion, 3B sum financed, 3C total sales price.
- Paragraph 4 LICENSE HOLDER DISCLOSURE: usually about agent affiliation, ignore for deal fields.
- Paragraph 5 EARNEST MONEY AND TERMINATION OPTION: earnest money amount, additional earnest money amount and date, option fee amount, option period in days.
- Paragraph 6 TITLE POLICY AND SURVEY: 6A title company name and address.
- Paragraph 9 CLOSING: closing date.
- Paragraph 22 AGREEMENT OF PARTIES: list of attached addenda — note whether "Third Party Financing Addendum" box is checked.
- Paragraph 23 TERMINATION OPTION: number of option days (also referenced in 5).
- Effective Date: bottom of contract near signatures, labeled "Effective Date".
- Broker Information section (last page): Buyer's broker (firm + associate name + email + phone), Listing broker (firm + associate name + email + phone).
- Third Party Financing Addendum (if attached): financing approval period in days (notice deadline for financing).

EXTRACT each field and return ONLY valid JSON (no prose, no markdown fences) matching this schema:

{
  "extracted": {
    "propertyAddress": string | null,            // street address only, e.g. "1234 Main St"
    "cityStateZip": string | null,               // "Austin, TX 78701"
    "buyerName": string | null,                  // full buyer name(s), comma-separated if multiple
    "sellerName": string | null,                 // full seller name(s), comma-separated if multiple
    "salePrice": number | null,                  // total sales price (3C) as a number, no $ or commas
    "earnestMoney": number | null,               // earnest money in 5A as a number
    "optionFee": number | null,                  // option fee in 5D as a number
    "optionDays": number | null,                 // termination option period (paragraph 23) as integer
    "financingDays": number | null,              // financing approval days from Third Party Financing Addendum, null if no addendum
    "hasFinancingAddendum": boolean,             // true if "Third Party Financing Addendum" box is checked in 22
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
    "parties.lender": number
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
7. Return ONLY the JSON object. No commentary, no markdown code fences.`;

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
  extracted.parties = { ...base.extracted.parties, ...((parsed.extracted && parsed.extracted.parties) || {}) };

  const confidence = (parsed.confidence && typeof parsed.confidence === 'object') ? parsed.confidence : {};
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.filter((w) => typeof w === 'string') : [];

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
