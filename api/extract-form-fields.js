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
  'https://staging.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+(?:-heathshepard-6590s-projects)?\.vercel\.app$/;

const ALLOWED_FORM_TYPES = new Set([
  'resale-contract',
  'financing-addendum',
  'termination-notice',
  'unimproved-property',
  'new-home-incomplete',
  'new-home-complete',
  'farm-ranch',
  'hoa-addendum',
  'lead-paint-addendum',
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
- addition_name (string): Subdivision / addition / neighborhood name if stated. Example: "Cibolo Canyons"
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
- escrow_officer (string): Escrow officer / closer name at the title company if stated. Example: "Ashley Phiffer"
- title_company_address (string): Title company office address if stated.
- financing_type (string): One of: "conventional", "fha", "va", "usda", "cash". Default "conventional" if loan mentioned.
- contract_effective_date (string): ISO date YYYY-MM-DD of contract execution.

§6.C SURVEY (set exactly ONE of these to true based on agent's intent):
- survey_existing_or_seller_pays (boolean): true if "seller will provide existing survey or pay for new one" / "seller will provide T-47 or pay for new survey" — TREC §6C(1).
- survey_buyer_obtains (boolean): true if "buyer will get new survey at buyer expense" — TREC §6C(2).
- survey_seller_new (boolean): true if "seller will pay for new survey" — TREC §6C(3).

§7.D PROPERTY CONDITION:
- as_is (boolean): Default true ("buyer accepts as-is"). Set false only if specific repairs required.
- as_is_with_repairs (boolean): true if specific repairs to be completed by seller before close.
- required_repairs (string): Specific repairs if as_is_with_repairs=true.
- service_contract_amount (number): Home warranty / residential service contract amount Seller pays. §7H.

§11 SPECIAL PROVISIONS:
- special_provisions (string): Factual special provisions text. (Brokers may not practice law — keep factual.)
- seller_concessions (number): Dollar amount Seller credits Buyer toward closing costs.

§22 ADDENDA — set true for each addendum that should be CHECKED:
- addendum_financing (boolean): Auto-true if loan_amount > 0.
- addendum_hoa (boolean): Auto-true if hoa_name or hoa_monthly_dues > 0.
- addendum_lead_paint (boolean): Auto-true if property_built_year < 1978.
- addendum_sellers_disclosure (boolean): true if Seller's Disclosure addendum used.

HOA (also fills 36-11 HOA addendum):
- hoa_exists (boolean): true if Cibolo Canyons / HOA / dues / mandatory membership mentioned. Default false ONLY if explicitly stated "no HOA".
- hoa_name (string): HOA name if stated.
- hoa_monthly_dues (number): Monthly HOA dues if stated.
- hoa_transfer_fee (number): Transfer fee at closing if stated.

LEAD PAINT (also fills OP-L):
- property_built_year (number): Year built. Required if pre-1978 → triggers lead paint addendum.

BROKER SECTION (§8):
- listing_broker_firm (string): Seller's agent firm. Example: "Phyllis Browning Company"
- listing_broker_address (string): Brokerage office address if stated. Example: "Boerne office"
- listing_agent_name (string): Seller's agent name. Example: "Bizzy Darling"
- listing_agent_license (string): Seller's agent license number.
- other_broker_firm (string): Buyer's agent firm. (If agent represents self, leave blank.)
- selling_agent_name (string): Buyer's agent name (other broker associate).
- buyer_only_agent (boolean): true if buyer's agent represents BUYER only.
- listing_only_seller_agent (boolean): true if listing agent represents SELLER only.
- buyer_agent_commission_pct (number): Buyer's agent commission % if stated. Example: 3
- seller_agent_commission_pct (number): Listing agent commission % if stated.

POSSESSION:
- possession (string): "closing" (default), "lease_after", "lease_before". §10.

EFFECTIVE / EXECUTION:
- contract_effective_date (string): ISO date YYYY-MM-DD. Defaults to today if not stated.
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
  'hoa-addendum': `
Extract these fields for the TREC 36 Addendum for Property Subject to Mandatory Membership in HOA.
Return ONLY fields that are present or can be inferred.

Fields to extract:
- property_address (string): Street address.
- city_state_zip (string): City, state, zip.
- buyer_name (string): Buyer's full name.
- seller_name (string): Seller's full name.
- hoa_name (string): Name of the HOA. Required.
- hoa_phone (string): HOA phone number if stated.
- hoa_management_company (string): HOA management company name if stated.
- hoa_monthly_dues (number): Monthly HOA dues amount if stated.
- hoa_transfer_fee (number): Transfer fee amount if stated.
- hoa_resale_cert_required (boolean): Whether resale certificate is required.
`,
  'lead-paint-addendum': `
Extract these fields for the OP-L Addendum for Sellers Disclosure of Information on Lead-Based Paint.
Return ONLY fields that are present or can be inferred.

Fields to extract:
- property_address (string): Street address.
- city_state_zip (string): City, state, zip.
- buyer_name (string): Buyer's full name.
- seller_name (string): Seller's full name.
- property_built_year (number): Year property was built. Critical for lead paint determination.
- seller_disclosure_choice (string): "no_knowledge" (default), "disclosed_hazards", or "not_disclosed".
- buyer_acknowledgment (boolean): Whether buyer acknowledges lead paint notice.
`,
};

// ---------------------------------------------------------------------------
// Canonical field names per form type (enforces strict JSON schema)
// ---------------------------------------------------------------------------
const CANONICAL_FIELDS = {
  'resale-contract': [
    'buyer_name', 'seller_name', 'property_address', 'city_state_zip', 'county',
    'legal_description', 'addition_name',
    'sale_price', 'earnest_money', 'option_fee', 'option_days',
    'loan_amount', 'down_payment_pct', 'down_payment_amt', 'closing_date', 'close_in_days',
    'title_company', 'escrow_officer', 'title_company_address',
    'financing_type', 'contract_effective_date',
    // §6.C survey options (exactly one)
    'survey_existing_or_seller_pays', 'survey_buyer_obtains', 'survey_seller_new',
    // §7.D property condition
    'as_is', 'as_is_with_repairs', 'required_repairs', 'service_contract_amount',
    // §11 special provisions
    'special_provisions', 'seller_concessions',
    // §22 addenda
    'addendum_financing', 'addendum_hoa', 'addendum_lead_paint', 'addendum_sellers_disclosure',
    // HOA
    'hoa_exists', 'hoa_name', 'hoa_monthly_dues', 'hoa_transfer_fee',
    // lead paint trigger
    'property_built_year',
    // broker section
    'listing_broker_firm', 'listing_broker_address',
    'listing_agent_name', 'listing_agent_license',
    'other_broker_firm', 'selling_agent_name',
    'buyer_only_agent', 'listing_only_seller_agent',
    'buyer_agent_commission_pct', 'seller_agent_commission_pct',
    // possession
    'possession',
  ],
  'financing-addendum': [
    'property_address', 'city_state_zip', 'buyer_name', 'financing_type',
    'loan_amount', 'down_payment_pct', 'interest_rate_max', 'loan_term_years'
  ],
  'termination-notice': [
    'property_address', 'city_state_zip', 'seller_name', 'buyer_name',
    'contract_effective_date', 'termination_reason'
  ],
  'unimproved-property': [
    'buyer_name', 'seller_name', 'property_address', 'city_state_zip', 'county',
    'legal_description', 'land_acreage', 'land_parcel_id', 'sale_price', 'earnest_money',
    'option_fee', 'option_days', 'loan_amount', 'down_payment_pct', 'down_payment_amt',
    'closing_date', 'title_company', 'financing_type', 'contract_effective_date'
  ],
  'new-home-incomplete': [
    'buyer_name', 'seller_name', 'property_address', 'city_state_zip', 'county',
    'legal_description', 'sale_price', 'earnest_money', 'option_fee', 'option_days',
    'loan_amount', 'down_payment_pct', 'down_payment_amt', 'closing_date', 'title_company',
    'financing_type', 'builder_name', 'builder_rep_name', 'builder_rep_phone',
    'expected_completion_date', 'contract_effective_date'
  ],
  'new-home-complete': [
    'buyer_name', 'seller_name', 'property_address', 'city_state_zip', 'county',
    'legal_description', 'sale_price', 'earnest_money', 'option_fee', 'option_days',
    'loan_amount', 'down_payment_pct', 'down_payment_amt', 'closing_date', 'title_company',
    'financing_type', 'builder_name', 'builder_rep_name', 'builder_rep_phone',
    'builder_warranty_company', 'co_received_date', 'co_number', 'contract_effective_date'
  ],
  'hoa-addendum': [
    'property_address', 'city_state_zip', 'buyer_name', 'seller_name',
    'hoa_name', 'hoa_phone', 'hoa_management_company', 'hoa_monthly_dues',
    'hoa_transfer_fee', 'hoa_resale_cert_required'
  ],
  'lead-paint-addendum': [
    'property_address', 'city_state_zip', 'buyer_name', 'seller_name',
    'property_built_year', 'seller_disclosure_choice', 'buyer_acknowledgment'
  ],
  'farm-ranch': [
    'buyer_name', 'seller_name', 'property_address', 'city_state_zip', 'county',
    'legal_description', 'land_acreage', 'land_parcel_id', 'sale_price', 'earnest_money',
    'option_fee', 'option_days', 'loan_amount', 'down_payment_pct', 'down_payment_amt',
    'closing_date', 'title_company', 'financing_type', 'contract_effective_date'
  ]
};

// Common field name variations model might return (maps to canonical names)
const FIELD_NAME_ALIASES = {
  'price': 'sale_price',
  'purchase_price': 'sale_price',
  'contract_price': 'sale_price',
  'amount': 'sale_price',
  'down_payment_percent': 'down_payment_pct',
  'down_payment_percentage': 'down_payment_pct',
  'down_pct': 'down_payment_pct',
  'down_percent': 'down_payment_pct',
  'down_payment_amount': 'down_payment_amt',
  'down_amount': 'down_payment_amt',
  'down_payment_dollars': 'down_payment_amt',
  'down_dollars': 'down_payment_amt',
  'address': 'property_address',
  'property': 'property_address',
  'street_address': 'property_address',
  'location': 'property_address',
  'buyer': 'buyer_name',
  'buyer_names': 'buyer_name',
  'sellers': 'seller_name',
  'seller_names': 'seller_name',
  'city_state': 'city_state_zip',
  'city': 'city_state_zip',
  'financing': 'financing_type',
  'loan_type': 'financing_type',
  'loan': 'financing_type',
  'principal': 'loan_amount',
  'loan_principal': 'loan_amount',
  'mortgage_amount': 'loan_amount',
  'option_period': 'option_days',
  'days_option': 'option_days',
  'option_period_days': 'option_days',
  'earnest': 'earnest_money',
  'earnest_money_amount': 'earnest_money',
  'em_amount': 'earnest_money',
  'em': 'earnest_money',
  'close_date': 'closing_date',
  'closing': 'closing_date',
  'close': 'closing_date',
  'settlement_date': 'closing_date',
  'contract_date': 'contract_effective_date',
  'effective_date': 'contract_effective_date',
  'execution_date': 'contract_effective_date'
};

// Normalize field names from model output
function normalizeFields(raw) {
  const normalized = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;

    // Try direct match first, then aliases
    let canonical = key;
    if (FIELD_NAME_ALIASES[key.toLowerCase()]) {
      canonical = FIELD_NAME_ALIASES[key.toLowerCase()];
    }

    normalized[canonical] = value;
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Extract fields via Claude Haiku with strict schema enforcement
// ---------------------------------------------------------------------------
async function extractFieldsWithAI(formType, message, transaction) {
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const schema = FIELD_SCHEMAS[formType] || FIELD_SCHEMAS['resale-contract'];
  const canonicalFields = CANONICAL_FIELDS[formType] || CANONICAL_FIELDS['resale-contract'];

  // Build context from existing transaction record
  const txContext = transaction && typeof transaction === 'object'
    ? `Existing transaction data (use as defaults, agent's message overrides):\n${JSON.stringify(transaction, null, 2)}`
    : 'No existing transaction data.';

  const today = new Date().toISOString().slice(0, 10);

  // Create strict schema template with all canonical field names
  const strictSchema = `\`\`\`json
{
  ${canonicalFields.map(f => `"${f}": null`).join(',\n  ')}
}
\`\`\``;

  // Determine agent role for disambiguation
  const agentRole = transaction?.agent_role || null;
  const roleContext = agentRole
    ? `The agent represents the ${agentRole === 'seller' ? 'SELLER' : 'BUYER'} side.`
    : "The agent's role is not specified; treat as BUYER unless message clearly indicates seller-side language.";

  const systemPrompt = `You are a Texas real estate transaction coordinator extracting structured data from an agent's message to fill out a TREC form.

Today's date: ${today}

${schema}

CRITICAL DISAMBIGUATION RULE (read carefully):
${roleContext}

When extracting buyer_name and seller_name:
- The PARTY THE AGENT REPRESENTS is determined by their role above.
- If agent_role is BUYER:
  * The buyer is typically named with: "for", "buying", "purchasing", "buyer is", "client", "my buyer", "the buyers"
  * The seller is the OTHER party (typically named with "from", "owned by", "listed by", etc.)
- If agent_role is SELLER:
  * The seller is the party the agent represents (usually not explicitly named, defaults to agent context)
  * The buyer is the offeror (typically named with "from", "offer from", "buyer is", "they're buying")
- If role is unclear: assume BUYER, which is the most common case for "make an offer" statements.

CRITICAL: You MUST return ONLY valid JSON matching this exact structure (include only fields with values):
${strictSchema}

Rules:
- Return ONLY the JSON object shown above — no markdown, no explanation, no code fences
- Use ONLY the field names shown in the template above
- Numbers must be actual numbers (not strings) for numeric fields
- Dates must be ISO format YYYY-MM-DD
- If a field cannot be determined, omit it entirely (do not include null values)
- If "close in 30 days" → calculate closing_date from today
- If "3.5% down" on a $300k purchase → down_payment_amt = 10500, loan_amount = 289500
- If "conventional loan" → financing_type = "conventional"
- Never fabricate values not present in the message or transaction context
- Do NOT nest any fields — return a flat JSON object`;

  const userPrompt = `${txContext}

Agent's message: "${message}"

Extract the form fields. Use ONLY field names from the template above.`;

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

  // Normalize any field names the model might have invented
  const normalized = normalizeFields(parsed);

  return normalized;
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

  // Auto-detect HOA from message context (Cibolo Canyons, mandatory membership, dues mentioned)
  if (fv.hoa_exists === undefined || fv.hoa_exists === null) {
    if (fv.hoa_name || fv.hoa_monthly_dues || fv.hoa_transfer_fee) {
      fv.hoa_exists = true;
    } else {
      const msg = String(message || '').toLowerCase();
      if (/\bhoa\b|homeowners?\s+association|mandatory\s+membership|cibolo\s+canyons/i.test(msg)) {
        fv.hoa_exists = true;
      } else {
        fv.hoa_exists = false;
      }
    }
  }

  // Auto-derive addendum flags for §22 checkboxes on TREC 20-18
  if (fv.addendum_financing === undefined) {
    fv.addendum_financing = !!(fv.loan_amount && Number(fv.loan_amount) > 0);
  }
  if (fv.addendum_hoa === undefined) {
    fv.addendum_hoa = !!fv.hoa_exists;
  }
  if (fv.addendum_lead_paint === undefined) {
    fv.addendum_lead_paint = !!(fv.property_built_year && Number(fv.property_built_year) < 1978);
  }

  // Default contract_effective_date = today if not set
  if (!fv.contract_effective_date) {
    fv.contract_effective_date = today.toISOString().slice(0, 10);
  }

  // Default §7.D As-Is = true unless repairs explicitly stated
  if (fv.as_is === undefined && fv.as_is_with_repairs !== true) {
    fv.as_is = true;
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
