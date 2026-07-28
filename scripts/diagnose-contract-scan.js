#!/usr/bin/env node
// scripts/diagnose-contract-scan.js
//
// Uploads a real filled TREC 1-4 Family Resale contract through the app as the
// demo user and checks what the scanner actually extracted against known
// ground truth. This is the test that matters - "the page loaded" says
// nothing about whether Dossie read the contract correctly.
//
// Ground truth comes from the PDF's own AcroForm fields (263 fields, 75
// filled), so the expectations are not guesses.
//
// Usage:
//   set DEMO_EMAIL=... && set DEMO_PASSWORD=... && node scripts/diagnose-contract-scan.js https://meetdossie.com [pdfPath]

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || 'https://meetdossie.com').replace(/\/$/, '');
const PDF = path.resolve(process.argv[3] || '.tmp/prod-resale-actual.pdf');
const EMAIL = process.env.DEMO_EMAIL;
const PASS = process.env.DEMO_PASSWORD;

// Read straight out of the PDF's form fields.
// TREC paragraph 1 reads "the parties are ___ (Seller) and ___ (Buyer)", so
// the first blank is the SELLER. Getting this backwards makes a correct
// extraction look like a swap bug.
const TRUTH = {
  buyer: 'Heath Shepard',
  seller: 'Josh Sissam',
  address: '123 Main St',
  city: 'Cibolo Canyons',
  county: 'Kendall',
  sales_price: '500,000',
  down_payment: '17,500',
  financed: '482,500',
};

const IGNORE = /posthog|google-analytics|gtag|doubleclick|favicon\.ico|chrome-extension|ERR_BLOCKED_BY_CLIENT/i;

const runDir = path.join(__dirname, '..', '.tmp-diagnostic',
  'scan-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(runDir, { recursive: true });

const problems = [];

(async () => {
  if (!fs.existsSync(PDF)) { console.error('PDF not found:', PDF); process.exit(1); }
  console.log(`[scan] ${BASE}`);
  console.log(`[scan] contract ${PDF} (${(fs.statSync(PDF).size / 1024).toFixed(0)} KB)`);
  console.log(`[scan] artifacts ${runDir}\n`);

  const t0Ref = { v: Date.now() };
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', m => { if (m.type() === 'error' && !IGNORE.test(m.text())) problems.push('console: ' + m.text().slice(0, 200)); });
  page.on('pageerror', e => problems.push('exception: ' + (e && e.message)));
  page.on('response', r => { if (r.status() >= 400 && !IGNORE.test(r.url())) problems.push(`http${r.status()}: ${r.url().slice(0, 150)}`); });

  // Log every backend call so "nothing extracted" can be told apart from
  // "the client never even tried".
  const calls = [];
  let uploadStarted = false;
  page.on('request', r => {
    const u = r.url();
    if (!/\/api\/|\/storage\/v1\//.test(u)) return;
    const line = `${r.method()} ${u.replace(/^https?:\/\/[^/]+/, '').split('?')[0]}`;
    calls.push(line);
    if (uploadStarted) console.log('        -> ' + line);
  });

  // Capture what scan-contract actually answers. Status alone is not enough:
  // a 200 carrying ok:false looks healthy from the outside.
  page.on('response', async r => {
    if (!/\/api\/scan-contract/.test(r.url())) return;
    let body = '';
    try { body = (await r.text()).slice(0, 1200); } catch (e) { body = '<unreadable: ' + e.message + '>'; }
    console.log(`\n  === /api/scan-contract responded ${r.status()} in ${Math.round((Date.now() - t0Ref.v) / 1000)}s ===`);
    console.log('  ' + body.replace(/\n/g, '\n  '));
    console.log('  === end response ===\n');
    fs.writeFileSync(path.join(runDir, 'scan-response.json'), body);
    if (r.status() >= 400 || /"ok"\s*:\s*false/.test(body)) {
      problems.push(`scan-contract ${r.status()}: ${body.slice(0, 300)}`);
    }
  });

  // sign in
  await page.goto(BASE + '/app', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.fill('input[type=email]', EMAIL);
  await page.fill('input[type=password]', PASS);
  await page.click('button:has-text("Sign In")');
  await page.waitForTimeout(7000);
  if (!(await page.$('button:has-text("Sign Out")'))) { console.error('[scan] sign-in failed'); process.exit(1); }
  console.log('  ok    signed in');

  // open the upload affordance
  await page.click('button:has-text("Open New Dossier")');
  await page.waitForTimeout(3500);
  await page.screenshot({ path: path.join(runDir, '1-upload-open.png') });

  // The control is styled text, not necessarily a <button> - a label wrapping
  // a hidden input is the usual pattern - so match on text, any element.
  const scanBtn = page.getByText('Scan Contract PDF', { exact: false }).first();
  if (!(await scanBtn.count())) { console.error('[scan] "Scan Contract PDF" control not found'); process.exit(1); }
  console.log('  ok    "Scan Contract PDF" present');

  // Drive the real control. Writing to the hidden input directly skips the
  // app's own handler, so the upload never fires. Fall back to the input only
  // if no file chooser opens.
  let usedChooser = true;
  try {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15000 }),
      scanBtn.click(),
    ]);
    await chooser.setFiles(PDF);
  } catch {
    usedChooser = false;
    const input = await page.$('input[type=file]');
    if (!input) { console.error('[scan] no file chooser and no file input'); process.exit(1); }
    await input.setInputFiles(PDF);
  }
  uploadStarted = true;
  const callsBefore = calls.length;
  console.log(`  ..    file submitted via ${usedChooser ? 'file chooser' : 'direct input'}, waiting for extraction`);
  const t0 = Date.now(); t0Ref.v = t0;

  // Wait until any ground-truth value shows up, or we give up. Check input
  // values as well as text - pre-filled fields are invisible to innerText.
  let seen = false;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(3000);
    const txt = ((await page.locator('body').innerText().catch(() => '')) || '') + '\n' +
      (await page.evaluate(() => [...document.querySelectorAll('input,select,textarea')]
        .filter(x => x.type !== 'file').map(x => x.value || '').join('\n')).catch(() => ''));
    if (txt.includes(TRUTH.address) || txt.includes(TRUTH.buyer) || txt.includes(TRUTH.seller)) { seen = true; break; }
    if (i % 5 === 4) console.log(`  ..    ${Math.round((Date.now() - t0) / 1000)}s elapsed`);
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(seen ? `  ok    extraction surfaced in ${secs}s` : `  FAIL  nothing recognisable after ${secs}s`);
  if (!seen) problems.push(`extraction produced no ground-truth value within ${secs}s`);

  const post = calls.slice(callsBefore);
  console.log(`\n  backend calls after upload: ${post.length}`);
  if (!post.length) {
    console.log('  >> the client made NO request after the file was set.');
    console.log('  >> the change handler never fired - this is a front-end break, not an AI failure.');
    problems.push('no network request issued after file selection');
  } else {
    [...new Set(post)].slice(0, 20).forEach(c => console.log('     ' + c));
  }

  await page.screenshot({ path: path.join(runDir, '2-after-scan.png'), fullPage: true });

  // innerText does NOT include the value of a form input. Scanning only the
  // visible text reports "extracted nothing" even when every field is filled,
  // so read input values too and search both.
  const inputValues = await page.evaluate(() =>
    [...document.querySelectorAll('input,select,textarea')]
      .filter(i => i.type !== 'file' && i.getClientRects().length)
      .map(i => i.value || '')
      .filter(Boolean));
  const finalText = ((await page.locator('body').innerText().catch(() => '')) || '')
    + '\n' + inputValues.join('\n');
  fs.writeFileSync(path.join(runDir, 'page-text.txt'), finalText);
  console.log(`  ..    ${inputValues.length} populated form fields after scan`);

  // score each field
  console.log('\n  field            expected              found');
  console.log('  ' + '-'.repeat(56));
  const missed = [];
  for (const [k, v] of Object.entries(TRUTH)) {
    const hit = finalText.includes(v) || finalText.includes(v.replace(/,/g, ''));
    console.log(`  ${k.padEnd(16)} ${v.padEnd(21)} ${hit ? 'yes' : 'NO'}`);
    if (!hit) missed.push(`${k} (${v})`);
  }
  if (missed.length) problems.push('not surfaced in UI: ' + missed.join(', '));

  console.log('\n================ RESULT ================');
  console.log(`  extracted ${Object.keys(TRUTH).length - missed.length}/${Object.keys(TRUTH).length} ground-truth fields`);
  if (problems.length) {
    console.log(`\n  ${problems.length} problem(s):`);
    [...new Set(problems)].slice(0, 15).forEach(p => console.log('   - ' + p));
  } else console.log('  no console errors, no failed requests');

  fs.writeFileSync(path.join(runDir, 'problems.json'), JSON.stringify({ missed, problems }, null, 2));
  console.log(`\n  artifacts: ${runDir}`);
  await browser.close();
  process.exit(missed.length || problems.length ? 1 : 0);
})().catch(e => { console.error('[scan] CRASH', e); process.exit(1); });
