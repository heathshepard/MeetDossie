#!/usr/bin/env node
/**
 * 20-19-template-mode.spec.js — end-to-end customer flow test for TREC 20-19
 * (Resale Contract) via "Use TREC template" mode.
 *
 * Walk:
 *   1. Launch headed Chromium with video recording enabled
 *   2. Sign in as demo@meetdossie.com on prod meetdossie.com
 *   3. Ensure a test transaction exists (or reuse one)
 *   4. Navigate to the dossier
 *   5. Click "Generate + Sign" button
 *   6. Select "TREC 20-19 One to Four Family Residential Contract"
 *   7. Fill signer name / email / role for one Buyer 1
 *   8. Click "Generate + Send for Signature"
 *   9. Wait for success confirmation
 *  10. Poll mailinator for the signing email
 *  11. Extract the DocuSeal signing URL
 *  12. Open the signing URL in a new tab
 *  13. Screenshot the signer view
 *  14. Extract page text; verify property_address, buyer_name, sale_price,
 *      closing_date are rendered on the PDF
 *  15. Save all evidence to .tmp/dossie-sign-e2e-runs/<runId>/
 *
 * Exit 0 = PASS; exit 1 = FAIL.
 *
 * USAGE:
 *   node scripts/daily-regression-suite/dossie-sign-e2e/tests/20-19-template-mode.spec.js
 *   BASE_URL=https://staging-preview-abc.vercel.app node ...
 *   HEADED=1 node ...   # visible browser (default headless)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { makeSignedInSession, ensureTestTransaction, screenshot } =
  require('../_lib/browser-walk');
const { pollInbox, extractSigningUrl, newAddress } = require('../_lib/mailinator');

// Load .env.local so DEMO_PASSWORD + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY populate.
function loadDotenv() {
  const envPath = path.resolve(__dirname, '..', '..', '..', '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
}

const RUN_ID = `20-19-template-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const OUT_DIR = path.resolve(__dirname, '..', '..', '..', '..', '.tmp', 'dossie-sign-e2e-runs', RUN_ID);
const VIDEO_DIR = path.join(OUT_DIR, 'video');

const FORM_KEY = '20-19';
const TEMPLATE_LABEL_RE = /20-19|Resale|One to Four/i;

async function main() {
  loadDotenv();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const base = process.env.BASE_URL || 'https://meetdossie.com';
  const headless = process.env.HEADED === '1' ? false : true;
  const buyer1Address = newAddress(FORM_KEY, 'buyer1');
  const seller1Address = newAddress(FORM_KEY, 'seller1');
  const startIso = new Date().toISOString();

  const evidence = {
    runId: RUN_ID,
    form: FORM_KEY,
    mode: 'template',
    base,
    startedAt: startIso,
    buyer1Address,
    seller1Address,
    steps: [],
    passed: false,
    failReason: null,
    videoPath: null,
    screenshots: [],
    signingUrl: null,
    signerViewText: null,
    consoleErrors: [],
  };

  function step(name, ok, extra = {}) {
    evidence.steps.push({ name, ok, at: new Date().toISOString(), ...extra });
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${extra.note ? ' — ' + extra.note : ''}`);
  }

  let session = null;
  const apiResponses = [];
  try {
    // ---- Seed a test transaction --------------------------------------
    let txCtx;
    try {
      txCtx = await ensureTestTransaction();
      step('seed test transaction', true, { transactionId: txCtx.transactionId, propertyAddress: txCtx.propertyAddress });
    } catch (err) {
      step('seed test transaction', false, { error: err.message });
      throw err;
    }

    // ---- Launch browser + sign in --------------------------------------
    console.log(`[e2e] launching browser (headless=${headless})...`);
    const consoleErrors = evidence.consoleErrors;
    session = await makeSignedInSession({
      base,
      headless,
      videoDir: VIDEO_DIR,
      consoleErrors,
    });
    const { page, ctx } = session;

    // Capture responses from esign endpoints so we can inspect success/failure
    // even if the UI hides the confirmation.
    page.on('response', async (resp) => {
      const u = resp.url();
      if (/\/api\/esign-(templates|create)\b/.test(u) && resp.request().method() === 'POST') {
        try {
          const body = await resp.json();
          apiResponses.push({ url: u, status: resp.status(), body });
          console.log(`  [api] ${resp.status()} ${u.split('/api/')[1]} ok=${body && body.ok} submissionId=${body && body.submissionId}`);
        } catch {
          apiResponses.push({ url: u, status: resp.status(), body: null });
        }
      }
    });

    step('sign in as demo', true);
    evidence.screenshots.push(await screenshot(page, path.join(OUT_DIR, 'T1-signed-in.png')));

    // ---- Navigate to the dossier we just patched -----------------------
    // The workspace UI shows a transaction list. The dossier we patched is the
    // demo user's first (oldest) transaction. Find and click its row. Prefer
    // the sentinel-tagged address; fall back to any row referencing "Test Ln"
    // or the first pipeline row we can find.
    await page.waitForTimeout(3500);
    const dealCandidates = [
      `text="${txCtx.propertyAddress}"`,
      `text=/${txCtx.sentinel}/`,
      `text=/Test Ln/i`,
      `text=/100 Test Ln/i`,
    ];
    let opened = false;
    for (const sel of dealCandidates) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await el.click().catch(() => {});
          await page.waitForTimeout(2500);
          opened = true;
          break;
        }
      } catch {}
    }

    // Fallback: try navigating directly to /workspace with the txId in a URL
    // hash, if that flow is supported. Otherwise click any first dossier row
    // in the pipeline sidebar/list.
    if (!opened) {
      // Look for pipeline links: cards with a right-arrow, dossier list items.
      // The Dossie UI has clickable transaction rows in the pipeline view.
      // Click the FIRST one we can find (works because we patched the first).
      const anyDossier = await page.$('[data-dossier-id], [data-transaction-id], .dossier-row, .transaction-row').catch(() => null);
      if (anyDossier) {
        await anyDossier.click().catch(() => {});
        await page.waitForTimeout(2500);
        opened = true;
      }
    }

    // Final fallback: use a URL to navigate directly.
    if (!opened) {
      await page.goto(`${base}/workspace.html?dossierId=${txCtx.transactionId}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      }).catch(() => {});
      await page.waitForTimeout(4000);
      // Check that we're now in dossier detail view — "Open in Emails", "Draft Amendment", etc.
      const inDetail = await page.$('button:has-text("Generate + Sign"), button:has-text("Fill Contract")').catch(() => null);
      if (inDetail) opened = true;
    }

    step('open seeded dossier', opened);
    evidence.screenshots.push(await screenshot(page, path.join(OUT_DIR, 'T2-dossier-open.png')));
    if (!opened) throw new Error('Could not open the seeded dossier in workspace UI.');

    // ---- Click "Generate + Sign" button --------------------------------
    const genSignSelectors = [
      'button:has-text("Generate + Sign")',
      'button:has-text("✍ Generate + Sign")',
      'button:has-text("Generate")',
    ];
    let clickedGen = false;
    for (const sel of genSignSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click().catch(() => {});
        await page.waitForTimeout(2000);
        clickedGen = true;
        break;
      }
    }
    step('click Generate + Sign', clickedGen);
    evidence.screenshots.push(await screenshot(page, path.join(OUT_DIR, 'T3-esign-modal.png')));
    if (!clickedGen) throw new Error('Could not click "Generate + Sign" button — dossier UI may not have loaded.');

    // The modal opens with doc=null which forces "Use TREC template" tab.
    // Confirm the template list is visible.
    await page.waitForTimeout(2000);

    // ---- Fill signer name + email --------------------------------------
    // Find the name input first (empty placeholder "Full name") and fill it.
    const nameInputs = await page.$$('input[placeholder="Full name"]');
    const emailInputs = await page.$$('input[type="email"][placeholder="Email address"]');
    // If there's already one signer row, fill it. Else add one first.
    if (nameInputs.length === 0) {
      const addBtn = await page.$('button:has-text("+ Add signer")');
      if (addBtn) {
        await addBtn.click();
        await page.waitForTimeout(500);
      }
    }
    const finalNameInputs = await page.$$('input[placeholder="Full name"]');
    const finalEmailInputs = await page.$$('input[type="email"][placeholder="Email address"]');
    if (finalNameInputs.length > 0) {
      await finalNameInputs[0].fill('Alex Testbuyer');
    }
    if (finalEmailInputs.length > 0) {
      await finalEmailInputs[0].fill(buyer1Address);
    }
    step('fill Buyer 1 signer', finalNameInputs.length > 0 && finalEmailInputs.length > 0, {
      note: `${buyer1Address}`,
    });

    // Role — set select value to "Buyer 1"
    const roleSelects = await page.$$('select');
    if (roleSelects.length > 0) {
      // Look for the first select that has "Buyer 1" as an option.
      for (const sel of roleSelects) {
        const options = await sel.$$eval('option', (opts) => opts.map((o) => o.value));
        if (options.includes('Buyer 1')) {
          await sel.selectOption('Buyer 1').catch(() => {});
          break;
        }
      }
    }
    step('set Buyer 1 role', true);
    evidence.screenshots.push(await screenshot(page, path.join(OUT_DIR, 'T4-signer-filled.png')));

    // ---- Select "TREC 20-19 Resale Contract" ---------------------------
    // The template list renders as buttons; click the one that matches.
    const templateBtns = await page.$$('button');
    let clickedTemplate = false;
    for (const btn of templateBtns) {
      try {
        const text = await btn.textContent();
        if (text && TEMPLATE_LABEL_RE.test(text) && /Resale|One to Four|20-19/i.test(text)) {
          const isDisabled = await btn.evaluate((el) => el.disabled);
          if (isDisabled) continue;
          await btn.click().catch(() => {});
          clickedTemplate = true;
          break;
        }
      } catch {}
    }
    step('select TREC 20-19 template', clickedTemplate);
    await page.waitForTimeout(1500);
    evidence.screenshots.push(await screenshot(page, path.join(OUT_DIR, 'T5-template-selected.png')));

    // ---- Click "Generate + Send for Signature" -------------------------
    const sendBtn = await page.$('button:has-text("Generate + Send for Signature"), button:has-text("Send for Signature")');
    let clickedSend = false;
    if (sendBtn) {
      const isDisabled = await sendBtn.evaluate((el) => el.disabled);
      if (!isDisabled) {
        await sendBtn.click().catch(() => {});
        clickedSend = true;
      }
    }
    step('click Send for Signature', clickedSend);
    if (!clickedSend) throw new Error('Send button not enabled or missing.');

    // Wait for the /api/esign-templates POST to complete (up to 90s).
    // Success = 200 + body.ok=true + submissionId present. The UI auto-closes
    // the confirmation, so we key on the API response, not the DOM.
    let sendConfirmed = false;
    let sendResponse = null;
    for (let i = 0; i < 45; i++) {
      await page.waitForTimeout(2000);
      sendResponse = apiResponses.find((r) => r.body && r.body.ok && r.body.submissionId);
      if (sendResponse) { sendConfirmed = true; break; }
      const sent = await page.$('text=/Sent for signature|Signature request sent/i').catch(() => null);
      if (sent) { sendConfirmed = true; break; }
      const err = await page.$('[data-error], .error, [role="alert"]').catch(() => null);
      if (err) {
        const t = await err.textContent().catch(() => '');
        if (t && /error|fail/i.test(t)) {
          step('send confirmation', false, { error: t.slice(0, 200) });
          throw new Error(`Send failed with UI error: ${t.slice(0, 200)}`);
        }
      }
      // Also check API responses for errors even without ok body.
      const anyErr = apiResponses.find((r) => r.body && r.body.ok === false);
      if (anyErr) {
        step('send confirmation', false, { error: anyErr.body.error });
        throw new Error(`Send failed with API error ${anyErr.status}: ${anyErr.body.error}`);
      }
    }
    step('send confirmation', sendConfirmed, sendResponse ? { submissionId: sendResponse.body.submissionId } : {});
    evidence.screenshots.push(await screenshot(page, path.join(OUT_DIR, 'T6-send-confirmed.png')));
    if (!sendConfirmed) throw new Error('Did not see /api/esign-templates success response after 90s.');
    evidence.submissionId = sendResponse ? sendResponse.body.submissionId : null;
    evidence.apiResponses = apiResponses;

    // ---- Poll mailinator for the signing email -------------------------
    console.log(`[e2e] polling mailinator for ${buyer1Address}...`);
    let msg = null;
    try {
      msg = await pollInbox(buyer1Address, {
        timeoutMs: 180_000,
        pollMs: 10_000,
        subjectMatch: /sign|Dossie|DocuSeal|action required/i,
        olderThanIso: startIso,
      });
      step('email arrived in mailinator', true, { subject: msg.subject, receivedAt: msg.receivedAt });
    } catch (err) {
      step('email arrived in mailinator', false, { error: err.message });
      throw err;
    }

    // Save the email HTML to the run dir.
    fs.writeFileSync(path.join(OUT_DIR, 'email.html'), msg.html, 'utf8');

    // ---- Extract signing URL -------------------------------------------
    const signingUrl = extractSigningUrl(msg.html);
    step('extract signing URL', !!signingUrl, { signingUrl });
    evidence.signingUrl = signingUrl;
    if (!signingUrl) throw new Error('No DocuSeal signing URL found in email HTML.');

    // ---- Open signing URL in a new tab ---------------------------------
    const signerTab = await ctx.newPage();
    await signerTab.goto(signingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await signerTab.waitForTimeout(8000); // let the PDF viewer render fields
    step('open signing URL', true);
    evidence.screenshots.push(await screenshot(signerTab, path.join(OUT_DIR, 'T7-signer-view.png'), { fullPage: true }));

    // ---- Extract page text — verify property values render -------------
    const bodyText = await signerTab.evaluate(() => document.body.innerText).catch(() => '');
    evidence.signerViewText = bodyText.slice(0, 4000);
    fs.writeFileSync(path.join(OUT_DIR, 'signer-view-text.txt'), bodyText, 'utf8');

    const expectedRenders = [
      { key: 'property_address_full', re: /100 Test Ln/i, sample: '100 Test Ln' },
      { key: 'buyer_name', re: /Alex Testbuyer/i, sample: 'Alex Testbuyer' },
      { key: 'seller_name', re: /Sam Testseller/i, sample: 'Sam Testseller' },
      { key: 'sale_price', re: /525[,.]?000|525000/i, sample: '525000' },
      { key: 'closing_date', re: /2026-08-15|08\/15\/2026|Aug.*15.*2026/i, sample: '2026-08-15' },
    ];

    let allRendered = true;
    for (const check of expectedRenders) {
      const ok = check.re.test(bodyText);
      step(`signer view renders ${check.key} (${check.sample})`, ok);
      if (!ok) allRendered = false;
    }

    // NOTE: The signer view is often a canvas-rendered PDF where innerText
    // returns nothing. If bodyText is empty/tiny, we accept that fields
    // ARE present via a canvas snapshot if any of the expected values are
    // present anywhere in the raw HTML.
    if (!allRendered && bodyText.length < 200) {
      // Fall back to full HTML content search.
      const html = await signerTab.content();
      fs.writeFileSync(path.join(OUT_DIR, 'signer-view.html'), html, 'utf8');
      let recheckAllRendered = true;
      for (const check of expectedRenders) {
        const ok = check.re.test(html);
        step(`signer HTML fallback renders ${check.key}`, ok);
        if (!ok) recheckAllRendered = false;
      }
      allRendered = recheckAllRendered;
    }

    if (!allRendered) {
      // Try to fetch the PDF blob from DocuSeal directly (if we can find the
      // download URL in the DOM) and check for the text in it. This is a
      // final fallback — canvas-rendered viewers hide text from DOM.
      const pdfDlLink = await signerTab.$('a[href$=".pdf"], a[href*="/download/"]').catch(() => null);
      if (pdfDlLink) {
        const href = await pdfDlLink.getAttribute('href');
        console.log(`[e2e] found PDF download link: ${href}`);
      }
    }

    evidence.passed = allRendered;
    if (!allRendered) {
      evidence.failReason = 'Signer view did not render one or more expected values.';
    }

  } catch (err) {
    evidence.passed = false;
    evidence.failReason = err.message;
    console.error(`[e2e] FATAL: ${err.message}`);
  } finally {
    if (session) {
      // Persist video path before disposing.
      try {
        const video = session.page.video();
        if (video) evidence.videoPath = await video.path();
      } catch {}
      await session.dispose();
    }
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(OUT_DIR, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');

    console.log('\n=== EVIDENCE ===');
    console.log(`  Run dir     : ${OUT_DIR}`);
    console.log(`  Passed      : ${evidence.passed}`);
    console.log(`  Fail reason : ${evidence.failReason || '—'}`);
    console.log(`  Video       : ${evidence.videoPath || '—'}`);
    console.log(`  Signing URL : ${evidence.signingUrl || '—'}`);
    console.log(`  Screenshots : ${evidence.screenshots.length}`);
    console.log(`  Buyer 1 inbox: https://www.mailinator.com/v4/public/inbox.jsp?to=${encodeURIComponent(evidence.buyer1Address)}`);
  }

  process.exit(evidence.passed ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
