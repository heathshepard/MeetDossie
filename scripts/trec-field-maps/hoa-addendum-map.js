// trec-field-maps/hoa-addendum-map.js
// AcroForm field map for HOA Addendum - Property Subject to Mandatory Membership
// 17 fields discovered via probe-trec-forms.js
// Source: C:\Users\Heath Shepard\Desktop\dossie\Dossie Forms\TREC Base\HOA-Addendum-Property-Subject-to-Mandatory-Membership.pdf

module.exports = {
  // Header
  property_address:  'Street Address and City',

  // HOA information
  hoa_name:          'Name of Property Owners Association Association and Phone Number',

  // Subdivision information delivery deadline (days)
  sub_info_days:     'the Subdivision Information to the Buyer If Seller delivers the Subdivision Information Buyer may terminate',

  // Cost delivery
  copy_to_seller:    'copy of the Subdivision Information to the Seller',

  // Updated resale certificate deposit for reserves
  reserves_note:     'D DEPOSITS FOR RESERVES Buyer shall pay any deposits for reserves required at closing by the Association',
};

// Checkboxes
module.exports.CHECKBOXES = {
  // How buyer is getting subdivision info
  sub_info_within_days:  '1 Within',           // "Within X days" delivery option
  sub_info_already_received: '3Buyer has received and approved the Subdivision Information before signing the contract Buyer',
  sub_info_not_required: '4Buyer does not require delivery of the Subdivision Information',

  // Updated resale certificate
  requires_updated_cert: 'does',
  no_updated_cert:       'does not require an updated resale certificate If Buyer requires an updated resale certificate Seller at',

  // Who pays for cert
  buyer_pays_cert:   'Buyer',
  seller_pays_cert:  'Seller shall pay the Title Company the cost of obtaining the',
};
