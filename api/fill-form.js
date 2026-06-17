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

