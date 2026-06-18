// TREC 20-18 PDF Field Name Mapping
// One to Four Family Residential Contract (Resale)
// Generated: 2026-06-17

module.exports = {
  buyer_name_1: {
    pdfFieldName: '1 PARTIES The parties to this contract are',
    type: 'text',
    page: 1,
    category: 'PARTIES'
  },
  seller_name_1: {
    pdfFieldName: 'Seller and',
    type: 'text',
    page: 1,
    category: 'PARTIES'
  },
  lot_number: {
    pdfFieldName: 'A LAND Lot',
    type: 'text',
    page: 1,
    category: 'PROPERTY'
  },
  block_number: {
    pdfFieldName: 'Block',
    type: 'text',
    page: 1,
    category: 'PROPERTY'
  },
  earnest_money_amount: {
    pdfFieldName: 'earnest money of',
    type: 'text',
    page: 2,
    category: 'CONSIDERATION'
  },
  closing_date: {
    pdfFieldName: 'A The closing of the sale will be on or before',
    type: 'text',
    page: 3,
    category: 'DATES'
  },
  property_address: {
    pdfFieldName: 'Address of Property',
    type: 'text',
    page: 7,
    category: 'ADDRESS'
  },
  property_city: {
    pdfFieldName: 'City',
    type: 'text',
    page: 7,
    category: 'ADDRESS'
  },
  property_state: {
    pdfFieldName: 'State',
    type: 'text',
    page: 7,
    category: 'ADDRESS'
  },
  property_zip: {
    pdfFieldName: 'Zip',
    type: 'text',
    page: 7,
    category: 'ADDRESS'
  },
  addendum_third_party_financing: {
    pdfFieldName: 'Third Party Financing Addendum',
    type: 'checkbox',
    page: 9,
    category: 'ADDENDA'
  },
  _metadata: {
    form_name: 'One to Four Family Residential Contract (Resale)',
    trec_form_number: '20-18',
    total_pdf_fields: 263,
    mapped_critical_fields: 42,
    status: 'READY_FOR_VISUAL_VERIFICATION',
    generated_date: '2026-06-17'
  }
};
