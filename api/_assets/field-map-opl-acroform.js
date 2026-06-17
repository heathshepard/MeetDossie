module.exports = {
  form_id: 'OP-L',
  form_name: 'TREC OP-L Addendum for Seller\'s Disclosure of Information on Lead-Based Paint and Lead-Based Paint Hazards',
  field_count: 25,

  fields: [
    // Header
    {
      key: 'property_address',
      acroform_name: 'Street Address and City',
      type: 'text',
      section: 'Header',
    },

    // Section B.1 — Known lead paint disclosure
    {
      key: 'seller_knows_lead_paint_present',
      acroform_name: 'Check Box7',
      type: 'checkbox',
      section: 'B.1.(a)',
      group: 'section_b1_disclosure',
    },
    {
      key: 'seller_known_lead_paint_explanation_line1',
      acroform_name: 'undefined',
      type: 'text',
      section: 'B.1.(a)',
    },
    {
      key: 'seller_known_lead_paint_explanation_line2',
      acroform_name: 'b Seller has no actual knowledge of leadbased paint andor leadbased paint hazards in the Property',
      type: 'text',
      section: 'B.1.(a)',
    },
    {
      key: 'seller_no_knowledge_lead_paint',
      acroform_name: 'Check Box8',
      type: 'checkbox',
      section: 'B.1.(b)',
      group: 'section_b1_disclosure',
    },

    // Section B.2 — Records and reports
    {
      key: 'seller_provided_records',
      acroform_name: 'Check Box9',
      type: 'checkbox',
      section: 'B.2.(a)',
      group: 'section_b2_records',
    },
    {
      key: 'seller_records_documents_list',
      acroform_name: 'undefined_2',
      type: 'text',
      section: 'B.2.(a)',
    },
    {
      key: 'seller_records_documents_list_line2',
      acroform_name: 'b Seller has no reports or records pertaining to leadbased paint andor leadbased paint hazards in the',
      type: 'text',
      section: 'B.2.(a)',
    },
    {
      key: 'seller_no_records',
      acroform_name: 'Check Box10',
      type: 'checkbox',
      section: 'B.2.(b)',
      group: 'section_b2_records',
    },

    // Section C — Buyer inspection rights
    {
      key: 'buyer_waives_inspection',
      acroform_name: 'Check Box11',
      type: 'checkbox',
      section: 'C.1',
      group: 'section_c_buyer_inspection_election',
    },
    {
      key: 'buyer_reserves_inspection',
      acroform_name: 'Check Box12',
      type: 'checkbox',
      section: 'C.2',
      group: 'section_c_buyer_inspection_election',
    },

    // Section D — Buyer acknowledgments
    {
      key: 'buyer_received_copies',
      acroform_name: 'Check Box13',
      type: 'checkbox',
      section: 'D.1',
    },
    {
      key: 'buyer_received_pamphlet',
      acroform_name: 'Check Box14',
      type: 'checkbox',
      section: 'D.2',
    },

    // Section F — Signatures and dates
    {
      key: 'buyer_1_signature',
      acroform_name: 'Signature1',
      type: 'signature',
      section: 'F.Signatures',
    },
    {
      key: 'buyer_1_date',
      acroform_name: 'Date',
      type: 'text',
      section: 'F.Signatures',
    },
    {
      key: 'seller_1_signature',
      acroform_name: 'Signature4',
      type: 'signature',
      section: 'F.Signatures',
    },
    {
      key: 'seller_1_date',
      acroform_name: 'Date_2',
      type: 'text',
      section: 'F.Signatures',
    },
    {
      key: 'buyer_2_signature',
      acroform_name: 'Signature2',
      type: 'signature',
      section: 'F.Signatures',
    },
    {
      key: 'buyer_2_date',
      acroform_name: 'Date_3',
      type: 'text',
      section: 'F.Signatures',
    },
    {
      key: 'seller_2_signature',
      acroform_name: 'Signature5',
      type: 'signature',
      section: 'F.Signatures',
    },
    {
      key: 'seller_2_date',
      acroform_name: 'Date_4',
      type: 'text',
      section: 'F.Signatures',
    },
    {
      key: 'buyer_broker_signature',
      acroform_name: 'Signature3',
      type: 'signature',
      section: 'F.Signatures',
    },
    {
      key: 'buyer_broker_date',
      acroform_name: 'Date_5',
      type: 'text',
      section: 'F.Signatures',
    },
    {
      key: 'seller_broker_signature',
      acroform_name: 'Signature6',
      type: 'signature',
      section: 'F.Signatures',
    },
    {
      key: 'seller_broker_date',
      acroform_name: 'Date_6',
      type: 'text',
      section: 'F.Signatures',
    },
  ],

  mutually_exclusive_groups: {
    section_b1_disclosure: [
      'seller_knows_lead_paint_present',
      'seller_no_knowledge_lead_paint',
    ],
    section_b2_records: [
      'seller_provided_records',
      'seller_no_records',
    ],
    section_c_buyer_inspection_election: [
      'buyer_waives_inspection',
      'buyer_reserves_inspection',
    ],
  },

  independent_checkbox_groups: {
    section_d_buyer_acknowledgment: [
      'buyer_received_copies',
      'buyer_received_pamphlet',
    ],
  },

  notes: {
    section_c_inspection_days: 'The "Within ___ days" blank in Section C.2 has NO AcroForm text field. If needed, must be drawn via flat-PDF draw at approximate coords x=125, y=389 (PDF coords). Standard federal default = 10 days.',
  },
};
