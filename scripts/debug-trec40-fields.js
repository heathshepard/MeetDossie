// Debug script: list all form fields in the PDF
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

async function debug() {
  console.log('Loading base64 PDF...');
  const TREC_FINANCING_B64 = require('../api/_assets/trec-financing-base64.js');
  const pdfBytes = Buffer.from(TREC_FINANCING_B64, 'base64');
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const form = pdfDoc.getForm();
  const fields = form.getFields();

  console.log(`\nTotal fields in TREC 40: ${fields.length}\n`);
  
  // Show first 20 fields to verify field names
  console.log('First 20 form fields:');
  for (let i = 0; i < Math.min(20, fields.length); i++) {
    const field = fields[i];
    const name = field.getName();
    const type = field.constructor.name;
    console.log(`  ${i+1}. [${type}] ${name}`);
  }

  // Look for the fields we're trying to fill
  console.log('\nSearching for key fields:');
  const keyNames = [
    'Street Address and City',
    'Address of Property',
    '3 FHA Insured Financing A Section',
    'excluding any financed MIP amortizable monthly for not less',
    'Conversion Mortgage loan in the original principal amount of',
  ];

  for (const keyName of keyNames) {
    const field = fields.find(f => f.getName() === keyName);
    if (field) {
      console.log(`  ? Found: ${keyName}`);
    } else {
      console.log(`  ? NOT FOUND: ${keyName}`);
    }
  }
}

debug().catch(e => {
  console.error('Debug failed:', e.message);
  process.exit(1);
});
