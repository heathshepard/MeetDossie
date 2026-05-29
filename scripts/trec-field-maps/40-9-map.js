// trec-field-maps/40-9-map.js
// AcroForm field map for TREC 40-9 Third Party Financing Addendum
// 64 fields discovered via probe-trec-forms.js
// Source: C:\Users\Heath Shepard\Desktop\dossie\Dossie Forms\TREC Base\Third-Party-Financing-Addendum-TREC-40.pdf

module.exports = {
  // Header
  property_address:  'Street Address and City',
  buyer_name:        'Initialed for identification by Buyer',  // buyer initials header
  address_of_property: 'Address of Property',                  // footer address

  // Loan type (use CHECKBOXES below)
  // First mortgage loan amount
  loan_amount_first: 'any financed PMI premium due in full in 1',  // principal amount of first mortgage

  // Conventional loan fields
  conventional_rate_max:  'years with interest not to exceed',     // max interest rate
  conventional_years:     'per annum for the first',               // loan term (years)
  conventional_origination: 'shown on Buyers Loan Estimate for the loan not to exceed', // origination charges

  // Property address on last page
  property_full:     'Street Address and City',
};

// Checkboxes - use form.getCheckBox(name).check()
module.exports.CHECKBOXES = {
  // Loan type
  conventional:      '1 Conventional Financing',
  texas_vet:         '2 Texas Veterans Loan A loans from the Texas Veterans Land Board of',
  fha:               '3 FHA Insured Financing A Section',
  va:                '4 VA Guaranteed Financing A VA guaranteed loan of not less than',
  usda:              '5 USDA Guaranteed Financing A USDAguaranteed loan of not less than',
  reverse_mortgage:  '6 Reverse Mortgage Financing A reverse mortgage loan also known as a Home Equity',

  // Mortgage structure
  first_mortgage:    'a A first mortgage loan in the principal amount of',
  second_mortgage:   'b A second mortgage loan in the principal amount of',

  // Buyer approval contingency
  buyer_approval:    'This contract is subject to Buyer obtaining Buyer Approval If Buyer cannot obtain Buyer',

  // PMI credit
  pmi_will:          'will',
  pmi_will_not:      'will not be an FHA insured loan',
};
