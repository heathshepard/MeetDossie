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
  'financing-addendum': [
    'loan_amount',
    'down_payment_amt',
    'financing_type',
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
  };

  return prompts[fieldName] || fieldName.replace(/_/g, ' ');
}

module.exports = {
  REQUIRED_FIELDS_BY_FORM_TYPE,
  getRequiredFieldsForFormType,
  getMissingRequiredFields,
  fieldNameToPrompt,
};
