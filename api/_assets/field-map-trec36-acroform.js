module.exports = {
  form_id: '36-11',
  form_name: 'TREC 36-11 Addendum for Property Subject to Mandatory Membership in a Property Owners Association',
  field_count: 17,

  fields: [
    // Header
    {
      key: 'property_address',
      acroform_name: 'Street Address and City',
      type: 'text',
      section: 'Header',
    },
    {
      key: 'hoa_name_and_phone',
      acroform_name: 'Name of Property Owners Association Association and Phone Number',
      type: 'text',
      section: 'Header',
    },

    // Section A — Subdivision Information delivery
    {
      key: 'section_a_item1_days',
      acroform_name: 'the Subdivision Information to the Buyer If Seller delivers the Subdivision Information Buyer may terminate',
      type: 'text',
      section: 'A.1',
      group: 'section_a_delivery_election',
    },
    {
      key: 'section_a_item1_check',
      acroform_name: '1 Within',
      type: 'checkbox',
      section: 'A.1',
      group: 'section_a_delivery_election',
    },
    {
      key: 'section_a_item2_days',
      acroform_name: 'copy of the Subdivision Information to the Seller',
      type: 'text',
      section: 'A.2',
      group: 'section_a_delivery_election',
    },
    {
      key: 'section_a_item2_check',
      acroform_name: 'undefined',
      type: 'checkbox',
      section: 'A.2',
      group: 'section_a_delivery_election',
    },
    {
      key: 'section_a_item3_check',
      acroform_name: '3Buyer has received and approved the Subdivision Information before signing the contract Buyer',
      type: 'checkbox',
      section: 'A.3',
      group: 'section_a_delivery_election',
    },
    {
      key: 'section_a_item4_check',
      acroform_name: '4Buyer does not require delivery of the Subdivision Information',
      type: 'checkbox',
      section: 'A.4',
      group: 'section_a_delivery_election',
    },

    // Section C — Resale certificate
    {
      key: 'section_c_buyer_requires_resale_cert',
      acroform_name: 'does',
      type: 'checkbox',
      section: 'C',
      group: 'section_c_resale_cert',
    },
    {
      key: 'section_c_buyer_does_not_require_resale_cert',
      acroform_name: 'does not require an updated resale certificate If Buyer requires an updated resale certificate Seller at',
      type: 'checkbox',
      section: 'C',
      group: 'section_c_resale_cert',
    },

    // Section D — Reserves
    {
      key: 'section_d_reserves_text',
      acroform_name: 'D DEPOSITS FOR RESERVES Buyer shall pay any deposits for reserves required at closing by the Association',
      type: 'text',
      section: 'D',
      optional: true,
    },

    // Section E — Title company cost payor
    {
      key: 'section_e_buyer_pays_title_company',
      acroform_name: 'Buyer',
      type: 'checkbox',
      section: 'E',
      group: 'section_e_title_company_payor',
    },
    {
      key: 'section_e_seller_pays_title_company',
      acroform_name: 'Seller shall pay the Title Company the cost of obtaining the',
      type: 'checkbox',
      section: 'E',
      group: 'section_e_title_company_payor',
    },

    // Signatures
    {
      key: 'buyer_1_signature',
      acroform_name: 'Signature1',
      type: 'signature',
      section: 'Signatures',
    },
    {
      key: 'seller_1_signature',
      acroform_name: 'Signature2',
      type: 'signature',
      section: 'Signatures',
    },
    {
      key: 'buyer_2_signature',
      acroform_name: 'Signature3',
      type: 'signature',
      section: 'Signatures',
    },
    {
      key: 'seller_2_signature',
      acroform_name: 'Signature4',
      type: 'signature',
      section: 'Signatures',
    },
  ],

  mutually_exclusive_groups: {
    section_a_delivery_election: [
      'section_a_item1_check',
      'section_a_item2_check',
      'section_a_item3_check',
      'section_a_item4_check',
    ],
    section_c_resale_cert: [
      'section_c_buyer_requires_resale_cert',
      'section_c_buyer_does_not_require_resale_cert',
    ],
    section_e_title_company_payor: [
      'section_e_buyer_pays_title_company',
      'section_e_seller_pays_title_company',
    ],
  },
};
