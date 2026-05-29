// Vercel Serverless Function: /api/extract-form-fields
// Takes natural language + transaction context, returns structured field values
// for TREC form filling via /api/fill-form.
//
// POST {
//   form_type: 'resale-contract' | 'financing-addendum' | 'termination-notice',
//   message: "write a contract for 123 Main St, $300k, John Smith buying, conventional loan...",
//   transaction: { property_address, buyer_name, seller_name, purchase_price, closing_date, ... }
// }
// Returns: { ok: true, field_values: { buyer_name, seller_name, ... } }
//
// Authorization: Bearer <supabase user JWT>

const Anthropic = require('@anthropic-ai/sdk');

const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

const ALLOWED_FORM_TYPES = new Set([
  'resale-contract',
  'financing-addendum',
  'termination-notice',
  'unimproved-property',
  'new-home-incomplete',
  'new-home-complete',
  'farm-ranch',
]);

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  if (!origin) return true;
  let allowOrigin = null;
  if (
    ALLOWED_ORIGINS.has(origin) ||
    LOCALHOST_ORIGIN_RE.test(origin) ||
    VERCEL_PREVIEW_RE.test(origin)
  ) {
    allowOrigin = origin;
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin);
}

// ---------------------------------------------------------------------------
// Field schema descriptions per form type
// ---------------------------------------------------------------------------
const FIELD_SCHEMAS = {
  'resale-contract': `
Extract these fields from the agent's message and transaction context.
Return a JSON object with ONLY the fields that are present or can be inferred.
Do NOT guess or fabricate values.

Fields to extract:
- buyer_name (string): Full legal name(s) of buyer(s). Example: "John Smith" or "John Smith and Jane Smith"
- seller_name (string): Full legal name(s) of seller(s).
- property_address (string): Street address only, no city/state. Example: "123 Main St"
- city_state_zip (string): City, state, zip. Example: "San Antonio, TX 78230"
- county (string): Texas county. Example: "Bexar"
- legal_description (string): Lot/block/subdivision if known.
- sale_price (number): Total purchase price in dollars. Example: 300000
- earnest_money (number): Earnest money amount. Default 1% of purchase price if not stated.
- option_fee (number): Option period fee in dollars. Default 100 if not stated.
- option_days (number): Option period days. Default 10 if not stated.
- loan_amount (number): Loan amount = sale_price - down_payment_amt
- down_payment_pct (number): Down payment as percentage. Example: 3.5
- down_payment_amt (number): Down payment dollar amount.
- closing_date (string): ISO date YYYY-MM-DD. Calculate from close_in_days if stated.
- close_in_days (number): Days to closing from today if stated.
- title_company (string): Title company name if stated.
- financing_type (string): One of: "conventional", "fha", "va", "usda", "cash". Default "conventional" if loan mentioned.
- hoa_exists (boolean): true if HOA mentioned or suspected, false if not.
- contract_effective_date (string): ISO date YYYY-MM-DD of contract execution.
`,
  'financing-addendum': `
Extract these fields for the Third Party Financing Addendum.
Return ONLY fields that are present or can be inferred.

Fields to extract:
- property_address (string): Street address.
- city_state_zip (string): City, state, zip.
- buyer_name (string): Buyer's full name.
- financing_type (string): One of: "conventional", "fha", "va", "usda". Required.
- loan_amount (number): Principal loan amount in dollars.
- down_payment_pct (number): Down payment percentage.
- interest_rate_max (number): Maximum interest rate (e.g., 8.0 for 8%).
- loan_term_years (number): Loan term in years (default 30).
`,
  'termination-notice': `
Extract these fields for the Notice of Sellers Termination of Contract.
Return ONLY fields that are present or can be inferred.

Fields to extract:
- property_address (string): Street address.
- city_state_zip (string): City, state, zip.
- seller_name (string): Seller's full name.
- buyer_name (string): Buyer's full name.
- contract_effective_date (string): ISO date YYYY-MM-DD of original contract.
- termination_reason (string): Brief reason for termination if stated.
`,
  'unimproved-property': `
Extract these fields for the TREC 9 Unimproved Property Contract (land purchase — no structures).
Return ONLY fields that are present or can be inferred.

Fields to extract:
- buyer_name (string): Full legal name(s) of buyer(s).
- seller_name (string): Full legal name(s) of seller(s).
- property_address (string): Street address or rural route description.
- city_state_zip (string): City, state, zip if known.
- county (string): Texas county. Example: "Bexar"
- legal_description (string): Lot/block/subdivision or survey abstract description.
- land_acreage (number): Acres of the land. Example: 5.5
- land_parcel_id (string): Parcel/tax ID if stated.
- sale_price (number): Total purchase price in dollars.
- earnest_money (number): Earnest money amount. Default 1% of purchase price if not stated.
- option_fee (number): Option period fee. Default 100 if not stated.
- option_days (number): Option period days. Default 10 if not stated.
- loan_amount (number): Loan amount if financed.
- down_payment_pct (number): Down payment as percentage if stated.
- down_payment_amt (number): Down payment dollar amount.
- closing_date (string): ISO date YYYY-MM-DD.
- title_company (string): Title company name if stated.
- financing_type (string): One of: "conventional", "fha", "va", "usda", "cash".
- contract_effective_date (string): ISO date YYYY-MM-DD of contract execution.
`,
  'new-home-incomplete': `
Extract these fields for the TREC 23 New Home Contract - Incomplete Construction.
Return ONLY fields that are present or can be inferred.

Fields to extract:
- buyer_name (string): Full legal name(s) of buyer(s).
- seller_name (string): Full legal name(s) of seller(s) or builder company name.
- property_address (string): Lot address or street address of the new construction.
- city_state_zip (string): City, state, zip.
- county (string): Texas county.
- legal_description (string): Lot/block/subdivision.
- sale_price (number): Contract price / purchase price.
- earnest_money (number): Earnest money amount. Default 1% if not stated.
- option_fee (number): Option fee. Default 100 if not stated.
- option_days (number): Option days. Default 10 if not stated.
- loan_amount (number): Loan amount if financed.
- down_payment_pct (number): Down payment percentage.
- down_payment_amt (number): Down payment dollar amount.
- closing_date (string): ISO date YYYY-MM-DD (estimated closing/completion date).
- title_company (string): Title company name if stated.
- financing_type (string): One of: "conventional", "fha", "va", "usda", "cash".
- builder_name (string): Builder company name.
- builder_rep_name (string): Builder's sales representative name.
- builder_rep_phone (string): Builder rep phone.
- expected_completion_date (string): ISO date YYYY-MM-DD when construction expected to complete.
- contract_effective_date (string): ISO date YYYY-MM-DD of contract execution.
`,
  'new-home-complete': `
Extract these fields for the TREC 24 New Home Contract - Completed Construction.
Return ONLY fields that are present or can be inferred.

Fields to extract:
- buyer_name (string): Full legal name(s) of buyer(s).
- seller_name (string): Full legal name(s) of seller(s) or builder company name.
- property_address (string): Street address of the completed new construction.
- city_state_zip (string): City, state, zip.
- county (string): Texas county.
- legal_description (string): Lot/block/subdivision.
- sale_price (number): Purchase price.
- earnest_money (number): Earnest money amount. Default 1% if not stated.
- option_fee (number): Option fee. Default 100 if not stated.
- option_days (number): Option days. Default 10 if not stated.
- loan_amount (number): Loan amount if financed.
- down_payment_pct (number): Down payment percentage.
- down_payment_amt (number): Down payment dollar amount.
- closing_date (string): ISO date YYYY-MM-DD.
- title_company (string): Title company name if stated.
- financing_type (string): One of: "conventional", "fha", "va", "usda", "cash".
- builder_name (string): Builder company name.
- builder_rep_name (string): Builder's sales representative name.
- builder_rep_phone (string): Builder rep phone.
- builder_warranty_company (string): Home warranty company name if stated.
- co_received_date (string): ISO date YYYY-MM-DD when certificate of occupancy was issued.
- co_number (string): Certificate of occupancy number if stated.
- contract_effective_date (string): ISO date YYYY-MM-DD of contract execution.
`,
  'farm-ranch': `
Extract these fields for the TREC 25 Farm and Ranch Contract (land with improvements).
Return ONLY fields that are present or can be inferred.

Fields to extract:
- buyer_name (string): Full legal name(s) of buyer(s).
- seller_name (string): Full legal name(s) of seller(s).
- property_address (string): Street address or rural route description.
- city_state_zip (string): City, state, zip if known.
- county (string): Texas county.
- legal_description (string): Survey/abstract/lot description for the farm or ranch parcel.
- land_acreage (number): Total acres. Example: 100.5
- land_parcel_id (string): Parcel/tax ID if stated.
- sale_price (number): Total purchase price.
- earnest_money (number): Earnest money amount. Default 1% if not stated.
- option_fee (number): Option fee. Default 100 if not stated.
- option_days (number): Option days. Default 10 if not stated.
- loan_amount (number): Loan amount if financed.
- down_payment_pct (number): Down payment percentage.
- down_payment_amt (number): Down payment dollar amount.
- closing_date (string): ISO date YYYY-MM-DD.
- title_company (string): Title company name if stated.
- financing_type (string): One of: "conventional", "fha", "va", "usda", "cash".
- contract_effective_date (string): ISO date YYYY-MM-DD of contract execution.
`,
};

// ---------------------------------------------------------------------------
// Extract fields via Claude Haiku
// ---------------------------------------------------------------------------
async function extractFieldsWithAI(formType, message, transaction) {
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const schema = FIELD_SCHEMAS[formType] || FIELD_SCHEMAS['resale-contract'];

  // Build context from existing transaction record
  const txContext = transaction && typeof transaction === 'object'
    ? `Existing transaction data (use as defaults, agent's message overrides):\n${JSON.stringify(transaction, null, 2)}`
    : 'No existing transaction data.';

  const today = new Date().toISOString().slice(0, 10);

  const systemPrompt = `You are a Texas real estate transaction coordinator extracting structured data from an agent's message to fill out a TREC form.

Today's date: ${today}

${schema}

Rules:
- Return ONLY valid JSON — no markdown, no explanation, no code fences
- Numbers must be actual numbers (not strings) for numeric fields
- Dates must be ISO format YYYY-MM-DD
- If a field cannot be determined, omit it entirely (do not include null values)
- If "close in 30 days" → calculate closing_date from today
- If "3.5% down" on a $300k purchase → down_payment_amt = 10500, loan_amount = 289500
- If "conventional loan" → financing_type = "conventional"
- Never fabricate values not present in the message or transaction context
- Return a flat JSON object, not nested`;

  const userPrompt = `${txContext}

Agent's message: "${message}"

Extract the form fields as a JSON object.`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';

  // Parse JSON from response
  let parsed;
  try {
    // Strip markdown code fences if present
    const cleaned = text.replace(/^```[a-z]*\n?/m, '').replace(/```$/m, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error('[extract-form-fields] JSON parse failed:', text.slice(0, 200));
    throw new Error('AI extraction returned invalid JSON. Please try again.');
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Post-process: calculate derived fields and apply defaults
// ---------------------------------------------------------------------------
function postProcess(formType, fields, message) {
  const fv = { ...fields };
  const today = new Date();

  // Calculate closing_date from close_in_days
  if (!fv.closing_date && fv.close_in_days) {
    const cd = new Date(today);
    cd.setDate(cd.getDate() + Number(fv.close_in_days));
    fv.closing_date = cd.toISOString().slice(0, 10);
  }

  // Default earnest_money = 1% of sale_price (use sale_price key to match fill-form.js)
  if (!fv.earnest_money && fv.sale_price) {
    fv.earnest_money = Math.round(Number(fv.sale_price) * 0.01);
  }

  // Default option_fee = $100 for purchase contracts (resale, land, new home, farm-ranch)
  const purchaseForms = new Set(['resale-contract', 'unimproved-property', 'new-home-incomplete', 'new-home-complete', 'farm-ranch']);
  if (!fv.option_fee && purchaseForms.has(formType)) {
    fv.option_fee = 100;
  }

  // Calculate loan_amount from down_payment
  if (!fv.loan_amount && fv.sale_price) {
    if (fv.down_payment_amt) {
      fv.loan_amount = Number(fv.sale_price) - Number(fv.down_payment_amt);
    } else if (fv.down_payment_pct) {
      fv.down_payment_amt = Math.round(Number(fv.sale_price) * Number(fv.down_payment_pct) / 100);
      fv.loan_amount = Number(fv.sale_price) - fv.down_payment_amt;
    }
  }

  // Default financing_type from message
  if (!fv.financing_type) {
    const msg = String(message || '').toLowerCase();
    if (/\bcash\b/.test(msg)) fv.financing_type = 'cash';
    else if (/\bfha\b/.test(msg)) fv.financing_type = 'fha';
    else if (/\bva\b/.test(msg)) fv.financing_type = 'va';
    else if (/\busda\b/.test(msg)) fv.financing_type = 'usda';
    else if (/\bconventional\b/.test(msg) || fv.loan_amount) fv.financing_type = 'conventional';
  }

  // Default possession
  if (!fv.possession) fv.possession = 'closing';

  // Default hoa_exists = false
  if (fv.hoa_exists === undefined) {
    fv.hoa_exists = false;
  }

  return fv;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(corsAllowed ? 204 : 403).end();
    return;
  }
  if (!corsAllowed) {
    res.status(403).json({ ok: false, error: 'Origin not allowed.' });
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ ok: false, error: 'AI service not configured.' });
    return;
  }

  try {
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'extract-form-fields', 30, 60 * 60 * 1000);

    const { userId } = await verifySupabaseToken(req);

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    const formType = sanitizeString(body.form_type, { maxLength: 50 });
    const message = sanitizeString(body.message, { maxLength: 2000 });
    const transaction = (body.transaction && typeof body.transaction === 'object') ? body.transaction : {};

    if (!formType) throw new ValidationError('form_type is required.');
    if (!ALLOWED_FORM_TYPES.has(formType)) {
      throw new ValidationError(`form_type must be one of: ${[...ALLOWED_FORM_TYPES].join(', ')}`);
    }
    if (!message) throw new ValidationError('message is required.');

    // Extract fields with AI
    const rawFields = await extractFieldsWithAI(formType, message, transaction);

    // Post-process and apply defaults
    const fieldValues = postProcess(formType, rawFields, message);

    return res.status(200).json({
      ok: true,
      field_values: fieldValues,
    });

  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.status || 401).json({ ok: false, error: error.message });
    }
    if (error instanceof ValidationError) {
      return res.status(error.status || 400).json({ ok: false, error: error.message });
    }
    if (error instanceof RateLimitError) {
      if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: 'Too many requests. Try again later.' });
    }
    console.error('[extract-form-fields] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not extract form fields. Try again.' });
  }
};
