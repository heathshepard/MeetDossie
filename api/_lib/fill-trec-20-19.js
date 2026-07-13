// api/_lib/fill-trec-20-19.js
//
// Shared coordinate-fill pipeline for TREC 20-19 (One to Four Family
// Residential Contract, Resale — 2026-07-01 effective flat PDF).
//
// 2026-07-13 CARTER — extracted from api/fill-form.js so
// /api/interactive-editor-download-pdf can render the SAME filled PDF as
// /api/fill-form. Previously the download endpoint returned the blank
// template, which meant Preview + Download in the Interactive Editor
// showed empty forms. See .tmp/dossie-sign-2026-07-13-BLOCKED/.
//
// TREC 20-19 is a FLAT PDF (0 AcroForm fields). This module draws text
// at pre-extracted coordinates from api/_assets/trec-20-19-field-coords.json.
// Coords are in pdf-lib bottom-left origin.
//
// PUBLIC API
//   fillTrec2019(pdfDoc, fieldValues) — mutates the pdfDoc in place.
//   formatMoney(value)                — "425000" -> "425,000"
//   formatDate(iso)                   — "2026-08-15" -> "08/15/2026"

const TREC_20_19_COORDS = (() => {
  try {
    return require('../_assets/trec-20-19-field-coords.json');
  } catch (e) {
    console.warn('[fill-trec-20-19] Failed to load 20-19 coordinates:', e && e.message);
    return { fields: {} };
  }
})();

function formatDate(isoLike) {
  if (!isoLike) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoLike));
  if (!m) return String(isoLike);
  return m[2] + '/' + m[3] + '/' + m[1];
}

function formatMoney(value) {
  const n = Number(String(value == null ? '' : value).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return String(value == null ? '' : value);
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/**
 * Fill a TREC 20-19 (flat) PDF with `fv` values. Mutates pdfDoc in place.
 * See fill-form.js fillResaleContractCoordinate() history — this is the
 * canonical implementation now, both fill-form.js and
 * interactive-editor-download-pdf.js call this.
 */
async function fillTrec2019(pdfDoc, fv) {
  const pages = pdfDoc.getPages();
  const coordMap = TREC_20_19_COORDS.fields || {};

  function drawFieldText(fieldName, value, options = {}) {
    if (value == null || value === '') return;
    const coord = coordMap[fieldName];
    if (!coord) {
      console.warn('[fill-trec-20-19] No coordinate for field:', fieldName);
      return;
    }
    if (coord.page < 1 || coord.page > pages.length) {
      console.warn('[fill-trec-20-19] Page out of range for field:', fieldName, 'page:', coord.page);
      return;
    }
    const page = pages[coord.page - 1];
    const fontSize = options.fontSize || coord.fontSize || 10;
    try {
      page.drawText(String(value).slice(0, 200), {
        x: coord.x,
        y: coord.y,
        size: fontSize,
        ...options,
      });
    } catch (e) {
      console.warn('[fill-trec-20-19] drawText failed for', fieldName + ':', e && e.message);
    }
  }

  // PARTIES — buyer_name, seller_name
  drawFieldText('buyer_name', fv.buyer_name);
  drawFieldText('seller_name', fv.seller_name);

  // PROPERTY
  const addr = fv.property_address || '';
  drawFieldText('property_address', addr);
  drawFieldText('city_state_zip', fv.city_state_zip);
  drawFieldText('county', fv.county);

  // LEGAL DESCRIPTION
  drawFieldText('legal_description', fv.legal_description);
  drawFieldText('legal_lot', fv.legal_lot);
  drawFieldText('legal_block', fv.legal_block);
  drawFieldText('addition_name', fv.addition_name);
  drawFieldText('exclusions', fv.exclusions);

  // SALES PRICE (Section 3)
  let cashPortion = (fv.down_payment_amt != null && fv.down_payment_amt !== '') ? Number(fv.down_payment_amt) : null;
  if (cashPortion == null && fv.sale_price != null && fv.loan_amount != null) {
    cashPortion = Number(fv.sale_price) - Number(fv.loan_amount);
  }
  drawFieldText('down_payment_amt', cashPortion != null ? formatMoney(cashPortion) : '');
  drawFieldText('loan_amount', Number(fv.loan_amount) > 0 ? formatMoney(fv.loan_amount) : '');
  drawFieldText('sale_price', fv.sale_price != null && fv.sale_price !== '' ? formatMoney(fv.sale_price) : '');
  drawFieldText('additional_cash_closing', fv.additional_cash_closing);

  // POSSESSION (Section 10.A)
  const possession = String(fv.possession || 'closing').toLowerCase();
  if (possession === 'lease' || possession === 'lease_after' || possession === 'temporary_lease') {
    drawFieldText('possession', 'Lease');
  } else {
    drawFieldText('possession', 'Upon Closing');
  }

  // EARNEST MONEY / TITLE (Section 5)
  drawFieldText('earnest_money', fv.earnest_money != null && fv.earnest_money !== '' ? formatMoney(fv.earnest_money) : '');
  drawFieldText('escrow_agent_name', fv.escrow_agent_name || fv.title_company || '');
  drawFieldText('escrow_agent_address_line1', fv.escrow_agent_address_line1 || fv.escrow_agent_address || fv.title_company_address || '');
  drawFieldText('title_company', fv.title_company || '');
  drawFieldText('title_company_address', fv.title_company_address || '');
  drawFieldText('earnest_receipt_date', fv.earnest_receipt_date ? formatDate(fv.earnest_receipt_date) : '');

  // ¶5A(1) Additional earnest money
  drawFieldText('additional_earnest_money',
    fv.additional_earnest_money != null && fv.additional_earnest_money !== ''
      ? formatMoney(fv.additional_earnest_money) : '');
  drawFieldText('additional_earnest_days',
    fv.additional_earnest_days != null && fv.additional_earnest_days !== ''
      ? String(fv.additional_earnest_days) : '');

  // OPTION FEE / OPTION PERIOD
  drawFieldText('option_fee', fv.option_fee != null && fv.option_fee !== '' ? formatMoney(fv.option_fee) : '');
  const optPeriod = (fv.option_period_days != null && fv.option_period_days !== '') ? String(fv.option_period_days)
    : (fv.option_days != null && fv.option_days !== '') ? String(fv.option_days) : '';
  drawFieldText('option_period_days', optPeriod);

  // TITLE OBJECTION / SURVEY (Section 6)
  const titleObjDays = fv.title_objection_days != null && fv.title_objection_days !== ''
    ? String(fv.title_objection_days) : '10';
  drawFieldText('title_objection_days', titleObjDays);

  drawFieldText('title_objection_activity', fv.title_objection_activity || fv.permitted_use || '');

  // ¶6C Survey — three separate days blanks
  const surveyDaysSeller = fv.survey_days_seller != null && fv.survey_days_seller !== ''
    ? String(fv.survey_days_seller) : (fv.survey_furnish_days != null && fv.survey_furnish_days !== ''
      ? String(fv.survey_furnish_days) : '');
  drawFieldText('survey_days_seller', surveyDaysSeller);

  const surveyDaysBuyer = fv.survey_days_buyer != null && fv.survey_days_buyer !== ''
    ? String(fv.survey_days_buyer) : '';
  drawFieldText('survey_days_buyer', surveyDaysBuyer);

  const surveyDaysNew = fv.survey_days_new != null && fv.survey_days_new !== ''
    ? String(fv.survey_days_new) : '';
  drawFieldText('survey_days_new', surveyDaysNew);

  // PROPERTY CONDITION (Section 7)
  drawFieldText('required_repairs', fv.required_repairs || '');
  drawFieldText('repairs_additional', fv.repairs_additional || '');
  drawFieldText('service_contract_amount', fv.service_contract_amount ? formatMoney(fv.service_contract_amount) : '');

  // ¶7B(2) Seller's Disclosure Notice days
  drawFieldText('seller_disclosure_days',
    fv.seller_disclosure_days != null && fv.seller_disclosure_days !== ''
      ? String(fv.seller_disclosure_days) : '');
  // ¶7I(2) Seller's Water Disclosure days
  drawFieldText('water_disclosure_days',
    fv.water_disclosure_days != null && fv.water_disclosure_days !== ''
      ? String(fv.water_disclosure_days) : '');

  // ¶8 Broker relationship disclosure
  drawFieldText('broker_relationship_disclosure', fv.broker_relationship_disclosure || '');

  // CLOSING (Section 9)
  const closingDate = fv.closing_date ? formatDate(fv.closing_date) : '';
  drawFieldText('closing_date', closingDate);
  if (fv.closing_date) {
    const yearMatch = /^(\d{4})/.exec(String(fv.closing_date));
    if (yearMatch) {
      drawFieldText('closing_year', yearMatch[1].slice(2));
    }
  }

  // ¶12A(2)(b) Settlement expense cap (Seller for Buyer)
  drawFieldText('settlement_expense_cap',
    fv.settlement_expense_cap != null && fv.settlement_expense_cap !== ''
      ? formatMoney(fv.settlement_expense_cap) : '');

  // ATTORNEYS (Section 23)
  drawFieldText('buyer_attorney', fv.buyer_attorney || '');
  drawFieldText('seller_attorney', fv.seller_attorney || '');
  drawFieldText('buyer_attorney_phone', fv.buyer_attorney_phone || '');
  drawFieldText('seller_attorney_phone', fv.seller_attorney_phone || '');
  drawFieldText('buyer_attorney_email', fv.buyer_attorney_email || '');
  drawFieldText('seller_attorney_email', fv.seller_attorney_email || '');

  // ¶21 Notice addresses / phones / emails
  drawFieldText('buyer_notice_address', fv.buyer_notice_address || '');
  drawFieldText('seller_notice_address', fv.seller_notice_address || '');
  drawFieldText('buyer_notice_phone', fv.buyer_notice_phone || '');
  drawFieldText('seller_notice_phone', fv.seller_notice_phone || '');
  drawFieldText('buyer_notice_email', fv.buyer_notice_email || '');
  drawFieldText('seller_notice_email', fv.seller_notice_email || '');

  // ¶21 Agent notice
  drawFieldText('sellers_agent_address', fv.sellers_agent_address || fv.listing_broker_address || '');
  drawFieldText('buyers_agent_address', fv.buyers_agent_address || fv.other_broker_address || '');
  drawFieldText('sellers_agent_phone', fv.sellers_agent_phone || fv.listing_agent_phone || '');
  drawFieldText('buyers_agent_phone', fv.buyers_agent_phone || fv.other_broker_phone || '');
  drawFieldText('sellers_agent_email', fv.sellers_agent_email || fv.listing_agent_email || '');
  drawFieldText('buyers_agent_email', fv.buyers_agent_email || fv.other_broker_assoc_email || '');

  // FUNDING / CLOSING STATEMENT NOTICE (Section 15)
  const fundingDays = fv.funding_notice_days != null && fv.funding_notice_days !== ''
    ? String(fv.funding_notice_days) : '2';
  drawFieldText('funding_notice_days', fundingDays);

  const closingStmtDays = fv.closing_statement_days != null && fv.closing_statement_days !== ''
    ? String(fv.closing_statement_days) : '3';
  drawFieldText('closing_statement_days', closingStmtDays);

  // SELLER CONCESSIONS / BUYER AGENT COMMISSION (Section 12)
  drawFieldText('seller_concessions',
    (fv.seller_concessions != null && fv.seller_concessions !== '' && Number(fv.seller_concessions) > 0)
      ? formatMoney(fv.seller_concessions) : '');

  if (fv.buyer_agent_commission_amt != null && fv.buyer_agent_commission_amt !== ''
      && Number(fv.buyer_agent_commission_amt) > 0) {
    drawFieldText('buyer_agent_commission_amt', formatMoney(fv.buyer_agent_commission_amt));
  } else if (fv.buyer_agent_commission_pct != null && fv.buyer_agent_commission_pct !== ''
      && Number(fv.buyer_agent_commission_pct) > 0) {
    drawFieldText('buyer_agent_commission_pct', String(fv.buyer_agent_commission_pct));
  }

  // HOA (Section 2)
  if (fv.hoa_exists === true) {
    drawFieldText('hoa_exists', 'Yes');
  }
  drawFieldText('hoa_description', fv.hoa_description || '');

  // EXECUTION BLOCK
  if (fv.closing_date || fv.contract_effective_date) {
    const execDateStr = fv.contract_effective_date || fv.closing_date || '';
    const execMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(execDateStr));
    if (execMatch) {
      drawFieldText('execution_day', execMatch[3]);
      drawFieldText('execution_month', ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'][parseInt(execMatch[2], 10) - 1]);
      drawFieldText('execution_year_2digit', execMatch[1].slice(2));
    }
  }
  drawFieldText('buyer_email', fv.buyer_email || '');
  drawFieldText('seller_email', fv.seller_email || '');

  // INITIALS (empty by design per 2026-07-04 atlas_29 fix)
  drawFieldText('buyer_initials', '');
  drawFieldText('seller_initials', '');

  // 20-19 RESTRUCTURED BROKER COMPENSATION (¶12B page 7)
  if (fv.broker_compensation_buyer_agent_pct != null && fv.broker_compensation_buyer_agent_pct !== '') {
    drawFieldText('broker_compensation_buyer_agent_pct', String(fv.broker_compensation_buyer_agent_pct));
  }
  if (fv.broker_compensation_buyer_agent_amt != null && fv.broker_compensation_buyer_agent_amt !== '') {
    drawFieldText('broker_compensation_buyer_agent_amt', formatMoney(fv.broker_compensation_buyer_agent_amt));
  }
  if (fv.broker_compensation_other_broker_pct != null && fv.broker_compensation_other_broker_pct !== '') {
    drawFieldText('broker_compensation_other_broker_pct', String(fv.broker_compensation_other_broker_pct));
  }
  if (fv.broker_compensation_other_broker_amt != null && fv.broker_compensation_other_broker_amt !== '') {
    drawFieldText('broker_compensation_other_broker_amt', formatMoney(fv.broker_compensation_other_broker_amt));
  }

  // Sections intentionally blank at origination per DOSSIE DOMAIN ESSENTIALS
  // (2026-07-05 lock): §6E prose, page 11 broker section, page 12 escrow receipt.
  // See fill-form.js for the full domain-rule commentary.
}

module.exports = {
  fillTrec2019,
  formatMoney,
  formatDate,
  TREC_20_19_COORDS,
};
