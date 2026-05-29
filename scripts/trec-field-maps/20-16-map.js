// trec-field-maps/20-16-map.js
// AcroForm field map for TREC 20-16 One-to-Four Family Residential Contract (Resale)
// 256 fields discovered via probe-trec-forms.js on the local fillable PDF.
// Source: C:\Users\Heath Shepard\Desktop\dossie\Dossie Forms\TREC Base\One-to-Four-Family-Residential-Contract-Resale.pdf
//
// Format: { logical_name: 'exact_pdf_field_name' }
// Logical names match the field_values schema in api/extract-form-fields.js and api/fill-form.js

module.exports = {
  // --- PARTIES ---
  buyer_name:        '1 PARTIES The parties to this contract are',
  seller_name:       'Seller and',

  // --- PROPERTY ---
  property_address:  'Texas known as',           // "Address of Property" appears later (signature page), use "Texas known as" for full address line
  legal_lot:         'A LAND Lot',
  legal_block:       'Block',
  legal_addition:    'undefined',                // Addition/subdivision name field
  city_state:        'Addition City of',         // "City of" field - city + state
  county:            'County of',

  // --- SALES PRICE ---
  // Paragraph 3: Sales Price
  sale_price_cash:   'undefined_2',              // Cash portion
  sale_price_finance: 'undefined_3',             // Financed portion (see financing addendum)
  // 'undefined_4' = total sales price (sum) - we write this one
  sale_price_total:  'undefined_4',

  // --- EARNEST MONEY ---
  earnest_money_amt: 'earnest money of',         // amount in dollars
  earnest_money_form: 'Earnest Money in the form of', // check / wire / etc.

  // --- OPTION PERIOD ---
  option_fee_amt:    'Option Fee in the form of', // option fee amount (the form prints "$" before this)
  option_fee_form:   'Seller or Listing Broker',  // payable to whom

  // --- CLOSING DATE ---
  // Paragraph 9A — "The closing of the sale will be on or before [date], 20[yy]"
  closing_date_text: 'A The closing of the sale will be on or before', // "Month Day" text
  closing_date_year: '20',                        // 2-digit year suffix (pre-printed "20")

  // --- TITLE COMPANY ---
  title_company:     'insurance Title Policy issued by',
  escrow_agent:      'Escrow Agent',

  // --- CONTRACT DATE (bottom receipt area) ---
  contract_date:     'Date',

  // --- ADDENDA CHECKBOXES ---
  addendum_financing:     'Third Party Financing Addendum',
  addendum_hoa:           'Addendum for Property Subject to',  // HOA addendum checkbox
  addendum_lead_paint:    'Addendum for Sale of Other Property by',  // NOTE: not exact for lead paint; see below

  // --- PROPERTY CONDITION ---
  // Paragraph 7D — Property condition acceptance
  as_is:             '1 Buyer accepts the Property As Is',     // checkbox
  as_is_except:      '2 Buyer accepts the Property As Is provided Seller at Sellers expense shall complete the', // checkbox

  // --- BROKER INFO (listing side) ---
  listing_broker_firm:    'Listing Broker Firm',
  listing_broker_license: 'License No_4',
  listing_agent_name:     'Listing Associates Name',
  listing_agent_license:  'License No_5',
  listing_agent_email:    'Listing Associates Email Address',
  listing_agent_phone:    'Phone_3',
  listing_broker_address: 'Listing Brokers Office Address',
  listing_broker_city:    'City_2',
  listing_broker_state:   'State_2',
  listing_broker_zip:     'Zip_2',

  // --- BROKER INFO (selling/buyer side) ---
  selling_broker_firm:    'Other Broker Firm',
  selling_broker_license: 'License No',
  selling_agent_name:     'Associates Name',
  selling_agent_license:  'License No_2',
  selling_agent_email:    'Associates Email Address',
  selling_agent_phone:    'Phone',
  selling_broker_address: 'Other Brokers Address',
  selling_broker_city:    'City',
  selling_broker_state:   'State',
  selling_broker_zip:     'Zip',
};

// Checkbox-only fields (use form.getCheckBox(name).check() to set)
module.exports.CHECKBOXES = {
  financing_by_addendum:  'B Sum of all financing described in the attached',
  as_is:                  '1 Buyer accepts the Property As Is',
  as_is_except:           '2 Buyer accepts the Property As Is provided Seller at Sellers expense shall complete the',
  addendum_financing:     'Third Party Financing Addendum',
  addendum_hoa:           'Addendum for Property Subject to',
  survey_from_buyer:      '2Within',             // survey obtainment: buyer's expense
  survey_from_seller:     '3Within',             // survey obtainment: seller's expense
  hoa_mandatory_yes:      'is',                  // HOA: Property IS subject to mandatory HOA
  hoa_mandatory_no:       'is not',              // HOA: Property is NOT subject to mandatory HOA
};
