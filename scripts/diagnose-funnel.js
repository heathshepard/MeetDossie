#!/usr/bin/env node
// scripts/diagnose-funnel.js
//
// Walks the acquisition funnel the way a stranger off Google would:
//   homepage -> founding CTA -> application modal -> submit
//
// Stops at submit. Approval happens in Telegram (DossieMarketingBot) and the
// Stripe checkout that follows is verified separately, because completing it
// is a real charge against a real founding spot.
//
// Records console errors, failed requests, and whether each step actually
// advanced. Screenshots every step.
//
// Usage:
//   node scripts/diagnose-funnel.js https://meetdossie.com [--submit]
//
// Without --submit it fills the form and stops, so the funnel can be checked
// without creating a founding_applications row.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || 'https://meetdossie.com').replace(/\/$/, '');
const DO_SUBMIT = process.argv.includes('--submit');

const IDENT = {
  name: 'Diagnostic Test (Heath)',
  email: process.env.DIAG_EMAIL || 'heath.shepard+diag@kw.com',
  phone: '(210) 555-0123',
  city: 'San Antonio',
  trec_license: '0654321',
  deals: '15',
  heard_from: 'google_search',
};

const IGNORE = /posthog|google-analytics|gtag|doubleclick|favicon\.ico|chrome-extension|ERR_BLOCKED_BY_CLIENT/i;

const runDir = path.join(__dirname, '..', '.tmp-diagnostic',
  'funnel-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(runDir, { recursive: true });

const findings = [];
let step = 'start';
const note = (kind, detail) =>
  findings.push({ step, kind, detail: String(detail).slice(0, 300) });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  page.on('console', m => {
    if (m.type() === 'error' && !IGNORE.test(m.text())) note('console', m.text());
  });
  page.on('pageerror', e => note('exception', e && e.message));
  page.on('response', r => {
    if (r.status() >= 400 && !IGNORE.test(r.url())) note('http' + r.status(), r.url());
  });

  const shot = n => page.screenshot({ path: path.join(runDir, n + '.png') });
  const ok = (label, detail) => console.log(`  ok    ${label.padEnd(34)} ${detail || ''}`);
  const bad = (label, detail) => { console.log(`  FAIL  ${label.padEnd(34)} ${detail || ''}`); note('step', `${label}: ${detail}`); };

  console.log(`[funnel] ${BASE}`);
  console.log(`[funnel] submit mode: ${DO_SUBMIT ? 'YES - will create a real application' : 'no - fill only'}`);
  console.log(`[funnel] artifacts ${runDir}\n`);

  // 1. land on homepage
  step = 'homepage';
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2200);
  const h1 = await page.locator('h1').first().innerText().catch(() => '');
  h1 ? ok('homepage renders', h1.replace(/\n/g, ' ').slice(0, 46)) : bad('homepage renders', 'no h1');
  await shot('1-homepage');

  // 2. follow the founding CTA the way a visitor would
  step = 'cta';
  const cta = page.locator('a:has-text("Become a Founding Member")').first();
  if (await cta.count()) {
    await cta.click();
    await page.waitForTimeout(2500);
    page.url().includes('/founding')
      ? ok('CTA -> /founding', page.url())
      : bad('CTA -> /founding', 'landed on ' + page.url());
  } else {
    bad('CTA present on homepage', 'not found');
    await page.goto(BASE + '/founding', { waitUntil: 'domcontentloaded' });
  }
  await page.waitForTimeout(1500);
  await shot('2-founding');

  // 3. scarcity counter - should reflect real remaining spots, cap is 25
  step = 'scarcity';
  const body = await page.locator('body').innerText().catch(() => '');
  const m = body.match(/(\d+)\s*(?:of|\/)\s*(\d+)\s*(?:spots?|founding)/i)
        || body.match(/(\d+)\s+spots?\s+(?:left|remaining)/i);
  if (m) {
    ok('scarcity counter', m[0].replace(/\n/g, ' '));
    if (/\b50\b/.test(m[0])) note('scarcity', 'counter shows 50; cap is 25 per CLAUDE.md section 5');
  } else {
    ok('scarcity counter', '(no numeric counter found on page)');
  }

  // 4. open the application modal
  step = 'modal';
  const join = page.locator('button:has-text("Join as Founding Member")').first();
  if (!(await join.count())) { bad('application CTA', 'not found'); }
  else {
    await join.click();
    await page.waitForTimeout(2500);
    const n = await page.locator('input#f-name').count();
    n ? ok('application modal opens', '7-field form') : bad('application modal opens', 'form did not appear');
  }
  await shot('3-form-open');

  // 5. fill it
  step = 'fill';
  try {
    await page.fill('input#f-name', IDENT.name);
    await page.fill('input#f-email', IDENT.email);
    await page.fill('input#f-phone', IDENT.phone);
    await page.selectOption('select#f-city', IDENT.city);
    await page.fill('input#f-license', IDENT.trec_license);
    await page.selectOption('select#f-deals', IDENT.deals);
    await page.selectOption('select#f-heard', IDENT.heard_from);
    ok('form fills', IDENT.email);
  } catch (e) {
    bad('form fills', e.message.slice(0, 90));
  }
  await shot('4-form-filled');

  // 6. submit
  step = 'submit';
  if (!DO_SUBMIT) {
    console.log('  --    submit skipped (pass --submit to create a real application)');
  } else {
    const btn = page.locator('form button[type=submit], button:has-text("Submit"), button:has-text("Apply")').first();
    if (!(await btn.count())) bad('submit button', 'not found');
    else {
      await btn.click();
      await page.waitForTimeout(7000);
      const after = await page.locator('body').innerText().catch(() => '');
      /thank|received|review|submitted|check your email/i.test(after)
        ? ok('submit confirmed', (after.match(/[^\n]*(thank|received|review|submitted)[^\n]*/i) || [''])[0].slice(0, 60))
        : bad('submit confirmed', 'no confirmation text found');
      await shot('5-submitted');
    }
  }

  console.log('\n================ FINDINGS ================');
  if (!findings.length) console.log('none');
  else {
    const seen = new Set();
    for (const f of findings) {
      const k = f.step + f.kind + f.detail;
      if (seen.has(k)) continue;
      seen.add(k);
      console.log(`  [${f.step}/${f.kind}] ${f.detail}`);
    }
  }
  fs.writeFileSync(path.join(runDir, 'findings.json'), JSON.stringify(findings, null, 2));
  console.log(`\n${findings.length} finding(s). Artifacts: ${runDir}`);

  await browser.close();
  process.exit(findings.length ? 1 : 0);
})().catch(e => { console.error('[funnel] CRASH', e); process.exit(1); });
