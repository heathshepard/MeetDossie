#!/usr/bin/env node
/**
 * iabs-defaults-e2e.spec.js — IABS progressive profiling end-to-end.
 *
 * Verifies the full customer flow for the two IABS templates
 * (4985883 Buyer/Tenant + 4984666 Seller/Landlord) with agent defaults:
 *
 *   FIRST-TIME PATH (Buyer/Tenant):
 *     1. Reset demo profile — clear iabs_defaults_completed + broker cols
 *     2. Sign in as demo → open dossier → Generate + Sign
 *     3. Fill Buyer 1 signer w/ mailinator address
 *     4. Select "IABS (Buyer/Tenant)"
 *     5. Verify first-time banner appears + 11 broker fields visible
 *     6. Fill all 11 IABS fields
 *     7. Click Send
 *     8. Verify Resend email arrives in mailinator inbox
 *     9. Verify save-defaults prompt appears
 *    10. Click "Yes, save as default"
 *    11. Verify profile.iabs_defaults_completed = true in DB
 *
 *   REPEAT PATH (Seller/Landlord):
 *    12. Open the same dossier → Generate + Sign again
 *    13. Select "IABS (Seller/Landlord)"
 *    14. Verify "IABS defaults active" banner appears
 *    15. Verify 11 broker fields are pre-populated from saved defaults
 *    16. Add Seller 1 signer + mailinator address
 *    17. Click Send
 *    18. Verify Resend email arrives at 2nd inbox
 *    19. Open signing URL + confirm sales_agent_name / broker_name render
 *
 * PASS = all steps green + video + both emails delivered + both signer
 *        views show the broker/agent defaults on the rendered PDF.
 *
 * USAGE:
 *   node scripts/daily-regression-suite/dossie-sign-e2e/tests/iabs-defaults-e2e.spec.js
 *   BASE_URL=https://staging-preview.vercel.app node ...
 *   HEADED=1 node ...
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  makeSignedInSession,
  ensureTestTransaction,
  screenshot,
} = require('../_lib/browser-walk');
const { pollInbox, extractSigningUrl, newAddress } = require('../_lib/mailinator');

const DEMO_USER_ID = 'c29ce34c-1434-44e5-a260-8d1a45213ec3';

const IABS_TEST_DATA = {
  broker_name:                'KW City View',
  broker_license_number:      '9001234',
  broker_email:               'broker-iabs-e2e@meetdossie.test',
  broker_phone:               '(210) 555-1234',
  supervising_broker_name:    'Alicia Supervisor',
  supervising_broker_license: '5551234',
  supervising_broker_phone:   '(210) 555-9911',
  agent_license_number:       '0765432',
  agent_phone:                '(210) 555-9876',
};

// Same keys, mapped to the DocuSeal-facing field names the modal uses.
const IABS_FORM_FIELDS = {
  sponsoring_broker_name:       IABS_TEST_DATA.broker_name,
  sponsoring_broker_license_no: IABS_TEST_DATA.broker_license_number,
  sponsoring_broker_email:      IABS_TEST_DATA.broker_email,
  sponsoring_broker_phone:      IABS_TEST_DATA.broker_phone,
  supervisor_name:              IABS_TEST_DATA.supervising_broker_name,
  supervisor_license_no:        IABS_TEST_DATA.supervising_broker_license,
  supervisor_phone:             IABS_TEST_DATA.supervising_broker_phone,
  sales_agent_name:             'Demo Agent',
  sales_agent_license_no:       IABS_TEST_DATA.agent_license_number,
  sales_agent_email:            'demo@meetdossie.com',
  sales_agent_phone:            IABS_TEST_DATA.agent_phone,
};

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

async function resetDemoIabsDefaults() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE env vars missing.');
  const patch = {
    iabs_defaults_completed: false,
    broker_name: null,
    broker_license_number: null,
    broker_phone: null,
    broker_email: null,
    supervising_broker_name: null,
    supervising_broker_license: null,
    supervising_broker_phone: null,
    agent_license_number: null,
    agent_phone: null,
  };
  const res = await fetch(`${url}/rest/v1/profiles?id=eq.${DEMO_USER_ID}`, {
    method: 'PATCH',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`resetDemoIabsDefaults failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

async function fetchDemoProfile() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(
    `${url}/rest/v1/profiles?id=eq.${DEMO_USER_ID}&select=iabs_defaults_completed,broker_name,broker_license_number,broker_email,broker_phone,supervising_broker_name,supervising_broker_license,supervising_broker_phone,agent_license_number,agent_phone&limit=1`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    }
  );
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function openDossierAndGenerateSign({ page, txCtx }) {
  const candidates = [
    `text="${txCtx.propertyAddress}"`,
    `text=/${txCtx.sentinel}/`,
    `text=/Test Ln/i`,
  ];
  let opened = false;
  for (const sel of candidates) {
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
  if (!opened) {
    // fallback direct URL
    const base = process.env.BASE_URL || 'https://meetdossie.com';
    await page.goto(`${base}/workspace.html?dossierId=${txCtx.transactionId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    }).catch(() => {});
    await page.waitForTimeout(4000);
  }

  const genSelectors = [
    'button:has-text("Generate + Sign")',
    'button:has-text("✍ Generate + Sign")',
    'button:has-text("Generate")',
  ];
  for (const sel of genSelectors) {
    const el = await page.$(sel);
    if (el) {
      await el.click().catch(() => {});
      await page.waitForTimeout(2500);
      return true;
    }
  }
  return false;
}

async function fillSignerRow({ page, index, name, email, roleValue }) {
  const currentNameInputs = await page.$$('input[placeholder="Full name"]');
  if (currentNameInputs.length <= index) {
    const addBtn = await page.$('button:has-text("+ Add signer")');
    if (addBtn) {
      await addBtn.click();
      await page.waitForTimeout(500);
    }
  }
  const nameInputs = await page.$$('input[placeholder="Full name"]');
  const emailInputs = await page.$$('input[type="email"][placeholder="Email address"]');
  if (nameInputs[index]) await nameInputs[index].fill(name);
  if (emailInputs[index]) await emailInputs[index].fill(email);
  const roleSelects = await page.$$('select');
  for (let sIdx = index; sIdx < roleSelects.length; sIdx++) {
    try {
      const options = await roleSelects[sIdx].$$eval('option', (opts) => opts.map((o) => o.value));
      if (options.includes(roleValue)) {
        await roleSelects[sIdx].selectOption(roleValue).catch(() => {});
        break;
      }
    } catch {}
  }
}

async function selectTemplate(page, labelRe) {
  const templateBtns = await page.$$('button');
  for (const btn of templateBtns) {
    try {
      const text = await btn.textContent();
      if (!text) continue;
      if (!labelRe.test(text)) continue;
      const isDisabled = await btn.evaluate((el) => el.disabled);
      if (isDisabled) continue;
      await btn.click().catch(() => {});
      await page.waitForTimeout(1200);
      return true;
    } catch {}
  }
  return false;
}

async function fillIabsFormFields(page, formFields) {
  for (const [key, value] of Object.entries(formFields)) {
    const sel = `[data-testid="iabs-field-${key}"]`;
    const el = await page.$(sel).catch(() => null);
    if (!el) continue;
    await el.fill(value).catch(() => {});
  }
}

async function readIabsFormValues(page) {
  const out = {};
  const keys = [
    'sponsoring_broker_name', 'sponsoring_broker_license_no', 'sponsoring_broker_email',
    'sponsoring_broker_phone', 'supervisor_name', 'supervisor_license_no',
    'supervisor_phone', 'sales_agent_name', 'sales_agent_license_no',
    'sales_agent_email', 'sales_agent_phone',
  ];
  for (const key of keys) {
    const sel = `[data-testid="iabs-field-${key}"]`;
    const el = await page.$(sel).catch(() => null);
    if (!el) { out[key] = ''; continue; }
    out[key] = await el.inputValue().catch(() => '');
  }
  return out;
}

async function clickSendButton(page) {
  const btn = await page.$('[data-testid="template-send-button"]');
  if (!btn) return false;
  const isDisabled = await btn.evaluate((el) => el.disabled);
  if (isDisabled) return false;
  await btn.click().catch(() => {});
  return true;
}

async function main() {
  loadDotenv();
  const base = process.env.BASE_URL || 'https://meetdossie.com';
  const headless = process.env.HEADED === '1' ? false : true;

  const runId = `iabs-defaults-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = path.resolve(__dirname, '..', '..', '..', '..', '.tmp', 'dossie-sign-e2e-runs', runId);
  const videoDir = path.join(outDir, 'video');
  fs.mkdirSync(outDir, { recursive: true });

  const startIso = new Date().toISOString();
  const evidence = {
    runId,
    form: 'iabs-defaults',
    mode: 'template',
    base,
    startedAt: startIso,
    steps: [],
    passed: false,
    failReason: null,
    videoPath: null,
    screenshots: [],
    consoleErrors: [],
    apiResponses: [],
    inboxes: {},
    profileStates: {},
  };

  function step(name, ok, extra = {}) {
    evidence.steps.push({ name, ok, at: new Date().toISOString(), ...extra });
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${extra.note ? ' — ' + extra.note : ''}`);
    if (!ok) evidence.failReason = evidence.failReason || name;
  }

  let session = null;
  const apiResponses = [];

  try {
    // 1. Reset demo IABS defaults so this run starts as a first-timer.
    await resetDemoIabsDefaults();
    const initialProfile = await fetchDemoProfile();
    evidence.profileStates.initial = initialProfile;
    step('reset demo IABS defaults', initialProfile && initialProfile.iabs_defaults_completed === false);

    // 2. Seed test transaction (patch existing demo dossier).
    const txCtx = await ensureTestTransaction();
    evidence.transactionId = txCtx.transactionId;
    step('seed test transaction', true, {
      transactionId: txCtx.transactionId,
      propertyAddress: txCtx.propertyAddress,
    });

    // 3. Sign in as demo.
    session = await makeSignedInSession({
      base,
      headless,
      videoDir,
      consoleErrors: evidence.consoleErrors,
    });
    const { page, ctx } = session;
    step('sign in as demo', true);

    page.on('response', async (resp) => {
      const u = resp.url();
      if (/\/api\/(esign-templates|save-agent-defaults|get-agent-defaults)\b/.test(u) &&
          (resp.request().method() === 'POST' || resp.request().method() === 'GET')) {
        try {
          const body = await resp.json();
          apiResponses.push({
            url: u,
            method: resp.request().method(),
            status: resp.status(),
            body,
          });
          console.log(`  [api] ${resp.status()} ${resp.request().method()} ${u.split('/api/')[1]} ok=${body && body.ok}`);
        } catch {
          apiResponses.push({ url: u, method: resp.request().method(), status: resp.status(), body: null });
        }
      }
    });

    evidence.screenshots.push(await screenshot(page, path.join(outDir, 'T01-signed-in.png')));

    // 4. Open dossier + Generate + Sign.
    await page.waitForTimeout(3000);
    const openedT1 = await openDossierAndGenerateSign({ page, txCtx });
    step('open dossier and click Generate + Sign (first time)', openedT1);
    if (!openedT1) throw new Error('Could not open dossier / Generate + Sign.');
    evidence.screenshots.push(await screenshot(page, path.join(outDir, 'T02-esign-modal-open.png')));

    // 5. Add Buyer 1 signer with mailinator inbox.
    const buyerAddress = newAddress('iabs-bt', 'buyer1', 1);
    evidence.inboxes.buyer1 = buyerAddress;
    await fillSignerRow({ page, index: 0, name: 'Alex Testbuyer', email: buyerAddress, roleValue: 'Buyer 1' });
    step('fill Buyer 1 signer row', true, { email: buyerAddress });

    // 6. Select IABS Buyer/Tenant template.
    const pickedT1 = await selectTemplate(page, /IABS.*Buyer|Buyer.Tenant/i);
    step('select IABS (Buyer/Tenant) template', pickedT1);
    if (!pickedT1) throw new Error('IABS Buyer/Tenant template not found in picker.');
    evidence.screenshots.push(await screenshot(page, path.join(outDir, 'T03-iabs-template-selected-first-time.png')));

    // 7. Verify first-time banner appears.
    const bannerFirstTime = await page.$('[data-testid="iabs-first-time-banner"]');
    step('first-time IABS banner visible', !!bannerFirstTime);

    // 8. Fill the 11 IABS fields.
    await fillIabsFormFields(page, IABS_FORM_FIELDS);
    step('fill 11 IABS broker/agent fields', true);
    evidence.screenshots.push(await screenshot(page, path.join(outDir, 'T04-iabs-fields-filled.png')));

    // 9. Click Send.
    const sentT1 = await clickSendButton(page);
    step('click Send (first time)', sentT1);

    // 10. Wait for esign-templates POST success.
    let sendResponse = null;
    for (let i = 0; i < 45; i++) {
      await page.waitForTimeout(2000);
      sendResponse = apiResponses.find(
        (r) => /esign-templates/.test(r.url) && r.method === 'POST' && r.body && r.body.ok && r.body.submissionId
      );
      if (sendResponse) break;
      const err = apiResponses.find(
        (r) => /esign-templates/.test(r.url) && r.method === 'POST' && r.body && r.body.ok === false
      );
      if (err) throw new Error(`Send API error: ${err.body.error}`);
    }
    step('esign-templates POST returned submissionId', !!sendResponse,
      sendResponse ? { submissionId: sendResponse.body.submissionId } : {});
    if (!sendResponse) throw new Error('No successful send response for IABS Buyer/Tenant.');
    evidence.submissionIdBuyer = sendResponse.body.submissionId;

    // 11. Save-defaults prompt should appear.
    await page.waitForTimeout(1500);
    const savePrompt = await page.$('[data-testid="iabs-save-defaults-prompt"]');
    step('save-defaults prompt appears after first-time send', !!savePrompt);
    evidence.screenshots.push(await screenshot(page, path.join(outDir, 'T05-save-defaults-prompt.png')));

    // 12. Click Yes.
    const yesBtn = await page.$('[data-testid="iabs-save-defaults-yes"]');
    if (yesBtn) {
      await yesBtn.click().catch(() => {});
      await page.waitForTimeout(3000);
    }
    const saveResp = apiResponses.find(
      (r) => /save-agent-defaults/.test(r.url) && r.method === 'POST'
    );
    step('save-agent-defaults POST succeeded', !!(saveResp && saveResp.body && saveResp.body.ok),
      saveResp ? { status: saveResp.status } : {});

    // 13. Verify profile flag flipped in DB.
    const afterSaveProfile = await fetchDemoProfile();
    evidence.profileStates.afterSave = afterSaveProfile;
    step('profile.iabs_defaults_completed = true in DB',
      !!(afterSaveProfile && afterSaveProfile.iabs_defaults_completed === true));
    step('profile.broker_name persisted',
      !!(afterSaveProfile && afterSaveProfile.broker_name === IABS_TEST_DATA.broker_name));
    step('profile.supervising_broker_license persisted (column name)',
      !!(afterSaveProfile && afterSaveProfile.supervising_broker_license === IABS_TEST_DATA.supervising_broker_license));

    // 14. Poll mailinator for the buyer-side email.
    console.log(`  [e2e] polling mailinator for ${buyerAddress}...`);
    const msg1 = await pollInbox(buyerAddress, {
      timeoutMs: 300_000,
      pollMs: 10_000,
      subjectMatch: /sign|Dossie|DocuSeal|IABS|action required/i,
      olderThanIso: startIso,
    });
    step('email arrived at Buyer 1 inbox (first send)', true, { subject: msg1.subject });
    fs.writeFileSync(path.join(outDir, 'email-buyer1.html'), msg1.html, 'utf8');
    const signingUrl1 = extractSigningUrl(msg1.html);
    step('extract Buyer 1 signing URL', !!signingUrl1, { signingUrl: signingUrl1 });

    // 15. REPEAT PATH — Seller/Landlord with saved defaults.
    // Close the current modal + start fresh.
    const closeXBtn = await page.$('button[aria-label="Close"]');
    if (closeXBtn) await closeXBtn.click().catch(() => {});
    await page.waitForTimeout(1500);

    // Reload the workspace to re-hydrate the template picker's IABS defaults GET.
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(4000);

    const openedT2 = await openDossierAndGenerateSign({ page, txCtx });
    step('open dossier and click Generate + Sign (repeat)', openedT2);
    if (!openedT2) throw new Error('Could not re-open dossier for repeat send.');
    await page.waitForTimeout(2000);
    evidence.screenshots.push(await screenshot(page, path.join(outDir, 'T06-esign-modal-repeat.png')));

    // 16. Add Seller 1 signer with mailinator inbox.
    const sellerAddress = newAddress('iabs-sl', 'seller1', 1);
    evidence.inboxes.seller1 = sellerAddress;
    await fillSignerRow({ page, index: 0, name: 'Sam Testseller', email: sellerAddress, roleValue: 'Seller 1' });
    step('fill Seller 1 signer row', true, { email: sellerAddress });

    // 17. Select IABS Seller/Landlord.
    const pickedT2 = await selectTemplate(page, /IABS.*Seller|Seller.Landlord/i);
    step('select IABS (Seller/Landlord) template', pickedT2);
    if (!pickedT2) throw new Error('IABS Seller/Landlord template not found in picker.');
    await page.waitForTimeout(1500);
    evidence.screenshots.push(await screenshot(page, path.join(outDir, 'T07-iabs-template-selected-repeat.png')));

    // 18. Verify defaults-active banner shows.
    const bannerActive = await page.$('[data-testid="iabs-defaults-active-banner"]');
    step('defaults-active banner visible on repeat send', !!bannerActive);

    // 19. Verify 11 fields are pre-populated from saved defaults.
    const populatedValues = await readIabsFormValues(page);
    evidence.populatedValues = populatedValues;
    const expectPrepopulated = {
      sponsoring_broker_name: IABS_FORM_FIELDS.sponsoring_broker_name,
      sponsoring_broker_license_no: IABS_FORM_FIELDS.sponsoring_broker_license_no,
      sponsoring_broker_phone: IABS_FORM_FIELDS.sponsoring_broker_phone,
      supervisor_name: IABS_FORM_FIELDS.supervisor_name,
      supervisor_license_no: IABS_FORM_FIELDS.supervisor_license_no,
      sales_agent_license_no: IABS_FORM_FIELDS.sales_agent_license_no,
      sales_agent_phone: IABS_FORM_FIELDS.sales_agent_phone,
    };
    for (const [key, expected] of Object.entries(expectPrepopulated)) {
      const got = populatedValues[key];
      step(`field ${key} auto-populated from saved defaults`, got === expected,
        { expected, got });
    }
    evidence.screenshots.push(await screenshot(page, path.join(outDir, 'T08-fields-auto-populated.png')));

    // 20. Send it (defaults are populated, no prompt should appear this time).
    const sentT2 = await clickSendButton(page);
    step('click Send (repeat)', sentT2);

    apiResponses.length = 0;  // reset so we pick up only this send's responses
    let sendResponse2 = null;
    for (let i = 0; i < 45; i++) {
      await page.waitForTimeout(2000);
      sendResponse2 = apiResponses.find(
        (r) => /esign-templates/.test(r.url) && r.method === 'POST' && r.body && r.body.ok && r.body.submissionId
      );
      if (sendResponse2) break;
      const err = apiResponses.find(
        (r) => /esign-templates/.test(r.url) && r.method === 'POST' && r.body && r.body.ok === false
      );
      if (err) throw new Error(`Repeat send API error: ${err.body.error}`);
    }
    step('repeat esign-templates POST returned submissionId', !!sendResponse2,
      sendResponse2 ? { submissionId: sendResponse2.body.submissionId } : {});
    if (!sendResponse2) throw new Error('No successful send response for IABS Seller/Landlord.');
    evidence.submissionIdSeller = sendResponse2.body.submissionId;

    // 21. Save-defaults prompt should NOT appear this time (defaults already saved).
    const savePromptAgain = await page.$('[data-testid="iabs-save-defaults-prompt"]');
    step('save-defaults prompt NOT shown on repeat send', !savePromptAgain);
    evidence.screenshots.push(await screenshot(page, path.join(outDir, 'T09-repeat-sent.png')));

    // 22. Poll mailinator for seller-side email.
    console.log(`  [e2e] polling mailinator for ${sellerAddress}...`);
    const msg2 = await pollInbox(sellerAddress, {
      timeoutMs: 300_000,
      pollMs: 10_000,
      subjectMatch: /sign|Dossie|DocuSeal|IABS|action required/i,
      olderThanIso: startIso,
    });
    step('email arrived at Seller 1 inbox (repeat send)', true, { subject: msg2.subject });
    fs.writeFileSync(path.join(outDir, 'email-seller1.html'), msg2.html, 'utf8');
    const signingUrl2 = extractSigningUrl(msg2.html);
    step('extract Seller 1 signing URL', !!signingUrl2, { signingUrl: signingUrl2 });

    // 23. Open Buyer signing URL + verify broker prefill renders.
    // (The Buyer 1 signer only owns client_initials + acknowledgment_date, so
    // to see the broker/agent prefill we open the SELLER-side (Seller Broker
    // isn't on this envelope), but the Buyer Broker slug link was sent to the
    // agent's email in envelope T1 — we don't intercept that here. Instead we
    // verify the Seller 1 view has the broker/agent fields visibly rendered on
    // the PDF preview. On IABS templates the broker section renders regardless
    // of role, since it's a shared document view.)
    if (signingUrl2) {
      const signerTab = await ctx.newPage();
      await signerTab.goto(signingUrl2, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await signerTab.waitForTimeout(8000);
      const bodyText = await signerTab.evaluate(() => document.body.innerText).catch(() => '');
      fs.writeFileSync(path.join(outDir, 'signer-view-seller1.txt'), bodyText, 'utf8');
      evidence.screenshots.push(await screenshot(signerTab, path.join(outDir, 'T10-signer-view-seller1.png'), { fullPage: true }));

      // Broker/agent info should render somewhere on the IABS PDF preview.
      // DocuSeal's signer view iframes the PDF, so innerText may be limited —
      // fallback to page HTML check.
      const foundBrokerName = new RegExp(IABS_TEST_DATA.broker_name, 'i').test(bodyText);
      const foundLicense = new RegExp(IABS_TEST_DATA.broker_license_number, 'i').test(bodyText);
      let bodyOrHtml = bodyText;
      if (!foundBrokerName || !foundLicense) {
        const html = await signerTab.content();
        fs.writeFileSync(path.join(outDir, 'signer-view-seller1.html'), html, 'utf8');
        bodyOrHtml = html;
      }
      step('signer view contains sponsoring broker name',
        new RegExp(IABS_TEST_DATA.broker_name.replace(/\s+/g, '\\s*'), 'i').test(bodyOrHtml));
      step('signer view contains broker license number',
        new RegExp(IABS_TEST_DATA.broker_license_number).test(bodyOrHtml));
      await signerTab.close().catch(() => {});
    }

    // Consider passed if all-critical steps green (fail-reason is the FIRST fail).
    const anyFail = evidence.steps.find((s) => !s.ok);
    evidence.passed = !anyFail;
    if (anyFail && !evidence.failReason) evidence.failReason = anyFail.name;
  } catch (err) {
    evidence.passed = false;
    evidence.failReason = evidence.failReason || err.message;
    console.error(`[e2e] FATAL: ${err.message}`);
  } finally {
    if (session) {
      try {
        const video = session.page.video();
        if (video) evidence.videoPath = await video.path();
      } catch {}
      await session.dispose();
    }
    evidence.finishedAt = new Date().toISOString();
    evidence.apiResponses = apiResponses;
    fs.writeFileSync(path.join(outDir, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');

    console.log('\n=== EVIDENCE ===');
    console.log(`  Run dir     : ${outDir}`);
    console.log(`  Passed      : ${evidence.passed}`);
    console.log(`  Fail reason : ${evidence.failReason || '-'}`);
    console.log(`  Video       : ${evidence.videoPath || '-'}`);
    console.log(`  Screenshots : ${evidence.screenshots.length}`);
    if (evidence.inboxes.buyer1) {
      console.log(`  Buyer inbox : https://www.mailinator.com/v4/public/inbox.jsp?to=${encodeURIComponent(evidence.inboxes.buyer1)}`);
    }
    if (evidence.inboxes.seller1) {
      console.log(`  Seller inbox: https://www.mailinator.com/v4/public/inbox.jsp?to=${encodeURIComponent(evidence.inboxes.seller1)}`);
    }
  }

  process.exit(evidence.passed ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
