// Field map for TREC 20-19 Resale Contract using DocuSeal template schema
// Source: DocuSeal template 4018208
// Coordinates are normalized 0-1 (page-relative, x=left, y=top)
// These coordinates are used by pdf-lib to place text on the PDF

module.exports = {
  // PARTIES section
  buyer_name: {
    page: 0,
    x: 0.3,
    y: 0.13,
    w: 0.52,
    h: 0.014,
    type: 'text',
  },
  seller_name: {
    page: 0,
    x: 0.4399941887654049,
    y: 0.1199981973810617,
    w: 0.43,
    h: 0.014,
    type: 'text',
  },

  // PROPERTY section
  property_address: {
    page: 0,
    x: 0.2699948069465605,
    y: 0.2334919699099584,
    w: 0.65,
    h: 0.014,
    type: 'text',
  },
  addition_city: {
    page: 0,
    x: 0.27,
    y: 0.22,
    w: 0.21,
    h: 0.014,
    type: 'text',
  },
  county: {
    page: 0,
    x: 0.66,
    y: 0.22,
    w: 0.24,
    h: 0.014,
    type: 'text',
  },
  legal_lot: {
    page: 0,
    x: 0.2186619718309859,
    y: 0.2086762394101119,
    w: 0.06584507042253523,
    h: 0.01548041349292711,
    type: 'text',
  },
  legal_block: {
    page: 0,
    x: 0.385,
    y: 0.2065,
    w: 0.08542253521126758,
    h: 0.01656855277475519,
    type: 'text',
  },
  Legal_Description: {
    page: 0,
    x: 0.5109742070587588,
    y: 0.2034052062876199,
    w: 0.3777464788732394,
    h: 0.01748691990752571,
    type: 'text',
  },

  // SALES PRICE section
  down_payment: {
    page: 0,
    x: 0.7599911971830986,
    y: 0.5829989455276984,
    w: 0.16,
    h: 0.016,
    type: 'text',
  },
  loan_amount: {
    page: 0,
    x: 0.76,
    y: 0.6435,
    w: 0.16,
    h: 0.016,
    type: 'text',
  },
  sales_price: {
    page: 0,
    x: 0.76,
    y: 0.66,
    w: 0.16,
    h: 0.016,
    type: 'text',
  },

  // LEASES section
  has_residential_leases: {
    page: 0,
    x: 0.078,
    y: 0.738,
    w: 0.014,
    h: 0.014,
    type: 'checkbox',
  },
  has_fixture_leases: {
    page: 0,
    x: 0.078,
    y: 0.77,
    w: 0.014,
    h: 0.014,
    type: 'checkbox',
  },
  has_natural_resource_leases: {
    page: 0,
    x: 0.078,
    y: 0.815,
    w: 0.014,
    h: 0.014,
    type: 'checkbox',
  },

  // EARNEST MONEY section
  earnest_money_amount: {
    page: 1,
    x: 0.485,
    y: 0.114,
    w: 0.1,
    h: 0.016,
    type: 'text',
  },
  option_fee: {
    page: 1,
    x: 0.81,
    y: 0.114,
    w: 0.11,
    h: 0.016,
    type: 'text',
  },
  option_period_days: {
    page: 1,
    x: 0.123,
    y: 0.352,
    w: 0.05,
    h: 0.016,
    type: 'text',
  },

  // FINANCING section
  title_company_name: {
    page: 1,
    x: 0.475,
    y: 0.5545,
    w: 0.3,
    h: 0.016,
    type: 'text',
  },
  escrow_agent_name: {
    page: 1,
    x: 0.295,
    y: 0.1,
    w: 0.19,
    h: 0.016,
    type: 'text',
  },

  // CLOSING DATE
  closing_date: {
    page: 4,
    x: 0.4728139957911532,
    y: 0.7379900015090458,
    w: 0.215918398575044,
    h: 0.01609052079780948,
    type: 'text',
  },
};
