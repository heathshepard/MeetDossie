// trec-field-maps/lead-paint-map.js
// AcroForm field map for Lead-Based Paint Addendum
// 25 fields discovered via probe-trec-forms.js
// Source: C:\Users\Heath Shepard\Desktop\dossie\Dossie Forms\TREC Base\Lead-Based-Paint-Addendum.pdf

module.exports = {
  // Header
  property_address:       'Street Address and City',

  // Seller disclosure fields
  seller_known_lead:      'undefined',           // Seller's known lead-based paint info
  seller_known_hazards:   'b Seller has no actual knowledge of leadbased paint andor leadbased paint hazards in the Property',
  seller_records:         'undefined_2',         // Records seller has
  seller_no_records:      'b Seller has no reports or records pertaining to leadbased paint andor leadbased paint hazards in the',

  // Dates (for signatures area)
  buyer_date_1:    'Date',
  buyer_date_2:    'Date_2',
  seller_date_1:   'Date_3',
  seller_date_2:   'Date_4',
  agent_date_1:    'Date_5',
  agent_date_2:    'Date_6',
};

// Checkboxes
module.exports.CHECKBOXES = {
  // Seller disclosure - known lead
  seller_no_knowledge:   'Check Box7',   // Seller has no knowledge
  seller_has_knowledge:  'Check Box8',   // Seller has knowledge (must disclose)

  // Seller records
  seller_no_records_cb:  'Check Box9',   // No records
  seller_has_records:    'Check Box10',  // Has records (attach)

  // Buyer acknowledgment
  buyer_received_pamphlet: 'Check Box11',
  buyer_inspection_period: 'Check Box12',  // Buyer has 10-day inspection period
  buyer_waives_inspection: 'Check Box13',  // Buyer waives inspection

  // Agent acknowledgment
  agent_informed_seller:   'Check Box14',
};
