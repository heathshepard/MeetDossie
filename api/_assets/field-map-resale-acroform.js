// VERIFIED 2026-06-16 by self-labeled PDF inspection — source of truth for these fields
// Semantic field name → AcroForm field name mapping for TREC Resale Contract (20-19)
// Source: Visual inspection of self-labeled PDF render
// Purpose: Used by fillResaleContractDocuSeal to map canonical field values to actual PDF fields

module.exports = {
  // Page 1 §1 PARTIES
  buyer_name: 'Seller and',
  seller_name: '1 PARTIES The parties to this contract are',

  // Page 1 §2 PROPERTY
  property_lot: 'A LAND Lot',
  property_block: 'Block',
  property_addition_city: 'Addition City of',
  property_county: 'County of',
  property_street_address: 'Texas known as',
  property_address: 'Texas known as',  // alias

  // Page 1 §3 SALES PRICE
  cash_portion: 'undefined_3',
  financing_amount: 'undefined_4',
  sale_price: 'undefined_5',
  sales_price: 'undefined_5',  // alias

  // Page 2 §5 EARNEST MONEY + OPTION
  earnest_money: 'as earnest money to',
  earnest_money_amount: 'as earnest money to',  // alias
  option_fee: 'as earnest money to 2',
  escrow_agent: 'undefined_6',
  escrow_agent_name: 'undefined_6',  // alias
  escrow_address: 'undefined_7',

  // Page 2 §5.B option period — CORRECTED field name
  option_period_days: 'Within',
  option_days: 'Within',  // alias

  // Page 2 §6 TITLE POLICY
  title_company: 'insurance Title Policy issued by',
  title_company_name: 'insurance Title Policy issued by',  // alias

  // Page 5 §9 CLOSING
  closing_date: 'A The closing of the sale will be on or before',
};
