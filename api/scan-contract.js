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
const IDENTIFY_MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 4096;
const MAX_PDF_BYTES = 32 * 1024 * 1024; // 32MB Anthropic doc limit

// =============================================================================
// DOCUMENT IDENTIFICATION + COMPLIANCE AUDITING
// =============================================================================

const IDENTIFY_PROMPT = `You are a Texas real estate document expert. Identify this document type precisely using the TREC form number, title, and key distinguishing features.

Return ONLY a JSON object with no markdown:
{
  "documentType": "<type>",
  "confidence": <0-1>,
  "reasoning": "<one sentence explaining what you saw that led to this identification>"
}

Document types and their KEY IDENTIFIERS:
- "trec-20-17": Title says "ONE TO FOUR FAMILY RESIDENTIAL CONTRACT" or "TREC NO. 20-18". Has paragraphs numbered 1-23. Has sales price, earnest money, option fee.
- "trec-financing-addendum": Title says "THIRD PARTY FINANCING ADDENDUM". TREC NO. 40-11. Has checkboxes for Conventional/FHA/VA/USDA financing types.
- "trec-hoa-addendum": Title says "ADDENDUM FOR PROPERTY SUBJECT TO MANDATORY MEMBERSHIP IN A PROPERTY OWNERS ASSOCIATION". TREC NO. 36-x.
- "trec-lead-paint": Title says "ADDENDUM FOR SELLER'S DISCLOSURE OF INFORMATION ON LEAD-BASED PAINT". Federal law form. Specifically about lead paint hazards only.
- "trec-sellers-disclosure": Title says "SELLER'S DISCLOSURE NOTICE" or "OP-H". Asks about foundation, roof, plumbing, electrical, appliances, neighborhood conditions. THIS IS NOT THE LEAD PAINT FORM even though it may mention lead paint in one question.
- "trec-buyer-representation": Title says "BUYER REPRESENTATION AGREEMENT" TAR 1501. Agent represents buyer.
- "trec-listing-agreement": Title says "RESIDENTIAL REAL ESTATE LISTING AGREEMENT" or "EXCLUSIVE RIGHT TO SELL". TAR 1101. Agent represents seller/listing side.
- "pre-approval-letter": Letter from a lender or bank stating buyer is pre-approved for a loan amount. Not a TREC form.
- "title-commitment": Title says "COMMITMENT FOR TITLE INSURANCE" or "TITLE COMMITMENT". From a title company.
- "survey": Shows a property plat, boundary lines, measurements. Created by a licensed surveyor.
- "inspection-report": Created by a home inspector. Lists property defects, conditions, recommendations.
- "hoa-docs": Package of HOA rules, bylaws, financials, resale certificate from a homeowners association.
- "closing-disclosure": Title says "CLOSING DISCLOSURE". Three-page federal form showing final loan terms and closing costs.
- "wire-instructions": Shows bank routing number, account number for wire transfer of funds.
- "cma": Comparative Market Analysis showing comparable property sales.
- "other": Anything that does not clearly match the above.

CRITICAL DISAMBIGUATION RULES:
1. trec-sellers-disclosure vs trec-lead-paint: If the form mentions foundation, roof, plumbing, electrical — it is trec-sellers-disclosure. If the form ONLY discusses lead paint hazards and has federal law language — it is trec-lead-paint.
2. trec-buyer-representation vs trec-listing-agreement: Buyer representation protects the buyer. Listing agreement gives agent the right to sell the property.
3. If confidence is below 0.85, set documentType to "other" and explain in reasoning.`;

const DOCUMENT_LABELS = {
  'trec-20-17': 'TREC One to Four Family Residential Contract',
  'trec-financing-addendum': 'Third Party Financing Addendum',
  'trec-hoa-addendum': 'HOA Addendum',
  'trec-lead-paint': 'Lead Based Paint Disclosure',
  'trec-sellers-disclosure': "Seller's Disclosure Notice",
  'trec-buyer-representation': 'Buyer Representation Agreement',
  'trec-listing-agreement': 'Listing Agreement',
  'pre-approval-letter': 'Pre-Approval Letter',
  'title-commitment': 'Title Commitment',
  'survey': 'Property Survey',
  'inspection-report': 'Inspection Report',
  'hoa-docs': 'HOA Documents',
  'closing-disclosure': 'Closing Disclosure',
  'wire-instructions': 'Wire Instructions',
  'cma': 'Comparative Market Analysis',
  'other': 'Document',
};

const COMPLIANCE_PROMPTS = {
  'trec-20-17': `You are an expert Texas real estate transaction coordinator auditing a TREC One to Four Family Residential Contract (TREC 20-17) for compliance.

IMPORTANT — ELECTRONIC SIGNATURES:
This contract may have been signed via DocuSign or other electronic signature platforms. Electronic signatures are legally valid under ESIGN and UETA. When checking for signatures and initials, look for:
- DocuSign signature blocks (showing signer name, date, and time like "4/8/2026 | 10:44 PDT")
- DocuSign initial blocks (showing initials like "KP" in a box)
- Any electronic signature indicator including timestamps, signer names, or digital signature marks
- "Initialed for identification by Buyer [initials]" line at the bottom of each page with any mark or electronic initial present

DO NOT flag a signature or initial as missing if there is a DocuSign block, timestamp, or any electronic signature indicator present for that party.

DOCUSIGN DETECTION:
If the document header contains "DocuSign Envelope ID:" this is a DocuSign-executed document. In DocuSign contracts:
- Electronic initials appear as small text initials (like "KP", "MS") in boxes at the bottom of pages — these ARE valid initials, count them as present
- The "Initialed for identification by Buyer [initials]" line with ANY text or mark counts as initialed
- DocuSign signature blocks showing the signer's name and a timestamp are valid signatures
- If you see "DocuSign Envelope ID:" at the top of the document, assume all parties who appear in the signature/initial blocks have properly executed their portions electronically unless a block is completely blank with no name or timestamp

For DocuSign documents, only flag missing signatures/initials if a signature block is completely empty with no name, no timestamp, and no electronic mark of any kind.

BROKER INFO BLOCK (Page 10):
The broker information block says "Print name(s) only. Do not sign" — agents are NOT supposed to sign this block. Printed names are correct and compliant. Do NOT flag missing signatures on the broker info block.

OPTION DAYS:
Look carefully at Paragraph 5B for the termination option period. It may show a number written in words or digits. Common values are 5, 7, 10 days. Do not flag as blank if any number is present.

REQUIRED SIGNATURES AND INITIALS — check each one:
- Buyer signature(s) on signature page
- Seller signature(s) on signature page
- Buyer initials on EVERY page that has an initials line
- Seller initials on EVERY page that has an initials line
- All signature dates filled in

REQUIRED FIELDS — check each one:
- Buyer name(s) filled in (Paragraph 1)
- Seller name(s) filled in (Paragraph 1)
- Property address filled in (Paragraph 2)
- Legal description filled in (Paragraph 2)
- Sales price filled in (Paragraph 3)
- Earnest money amount filled in (Paragraph 5)
- Earnest money holder filled in (Paragraph 5)
- Option fee amount filled in (Paragraph 23)
- Option days filled in (Paragraph 23)
- Closing date filled in (Paragraph 9)
- Title company filled in (Paragraph 6)
- All checked addenda boxes have corresponding addenda attached

ADDENDA VERIFICATION:
- List every checkbox checked in Paragraph 22
- For each checked box, note whether the corresponding addendum appears to be attached

Return a JSON compliance report:
{
  "passed": true/false,
  "missingSignatures": ["description of each missing signature"],
  "missingInitials": ["page X - buyer initials missing", etc],
  "blankRequiredFields": ["field name", etc],
  "checkedAddenda": ["list of all checked addenda"],
  "missingAddenda": ["addenda checked but not found attached"],
  "warnings": ["any other issues"],
  "summary": "Plain English summary of what needs to be fixed"
}`,

  'trec-financing-addendum': `You are a Texas TC auditing a Third Party Financing Addendum for compliance.

REQUIRED:
- Buyer initials
- Seller initials
- Loan type checked (Conventional/FHA/VA/USDA/Other)
- Loan amount filled in
- Financing days filled in
- Interest rate or "prevailing rate" noted

Extract also:
- lender_name (if specified)
- loan_amount
- loan_type
- financing_days
- interest_rate

Return compliance JSON:
{
  "passed": true/false,
  "missingSignatures": [],
  "blankRequiredFields": [],
  "extractedFields": { "lenderName": "", "loanAmount": 0, "loanType": "", "financingDays": 0 },
  "warnings": [],
  "summary": ""
}`,

  'trec-hoa-addendum': `You are a Texas TC auditing an HOA Addendum (TREC 36-x) for compliance.

REQUIRED:
- Buyer initials
- Seller initials
- HOA name filled in
- Assessment amounts filled in
- HOA document delivery period filled in

Extract also:
- hoa_name
- hoa_phone
- hoa_management_company
- hoa_assessment_amount
- hoa_document_deadline_days

Return compliance JSON:
{
  "passed": true/false,
  "missingSignatures": [],
  "blankRequiredFields": [],
  "extractedFields": { "hoaName": "", "hoaPhone": "", "hoaManagementCompany": "", "hoaDocumentDeadlineDays": 0 },
  "warnings": [],
  "summary": ""
}`,

  'trec-lead-paint': `You are a Texas TC auditing a Lead Based Paint Disclosure for compliance.

REQUIRED (for pre-1978 homes):
- Buyer signature and date
- Seller signature and date
- Both agents signatures and dates
- Buyer acknowledgment checkbox checked
- Seller disclosure section completed
- Agent acknowledgment checked

Return compliance JSON:
{
  "passed": true/false,
  "missingSignatures": [],
  "blankRequiredFields": [],
  "warnings": [],
  "summary": ""
}`,

  'trec-sellers-disclosure': `You are a Texas TC auditing a Seller's Disclosure Notice (TREC OP-H) for compliance.

IMPORTANT: This is NOT a lead paint disclosure. This is about property condition.

REQUIRED:
- Seller signature and date on final page
- All sections answered — not left blank
- Foundation, roof, plumbing, electrical sections completed

Return compliance JSON:
{
  "passed": true/false,
  "missingSignatures": [],
  "blankRequiredFields": [],
  "warnings": [],
  "summary": ""
}`,

  'pre-approval-letter': `You are a Texas TC reviewing a mortgage pre-approval letter.

Extract these fields:
- lender_name (bank or mortgage company name)
- loan_officer_name
- loan_officer_email
- loan_officer_phone
- loan_amount (pre-approved amount)
- loan_type (Conventional/FHA/VA/etc)
- expiration_date (when pre-approval expires)
- buyer_name (who the letter is for)

Return JSON:
{
  "passed": true,
  "extractedFields": { "lenderName": "", "loanOfficerName": "", "loanOfficerEmail": "", "loanOfficerPhone": "", "loanAmount": 0, "loanType": "", "expirationDate": "", "buyerName": "" },
  "warnings": [],
  "summary": ""
}`,

  'trec-listing-agreement': `You are a Texas TC reviewing a Listing Agreement (TAR 1101 or similar).

Extract these fields:
- seller_name (property owner/client name)
- seller_email
- seller_phone
- property_address
- city_state_zip
- list_price
- listing_start_date
- listing_end_date (expiration date)
- agent_name (listing agent)
- agent_email
- agent_phone
- brokerage_name
- commission_rate

REQUIRED signatures:
- Seller signature and date
- Listing agent signature and date
- Broker signature if required

Return compliance JSON:
{
  "passed": true/false,
  "missingSignatures": [],
  "blankRequiredFields": [],
  "extractedFields": {
    "sellerName": "",
    "sellerEmail": "",
    "sellerPhone": "",
    "propertyAddress": "",
    "cityStateZip": "",
    "listPrice": 0,
    "listingStartDate": "",
    "listingEndDate": "",
    "agentName": "",
    "agentEmail": "",
    "agentPhone": "",
    "brokerageName": "",
    "commissionRate": ""
  },
  "warnings": [],
  "summary": ""
}`,

  'trec-buyer-representation': `You are a Texas TC auditing a Buyer Representation Agreement for compliance.

REQUIRED:
- Buyer signature and date
- Agent signature and date
- Broker name filled in
- Commission terms filled in
- Representation period dates filled in

Return compliance JSON:
{
  "passed": true/false,
  "missingSignatures": [],
  "blankRequiredFields": [],
  "warnings": [],
  "summary": ""
}`,

  'other': `You are a Texas TC reviewing a real estate document. Extract any relevant fields you can find including names, dates, addresses, amounts, and contact information. Note the document type and purpose.

Return JSON:
{
  "passed": true,
  "documentDescription": "description of what this document is",
  "extractedFields": {},
  "warnings": [],
  "summary": "brief description of document contents"
}`,
};

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

EXTENDED FIELDS (top-level, look across the whole contract + any attached addenda):
- titleCompany, titleOfficerName, titleOfficerEmail, titleOfficerPhone — the title company (Paragraph 6A) plus the named escrow / closing officer if listed (sometimes appears in 6A, in the title commitment block, or in special provisions). Email/phone are uncommon on TREC 20-17 itself but capture them when present.
- lenderName, loanOfficerName, loanOfficerEmail, loanOfficerPhone — institution name and individual loan officer. Often blank on the contract; pull from the Third Party Financing Addendum if attached. Otherwise null.
- hoaName, hoaManagementCompany — populated from the HOA Addendum (TREC 36-x) if attached: hoaName is the association name, hoaManagementCompany is the management company / agent that fulfills resale certificates. Both null when no HOA addendum.
- mlsNumber, bedrooms, bathrooms, sqft, yearBuilt — TREC 20-17 itself does NOT carry these. Only populate if you see them written into Paragraph 11 Special Provisions or a side note. Otherwise null.
- possessionDate — YYYY-MM-DD when Paragraph 9.B specifies a specific date; mirror Paragraph 9.B possession.specificDate into the top-level possessionDate. Null when possession is "upon closing" / "upon funding".
- appraisalDeadline — date by which appraisal/lender's right-to-terminate notice must be delivered, derived from the Right-to-Terminate-Due-to-Lender's-Appraisal addendum (effective date + appraisalTerminationDays) when present. Null otherwise.
- surveyDeadline — date by which seller must deliver an existing survey or buyer must obtain one. Sometimes specified in Paragraph 6C ("Survey"); typically a number of days after effective date. Convert to YYYY-MM-DD if both effective date and the day count are known. Null otherwise.
- hoaDocumentDeadline — date by which HOA resale certificate / subdivision documents must be delivered, from the HOA Addendum. Null when no HOA addendum.
- loanApprovalDeadline — date the buyer's third-party financing approval must be obtained, derived from effective date + financingDays when both are known. Null otherwise.

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
    "titleOfficer": string | null,               // legacy: escrow officer if listed, mirror of titleOfficerName
    "titleOfficerName": string | null,           // named escrow / closing officer
    "titleOfficerEmail": string | null,
    "titleOfficerPhone": string | null,
    "lenderName": string | null,                 // institution / lender name (Third Party Financing Addendum)
    "loanOfficerName": string | null,
    "loanOfficerEmail": string | null,
    "loanOfficerPhone": string | null,
    "hoaName": string | null,                    // from HOA Addendum (TREC 36-x)
    "hoaManagementCompany": string | null,       // management agent that fulfills resale certs
    "mlsNumber": string | null,                  // rarely on TREC 20-17 — only when written in
    "bedrooms": number | null,
    "bathrooms": number | null,
    "sqft": number | null,
    "yearBuilt": number | null,
    "possessionDate": string | null,             // YYYY-MM-DD; mirror of possession.specificDate
    "appraisalDeadline": string | null,          // YYYY-MM-DD; effective + appraisalTerminationDays
    "surveyDeadline": string | null,             // YYYY-MM-DD if computable from 6C
    "hoaDocumentDeadline": string | null,        // YYYY-MM-DD from HOA addendum
    "loanApprovalDeadline": string | null,       // YYYY-MM-DD; effective + financingDays
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
    "titleOfficerName": number,
    "titleOfficerEmail": number,
    "titleOfficerPhone": number,
    "lenderName": number,
    "loanOfficerName": number,
    "loanOfficerEmail": number,
    "loanOfficerPhone": number,
    "hoaName": number,
    "hoaManagementCompany": number,
    "mlsNumber": number,
    "bedrooms": number,
    "bathrooms": number,
    "sqft": number,
    "yearBuilt": number,
    "possessionDate": number,
    "appraisalDeadline": number,
    "surveyDeadline": number,
    "hoaDocumentDeadline": number,
    "loanApprovalDeadline": number,
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
      titleOfficerName: null,
      titleOfficerEmail: null,
      titleOfficerPhone: null,
      lenderName: null,
      loanOfficerName: null,
      loanOfficerEmail: null,
      loanOfficerPhone: null,
      hoaName: null,
      hoaManagementCompany: null,
      mlsNumber: null,
      bedrooms: null,
      bathrooms: null,
      sqft: null,
      yearBuilt: null,
      possessionDate: null,
      appraisalDeadline: null,
      surveyDeadline: null,
      hoaDocumentDeadline: null,
      loanApprovalDeadline: null,
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

  // Cross-field mirrors for the extended schema. Each rule fires only when the
  // target is empty, so a directly-extracted value always wins.
  if (!extracted.titleOfficerName && typeof extracted.titleOfficer === 'string' && extracted.titleOfficer.trim()) {
    extracted.titleOfficerName = extracted.titleOfficer;
  }
  if (!extracted.possessionDate && extracted.possession && extracted.possession.specificDate) {
    extracted.possessionDate = extracted.possession.specificDate;
  }
  if (!extracted.lenderName && extracted.parties && typeof extracted.parties.lender === 'string' && extracted.parties.lender.trim()) {
    extracted.lenderName = extracted.parties.lender;
  }
  const addDays = (isoDate, days) => {
    if (!isoDate || typeof days !== 'number' || !Number.isFinite(days)) return null;
    const t = new Date(isoDate);
    if (Number.isNaN(t.getTime())) return null;
    t.setUTCDate(t.getUTCDate() + days);
    return t.toISOString().slice(0, 10);
  };
  if (!extracted.loanApprovalDeadline) {
    const calc = addDays(extracted.contractEffectiveDate, extracted.financingDays);
    if (calc) extracted.loanApprovalDeadline = calc;
  }
  if (!extracted.appraisalDeadline) {
    const calc = addDays(extracted.contractEffectiveDate, extracted.addenda.appraisalTerminationDays);
    if (calc) extracted.appraisalDeadline = calc;
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

async function identifyDocument(pdfBase64) {
  const response = await anthropic.messages.create({
    model: IDENTIFY_MODEL,
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: IDENTIFY_PROMPT },
      ],
    }],
  });
  const textBlock = (response.content || []).find((b) => b.type === 'text');
  const parsed = safeParseJson(textBlock ? textBlock.text : '') || {};
  const rawType = typeof parsed.documentType === 'string' ? parsed.documentType : 'other';
  const documentType = DOCUMENT_LABELS[rawType] ? rawType : 'other';
  return {
    documentType,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
  };
}

function emptyComplianceReport(docLabel) {
  return {
    passed: false,
    missingSignatures: [],
    missingInitials: [],
    blankRequiredFields: [],
    checkedAddenda: [],
    missingAddenda: [],
    extractedFields: {},
    warnings: [`Compliance check for ${docLabel} could not be parsed.`],
    summary: 'Unable to complete compliance check — please review the document manually.',
    documentDescription: null,
  };
}

async function auditCompliance(pdfBase64, documentType) {
  const prompt = COMPLIANCE_PROMPTS[documentType] || COMPLIANCE_PROMPTS.other;
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: prompt },
      ],
    }],
  });
  const textBlock = (response.content || []).find((b) => b.type === 'text');
  const parsed = safeParseJson(textBlock ? textBlock.text : '');
  if (!parsed || typeof parsed !== 'object') {
    return emptyComplianceReport(DOCUMENT_LABELS[documentType] || 'document');
  }
  const arr = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []);
  return {
    passed: parsed.passed === true,
    missingSignatures: arr(parsed.missingSignatures),
    missingInitials: arr(parsed.missingInitials),
    blankRequiredFields: arr(parsed.blankRequiredFields),
    checkedAddenda: arr(parsed.checkedAddenda),
    missingAddenda: arr(parsed.missingAddenda),
    extractedFields: (parsed.extractedFields && typeof parsed.extractedFields === 'object') ? parsed.extractedFields : {},
    warnings: arr(parsed.warnings),
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    documentDescription: typeof parsed.documentDescription === 'string' ? parsed.documentDescription : null,
  };
}

async function runFullScan(pdfBase64) {
  validatePdfBase64(pdfBase64);

  // Stage 1: identify document type (cheap Haiku call).
  const ident = await identifyDocument(pdfBase64);
  const documentType = ident.documentType;
  const documentLabel = DOCUMENT_LABELS[documentType] || 'Document';

  // Stage 2: run the doc-type-specific compliance audit.
  const complianceReport = await auditCompliance(pdfBase64, documentType);

  // Stage 3: for TREC 20-17, also run the full extraction pass to populate the
  // dossier form. Other types rely on the extractedFields embedded in the
  // compliance prompt's response.
  let trecExtraction = null;
  if (documentType === 'trec-20-17') {
    try {
      trecExtraction = await scanContract(pdfBase64);
    } catch (err) {
      console.error('[scan-contract] TREC extraction failed:', err && err.message);
    }
  }

  const extractedFields = trecExtraction
    ? trecExtraction.extracted
    : (complianceReport.extractedFields || {});

  return {
    documentType,
    documentLabel,
    documentTypeConfidence: ident.confidence,
    complianceReport,
    extractedFields,
    // Backwards-compat fields — only populated for TREC 20-17.
    extracted: trecExtraction ? trecExtraction.extracted : null,
    confidence: trecExtraction ? trecExtraction.confidence : {},
    warnings: trecExtraction ? trecExtraction.warnings : (complianceReport.warnings || []),
  };
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

    const result = await runFullScan(pdfBase64);
    return res.status(200).json({
      ok: true,
      documentType: result.documentType,
      documentLabel: result.documentLabel,
      documentTypeConfidence: result.documentTypeConfidence,
      complianceReport: result.complianceReport,
      extractedFields: result.extractedFields,
      // Legacy fields preserved for any client that hasn't been updated yet.
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
module.exports.runFullScan = runFullScan;
module.exports.identifyDocument = identifyDocument;
module.exports.auditCompliance = auditCompliance;
module.exports.DOCUMENT_LABELS = DOCUMENT_LABELS;
