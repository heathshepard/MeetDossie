// Test script for TREC 40 FHA financing addendum filling
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

// Load the base64 PDF
const TREC_FINANCING_B64 = require('../api/_assets/trec-financing-base64.js');
const FIELD_MAP_TREC40_ACROFORM = require('../api/_assets/field-map-trec40-acroform.js');

// Utility functions from fill-form.js
const safeSetText = (form, fieldName, value) => {
  try {
    const field = form.getField(fieldName);
    if (field && typeof field.setText === 'function') {
      field.setText(String(value));
    }
  } catch (e) {
    console.log(`[safeSetText] Field not found or error: ${fieldName}`);
  }
};

const safeCheck = (form, fieldName) => {
  try {
    const field = form.getField(fieldName);
    if (field && typeof field.check === 'function') {
      field.check();
    }
  } catch (e) {
    console.log(`[safeCheck] Field not found or error: ${fieldName}`);
  }
};

const formatMoney = (val) => {
  if (!val) return '';
  const num = typeof val === 'string' ? parseFloat(val) : val;
  return num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
};

// Main test
async function testFHA() {
  console.log('Loading TREC 40 base64 PDF...');
  const pdfBytes = Buffer.from(TREC_FINANCING_B64, 'base64');
  const pdfDoc = await PDFDocument.load(pdfBytes);
  
  const form = pdfDoc.getForm();
  const fieldMap = FIELD_MAP_TREC40_ACROFORM;

  console.log('Filling FHA scenario...');
  const fv = {
    property_address: '123 Main St',
    financing_type: 'fha',
    financing_type_fha: true,
    fha_section_number: '203(b)',
    c_loan_amount: '482500',
    c_term_years: '30',
    c_interest_rate: '6.5',
    c_origination_pct: '1.5',
    buyer_approval_days: '21',
  };

  // Fill property address
  safeSetText(form, fieldMap.property_address_page1, fv.property_address);
  safeSetText(form, fieldMap.property_address_page2, fv.property_address);

  // Check FHA checkbox
  safeCheck(form, fieldMap.section_c_fha);

  // Fill FHA fields
  safeSetText(form, fieldMap.c_fha_section_number, fv.fha_section_number);
  safeSetText(form, fieldMap.c_loan_amount, formatMoney(fv.c_loan_amount));
  safeSetText(form, fieldMap.c_term_years, fv.c_term_years);
  safeSetText(form, fieldMap.c_interest_rate, fv.c_interest_rate);
  safeSetText(form, fieldMap.c_origination_pct, fv.c_origination_pct);

  // Buyer approval days
  safeSetText(form, fieldMap.buyer_approval_days, fv.buyer_approval_days);

  // Update appearances
  try {
    form.updateFieldAppearances();
  } catch (e) {
    console.log('Warning: updateFieldAppearances failed:', e.message);
  }

  console.log('Saving filled PDF...');
  const pdfOut = await pdfDoc.save();
  fs.writeFileSync('.tmp-carter-trec40-test.pdf', pdfOut);
  console.log('Saved to .tmp-carter-trec40-test.pdf');

  console.log('Test PDF created. Please verify manually in Adobe Reader or equivalent.');
  console.log('Check page 1 and 2 for:');
  console.log('  - Property address: 123 Main St');
  console.log('  - Section C (FHA) checkbox: CHECKED (others unchecked)');
  console.log('  - FHA Section: 203(b)');
  console.log('  - Loan amount: 482,500');
  console.log('  - Term: 30 years');
  console.log('  - Interest rate: 6.5%');
  console.log('  - Origination: 1.5%');
  console.log('  - Buyer approval: 21 days');
}

testFHA().catch(e => {
  console.error('Test failed:', e.message);
  process.exit(1);
});
