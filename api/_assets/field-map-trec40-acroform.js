// VERIFIED 2026-06-16 by Atlas self-labeled PDF + position-based widget inspection.
// CRITICAL: PDF field names on TREC 40 are MISLEADING. The VA checkbox is named
// "6 Reverse Mortgage Financing" because the PDF authoring is bizarre.
// Trust POSITION (page + y coordinate), NOT field NAME. Every entry below is anchored
// by explicit y-position to disambiguate the 7 financing type checkboxes.
// See .tmp-correct-acroform-mapping-trec40.json for full audit trail.

module.exports = {
  // ===========================================================================
  // PROPERTY IDENTIFICATION (pages 1 + 2 header)
  // ===========================================================================
  property_address_page1: 'Street Address and City',
  property_address_page2: 'Address of Property',

  // ===========================================================================
  // FINANCING TYPE CHECKBOXES (page 1, y-descending 557→166)
  // CRITICAL: Field names are MISLEADING. Use position to disambiguate.
  // ===========================================================================
  section_a_conventional: '1 Conventional Financing',
  section_b_tx_veterans: '2 Texas Veterans Loan A loans from the Texas Veterans Land Board of',
  section_c_fha: '3 FHA Insured Financing A Section',
  section_d_va: '6 Reverse Mortgage Financing A reverse mortgage loan also known as a Home Equity', // NAME LIES - VA by position y=357
  section_e_usda: '4 VA Guaranteed Financing A VA guaranteed loan of not less than', // NAME LIES - USDA by position y=300
  section_f_reverse_mortgage: '5 USDA Guaranteed Financing A USDAguaranteed loan of not less than', // NAME LIES - Reverse by position y=242
  section_g_other_financing: '6 Reverse Mortgage Financing A reverse mortgage loan also known as a Home Equity-1', // NAME LIES - Other by position y=166

  // ===========================================================================
  // SECTION A: CONVENTIONAL FINANCING (two sub-loans: A.1 + A.2)
  // ===========================================================================
  a1_first_mortgage_checkbox: 'a A first mortgage loan in the principal amount of',
  a1_loan_amount: 'years with interest not to exceed', // NAME LIES - this is the loan amount blank
  a1_term_years: 'any financed PMI premium due in full in 1',
  a1_interest_rate: 'any financed PMI premium due in full in 2',
  a1_interest_term_years: 'per annum for the first',
  a1_origination_pct: 'shown on Buyers Loan Estimate for the loan not to exceed',

  a2_second_mortgage_checkbox: 'b A second mortgage loan in the principal amount of',
  a2_loan_amount: 'excluding',
  a2_term_years: 'any financed PMI premium due in full in 1_2',
  a2_interest_rate: 'any financed PMI premium due in full in 2_2',
  a2_interest_term_years: 'per annum for the first_2',
  a2_origination_pct: 'shown on Buyers Loan Estimate for the loan not to exceed_2',

  // ===========================================================================
  // SECTION B: TX VETERANS LOAN
  // Note: Section B has NO interest-rate blank (rate is fixed by TVLB)
  // ===========================================================================
  b_loan_amount: 'for a period in the total amount of',
  b_term_years: 'years at the interest rate established by the',

  // ===========================================================================
  // SECTION C: FHA INSURED FINANCING
  // ===========================================================================
  c_fha_section_number: 'undefined', // The 'Section ____' label after FHA header
  c_loan_amount: 'excluding any financed MIP amortizable monthly for not less',
  c_term_years: 'than',
  c_interest_rate: 'years with interest not to exceed_2',
  c_interest_term_years: 'Text1',
  c_origination_pct: 'not to exceed',

  // ===========================================================================
  // SECTION D: VA GUARANTEED FINANCING (y=357 down to y=311)
  // ===========================================================================
  d_loan_amount: 'excluding_2',
  d_term_years: 'any financed Funding Fee amortizable monthly for not less than',
  d_interest_rate: 'not to exceed_2',
  d_interest_term_years: 'per annum for the first_3',
  d_origination_pct: { field: 'Text2', widget_index: 0 }, // TWO Text2 widgets - this is index 0

  // ===========================================================================
  // SECTION E: USDA GUARANTEED FINANCING (y=300 down to y=266)
  // ===========================================================================
  e_loan_amount: 'Charges as shown on Buyers Loan Estimate for the loan not to exceed',
  e_term_years: 'years',
  e_interest_rate: 'with interest not to exceed',
  e_interest_term_years: 'excluding any financed Funding Fee amortizable monthly for not less than',
  e_origination_pct: 'Estimate for the loan not to exceed',

  // ===========================================================================
  // SECTION F: REVERSE MORTGAGE (y=242 down to y=195)
  // ===========================================================================
  f_loan_amount: 'per annum for the first_4',
  f_term_years: 'any financed PMI premium or other costs with interest not to exceed',
  f_interest_rate: 'for the first',
  f_origination_pct: 'Origination Charges as shown on Buyers Loan Estimate for the loan not to exceed',
  f_will_be_fha_insured: 'will',
  f_will_not_be_fha_insured: 'will not be an FHA insured loan',

  // ===========================================================================
  // SECTION G: OTHER FINANCING (y=166 down to y=130)
  // ===========================================================================
  g_loan_amount: 'excluding_2-1',
  g_term_years: 'any financed Funding Fee amortizable monthly for not less than-1',
  g_interest_rate: 'not to exceed-1',
  g_interest_term_years: 'per annum for the first_3-1',
  g_origination_pct: 'not to exceed_2-1',
  g_second_origination_or_sub: { field: 'Text2', widget_index: 1 }, // TWO Text2 widgets - this is index 1
  g_will_checkbox: 'will-1',
  g_will_not_checkbox: 'will-2',

  // ===========================================================================
  // PAGE 1 INITIALS
  // ===========================================================================
  buyer_initial_1: 'Initialed for identification by Buyer',
  buyer_initial_2: 'undefined_2',
  seller_initial_1: 'and Seller',
  seller_initial_2: 'undefined_3',

  // ===========================================================================
  // PAGE 2 APPROVALS + SPECIAL SECTIONS
  // ===========================================================================
  buyer_approval_days: 'Conversion Mortgage loan in the original principal amount of', // NAME LIES - this is buyer approval days
  buyer_approval_subject_checkbox: 'This contract is subject to Buyer obtaining Buyer Approval If Buyer cannot obtain Buyer',
  property_approval_checkbox: 'Check Box2',
  va_appraised_value: 'value of the Property established by the Department of Veterans Affairs',

  // ===========================================================================
  // PAGE 2 SIGNATURES
  // ===========================================================================
  buyer_signature_1: 'Signature1',
  buyer_signature_2: 'Signature3',
  seller_signature_1: 'Signature2',
  seller_signature_2: 'Signature4',
};