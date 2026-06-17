module.exports = {
  form_id: '11-9',
  form_name: 'TREC 11-9 Addendum for Back-Up Contract',
  field_count: 13,

  fields: [
    // Header
    {
      key: 'property_address_page1',
      acroform_name: 'Address of Property',
      type: 'text',
      section: 'Header',
      page: 1,
    },
    {
      key: 'property_address_page2',
      acroform_name: 'Text2',
      type: 'text',
      section: 'Header',
      page: 2,
    },

    // Section A(2) — Additional earnest money and option fee
    {
      key: 'additional_earnest_money_amount',
      acroform_name: 'Text1',
      type: 'text',
      section: 'A(2)',
      page: 1,
    },
    {
      key: 'additional_option_fee_amount',
      acroform_name: 'Text1 1',
      type: 'text',
      section: 'A(2)',
      page: 1,
    },
    {
      key: 'additional_earnest_money_delivery_days',
      acroform_name: 'Text1 2',
      type: 'text',
      section: 'A(2)',
      page: 1,
    },

    // Section G — Termination of first contract
    {
      key: 'first_contract_termination_deadline_phrase',
      acroform_name: 'Except as provided by this Addendum neither party is required to perform under the',
      type: 'text',
      section: 'G',
      page: 1,
    },
    {
      key: 'first_contract_termination_year_1',
      acroform_name: '20',
      type: 'text',
      section: 'G',
      page: 1,
    },

    // Section H — Notice of first contract termination
    {
      key: 'first_contract_termination_notice_phrase',
      acroform_name: 'the BackUp Contract terminates and the earnest money will be refunded to Buyer  Seller must',
      type: 'text',
      section: 'H',
      page: 1,
    },
    {
      key: 'first_contract_termination_year_2',
      acroform_name: '20_2',
      type: 'text',
      section: 'H',
      page: 1,
    },

    // Page 1 footer — Initials
    {
      key: 'buyer_initials_1',
      acroform_name: 'Text3',
      type: 'text',
      section: 'Footer',
      page: 1,
    },
    {
      key: 'buyer_initials_2',
      acroform_name: 'Text3 3',
      type: 'text',
      section: 'Footer',
      page: 1,
    },
    {
      key: 'seller_initials_1',
      acroform_name: 'Text31',
      type: 'text',
      section: 'Footer',
      page: 1,
    },
    {
      key: 'seller_initials_2',
      acroform_name: 'Text31 2',
      type: 'text',
      section: 'Footer',
      page: 1,
    },
  ],

  no_acroform_signature_fields: {
    note: 'Page 2 has 4 visual signature lines and 4 date lines but NO AcroForm signature fields. Signatures and dates must be drawn at fixed coordinates via pdf-lib drawText / drawImage using flat-pdf-filler.js pattern.',
    fields_needing_coordinates: [
      'buyer_1_signature_page2',
      'buyer_2_signature_page2',
      'seller_1_signature_page2',
      'seller_2_signature_page2',
      'buyer_1_signature_date_page2',
      'buyer_2_signature_date_page2',
      'seller_1_signature_date_page2',
      'seller_2_signature_date_page2',
    ],
  },

  notes: {
    field_names: 'Field names in this PDF are raw OCR garbage (Text1, Text2, Text3, "20", "20_2", plus literal sentence fragments). DO NOT infer purpose from the name; trust the section notes above.',
    section_a2_text1_space: 'Field names have literal SPACES: "Text1 1" not "Text1_1", "Text1 2" not "Text1_2".',
    section_g_h_paragraphs: 'Sections G and H capture termination-deadline paragraph text as free-form blanks with separate year digits.',
  },
};
