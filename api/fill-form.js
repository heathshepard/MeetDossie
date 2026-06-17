// ---------------------------------------------------------------------------
// THIRD PARTY FINANCING ADDENDUM (TREC 40-11 / 40-12)
// 53 verified AcroForm fields. CRITICAL: PDF field names are MISLEADING.
// Trust field-map-trec40-acroform.js which maps semantics → PDF names
// using position-based disambiguation (page + y-coordinate).
// ---------------------------------------------------------------------------
// THIRD PARTY FINANCING ADDENDUM (TREC 40-11 / 40-12)
// 53 verified AcroForm fields. CRITICAL: PDF field names are MISLEADING.
// Trust field-map-trec40-acroform.js which maps semantics → PDF names
// using position-based disambiguation (page + y-coordinate).
// ---------------------------------------------------------------------------
async function fillFinancingAddendum(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  const fieldMap = FIELD_MAP_TREC40_ACROFORM;

  // Utility: safely set a text field, handling widget_index for Text2 disambiguation
  const setFieldValue = (form, mapEntry, value) => {
    if (!value && value !== 0) return;
    const valueStr = String(value).trim();
    if (!valueStr) return;

    if (typeof mapEntry === 'string') {
      safeSetText(form, mapEntry, valueStr);
    } else if (mapEntry && typeof mapEntry === 'object' && mapEntry.field) {
      try {
        const field = form.getField(mapEntry.field);
        if (field && typeof field.setText === 'function') {
          if (mapEntry.widget_index != null) {
            const widgets = field.acroField.getWidgets();
            if (widgets && widgets[mapEntry.widget_index]) {
              field.setText(valueStr, mapEntry.widget_index);
            } else {
              field.setText(valueStr);
            }
          } else {
            field.setText(valueStr);
          }
        }
      } catch (e) {
        console.warn(`[fill-form] Could not set field ${mapEntry.field}:`, e.message);
      }
    }
  };

  const checkField = (form, fieldName) => {
    if (!fieldName) return;
    safeCheck(form, fieldName);
  };

  // Property identification
  if (fv.property_address) {
    setFieldValue(form, fieldMap.property_address_page1, fv.property_address);
    setFieldValue(form, fieldMap.property_address_page2, fv.property_address);
  }

  const ft = String(fv.financing_type || '').toLowerCase();
  const isConventional = ft === 'conventional' || fv.financing_type_conventional === true;
  const isTxVeterans = ft === 'tx-vet' || ft === 'tx_veterans' || fv.financing_type_tx_vet === true;
  const isFHA = ft === 'fha' || fv.financing_type_fha === true;
  const isVA = ft === 'va' || fv.financing_type_va === true;
  const isUSDA = ft === 'usda' || fv.financing_type_usda === true;
  const isReverse = ft === 'reverse' || fv.financing_type_reverse_mortgage === true;
  const isOther = ft === 'other' || fv.financing_type_other === true;

  // Section A: Conventional
  if (isConventional) {
    checkField(form, fieldMap.section_a_conventional);
    if (fv.a1_loan_amount || fv.principal_amount || fv.loan_amount) {
      checkField(form, fieldMap.a1_first_mortgage_checkbox);
      const a1Amt = fv.a1_loan_amount || fv.principal_amount || fv.loan_amount;
      setFieldValue(form, fieldMap.a1_loan_amount, formatMoney(a1Amt));
    }
    if (fv.a1_term_years) setFieldValue(form, fieldMap.a1_term_years, fv.a1_term_years);
    if (fv.a1_interest_rate) setFieldValue(form, fieldMap.a1_interest_rate, fv.a1_interest_rate);
    if (fv.a1_interest_term_years) setFieldValue(form, fieldMap.a1_interest_term_years, fv.a1_interest_term_years);
    if (fv.a1_origination_pct) setFieldValue(form, fieldMap.a1_origination_pct, fv.a1_origination_pct);
    if (fv.a2_loan_amount) {
      checkField(form, fieldMap.a2_second_mortgage_checkbox);
      setFieldValue(form, fieldMap.a2_loan_amount, formatMoney(fv.a2_loan_amount));
    }
    if (fv.a2_term_years) setFieldValue(form, fieldMap.a2_term_years, fv.a2_term_years);
    if (fv.a2_interest_rate) setFieldValue(form, fieldMap.a2_interest_rate, fv.a2_interest_rate);
    if (fv.a2_interest_term_years) setFieldValue(form, fieldMap.a2_interest_term_years, fv.a2_interest_term_years);
    if (fv.a2_origination_pct) setFieldValue(form, fieldMap.a2_origination_pct, fv.a2_origination_pct);
  }

  // Section B: TX Veterans
  if (isTxVeterans) {
    checkField(form, fieldMap.section_b_tx_veterans);
    const bAmt = fv.b_loan_amount || fv.principal_amount || fv.loan_amount;
    if (bAmt) setFieldValue(form, fieldMap.b_loan_amount, formatMoney(bAmt));
    if (fv.b_term_years) setFieldValue(form, fieldMap.b_term_years, fv.b_term_years);
  }

  // Section C: FHA
  if (isFHA) {
    checkField(form, fieldMap.section_c_fha);
    if (fv.fha_section_number) setFieldValue(form, fieldMap.c_fha_section_number, fv.fha_section_number);
    const cAmt = fv.c_loan_amount || fv.principal_amount || fv.loan_amount;
    if (cAmt) setFieldValue(form, fieldMap.c_loan_amount, formatMoney(cAmt));
    if (fv.c_term_years) setFieldValue(form, fieldMap.c_term_years, fv.c_term_years);
    if (fv.c_interest_rate) setFieldValue(form, fieldMap.c_interest_rate, fv.c_interest_rate);
    if (fv.c_interest_term_years) setFieldValue(form, fieldMap.c_interest_term_years, fv.c_interest_term_years);
    if (fv.c_origination_pct) setFieldValue(form, fieldMap.c_origination_pct, fv.c_origination_pct);
  }

  // Section D: VA
  if (isVA) {
    checkField(form, fieldMap.section_d_va);
    const dAmt = fv.d_loan_amount || fv.principal_amount || fv.loan_amount;
    if (dAmt) setFieldValue(form, fieldMap.d_loan_amount, formatMoney(dAmt));
    if (fv.d_term_years) setFieldValue(form, fieldMap.d_term_years, fv.d_term_years);
    if (fv.d_interest_rate) setFieldValue(form, fieldMap.d_interest_rate, fv.d_interest_rate);
    if (fv.d_interest_term_years) setFieldValue(form, fieldMap.d_interest_term_years, fv.d_interest_term_years);
    if (fv.d_origination_pct) setFieldValue(form, fieldMap.d_origination_pct, fv.d_origination_pct);
    if (fv.va_appraised_value) setFieldValue(form, fieldMap.va_appraised_value, formatMoney(fv.va_appraised_value));
  }

  // Section E: USDA
  if (isUSDA) {
    checkField(form, fieldMap.section_e_usda);
    const eAmt = fv.e_loan_amount || fv.principal_amount || fv.loan_amount;
    if (eAmt) setFieldValue(form, fieldMap.e_loan_amount, formatMoney(eAmt));
    if (fv.e_term_years) setFieldValue(form, fieldMap.e_term_years, fv.e_term_years);
    if (fv.e_interest_rate) setFieldValue(form, fieldMap.e_interest_rate, fv.e_interest_rate);
    if (fv.e_interest_term_years) setFieldValue(form, fieldMap.e_interest_term_years, fv.e_interest_term_years);
    if (fv.e_origination_pct) setFieldValue(form, fieldMap.e_origination_pct, fv.e_origination_pct);
  }

  // Section F: Reverse Mortgage
  if (isReverse) {
    checkField(form, fieldMap.section_f_reverse_mortgage);
    const fAmt = fv.f_loan_amount || fv.principal_amount || fv.loan_amount;
    if (fAmt) setFieldValue(form, fieldMap.f_loan_amount, formatMoney(fAmt));
    if (fv.f_term_years) setFieldValue(form, fieldMap.f_term_years, fv.f_term_years);
    if (fv.f_interest_rate) setFieldValue(form, fieldMap.f_interest_rate, fv.f_interest_rate);
    if (fv.f_origination_pct) setFieldValue(form, fieldMap.f_origination_pct, fv.f_origination_pct);
    if (fv.f_will_be_fha_insured === true) checkField(form, fieldMap.f_will_be_fha_insured);
    if (fv.f_will_not_be_fha_insured === true) checkField(form, fieldMap.f_will_not_be_fha_insured);
  }

  // Section G: Other
  if (isOther) {
    checkField(form, fieldMap.section_g_other_financing);
    const gAmt = fv.g_loan_amount || fv.principal_amount || fv.loan_amount;
    if (gAmt) setFieldValue(form, fieldMap.g_loan_amount, formatMoney(gAmt));
    if (fv.g_term_years) setFieldValue(form, fieldMap.g_term_years, fv.g_term_years);
    if (fv.g_interest_rate) setFieldValue(form, fieldMap.g_interest_rate, fv.g_interest_rate);
    if (fv.g_interest_term_years) setFieldValue(form, fieldMap.g_interest_term_years, fv.g_interest_term_years);
    if (fv.g_origination_pct) setFieldValue(form, fieldMap.g_origination_pct, fv.g_origination_pct);
    if (fv.g_second_origination_or_sub) setFieldValue(form, fieldMap.g_second_origination_or_sub, fv.g_second_origination_or_sub);
    if (fv.g_will === true) checkField(form, fieldMap.g_will_checkbox);
    if (fv.g_will_not === true) checkField(form, fieldMap.g_will_not_checkbox);
  }

  // Page 2 approvals
  if (fv.buyer_approval_days) setFieldValue(form, fieldMap.buyer_approval_days, fv.buyer_approval_days);

  try { form.updateFieldAppearances(); } catch (e) { console.warn('[fill-form] updateFieldAppearances failed:', e.message); }

  return pdfDoc;
}

// ---------------------------------------------------------------------------
// AMENDMENT TO CONTRACT (TREC 39-10 / 39-11)
// 30 verified AcroForm fields + 6 fields needing coordinate overlay.
// Atlas verified field mapping 2026-06-16. Trust the field names in the map.
// ---------------------------------------------------------------------------
async function fillAmendmentAcroForm(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  const FIELD_MAP = require('./field-map-trec39-acroform.js');

  const safeSetText = (form, name, value) => {
    if (!value && value !== 0) return;
    const valueStr = String(value).trim();
    if (!valueStr) return;

    try {
      const field = form.getTextField(name);
      if (!field) return;
      const max = field.getMaxLength();
      let v = valueStr;
      if (max && v.length > max) v = v.slice(0, max);
      field.setText(v);
    } catch (e) {
      console.warn(`[fillAmendmentAcroForm] Could not set text field "${name}":`, e.message);
    }
  };

  const safeCheck = (form, name) => {
    try {
      const box = form.getCheckBox(name);
      if (box) box.check();
    } catch (e) {
      console.warn(`[fillAmendmentAcroForm] Could not check field "${name}":`, e.message);
    }
  };

  const formatDate = (iso) => {
    if (!iso) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    if (!m) return String(iso);
    return `${m[2]}/${m[3]}/${m[1]}`;
  };

  const formatMoney = (v) => {
    const n = Number(String(v || '').replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(n)) return String(v || '');
    return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  };

  // =========================================================================
  // HEADER: Property Address
  // =========================================================================
  if (fv.property_address) {
    safeSetText(form, FIELD_MAP.property_address, fv.property_address);
  }

  // =========================================================================
  // SECTION 1: SALES PRICE CHANGE
  // =========================================================================
  if (fv.sales_price_change_active === true) {
    safeCheck(form, FIELD_MAP.sales_price_change_active);
  }
  if (fv.new_cash_portion) {
    safeSetText(form, FIELD_MAP.new_cash_portion, formatMoney(fv.new_cash_portion));
  }
  if (fv.new_financing_amount) {
    safeSetText(form, FIELD_MAP.new_financing_amount, formatMoney(fv.new_financing_amount));
  }
  if (fv.new_sales_price_total) {
    safeSetText(form, FIELD_MAP.new_sales_price_total, formatMoney(fv.new_sales_price_total));
  }

  // =========================================================================
  // SECTION 2: SELLER REPAIRS & TREATMENTS
  // =========================================================================
  if (fv.seller_repairs_treatments_active === true) {
    safeCheck(form, FIELD_MAP.seller_repairs_treatments_active);
  }
  if (fv.seller_repairs_treatments_list) {
    safeSetText(form, FIELD_MAP.seller_repairs_treatments_list, fv.seller_repairs_treatments_list);
  }

  // =========================================================================
  // SECTION 3: CLOSING DATE CHANGE
  // =========================================================================
  if (fv.closing_date_change_active === true) {
    safeCheck(form, FIELD_MAP.closing_date_change_active);
  }
  if (fv.new_closing_date_month_day) {
    safeSetText(form, FIELD_MAP.new_closing_date_month_day, fv.new_closing_date_month_day);
  }
  if (fv.new_closing_date_year_suffix) {
    safeSetText(form, FIELD_MAP.new_closing_date_year_suffix, fv.new_closing_date_year_suffix);
  }

  // =========================================================================
  // SECTION 4: FINANCING AMOUNT (PARA 12A1b)
  // =========================================================================
  if (fv.financing_amount_change_active === true) {
    safeCheck(form, FIELD_MAP.financing_amount_change_active);
  }
  if (fv.new_financing_amount_12A1b) {
    safeSetText(form, FIELD_MAP.new_financing_amount_12A1b, formatMoney(fv.new_financing_amount_12A1b));
  }
  if (fv.buyer_will_deliver_revised_approval === true) {
    safeCheck(form, FIELD_MAP.buyer_will_deliver_revised_approval);
  }
  if (fv.buyer_will_not_deliver_revised_approval === true) {
    safeCheck(form, FIELD_MAP.buyer_will_not_deliver_revised_approval);
  }
  if (fv.revised_approval_notice_days) {
    safeSetText(form, FIELD_MAP.revised_approval_notice_days, String(fv.revised_approval_notice_days));
  }

  // =========================================================================
  // SECTION 5: LENDER REQUIRED REPAIRS
  // =========================================================================
  if (fv.lender_required_repairs_active === true) {
    safeCheck(form, FIELD_MAP.lender_required_repairs_active);
  }
  if (fv.lender_repairs_not_to_exceed_amount) {
    safeSetText(form, FIELD_MAP.lender_repairs_not_to_exceed_amount, formatMoney(fv.lender_repairs_not_to_exceed_amount));
  }
  // NOTE: Para 5 Buyer/Seller choice has no AcroForm field — needs overlay or manual entry

  // =========================================================================
  // SECTION 6: ADDITIONAL OPTION FEE
  // =========================================================================
  if (fv.additional_option_fee_active === true) {
    safeCheck(form, FIELD_MAP.additional_option_fee_active);
  }
  if (fv.additional_option_fee_amount) {
    safeSetText(form, FIELD_MAP.additional_option_fee_amount, formatMoney(fv.additional_option_fee_amount));
  }
  if (fv.additional_option_fee_extension_days) {
    safeSetText(form, FIELD_MAP.additional_option_fee_extension_days, String(fv.additional_option_fee_extension_days));
  }
  if (fv.additional_option_fee_new_end_date) {
    safeSetText(form, FIELD_MAP.additional_option_fee_new_end_date, fv.additional_option_fee_new_end_date);
  }
  if (fv.additional_option_fee_credit_yes === true) {
    safeCheck(form, FIELD_MAP.additional_option_fee_credit_yes);
  }
  if (fv.additional_option_fee_credit_no === true) {
    safeCheck(form, FIELD_MAP.additional_option_fee_credit_no);
  }

  // =========================================================================
  // SECTION 7: BUYER WAIVES UNRESTRICTED TERMINATION
  // =========================================================================
  if (fv.buyer_waives_unrestricted_termination_active === true) {
    safeCheck(form, FIELD_MAP.buyer_waives_unrestricted_termination_active);
  }

  // =========================================================================
  // SECTION 8: BUYER APPROVAL DATE CHANGE
  // =========================================================================
  if (fv.buyer_approval_date_change_active === true) {
    safeCheck(form, FIELD_MAP.buyer_approval_date_change_active);
  }
  if (fv.new_buyer_approval_notice_date_month_day) {
    safeSetText(form, FIELD_MAP.new_buyer_approval_notice_date_month_day, fv.new_buyer_approval_notice_date_month_day);
  }
  if (fv.new_buyer_approval_notice_year_suffix) {
    safeSetText(form, FIELD_MAP.new_buyer_approval_notice_year_suffix, fv.new_buyer_approval_notice_year_suffix);
  }

  // =========================================================================
  // SECTION 9: OTHER MODIFICATIONS
  // =========================================================================
  if (fv.other_modifications_active === true) {
    safeCheck(form, FIELD_MAP.other_modifications_active);
  }
  if (fv.other_modifications_line_1) {
    safeSetText(form, FIELD_MAP.other_modifications_line_1, fv.other_modifications_line_1);
  }
  if (fv.other_modifications_line_2) {
    safeSetText(form, FIELD_MAP.other_modifications_line_2, fv.other_modifications_line_2);
  }
  if (fv.other_modifications_line_3) {
    safeSetText(form, FIELD_MAP.other_modifications_line_3, fv.other_modifications_line_3);
  }
  if (fv.other_modifications_overflow_8) {
    safeSetText(form, FIELD_MAP.other_modifications_overflow_8, fv.other_modifications_overflow_8);
  }
  if (fv.other_modifications_overflow_9) {
    safeSetText(form, FIELD_MAP.other_modifications_overflow_9, fv.other_modifications_overflow_9);
  }
  if (fv.other_modifications_overflow_10) {
    safeSetText(form, FIELD_MAP.other_modifications_overflow_10, fv.other_modifications_overflow_10);
  }

  // =========================================================================
  // SECTION 10: CONSULT ATTORNEY
  // =========================================================================
  if (fv.consult_attorney_acknowledgement === true) {
    safeCheck(form, FIELD_MAP.consult_attorney_acknowledgement);
  }

  // =========================================================================
  // FOOTER: EXECUTION BLOCK (date of signing)
  // =========================================================================
  if (fv.executed_day_of_month) {
    safeSetText(form, FIELD_MAP.executed_day_of_month, String(fv.executed_day_of_month));
  }
  if (fv.executed_month_name) {
    safeSetText(form, FIELD_MAP.executed_month_name, fv.executed_month_name);
  }
  if (fv.executed_year_suffix) {
    safeSetText(form, FIELD_MAP.executed_year_suffix, String(fv.executed_year_suffix));
  }

  // =========================================================================
  // SIGNATURE BLOCK
  // =========================================================================
  // NOTE: Signature fields are not auto-populated; they're signed in DocuSeal or by hand.
  // Printed names, initials, and signature dates are also not in AcroForm fields.

  try {
    form.updateFieldAppearances();
  } catch (e) {
    console.warn('[fillAmendmentAcroForm] updateFieldAppearances failed:', e.message);
  }

  return pdfDoc;
}



// ---------------------------------------------------------------------------
// HOA ADDENDUM (TREC 36-11)
// 17 verified AcroForm fields. Atlas verified 2026-06-15.
// ---------------------------------------------------------------------------
async function fillHOAAddendumAcroForm(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  const FIELD_MAP = require("./field-map-trec36-acroform.js");

  const safeSetText = (form, name, value) => {
    if (!value && value !== 0) return;
    const valueStr = String(value).trim();
    if (!valueStr) return;
    try {
      const field = form.getTextField(name);
      if (!field) return;
      const max = field.getMaxLength();
      let v = valueStr;
      if (max && v.length > max) v = v.slice(0, max);
      field.setText(v);
    } catch (e) {
      console.warn(`[fillHOAAddendumAcroForm] Could not set text field "${name}":`, e.message);
    }
  };

  const safeCheck = (form, name) => {
    try {
      const box = form.getCheckBox(name);
      if (box) box.check();
    } catch (e) {
      console.warn(`[fillHOAAddendumAcroForm] Could not check field "${name}":`, e.message);
    }
  };

  if (fv.property_address) {
    const f = FIELD_MAP.fields.find(f => f.key === "property_address");
    if (f) safeSetText(form, f.acroform_name, fv.property_address);
  }
  if (fv.hoa_name_and_phone) {
    const f = FIELD_MAP.fields.find(f => f.key === "hoa_name_and_phone");
    if (f) safeSetText(form, f.acroform_name, fv.hoa_name_and_phone);
  }

  if (fv.section_a_item1_check === true) {
    const f = FIELD_MAP.fields.find(f => f.key === "section_a_item1_check");
    if (f) safeCheck(form, f.acroform_name);
  }
  if (fv.section_a_item1_days) {
    const f = FIELD_MAP.fields.find(f => f.key === "section_a_item1_days");
    if (f) safeSetText(form, f.acroform_name, String(fv.section_a_item1_days));
  }

  if (fv.section_a_item2_check === true) {
    const f = FIELD_MAP.fields.find(f => f.key === "section_a_item2_check");
    if (f) safeCheck(form, f.acroform_name);
  }
  if (fv.section_a_item2_days) {
    const f = FIELD_MAP.fields.find(f => f.key === "section_a_item2_days");
    if (f) safeSetText(form, f.acroform_name, String(fv.section_a_item2_days));
  }

  if (fv.section_a_item3_check === true) {
    const f = FIELD_MAP.fields.find(f => f.key === "section_a_item3_check");
    if (f) safeCheck(form, f.acroform_name);
  }

  if (fv.section_a_item4_check === true) {
    const f = FIELD_MAP.fields.find(f => f.key === "section_a_item4_check");
    if (f) safeCheck(form, f.acroform_name);
  }

  if (fv.section_c_buyer_requires_resale_cert === true) {
    const f = FIELD_MAP.fields.find(f => f.key === "section_c_buyer_requires_resale_cert");
    if (f) safeCheck(form, f.acroform_name);
  }
  if (fv.section_c_buyer_does_not_require_resale_cert === true) {
    const f = FIELD_MAP.fields.find(f => f.key === "section_c_buyer_does_not_require_resale_cert");
    if (f) safeCheck(form, f.acroform_name);
  }

  if (fv.section_d_reserves_text) {
    const f = FIELD_MAP.fields.find(f => f.key === "section_d_reserves_text");
    if (f) safeSetText(form, f.acroform_name, fv.section_d_reserves_text);
  }

  if (fv.section_e_buyer_pays_title_company === true) {
    const f = FIELD_MAP.fields.find(f => f.key === "section_e_buyer_pays_title_company");
    if (f) safeCheck(form, f.acroform_name);
  }
  if (fv.section_e_seller_pays_title_company === true) {
    const f = FIELD_MAP.fields.find(f => f.key === "section_e_seller_pays_title_company");
    if (f) safeCheck(form, f.acroform_name);
  }

  try { form.updateFieldAppearances(); } catch (e) { console.warn("[fillHOAAddendumAcroForm] updateFieldAppearances failed:", e.message); }
  return pdfDoc;
}


// ---------------------------------------------------------------------------
// LEAD-BASED PAINT ADDENDUM (OP-L)
// 25 verified AcroForm fields. Atlas verified 2026-06-15.
// ---------------------------------------------------------------------------
async function fillLeadBasedPaintAcroForm(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  const FIELD_MAP = require("./field-map-opl-acroform.js");

  const safeSetText = (form, name, value) => {
    if (!value && value !== 0) return;
    const valueStr = String(value).trim();
    if (!valueStr) return;
    try {
      const field = form.getTextField(name);
      if (!field) return;
      field.setText(valueStr);
    } catch (e) {
      console.warn(`[fillLeadBasedPaintAcroForm] Could not set "${name}":`, e.message);
    }
  };

  const safeCheck = (form, name) => {
    try {
      const box = form.getCheckBox(name);
      if (box) box.check();
    } catch (e) {
      console.warn(`[fillLeadBasedPaintAcroForm] Could not check "${name}":`, e.message);
    }
  };

  if (fv.property_address) safeSetText(form, "Street Address and City", fv.property_address);

  if (fv.seller_knows_lead_paint_present === true) safeCheck(form, "Check Box7");
  if (fv.seller_known_lead_paint_explanation_line1) safeSetText(form, "undefined", fv.seller_known_lead_paint_explanation_line1);
  if (fv.seller_known_lead_paint_explanation_line2) safeSetText(form, "b Seller has no actual knowledge of leadbased paint andor leadbased paint hazards in the Property", fv.seller_known_lead_paint_explanation_line2);
  if (fv.seller_no_knowledge_lead_paint === true) safeCheck(form, "Check Box8");

  if (fv.seller_provided_records === true) safeCheck(form, "Check Box9");
  if (fv.seller_records_documents_list) safeSetText(form, "undefined_2", fv.seller_records_documents_list);
  if (fv.seller_records_documents_list_line2) safeSetText(form, "b Seller has no reports or records pertaining to leadbased paint andor leadbased paint hazards in the", fv.seller_records_documents_list_line2);
  if (fv.seller_no_records === true) safeCheck(form, "Check Box10");

  if (fv.buyer_waives_inspection === true) safeCheck(form, "Check Box11");
  if (fv.buyer_reserves_inspection === true) safeCheck(form, "Check Box12");

  if (fv.buyer_received_copies === true) safeCheck(form, "Check Box13");
  if (fv.buyer_received_pamphlet === true) safeCheck(form, "Check Box14");

  if (fv.buyer_1_date) safeSetText(form, "Date", fv.buyer_1_date);
  if (fv.seller_1_date) safeSetText(form, "Date_2", fv.seller_1_date);
  if (fv.buyer_2_date) safeSetText(form, "Date_3", fv.buyer_2_date);
  if (fv.seller_2_date) safeSetText(form, "Date_4", fv.seller_2_date);
  if (fv.buyer_broker_date) safeSetText(form, "Date_5", fv.buyer_broker_date);
  if (fv.seller_broker_date) safeSetText(form, "Date_6", fv.seller_broker_date);

  try { form.updateFieldAppearances(); } catch (e) { console.warn("[fillLeadBasedPaintAcroForm] updateFieldAppearances failed:", e.message); }
  return pdfDoc;
}


// ---------------------------------------------------------------------------
// BACKUP CONTRACT (TREC 11-9)
// 13 verified AcroForm fields. Atlas verified 2026-06-15.
// ---------------------------------------------------------------------------
async function fillBackupContractAcroForm(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  const FIELD_MAP = require("./field-map-trec11-acroform.js");

  const safeSetText = (form, name, value) => {
    if (!value && value !== 0) return;
    const valueStr = String(value).trim();
    if (!valueStr) return;
    try {
      const field = form.getTextField(name);
      if (!field) return;
      field.setText(valueStr);
    } catch (e) {
      console.warn(`[fillBackupContractAcroForm] Could not set "${name}":`, e.message);
    }
  };

  if (fv.property_address_page1) safeSetText(form, "Address of Property", fv.property_address_page1);
  if (fv.property_address_page2) safeSetText(form, "Text2", fv.property_address_page2);

  if (fv.additional_earnest_money_amount) safeSetText(form, "Text1", fv.additional_earnest_money_amount);
  if (fv.additional_option_fee_amount) safeSetText(form, "Text1 1", fv.additional_option_fee_amount);
  if (fv.additional_earnest_money_delivery_days) safeSetText(form, "Text1 2", String(fv.additional_earnest_money_delivery_days));

  if (fv.first_contract_termination_deadline_phrase) safeSetText(form, "Except as provided by this Addendum neither party is required to perform under the", fv.first_contract_termination_deadline_phrase);
  if (fv.first_contract_termination_year_1) safeSetText(form, "20", String(fv.first_contract_termination_year_1));

  if (fv.first_contract_termination_notice_phrase) safeSetText(form, "the BackUp Contract terminates and the earnest money will be refunded to Buyer  Seller must", fv.first_contract_termination_notice_phrase);
  if (fv.first_contract_termination_year_2) safeSetText(form, "20_2", String(fv.first_contract_termination_year_2));

  if (fv.buyer_initials_1) safeSetText(form, "Text3", fv.buyer_initials_1);
  if (fv.buyer_initials_2) safeSetText(form, "Text3 3", fv.buyer_initials_2);
  if (fv.seller_initials_1) safeSetText(form, "Text31", fv.seller_initials_1);
  if (fv.seller_initials_2) safeSetText(form, "Text31 2", fv.seller_initials_2);

  try { form.updateFieldAppearances(); } catch (e) { console.warn("[fillBackupContractAcroForm] updateFieldAppearances failed:", e.message); }
  return pdfDoc;
}


module.exports = {
  fillHOAAddendumAcroForm,
  fillLeadBasedPaintAcroForm,
  fillBackupContractAcroForm,
};
