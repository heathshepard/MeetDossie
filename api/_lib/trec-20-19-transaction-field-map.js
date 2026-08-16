// api/_lib/trec-20-19-transaction-field-map.js
//
// SEMANTICS layer for TREC 20-19 — the missing half of the field-map library.
//
// The two jobs are split permanently and this file is only ever the second one:
//
//   GEOMETRY  (where a field sits on the page)  -> deterministic, extracted from
//             AcroForm widget rects by scripts/extract-acroform-fields.js.
//             A model must never estimate a coordinate.
//   SEMANTICS (what a field MEANS, and which dossier column feeds it) -> this
//             file. Reviewed by a human once, versioned, checked into git.
//
// Why this exists
// ---------------
// interactive-editor-init.js used to resolve a field's value with:
//
//     Object.prototype.hasOwnProperty.call(txn, canonical) ? txn[canonical] : null
//
// i.e. it looked up the TREC field key as a literal `transactions` column name.
// Of the 180 agent-fillable keys on 20-19, exactly 10 collide with a real column
// by luck, so a fully-populated dossier prefilled almost nothing while sale
// price, earnest money, option fee and title company all sat in the row. That is
// the whole "Fill Contract filled 2 of 31 required fields" bug — not a geometry
// problem, a naming problem.
//
// Rules this file obeys
// ---------------------
// 1. NEVER invent a contract term. Every resolver returns a value only when the
//    dossier actually contains the data. No defaults, no "1% of sale price",
//    no `as_is = true`. A blank field is always correct-er than a guessed one.
// 2. Every returned value carries a provenance:
//      'record'  - copied verbatim out of one stored column.
//      'derived' - computed from stored columns by plain arithmetic or date
//                  math. `basis` names the exact columns used so the UI can
//                  show the agent how we got there.
//    There is deliberately no 'assumed' provenance in this module. Assumptions
//    are the extractor's business (extract-form-fields.js `_assumed`), and they
//    are surfaced separately and gated before signature.
// 3. One key -> one resolver. Ambiguity gets left blank, not resolved by
//    coin-flip.
//
// Bump MAP_VERSION on any semantic change. interactive-editor-init.js reports
// it in the init payload so a signature_request can be pinned to the map
// version that produced its values.
//
// CARTER 2026-08-16.

const MAP_VERSION = '2026-08-16.1';
const FORM_CODE = '20-19';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function present(v) {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

function num(v) {
  if (!present(v)) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// First column in `names` that actually holds something. Returns the column
// name too, so `basis` can name it honestly instead of guessing.
function firstPresent(txn, names) {
  for (const n of names) {
    if (present(txn[n])) return { value: txn[n], column: n };
  }
  return null;
}

function record(txn, ...columns) {
  return () => {
    const hit = firstPresent(txn, columns);
    if (!hit) return null;
    return { value: hit.value, provenance: 'record', basis: hit.column };
  };
}

// "123 Main St, San Antonio, TX 78209" for every "Contract Concerning" header.
function fullAddress(txn) {
  const street = present(txn.property_address) ? String(txn.property_address).trim() : '';
  const rest = present(txn.city_state_zip) ? String(txn.city_state_zip).trim() : '';
  if (!street && !rest) return null;
  const value = [street, rest].filter(Boolean).join(', ');
  return {
    value,
    provenance: rest ? 'derived' : 'record',
    basis: rest ? 'property_address + city_state_zip' : 'property_address',
  };
}

// Parses an ISO-ish date to { y, m, d } in LOCAL calendar terms.
//
// `new Date('2026-09-19')` parses as UTC midnight, so in any US timezone
// .getFullYear()/.getDate() roll back a day — this is the same UTC-vs-local
// shift that made every displayed TREC deadline one day early. Split the string
// instead of going through Date at all.
function calendarParts(v) {
  if (!present(v)) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return { y: Number(us[3]), m: Number(us[1]), d: Number(us[2]) };
  return null;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// TREC 20-19 checkbox 22 (AGREEMENT OF PARTIES) addenda. `transactions.addenda`
// / `addenda_attached` are free-form (array or object depending on vintage), so
// match on substrings rather than assuming a shape.
function addendaList(txn) {
  const raw = txn.addenda_attached != null ? txn.addenda_attached : txn.addenda;
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw.map((x) => String(x).toLowerCase());
  if (typeof raw === 'string') return [raw.toLowerCase()];
  if (typeof raw === 'object') {
    // { "third_party_financing": true, ... } -> the truthy keys
    return Object.entries(raw)
      .filter(([, v]) => v === true || v === 'true')
      .map(([k]) => String(k).toLowerCase());
  }
  return null;
}

// A §22 addendum box is ticked ONLY on an affirmative match.
//
// Returning 'false' here would be an assertion — "no Third Party Financing
// Addendum is attached to this contract" — made on the strength of an
// addenda list we have no reason to believe is complete. Dossie's own scanner
// has already been caught detecting an addendum in ¶3B that the dossier row
// never recorded. So absence of evidence stays blank and the agent decides.
function addendumChecked(txn, ...needles) {
  const list = addendaList(txn);
  if (!list) return null;
  const hit = list.some((entry) => needles.some((n) => entry.includes(n)));
  if (!hit) return null;
  return {
    value: 'true',
    provenance: 'derived',
    basis: txn.addenda_attached != null ? 'addenda_attached' : 'addenda',
  };
}

function boolField(txn, column, { invert = false } = {}) {
  return () => {
    const v = txn[column];
    if (v === null || v === undefined || v === '') return null;
    const truthy = v === true || v === 'true' || v === 'yes' || v === 'Yes';
    const val = invert ? !truthy : truthy;
    return { value: val ? 'true' : 'false', provenance: 'record', basis: column };
  };
}

// ---------------------------------------------------------------------------
// The map. key -> (txn) => { value, provenance, basis } | null
// ---------------------------------------------------------------------------

function buildResolvers(txn) {
  const addr = () => fullAddress(txn);

  // §3A cash portion. Only computed when BOTH sale price and loan amount are
  // stored — otherwise we would be asserting an all-cash or fully-financed deal
  // that nobody told us about. Falls back to a literal down_payment if present.
  const cashPortion = () => {
    const price = num(txn.sale_price);
    const loan = num(txn.loan_amount);
    if (price != null && loan != null) {
      const cash = price - loan;
      if (cash < 0) return null; // contradictory data — show blank, not nonsense
      return {
        value: String(cash),
        provenance: 'derived',
        basis: 'sale_price − loan_amount',
      };
    }
    if (present(txn.down_payment)) {
      return { value: txn.down_payment, provenance: 'record', basis: 'down_payment' };
    }
    return null;
  };

  const closingYear = () => {
    const p = calendarParts(txn.closing_date);
    if (!p) return null;
    return { value: String(p.y), provenance: 'derived', basis: 'closing_date' };
  };

  const executedPart = (part) => () => {
    const p = calendarParts(txn.contract_effective_date);
    if (!p) return null;
    const value = part === 'd' ? String(p.d)
      : part === 'm' ? MONTH_NAMES[p.m - 1]
        : String(p.y);
    if (!value) return null;
    return { value, provenance: 'derived', basis: 'contract_effective_date' };
  };

  return {
    // --- §1 PARTIES -------------------------------------------------------
    seller_name: record(txn, 'seller_name'),
    buyer_name: record(txn, 'buyer_name'),

    // --- §2A LAND / PROPERTY ---------------------------------------------
    // land_lot / land_block / land_addition are NOT derived by parsing
    // legal_description. That string's shape varies by county and a bad parse
    // writes a wrong legal description into a binding contract. Left blank.
    land_county: record(txn, 'county'),
    land_city: record(txn, 'land_city'),
    property_address: addr,
    exclusions: record(txn, 'fixtures_excluded'),

    // Every "Contract Concerning" page header is the same property address.
    property_address_p2: addr,
    property_address_p3: addr,
    property_address_p4: addr,
    property_address_page4: addr,
    property_address_page5: addr,
    property_address_page6: addr,
    property_address_page7: addr,
    property_address_header_p7: addr,
    property_address_header_p8: addr,
    property_address_header_p9: addr,
    property_address_header_p10: addr,
    property_address_page_10: addr,
    property_address_page_11: addr,

    // --- §3 SALES PRICE ---------------------------------------------------
    sales_price_cash_portion: cashPortion,
    sales_price_total: record(txn, 'sale_price'),

    // --- §5 EARNEST MONEY / OPTION FEE -----------------------------------
    escrow_agent_name: record(txn, 'earnest_money_title_company', 'title_company'),
    earnest_money_amount: record(txn, 'earnest_money_amount', 'earnest_money'),
    option_fee_amount: record(txn, 'option_fee_amount', 'option_fee'),
    option_period_days: record(txn, 'option_days'),

    // --- §6 TITLE / SURVEY ------------------------------------------------
    title_company_name: record(txn, 'title_company'),
    objection_days: record(txn, 'objection_days'),

    // --- §6E POA ----------------------------------------------------------
    hoa_membership: boolField(txn, 'hoa'),
    hoa_membership_is_not: boolField(txn, 'hoa', { invert: true }),

    // --- §7B SELLER'S DISCLOSURE -----------------------------------------
    sellers_disclosure_received: boolField(txn, 'sdn_received'),
    seller_disclosure_received: boolField(txn, 'sdn_received'),

    // --- §7D PROPERTY CONDITION ------------------------------------------
    // as_is is a material contract term. Only mirrored when the dossier
    // actually stores it — never defaulted to true.
    acceptance_as_is: boolField(txn, 'as_is'),
    specific_repairs_line1: record(txn, 'repairs_summary'),

    // --- §7H RESIDENTIAL SERVICE CONTRACT --------------------------------
    residential_service_contract_amount: record(txn, 'service_contract_amount'),

    // --- §9 CLOSING -------------------------------------------------------
    closing_date: record(txn, 'closing_date'),
    closing_year: closingYear,

    // --- §11 SPECIAL PROVISIONS ------------------------------------------
    special_provisions_line1: record(txn, 'special_provisions'),

    // --- §21 NOTICES ------------------------------------------------------
    buyer_notice_phone: record(txn, 'buyer_phone'),
    buyer_notice_email_fax_2: record(txn, 'buyer_email'),
    seller_notice_phone: record(txn, 'seller_phone'),
    seller_notice_email_fax_2: record(txn, 'seller_email'),

    // --- §22 AGREEMENT OF PARTIES (addenda checkboxes) -------------------
    addendum_third_party_financing: () => addendumChecked(txn, 'third party financing', 'third_party_financing'),
    addendum_lead_based_paint: () => addendumChecked(txn, 'lead', 'lead_based_paint'),
    addendum_sellers_temporary_lease: () => addendumChecked(txn, "seller's temporary", 'sellers_temporary', 'seller_temp'),
    addendum_buyers_temporary_lease: () => addendumChecked(txn, "buyer's temporary", 'buyers_temporary', 'buyer_temp'),
    addendum_hydrostatic_testing: () => addendumChecked(txn, 'hydrostatic'),
    addendum_environmental_assessment: () => addendumChecked(txn, 'environmental'),
    addendum_mineral_reservation: () => addendumChecked(txn, 'mineral'),
    addendum_propane_gas_service_area: () => addendumChecked(txn, 'propane'),
    addendum_improvement_district_assessment: () => addendumChecked(txn, 'improvement district'),

    // --- EXECUTED (effective date) ---------------------------------------
    executed_day: executedPart('d'),
    executed_month: executedPart('m'),
    executed_year: executedPart('y'),

    // --- BROKER INFORMATION ----------------------------------------------
    listing_broker_firm_name: record(txn, 'listing_broker_name'),
    listing_broker_license_no: record(txn, 'listing_broker_license_no'),
    listing_associate_name: record(txn, 'listing_agent_name'),
    listing_associate_license_no: record(txn, 'listing_agent_license_no'),
    listing_associate_email: record(txn, 'listing_agent_email_addr'),
    listing_associate_phone: record(txn, 'listing_agent_phone_no'),
    other_broker_firm_name: record(txn, 'other_broker_name'),
    other_broker_license_no: record(txn, 'other_broker_license_no'),
    other_associate_name: record(txn, 'other_agent_name'),
    other_associate_license_no: record(txn, 'other_agent_license_no'),
    other_associate_email: record(txn, 'other_agent_email_addr'),
    other_associate_phone: record(txn, 'other_agent_phone_no'),

    // --- RECEIPT BLOCKS (page 11) ----------------------------------------
    option_fee_receipt_date: record(txn, 'option_fee_paid_at'),
    earnest_money_escrow_agent_name: record(txn, 'earnest_money_title_company', 'title_company'),
    earnest_money_received_by: record(txn, 'escrow_officer_name', 'title_officer_name'),
    earnest_money_escrow_email: record(txn, 'title_officer_email'),
    earnest_money_escrow_phone: record(txn, 'title_officer_phone'),
    earnest_money_receipt_datetime: record(txn, 'earnest_money_deposited_at'),
    contract_receipt_escrow_agent_name: record(txn, 'title_company'),
    contract_receipt_received_by: record(txn, 'escrow_officer_name', 'title_officer_name'),
    contract_receipt_escrow_email: record(txn, 'title_officer_email'),
    contract_receipt_escrow_phone: record(txn, 'title_officer_phone'),
    additional_em_escrow_agent_name: record(txn, 'title_company'),
    additional_em_received_by: record(txn, 'escrow_officer_name', 'title_officer_name'),
    additional_em_escrow_email: record(txn, 'title_officer_email'),
    additional_em_escrow_phone: record(txn, 'title_officer_phone'),
  };
}

/**
 * Resolve one TREC 20-19 field key against a transactions row.
 *
 * @returns {{value: string, provenance: 'record'|'derived', basis: string}|null}
 *          null means "the dossier does not contain this" — the caller must
 *          leave the field blank rather than substitute anything.
 */
function resolveFieldValue(key, txn) {
  if (!key || !txn) return null;
  const resolvers = buildResolvers(txn);
  const fn = resolvers[key];
  if (!fn) return null;
  let out = null;
  try {
    out = fn();
  } catch (_err) {
    return null; // a broken resolver must never poison a contract field
  }
  if (!out || !present(out.value)) return null;
  return { value: String(out.value), provenance: out.provenance, basis: out.basis };
}

/** Every key this map knows how to fill. Used by tests + coverage reporting. */
function mappedKeys() {
  return Object.keys(buildResolvers({}));
}

module.exports = {
  MAP_VERSION,
  FORM_CODE,
  resolveFieldValue,
  mappedKeys,
  // exported for unit tests
  calendarParts,
};
