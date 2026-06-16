// Semantic field name → AcroForm field name mapping for TREC Resale Contract (20-19)
// Source: AcroForm inspection of TREC resale PDF + Python scripts/document_field_maps.py
// Purpose: Used by fillResaleContractDocuSeal to map canonical field values to actual PDF fields
// Last updated: 2026-06-16 (AcroForm refactor)

module.exports = {
  // SECTION 1: PARTIES (Page 1)
  // NOTE: PDF field names are backwards per TREC quirk
  // '1 PARTIES The parties to this contract are' = Seller name blank
  // 'Seller and' = Buyer name blank
  buyer_name: 'Seller and',
  seller_name: '1 PARTIES The parties to this contract are',

  // SECTION 2: PROPERTY (Pages 1, 9, 10)
  property_address: 'Address of Property',
  // Additional address repeats (all get same value)
  property_address_2: 'Address of Property_2',
  property_address_header_1: 'Contract Concerning',
  property_address_header_2: 'Contract Concerning_2',
  property_address_header_3: 'Contract Concerning_3',
  property_address_header_4: 'Contract Concerning_4',
  property_address_broker_page: 'Addr of Prop',

  // Legal description (leave blank unless we have data — not in transactions table yet)
  legal_lot: 'A LAND Lot',
  legal_block: 'Block',
  legal_addition: 'Addition City of',
  legal_county: 'County of',
  legal_city_state_zip: 'Texas known as',

  // SECTION 3: EARNEST MONEY (Page 2)
  earnest_money: 'earnest money of',
  earnest_money_form: 'Earnest Money in the form of',

  // SECTION 5: OPTION PERIOD (Page 2)
  option_fee: 'Option Fee in the form of',

  // SECTION 6A: TITLE POLICY (Page 2)
  title_company: 'insurance Title Policy issued by',
  escrow_agent: 'Escrow Agent',

  // SECTION 7: CLOSING DATE (Page 1)
  closing_date: 'A The closing of the sale will be on or before',

  // SECTION 8: FINANCING (checkbox)
  financing_addendum: 'B Sum of all financing described in the attached',

  // SECTION 14: EARNEST MONEY FORM (Page 9)
  earnest_money_received_by: 'Received by',
  earnest_money_address: 'Address',
  earnest_money_city: 'City_4',
  earnest_money_state: 'State_4',
  earnest_money_zip: 'Zip_4',
  earnest_money_email: 'Email Address',
  earnest_money_date: 'Date',
  earnest_money_phone: 'Phone_6',
  earnest_money_fax: 'Fax',

  // SECTION 15: SALES PRICE / FINANCING (Page 2)
  // "will not be credited" = checkbox for earnest money credit
  // "acknowledged by Seller" = sales price field
  sales_price: 'will not be credited to the Sales Price at closing Time is of the',
  sales_price_acknowledged: 'acknowledged by Seller and Buyers agreement to pay Seller',

  // BROKER INFORMATION (Page 10-11)
  listing_broker_firm: 'Listing Broker Firm',
  listing_broker_license: 'License No_4',
  listing_associate_name: 'Listing Associates Name',
  listing_associate_email: 'Listing Associates Email Address',
  listing_associate_phone: 'Phone_3',
  listing_broker_address: 'Listing Brokers Office Address',
  listing_broker_city: 'City_2',
  listing_broker_state: 'State_2',
  listing_broker_zip: 'Zip_2',

  other_broker_firm: 'Other Broker Firm',
  other_broker_license: 'License No_2',
  other_broker_address: 'Other Brokers Address',
  other_broker_city: 'City',
  other_broker_state: 'State',
  other_broker_zip: 'Zip',
  other_broker_phone: 'Phone_2',

  selling_associate_name: 'Selling Associates Name',
  selling_associate_email: 'Selling Associates Email Address',
  selling_associate_phone: 'Phone_5',
  selling_associate_address: 'Selling Associates Office Address',
  selling_associate_city: 'City_3',
  selling_associate_state: 'State_3',

  // SELLER FINANCING (checkbox)
  seller_financing_addendum: 'Seller Financing Addendum',

  // PROPERTY OWNER ASSOCIATIONS (Page 3, checkbox)
  property_owners_associations: 'Addendum for Property Subject to',

  // ACCEPTANCE OF PROPERTY CONDITION (Page 3, checkboxes)
  property_acceptance_as_is: 'As Is',
  property_acceptance_as_is_except: 'As Is except',

  // REPAIRS (Page 3)
  repairs_description: 'following specific repairs and treatments',

  // TITLE POLICY COMMITMENT OBJECTION (Page 4)
  title_policy_objection_days: '3 days prior',

  // ADDENDA (checkboxes, Page 10)
  third_party_financing_addendum: 'Third Party Financing Addendum',
  environmental_assessment: 'Environmental Assessment Threatened or',
  buyers_temporary_lease: 'Buyers Temporary Residential Lease',
  sellers_temporary_lease: 'Sellers Temporary Residential Lease',
  short_sale_addendum: 'Short Sale Addendum',
  loan_assumption_addendum: 'Loan Assumption Addendum',
  oil_gas_reservation: 'Addendum for Reservation of Oil Gas',
  backup_contract: 'Addendum for BackUp Contract',
  sale_other_property: 'Addendum for Sale of Other Property by',
  seaward_property: 'Addendum for Property Located Seaward',
  propane_gas: 'Addendum for Property in a Propane Gas',

  // EXECUTION (Page 10, signature fields)
  executed_date: 'EXECUTED the',
  executed_day: 'day of',
  executed_year: '20_2',

  // SELLER SIGNATURE (Text fields for date/initials before signature)
  seller_initialed_date_1: 'Initialed for identification by Buyer',
  seller_initialed_date_2: 'Initialed for identification by Buyer_2',
  seller_initialed_date_3: 'Initialed for identification by Buyer_3',
  seller_initialed_date_4: 'Initialed for identification by Buyer_4',
  seller_initialed_date_5: 'Initialed for identification by Buyer_5',

  // BUYER INITIALS
  buyer_initialed_1: 'and Seller',
  buyer_initialed_2: 'and Seller_2',
  buyer_initialed_3: 'and Seller_3',
  buyer_initialed_4: 'and Seller_4',
  buyer_initialed_5: 'and Seller_5',
  buyer_initialed_6: 'and Seller_6',
  buyer_initialed_7: 'and Seller_7',

  // CONTRACT EFFECTIVE DATE
  contract_effective_date: 'Date',

  // AGENCY DISCLOSURE (Page 10)
  // "Seller only as Sellers agent" and "Seller and Buyer as an intermediary" are checkboxes
  agency_seller_only: 'Seller only as Sellers agent',
  agency_intermediary: 'Seller and Buyer as an intermediary',
  agency_buyer_only: 'Buyer only',

  // SELLER'S DISCLOSURE ADDENDUM (checkboxes)
  sellers_disclosure_addendum: 'Addendum for Sellers Disclos',
  sellers_disclosure: 'Sellers Disclos',

  // EARNEST MONEY RECEIVED (Page 9)
  earnest_money_received_date: 'DateTime',

  // Option period within days
  option_period_days: 'Within one', // This is a checkbox typically; refactor as needed

  // SERVICE CONTRACT
  service_contract_amount: 'service contract in an amount not exceeding',
};
