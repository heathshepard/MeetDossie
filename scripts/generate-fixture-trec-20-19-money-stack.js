#!/usr/bin/env node
'use strict';

// scripts/generate-fixture-trec-20-19-money-stack.js
//
// Builds the SYNTHETIC, committable fixture used by
// scripts/regression-scan-contract-real-artifact.js (the real-artifact
// acceptance check wired into the staging auto-merge gate).
//
// WHY THIS EXISTS (2026-09-29 postmortem): the money-stack extraction
// schema shipped to production with every mock test green, then returned
// EVERY field as null with ok:true against a real 12-page PDF through a
// real Anthropic API call (Haiku truncated mid-JSON at max_tokens=4096;
// the catch path silently wiped the whole result). The only test that
// would have caught this is one that (a) runs a REAL PDF through the REAL
// scanContract() code path, including a live model call, and (b) asserts
// actual known values landed, not just that the response parsed.
//
// The real document that surfaced the bug is Heath's own personal
// financial data (.tmp/fixtures/fawndale-offer/contract.pdf) — gitignored,
// never committed (public repo, GitGuardian). This script instead
// generates a fully SYNTHETIC TREC 20-19 with obviously-fake values, using
// the exact same production fill pipeline (api/_lib/fill-trec-20-19.js's
// fillTrec2019()) that renders real member contracts, seeded onto the
// blank template asset already committed at
// api/_assets/trec-resale-20-19-base64.js. Every value below is invented
// for this fixture — no resemblance to any real transaction intended.
//
// Output is deterministic (same input -> byte-identical PDF modulo any
// pdf-lib internal timestamps) and carries no personal data, so it is
// safe to commit. Run this file only when the fixture needs to change;
// the generated PDF + its ground-truth JSON are what actually get
// committed and read by CI, not this generator.
//
// Usage:
//   node scripts/generate-fixture-trec-20-19-money-stack.js

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { fillTrec2019 } = require('../api/_lib/fill-trec-20-19');

const OUT_DIR = path.join(__dirname, 'fixtures');
const OUT_PDF = path.join(OUT_DIR, 'synthetic-trec-20-19-money-stack.pdf');
const OUT_JSON = path.join(OUT_DIR, 'synthetic-trec-20-19-money-stack.expected.json');

// Every value here is synthetic — chosen to be obviously fake (round
// numbers, "TEST"/"QACHECK" markers in names) and distinct enough from
// one another that a field swap (e.g. cash vs. financed, earnest money vs.
// option fee) would fail the assertions rather than coincidentally pass.
const FV = {
  buyer_name: 'QACHECK Buyer Testperson',
  seller_name: 'QACHECK Seller Testperson',
  property_address: '123 Synthetic Fixture Lane',
  city_name: 'Testville',
  county: 'Test County',
  legal_lot: '99',
  legal_block: 'Z',
  addition_name: 'Fixture Estates',

  sale_price: 500000,
  down_payment_amt: 100000, // Paragraph 3A cash portion
  loan_amount: 400000, // Paragraph 3B financed portion

  escrow_agent_name: 'Synthetic Title Co',
  earnest_money: 10000, // Paragraph 5A
  option_fee: 250, // Paragraph 5A / 5B
  option_period_days: 10, // Paragraph 5B (Option Period)

  title_company: 'Synthetic Title Co',

  special_provisions_line1: 'SYNTHETIC TEST FIXTURE - NOT A REAL CONTRACT.',

  service_contract_amount: 650, // Paragraph 7H residential service contract cap

  closing_date: '2026-12-15', // Paragraph 9A

  // Paragraph 12B(1): Seller pays Other Broker (buyer's broker) a
  // PERCENTAGE, not a flat dollar amount — exercises the checkbox-election
  // percentage path (checkbox-election.js / debugParagraph12B parsing),
  // not just the dollar path.
  broker_compensation_other_broker_pct: 3.0,
};

// The ground truth scanContract() must return for this fixture. Kept next
// to the PDF (not derived from FV programmatically) so a future change to
// FV or to fillTrec2019()'s coordinate map can't silently drag both the
// input and the expectation in the same wrong direction — a human has to
// look at both.
const EXPECTED = {
  salePrice: 500000,
  salePriceCash: 100000,
  salePriceFinanced: 400000,
  earnestMoney: 10000,
  optionFee: 250,
  optionDays: 10,
  closingDate: '2026-12-15',
  hasSpecialProvisions: true,
  serviceContractCap: 650,
  // ¶12B(1): percentage election, not dollar. debugParagraph12B is
  // deterministically re-parsed server-side (checkbox-election.js) — the
  // real-artifact check asserts on that parsed percentage, not on the raw
  // model prose.
  paragraph12BuyerBrokerCompPct: 3,
};

async function main() {
  const base64 = require('../api/_assets/trec-resale-20-19-base64.js');
  const bytes = Buffer.from(base64, 'base64');
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });

  await fillTrec2019(pdfDoc, FV);

  const outBytes = await pdfDoc.save();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_PDF, outBytes);
  fs.writeFileSync(OUT_JSON, JSON.stringify(EXPECTED, null, 2) + '\n');

  console.log(`Wrote ${OUT_PDF} (${outBytes.length} bytes)`);
  console.log(`Wrote ${OUT_JSON}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
