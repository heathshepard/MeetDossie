'use strict';
// Manual verification for the unbreakable-token overflow fix in
// fill-trec-20-19.js (2026-08-30). Runs through the REAL production path
// (api/fill-form.js __testing.fillForm) for four buyer_notice_email shapes,
// saves each PDF + a page-8 PNG render for visual read-back, and dumps
// pdftotext output for the page-8 email lines so the report can quote what
// was actually drawn, not just what the code says it should draw.

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { PDFDocument } = require('pdf-lib');

const REPO = '/mnt/c/Users/Heath/Projects/MeetDossie';
const OUT_DIR = __dirname;

const { __testing } = require(path.join(REPO, 'api/fill-form.js'));
const { fillForm } = __testing;

const baseFv = {
  buyer_name: 'Kanika Jain, Ketan Thakkar',
  seller_name: 'George T Sirianni, Mary Elizabeth Sirianni',
  property_address: '507 Ridge Blf',
  city_state_zip: 'San Antonio, TX 78216',
  city: 'San Antonio',
  county: 'Bexar',
  property_full: '507 Ridge Blf, San Antonio, TX 78216',
  legal_lot: '9',
  legal_block: '12',
  addition_name: 'Camino Real/Woodlands',
  sale_price: 630000,
  loan_amount: 504000,
  down_payment_amt: 126000,
  earnest_money: 6300,
  option_fee: 100,
  option_period_days: 10,
  escrow_agent_name: 'Jessica Guevara, ENV Title',
  escrow_agent_address: '4499 Pond Hill Rd., San Antonio, TX 78231',
  title_company: 'ENV Title',
  title_seller_expense: true,
  survey_option: '1',
  survey_option1_expense: 'seller',
  survey_days_seller: '25',
  accepts_as_is: true,
  seller_disclosure_received: true,
  water_disclosure_received: false,
  water_disclosure_days: 10,
  closing_date: '2026-09-28',
  possession: 'closing',
  broker_compensation_other_broker_pct: 3,
  addendum_financing: true,
  addendum_appraisal_termination: true,
  buyer_notice_phone: '(425) 922-2529 / (408) 806-3561',
  sellers_agent_email: 'wboyd@cbharper.com',
  listing_agent_email: 'wboyd@cbharper.com',
  buyers_agent_email: 'heath.shepard@kw.com',
  other_broker_assoc_email: 'heath.shepard@kw.com',
  // NOTE: contract_effective_date intentionally omitted -- must stay blank.
};

const TOKEN_140 = 'a'.repeat(130) + '@' + 'b'.repeat(9) + '.com'; // 144 chars, no whitespace
const TOKEN_34A = 'a'.repeat(34); // 34 'a's, ~3.5pt over the 180pt/10pt budget

const CASES = [
  ['case1-140char-unbroken', TOKEN_140],
  ['case2-34a-boundary', TOKEN_34A],
  ['case3-empty', ''],
  ['case4-normal-two-email', 'strkanjain@gmail.com; ketanhthakkar@gmail.com'],
];

async function run() {
  for (const [label, value] of CASES) {
    const fv = { ...baseFv };
    if (value !== '') fv.buyer_notice_email = value;
    console.log('\n=== ' + label + ' (buyer_notice_email=' + JSON.stringify(value.slice(0, 40) + (value.length > 40 ? '...' : '')) + ', len=' + value.length + ') ===');
    const pdfBytes = await fillForm('resale-contract', fv);
    const outPdf = path.join(OUT_DIR, label + '.pdf');
    fs.writeFileSync(outPdf, pdfBytes);

    // Sanity checks that don't need rendering.
    const doc = await PDFDocument.load(pdfBytes);
    console.log('  pages:', doc.getPages().length);

    // Render page 8 to PNG for visual read-back.
    execSync(`pdftoppm -png -r 200 -f 8 -l 8 "${outPdf}" "${path.join(OUT_DIR, label + '-p8')}"`, { stdio: 'inherit' });

    // Dump raw text layer for page 8 for a quick objective check alongside
    // the visual read.
    try {
      const txt = execSync(`pdftotext -f 8 -l 8 -layout "${outPdf}" -`).toString();
      const lines = txt.split('\n').filter(l => /gmail|aaaa|Email/i.test(l));
      console.log('  page 8 email-related lines:');
      lines.forEach(l => console.log('   |' + l + '|'));
    } catch (e) {
      console.log('  pdftotext failed:', e.message);
    }
  }

  // Full 12-page render + executed-date/signature-blank check on the
  // 140-char case (the worst-case / most likely to disturb layout).
  console.log('\n=== full 12-page render, case1 (140-char token) ===');
  const fvFull = { ...baseFv, buyer_notice_email: TOKEN_140 };
  const pdfBytesFull = await fillForm('resale-contract', fvFull);
  const outFull = path.join(OUT_DIR, 'case1-full.pdf');
  fs.writeFileSync(outFull, pdfBytesFull);
  const docFull = await PDFDocument.load(pdfBytesFull);
  console.log('  total pages:', docFull.getPages().length);
  execSync(`pdftoppm -png -r 150 "${outFull}" "${path.join(OUT_DIR, 'case1-full-page')}"`, { stdio: 'inherit' });

  const fullTxt = execSync(`pdftotext -layout "${outFull}" -`).toString();
  console.log('  contains "EXECUTED the" line:', / EXECUTED the.*day of.*20/i.test(fullTxt));
  // Grep the literal executed blank area for stray day/month/year values --
  // best-effort text check; visual PNG read is the real check.
}

run().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
