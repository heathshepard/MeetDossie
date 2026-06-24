// Headless smoke test for the offline labeler.
// - Loads the file:// URL
// - Reads progress text + first widget card
// - Programmatically clicks "Accept guess" three times
// - Exports JSON via downloadable Blob (intercepted) and prints it
// - Confirms zero network requests
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const FILE = path.resolve(__dirname, 'trec-labeler.html');
const URL = 'file://' + FILE.replace(/\\/g, '/');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();

  const networkAttempts = [];
  page.on('request', (req) => {
    if (!req.url().startsWith('file://')) {
      networkAttempts.push(req.url());
    }
  });
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push('PAGE ERROR: ' + err.message));

  await page.goto(URL);
  await page.waitForSelector('#content .card', { timeout: 5000 });

  const progressText = await page.textContent('#progress');
  console.log('progress:', progressText.replace(/\s+/g, ' ').trim());

  const firstBreadcrumb = await page.textContent('.card .breadcrumb');
  console.log('first card breadcrumb:', firstBreadcrumb.trim());

  // Click Accept once
  await page.click('button[data-action="accept"]');
  await page.waitForTimeout(100);
  const breadcrumb2 = await page.textContent('.card .breadcrumb');
  console.log('after accept #1 breadcrumb:', breadcrumb2.trim());

  // Click Correct, fill, save
  await page.click('button[data-action="correct"]');
  await page.fill('#correctInput', 'addendum_propane');
  await page.click('button[data-action="save-correct"]');
  await page.waitForTimeout(100);
  const breadcrumb3 = await page.textContent('.card .breadcrumb');
  console.log('after correct breadcrumb:', breadcrumb3.trim());

  // Click Skip
  await page.click('button[data-action="skip"]');
  await page.waitForTimeout(100);
  const breadcrumb4 = await page.textContent('.card .breadcrumb');
  console.log('after skip breadcrumb:', breadcrumb4.trim());

  // Click Not fillable
  await page.click('button[data-action="not_fillable"]');
  await page.waitForTimeout(100);

  // Check localStorage contents
  const labels = await page.evaluate(() => localStorage.getItem('trec-labeler-trec-20-18'));
  console.log('localStorage label count:', JSON.parse(labels) ? Object.keys(JSON.parse(labels)).length : 0);
  console.log('localStorage sample:', labels && labels.slice(0, 200));

  // Trigger Export — capture the download
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportBtn'),
  ]);
  const dlPath = path.join(__dirname, '.smoke-export.json');
  await download.saveAs(dlPath);
  const exportContents = fs.readFileSync(dlPath, 'utf8');
  console.log('export filename:', download.suggestedFilename());
  console.log('export rows:', JSON.parse(exportContents).labels.length);

  // Switch form selector to TREC 40 — should now show a card, NOT empty-state
  await page.selectOption('#formSelect', 'trec-40');
  await page.waitForSelector('#content .card', { timeout: 5000 });
  const t40Progress = await page.textContent('#progress');
  console.log('trec-40 progress:', t40Progress.replace(/\s+/g, ' ').trim());
  const t40Crumb = await page.textContent('.card .breadcrumb');
  console.log('trec-40 first card:', t40Crumb.trim());

  // Label 3 widgets on TREC 40 to verify per-form localStorage isolation
  await page.click('button[data-action="accept"]');
  await page.waitForTimeout(60);
  await page.click('button[data-action="skip"]');
  await page.waitForTimeout(60);
  await page.click('button[data-action="correct"]');
  await page.fill('#correctInput', 'loan_amount');
  await page.click('button[data-action="save-correct"]');
  await page.waitForTimeout(60);

  // Export from TREC 40 — verify form-id propagates
  const [download2] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportBtn'),
  ]);
  const dlPath2 = path.join(__dirname, '.smoke-export-trec-40.json');
  await download2.saveAs(dlPath2);
  const exp2 = JSON.parse(fs.readFileSync(dlPath2, 'utf8'));
  console.log('trec-40 export filename:', download2.suggestedFilename());
  console.log('trec-40 export form:', exp2.form);
  console.log('trec-40 export rows:', exp2.labels.length);

  // Verify localStorage isolation — 20-18 still has its 4 labels, 40 has its own
  const labels2018 = await page.evaluate(() => localStorage.getItem('trec-labeler-trec-20-18'));
  const labels40   = await page.evaluate(() => localStorage.getItem('trec-labeler-trec-40'));
  console.log('20-18 labels still present:', labels2018 ? Object.keys(JSON.parse(labels2018)).length : 0);
  console.log('40 labels present:', labels40 ? Object.keys(JSON.parse(labels40)).length : 0);

  // Cycle every form to ensure no console errors / no empty state for any
  const ALL_FORMS = ['trec-20-18','trec-40','trec-39-10','op-h','trec-36-11','trec-38-7','op-l'];
  for (const fid of ALL_FORMS) {
    await page.selectOption('#formSelect', fid);
    await page.waitForTimeout(50);
    const isEmpty = (await page.textContent('#content')).includes('No widgets loaded');
    console.log('  ' + fid + ' empty?', isEmpty);
  }

  // Final checks
  console.log('console errors:', consoleErrors.length);
  if (consoleErrors.length) consoleErrors.forEach((e) => console.log('  ERR:', e));
  console.log('network attempts (should be 0):', networkAttempts.length);
  if (networkAttempts.length) networkAttempts.forEach((u) => console.log('  NET:', u));

  await browser.close();
  console.log('Smoke test complete.');
})().catch((e) => { console.error('Smoke FAIL:', e); process.exit(1); });
