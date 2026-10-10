// api/_lib/fill-form-required-fields.js
// Critical field lists per TREC form type.
// Used by GapWizard to detect incomplete PDFs after fill_forms.

const REQUIRED_FIELDS_BY_FORM_TYPE = {
  'resale-contract': [
    'sale_price',
    'closing_date',
    'option_days',
    'option_fee',
    'earnest_money',
    'financing_type',
    'title_policy_paid_by',
  ],
  // 2026-10-10 CARTER — TREC 40-11 Third Party Financing Addendum. Expanded
  // from the original 3 (loan_amount/down_payment_amt/financing_type) per
  // the 2026-10-10 classification audit (api/_lib/trec-40-11-field-map.js) —
  // 'rate'/'term' (loan_term_years, interest_rate_cap) and the two real
  // elections fillFinancingAddendum() wires are now in this list too, per
  // feedback_verify-contract-elections-before-execution.md (Pfeiffers Gate:
  // ¶7D shipped blank on a base contract, nobody caught it — every
  // "check one box only" election belongs in the required set). The ¶2.A
  // BUYER APPROVAL pair itself is NOT listed separately here — it's
  // computed automatically from financing_type (already required), not a
  // distinct fv field an agent fills in; buyer_approval_days (the ¶2.A
  // termination-days blank) and financing_other_waive_2b (G. Other
  // Financing's ¶2.B waiver pair) ARE distinct fv fields and are listed.
  'financing-addendum': [
    'loan_amount',
    'down_payment_amt',
    'financing_type',
    'loan_term_years',
    'interest_rate_cap',
    'buyer_approval_days',
    'financing_other_waive_2b',
  ],
  'unimproved-property': [
    'sale_price',
    'closing_date',
    'option_days',
    'option_fee',
    'earnest_money',
    'financing_type',
    'land_acreage',
  ],
  'farm-ranch': [
    'sale_price',
    'closing_date',
    'option_days',
    'option_fee',
    'earnest_money',
    'financing_type',
    'land_acreage',
  ],
  'new-home-incomplete': [
    'sale_price',
    'closing_date',
    'option_days',
    'option_fee',
    'earnest_money',
    'financing_type',
    'expected_completion_date',
  ],
  'new-home-complete': [
    'sale_price',
    'closing_date',
    'option_days',
    'option_fee',
    'earnest_money',
    'financing_type',
  ],
  // 2026-10-09 CARTER — TXR 1406 Seller's Disclosure Notice. Only the
  // derivable fields from api/_lib/txr-1406-field-map.js belong here —
  // property address (baked on every page) and the seller's own name
  // (printed-name widget on page 6). hoa_name/hoa_phone/hoa_management_company
  // are also derivable but genuinely optional (not every property has an
  // HOA). The ~250-item disclosure grid is the seller's own knowledge and
  // is answered live at signing — it is never a `transactions` column, so
  // it can never appear in this list (see getMustAskWidgetNames() instead).
  'sellers-disclosure': [
    'property_address',
    'city_state_zip',
    'seller_name',
  ],
  // 2026-10-10 CARTER — TREC 39-11 Amendment (rev 05-04-2026). Per
  // trec-executed-date-block-needs-a-field.md (omitted twice in 3 days on
  // live deals, deadlines run off it) the EXECUTED/final-acceptance date is
  // a REQUIRED field on this form, not decoration — now wired for real
  // (see fillAmendment()'s EXECUTED-block fix, api/fill-form.js). The
  // numbered-paragraph elections (sales price change, closing date change,
  // repairs, etc.) are each independently optional — which ones apply is
  // the agent's choice per deal, not a blanket requirement — so they are
  // NOT listed here; see api/_lib/trec-amendment-39-11-field-map.js /
  // trec-amendment-39-11-field-classification.json for the full must_ask
  // inventory of every election widget on the form.
  'amendment': [
    'property_address',
    'city_state_zip',
    'date_of_final_acceptance',
  ],
};

/**
 * Get required fields for a given form type.
 * Returns array of snake_case field names that must be non-empty for the filled PDF.
 */
function getRequiredFieldsForFormType(formType) {
  return REQUIRED_FIELDS_BY_FORM_TYPE[formType] || [];
}

/**
 * Check which required fields are missing from the transaction record.
 * Returns array of missing field names.
 */
function getMissingRequiredFields(formType, transaction) {
  const required = getRequiredFieldsForFormType(formType);
  const missing = [];

  for (const field of required) {
    const value = transaction[field];
    // Field is missing if null, undefined, empty string, 0, or false
    // (0 is a valid value for numeric fields, so don't count it as missing)
    if (
      value === null ||
      value === undefined ||
      value === '' ||
      (typeof value === 'boolean' && !value)
    ) {
      missing.push(field);
    }
  }

  return missing;
}

/**
 * Convert snake_case field name to a human-readable prompt.
 */
function fieldNameToPrompt(fieldName) {
  const prompts = {
    sale_price: "Sale price",
    closing_date: "Closing date",
    option_days: "Number of option period days",
    option_fee: "Option fee amount",
    earnest_money: "Earnest money amount",
    financing_type: "Type of financing (cash, conventional, FHA, VA, USDA)",
    title_policy_paid_by: "Who pays for the title policy (buyer or seller)",
    loan_amount: "Loan amount",
    down_payment_amt: "Down payment amount",
    land_acreage: "Land acreage",
    expected_completion_date: "Expected completion date",
    loan_term_years: "Loan term (years)",
    interest_rate_cap: "Interest rate cap (%)",
    buyer_approval_days: "¶2.A days to terminate if Buyer Approval not obtained",
    financing_other_waive_2b: "G. Other Financing — does Buyer waive ¶2.B Property Approval?",
    date_of_final_acceptance: "EXECUTED / date of final acceptance",
  };

  return prompts[fieldName] || fieldName.replace(/_/g, ' ');
}

module.exports = {
  REQUIRED_FIELDS_BY_FORM_TYPE,
  getRequiredFieldsForFormType,
  getMissingRequiredFields,
  fieldNameToPrompt,
};
