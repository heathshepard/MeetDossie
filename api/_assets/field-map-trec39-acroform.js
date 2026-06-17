// TREC No. 39-10 — Amendment to Contract (rev. 11-04-2024)
// Verified AcroForm field mapping by Atlas, 2026-06-16.
// Maps semantic field names to actual PDF field names.
// CRITICAL: PDF field names are MISLEADING — always use this map, not the raw PDF names.

module.exports = {
  // =========================================================================
  // HEADER
  // =========================================================================
  property_address: 'Street Address and City',

  // =========================================================================
  // SECTION 1: SALES PRICE CHANGE
  // =========================================================================
  sales_price_change_active: '1 The Sales Price in Paragraph 3 of the contract is',
  new_cash_portion: 'undefined',
  new_financing_amount: 'undefined_2',
  new_sales_price_total: 'undefined_3',

  // =========================================================================
  // SECTION 2: SELLER REPAIRS & TREATMENTS
  // =========================================================================
  seller_repairs_treatments_active: '2 In addition to any repairs and treatments otherwise required by the contract Seller at Sellers',
  seller_repairs_treatments_list: 'Text1',

  // =========================================================================
  // SECTION 3: CLOSING DATE CHANGE
  // =========================================================================
  closing_date_change_active: '3 The date in Paragraph 9 of the contract is changed to',
  new_closing_date_month_day: 'date 5',
  new_closing_date_year_suffix: '20_25',

  // =========================================================================
  // SECTION 4: FINANCING AMOUNT (PARA 12A1b)
  // =========================================================================
  financing_amount_change_active: '4 The amount in Paragraph 12A1b of the contract is changed to',
  new_financing_amount_12A1b: '20',  // MISLEADING NAME — this is the financing dollar amount, not a year
  buyer_will_deliver_revised_approval: 'will',
  buyer_will_not_deliver_revised_approval: 'will not',
  revised_approval_notice_days: 'undefined_5',

  // =========================================================================
  // SECTION 5: LENDER REQUIRED REPAIRS
  // =========================================================================
  lender_required_repairs_active: '5 The cost of lender required repairs and treatment as itemized on the attached list will be paid',
  lender_repairs_not_to_exceed_amount: 'undefined_4',
  // NOTE: Para 5 Buyer/Seller choice has NO AcroForm field — pre-printed text only. Needs coordinate overlay later.

  // =========================================================================
  // SECTION 6: ADDITIONAL OPTION FEE
  // =========================================================================
  additional_option_fee_active: '6 Buyer has paid Seller an additional Option Fee of',
  additional_option_fee_amount: 'as follows',
  additional_option_fee_extension_days: 'for an extension of the',
  additional_option_fee_new_end_date: 'contract',
  additional_option_fee_credit_yes: 'Fee',
  additional_option_fee_credit_no: 'Fee 2',

  // =========================================================================
  // SECTION 7: BUYER WAIVES UNRESTRICTED TERMINATION
  // =========================================================================
  buyer_waives_unrestricted_termination_active: '7 Buyer waives the unrestricted right to terminate the contract for which the Option Fee was paid',

  // =========================================================================
  // SECTION 8: BUYER APPROVAL DATE CHANGE
  // =========================================================================
  buyer_approval_date_change_active: '8 The date for Buyer to give written notice to Seller that Buyer cannot obtain Buyer Approval as',
  new_buyer_approval_notice_date_month_day: 'Text6',
  new_buyer_approval_notice_year_suffix: '20_3',  // ONLY field with maxLength=2

  // =========================================================================
  // SECTION 9: OTHER MODIFICATIONS
  // =========================================================================
  other_modifications_active: '9 Other Modifications Insert only factual statements and business details applicable to this sale',
  other_modifications_line_1: 'Text3.1',
  other_modifications_line_2: 'Text4.1',
  other_modifications_line_3: 'Text5.1',
  other_modifications_overflow_8: 'Text 8',
  other_modifications_overflow_9: 'Text 9',
  other_modifications_overflow_10: 'Text 10',

  // =========================================================================
  // SECTION 10: CONSULT ATTORNEY
  // =========================================================================
  consult_attorney_acknowledgement: '10',

  // =========================================================================
  // FOOTER: EXECUTION BLOCK
  // =========================================================================
  executed_day_of_month: 'DATE OF FINAL ACCEPTANCE',  // MISLEADING NAME — day only
  executed_month_name: '20_4',  // MISLEADING NAME — this is the month name field (170pt wide)
  executed_year_suffix: 'BROKER FILL IN THE',  // MISLEADING NAME — this is the 2-digit year

  // =========================================================================
  // SIGNATURE BLOCK
  // =========================================================================
  buyer_1_signature: 'Signature3',
  seller_1_signature: 'Signature5',
  buyer_2_signature: 'Signature7',
  seller_2_signature: 'Signature8',

  // =========================================================================
  // FIELDS WITH NO ACROFORM WIDGET — MUST USE COORDINATE OVERLAY
  // =========================================================================
  // NOTE: The following have no AcroForm fields and need coordinate-based overlay or manual entry:
  // - buyer_printed_name (no field — write under signature)
  // - seller_printed_name (no field — write under signature)
  // - buyer_initials (no field — manual)
  // - seller_initials (no field — manual)
  // - section_5_buyer_or_seller_pays_choice (pre-printed text labels, no field)

  // =========================================================================
  // AMBIGUOUS FIELDS (marked verified=false in JSON) — SKIP FOR NOW
  // =========================================================================
  // These three fields have ambiguous positions and need visual confirmation:
  // - 'be credited to the Sales Price' (x=72, y=401) — may be Section 2 or 6 overflow
  // - '20_2' (x=238, y=400) — likely paired date field with above, purpose unclear
  // - 'Text7 1' (x=527, y=326) — narrow field, may belong to Para 8 or 9
  // Leave these blank until printed copy confirms their purpose.
};
