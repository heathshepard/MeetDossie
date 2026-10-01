#!/usr/bin/env node
// scripts/fixtures/generate-synthetic-trec-20-19-money-stack.js
//
// Builds a SYNTHETIC (fully fake, no real client/person/address) filled-but-
// unsigned TREC 20-19 for exercising the inline signature-stamp renderer
// (api/_lib/signature-stamp.js) end to end without ever touching a real
// transaction document. "Money stack" = the dense dollar-figure cluster in
// paragraph 3 (sales price / financed amount / cash portion / earnest money
// / option fee) which sits closest to the page-1 initials footer, making it
// the tightest real-world test of stamp placement.
//
// Output: scripts/fixtures/synthetic-trec-20-19-money-stack.pdf — gitignored,
// NEVER commit it (see .gitignore). Starts from the blessed blank form at
// scripts/trec-forms/20-19.pdf (already committed, already blank).
//
// Usage: node scripts/fixtures/generate-synthetic-trec-20-19-money-stack.js

'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { fillTrec2019 } = require('../../api/_lib/fill-trec-20-19');

const BLANK_PATH = path.join(__dirname, '..', 'trec-forms', '20-19.pdf');
const OUT_PATH = path.join(__dirname, 'synthetic-trec-20-19-money-stack.pdf');

const SYNTHETIC_FIELD_VALUES = {
  buyer_name: 'Jordan Q. Testbuyer',
  seller_name: 'Casey R. Testseller',
  property_address: '1 Synthetic Fixture Lane',
  city: 'Faketown',
  county: 'Bexar',
  legal_description: 'Lot 1, Block 1, SYNTHETIC FIXTURE SUBDIVISION',
  legal_lot: '1',
  legal_block: '1',
  addition_name: 'Synthetic Fixture Subdivision',
  sale_price: 350000,
  loan_amount: 280000,
  down_payment_amt: 70000,
  earnest_money: 5000,
  option_fee: 200,
  option_period_days: '10',
  title_company: 'Synthetic Test Title Co.',
  escrow_agent_name: 'Synthetic Test Title Co.',
  closing_date: '2026-12-01',
};

async function main() {
  const blankBytes = fs.readFileSync(BLANK_PATH);
  const pdfDoc = await PDFDocument.load(blankBytes, { ignoreEncryption: true });
  await fillTrec2019(pdfDoc, SYNTHETIC_FIELD_VALUES);
  const outBytes = await pdfDoc.save();
  fs.writeFileSync(OUT_PATH, outBytes);
  console.log(`Wrote ${OUT_PATH} (${outBytes.length} bytes, ${pdfDoc.getPageCount()} pages) — synthetic, do not commit.`);
}

main().catch((err) => {
  console.error('generate-synthetic-trec-20-19-money-stack failed:', err && err.message);
  process.exit(1);
});
