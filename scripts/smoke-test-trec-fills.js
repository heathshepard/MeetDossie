#!/usr/bin/env node

/**
 * Smoke test for TREC 38-7, 23-20, 24-20, 25-17 fill functions
 * Generates sample PDFs with realistic test data and saves to Engineering/
 */

const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

// Import base64 assets
const TREC_TERMINATION_B64 = require('../api/_assets/trec-termination-base64.js');
const TREC_NEW_HOME_INCOMPLETE_B64 = require('../api/_assets/trec-new-home-incomplete-23-20-base64.js');
const TREC_NEW_HOME_COMPLETE_B64 = require('../api/_assets/trec-new-home-complete-24-20-base64.js');
const TREC_FARM_RANCH_B64 = require('../api/_assets/trec-farm-ranch-25-17-base64.js');

// Import field maps
const TREC_38_7_MAP = require('../api/_assets/field-maps/trec-38-7-coords.json');
const TREC_23_20_MAP = require('../api/_assets/field-maps/trec-23-20-coords.json');
const TREC_24_20_MAP = require('../api/_assets/field-maps/trec-24-20-coords.json');
const TREC_25_17_MAP = require('../api/_assets/field-maps/trec-25-17-coords.json');

// Import filler utility
const { fillFlatPdfFromMap } = require('../api/_assets/flat-pdf-filler.js');

const OUTPUT_DIR = path.join(__dirname, '../Engineering/trec-fill-samples-2026-06-14');

// Helper to format dates
function formatDate(isoLike) {
  if (!isoLike) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoLike));
  if (!m) return String(isoLike);
  return m[2] + '/' + m[3] + '/' + m[1];
}

function formatMoney(value) {
  const n = Number(String(value || '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return String(value || '');
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// Test data
const testData = {
  termination_38_7: {
    buyer_name: 'John Smith',
    seller_name: 'Jane Doe',
    property_address: '123 Main Street, San Antonio, TX 78201',
    contract_effective_date: '2026-05-15',
    termination_notice_date: '2026-06-12',
    termination_reason: 'other',
  },
  new_home_incomplete_23_20: {
    buyer_name: 'Robert Johnson',
    seller_name: 'New Homes Builder LLC',
    property_address_header: '456 Oak Drive',
    lot_number: '42',
    block_number: 'B',
    addition_name: 'Lakeside Heights Addition',
    city_state: 'Austin',
    county: 'Travis',
    property_zip: '78704',
    cash_down_payment: '50000',
    loan_amount: '400000',
    total_sales_price: '450000',
    earnest_money_amount: '10000',
    option_fee_amount: '500',
    option_period_days: '10',
    title_company_name: 'Texas Title Company',
    closing_date: '2026-08-15',
    contract_effective_date: '2026-06-12',
    listing_agent_name: 'Sarah Williams',
    listing_agent_phone: '(512) 555-1234',
    listing_agent_email: 'sarah@example.com',
  },
  new_home_complete_24_20: {
    buyer_name: 'Michael Brown',
    seller_name: 'Premier Builders Inc',
    property_address_header: '789 Elm Street',
    lot_number: '15',
    block_number: 'C',
    addition_name: 'Sunset Estates',
    city_state: 'Houston',
    county: 'Harris',
    property_zip: '77002',
    cash_down_payment: '75000',
    loan_amount: '375000',
    total_sales_price: '450000',
    earnest_money_amount: '12000',
    option_fee_amount: '750',
    option_period_days: '10',
    title_company_name: 'Harris Title Services',
    closing_date: '2026-07-30',
    co_number: 'CO-2026-056789',
    completion_date: '2026-06-01',
    builder_warranty_company: 'Builder Warranty Group',
    contract_effective_date: '2026-06-12',
  },
  farm_ranch_25_17: {
    buyer_name: 'Thomas Davis',
    seller_name: 'Ranch Properties LLC',
    property_address_header: '1000 Ranch Road',
    county: 'Kendall',
    property_zip: '78055',
    land_acres: '125',
    improvements_description: 'Residential house, barn, fencing',
    cash_down_payment: '150000',
    loan_amount: '600000',
    total_sales_price: '750000',
    earnest_money_amount: '25000',
    option_fee_amount: '1000',
    option_period_days: '14',
    title_company_name: 'Hill Country Title',
    closing_date: '2026-09-15',
    contract_effective_date: '2026-06-12',
    mineral_rights_provision: 'Seller retains oil and gas rights',
  },
};

async function fillTest(name, base64Data, fieldMap, testValues) {
  try {
    console.log(`\nTesting ${name}...`);

    // Decode base64
    const raw = typeof base64Data === 'object' && base64Data.base64Pdf ? base64Data.base64Pdf : base64Data;
    const pdfBytes = Buffer.from(raw, 'base64');

    // Load PDF
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

    // Fill with test data
    await fillFlatPdfFromMap(pdfDoc, testValues, fieldMap);

    // Save
    const pdfBuffer = await pdfDoc.save();
    const filename = name.replace(/\s+/g, '-').toLowerCase() + '.pdf';
    const filepath = path.join(OUTPUT_DIR, filename);

    fs.writeFileSync(filepath, pdfBuffer);
    console.log(`  ✓ Saved ${filepath} (${pdfBuffer.length} bytes)`);

    return true;
  } catch (err) {
    console.error(`  ✗ ${name} failed:`, err.message);
    return false;
  }
}

async function main() {
  console.log('TREC Fill Functions Smoke Test');
  console.log('==============================');

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log(`Created output directory: ${OUTPUT_DIR}`);
  }

  const results = [];

  // Test each form
  results.push(await fillTest('TREC 38-7 Buyer Termination', TREC_TERMINATION_B64, TREC_38_7_MAP, testData.termination_38_7));
  results.push(await fillTest('TREC 23-20 New Home Incomplete', TREC_NEW_HOME_INCOMPLETE_B64, TREC_23_20_MAP, testData.new_home_incomplete_23_20));
  results.push(await fillTest('TREC 24-20 New Home Complete', TREC_NEW_HOME_COMPLETE_B64, TREC_24_20_MAP, testData.new_home_complete_24_20));
  results.push(await fillTest('TREC 25-17 Farm and Ranch', TREC_FARM_RANCH_B64, TREC_25_17_MAP, testData.farm_ranch_25_17));

  // Summary
  console.log('\n==============================');
  const passed = results.filter(Boolean).length;
  const total = results.length;
  console.log(`Results: ${passed}/${total} tests passed`);

  if (passed === total) {
    console.log('✓ All smoke tests passed!');
    process.exit(0);
  } else {
    console.log('✗ Some tests failed');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
