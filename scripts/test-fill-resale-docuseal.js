#!/usr/bin/env node
/**
 * Test script: Fill TREC 20-19 Resale Contract with full field map
 * Usage: node scripts/test-fill-resale-docuseal.js
 * Outputs: test-filled-resale-docuseal.pdf in current directory
 */

const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

// Load the base64 PDF asset
const TREC_RESALE_B64 = require('../api/_assets/trec-resale-20-19-base64.js');

// Load the field map
const FIELD_MAP_DOCUSEAL = require('../api/_assets/field-map-resale-docuseal.js');

// Helper functions
function formatMoney(val) {
  if (!val) return '';
  const num = Number(String(val).replace(/[^0-9.]/g, ''));
  if (isNaN(num)) return String(val);
  return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(val) {
  if (!val) return '';
  // Assume YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}/.test(String(val))) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(val));
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return months[parseInt(m[2], 10) - 1] + ' ' + parseInt(m[3], 10) + ', ' + m[1];
  }
  return String(val);
}

// Test data: comprehensive field coverage
const testFieldValues = {
  // Parties
  buyer_name: 'John Doe',
  seller_name: 'Jane Smith',

  // Property
  property_address: '123 Main Street, Austin, TX 78701',
  legal_lot: '15',
  legal_block: '3',
  addition_city: 'Austin',
  county: 'Travis',
  Legal_Description: 'Lot 15, Block 3, Oak Hill Subdivision',

  // Sales Price
  sales_price: '350000',
  down_payment: '70000',
  loan_amount: '280000',

  // Financing
  title_company_name: 'Texas Title & Escrow',
  escrow_agent_name: 'Sarah Johnson',
  escrow_agent_address: '456 Oak Lane, Austin, TX 78704',

  // Earnest Money
  earnest_money_amount: '10500',
  option_fee: '300',
  option_period_days: '10',

  // Survey
  survey_not_amended: true,
  survey_amend_buyer: false,
  survey_amend_seller: false,

  // Leases
  has_residential_leases: false,
  has_fixture_leases: false,
  has_natural_resource_leases: false,

  // Financing
  third_party_financing: true,

  // Dates (closing date on page 4, field 'closing_date')
  closing_date: '2026-07-15',

  // Broker info (page 9)
  listing_agent_name: 'Bob Wilson',
  listing_agent_phone: '(512) 555-1234',
  listing_agent_email: 'bob@realty.com',
  selling_associate_name: 'Alice Brown',
  selling_associate_phone: '(512) 555-5678',
  selling_associate_email: 'alice@realty.com',

  // Additional common fields
  additional_earnest_money: '5000',
  additional_em_days: '30',
  title_seller_pays: true,
  title_buyer_pays: false,
};

async function fillPdf() {
  console.log('Loading PDF...');
  const pdfBytes = Buffer.from(TREC_RESALE_B64, 'base64');
  const pdfDoc = await PDFDocument.load(pdfBytes);

  console.log(`PDF loaded with ${pdfDoc.getPageCount()} pages`);
  console.log(`Field map has ${Object.keys(FIELD_MAP_DOCUSEAL).length} fields`);
  console.log(`Test data has ${Object.keys(testFieldValues).length} field values`);

  // Embed fonts at doc level
  const { StandardFonts } = require('pdf-lib');
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Helper: draw text on page at normalized coordinates
  function drawTextOnPage(page, fieldName, value) {
    if (!value || value === '') return;

    const coord = FIELD_MAP_DOCUSEAL[fieldName];
    if (!coord) {
      console.warn(`Field ${fieldName} has no coordinate mapping, skipping`);
      return;
    }

    const pageHeight = page.getHeight();
    const pageWidth = page.getWidth();

    const x = coord.x * pageWidth;
    const y = pageHeight - (coord.y * pageHeight);
    const fontSize = 10;

    page.drawText(String(value), {
      x,
      y,
      size: fontSize,
      color: require('pdf-lib').rgb(0, 0, 0),
      font: helvetica,
    });
  }

  // Helper: draw checkbox at coordinates
  function drawCheckmark(page, fieldName) {
    const coord = FIELD_MAP_DOCUSEAL[fieldName];
    if (!coord) {
      console.warn(`Checkbox field ${fieldName} has no coordinate mapping, skipping`);
      return;
    }

    const pageHeight = page.getHeight();
    const pageWidth = page.getWidth();

    const x = coord.x * pageWidth;
    const y = pageHeight - (coord.y * pageHeight);
    const size = 10;

    page.drawText('X', {
      x: x - 1,
      y: y - 3,
      size,
      color: require('pdf-lib').rgb(0, 0, 0),
      font: helvetica,
    });
  }

  const pages = pdfDoc.getPages();
  let fillCount = 0;
  let checkboxCount = 0;
  let skippedCount = 0;

  // Iterate through ALL fields in the field map
  Object.entries(FIELD_MAP_DOCUSEAL).forEach(([fieldName, coord]) => {
    const pageIndex = coord.page;
    const page = pages[pageIndex];

    if (!page) {
      console.warn(`Page ${pageIndex} does not exist (field: ${fieldName})`);
      skippedCount++;
      return;
    }

    const value = testFieldValues[fieldName];

    if (!value && value !== 0 && value !== false) {
      // No value provided, skip
      return;
    }

    // Format display value
    let displayValue = value;
    if (fieldName.includes('money') || fieldName.includes('amount') || fieldName.includes('price') || fieldName.includes('payment')) {
      displayValue = formatMoney(value);
    } else if (fieldName.includes('date')) {
      displayValue = formatDate(value);
    } else if (fieldName.includes('days') || fieldName.includes('period')) {
      displayValue = String(value).trim();
    }

    // Draw field
    if (coord.type === 'checkbox') {
      if (value === true || value === 'true' || value === 1 || value === '1' || value === 'yes' || value === 'Yes') {
        drawCheckmark(page, fieldName);
        checkboxCount++;
      }
    } else {
      drawTextOnPage(page, fieldName, displayValue);
      fillCount++;
    }
  });

  console.log(`\nFill complete:`);
  console.log(`  - Text fields filled: ${fillCount}`);
  console.log(`  - Checkboxes marked: ${checkboxCount}`);
  console.log(`  - Pages without pages skipped: ${skippedCount}`);

  // Save the PDF
  const outputPath = path.join(process.cwd(), 'test-filled-resale-docuseal.pdf');
  const pdfBytesOutput = await pdfDoc.save();
  fs.writeFileSync(outputPath, pdfBytesOutput);

  console.log(`\nPDF saved to: ${outputPath}`);
  console.log(`File size: ${(pdfBytesOutput.length / 1024).toFixed(2)} KB`);
}

fillPdf().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
