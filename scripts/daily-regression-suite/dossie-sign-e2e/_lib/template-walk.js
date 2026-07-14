/**
 * template-walk.js — reusable "Use TREC template" flow driver.
 *
 * The 15 canonical Dossie Sign forms all use the same modal + Send button,
 * so each per-form spec calls runTemplateWalk() with a small config object.
 * Keeps per-form specs to ~30 lines each.
 *
 * Config shape:
 *   {
 *     formKey: '20-19',
 *     runId: '20-19-template-<iso>',
 *     outDir: '.tmp/.../<runId>',
 *     base: 'https://meetdossie.com',
 *     headless: true,
 *     templateLabelRe: /20-19|Resale|One to Four/i,
 *     signers: [                     // list of signer profiles for this form
 *       { name, roleValue, addressForm, expectEmail: true },
 *     ],
 *     expectedRenders: [             // regexes to validate on the signer view
 *       { key, re, sample },
 *     ],
 *   }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { makeSignedInSession, ensureTestTransaction, screenshot } = require('./browser-walk');
const { pollInbox, extractSigningUrl, newAddress } = require('./mailinator');

async function runTemplateWalk(cfg) {
  const { formKey, base, headless, templateLabelRe, signers, expectedRenders } = cfg;
  const runId = cfg.runId || `${formKey}-template-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = cfg.outDir || path.resolve(__dirname, '..', '..', '..', '..', '.tmp', 'dossie-sign-e2e-runs', runId);
  const videoDir = path.join(outDir, 'video');
  fs.mkdirSync(outDir, { recursive: true });

  const startIso = new Date().toISOString();
  const evidence = {
    runId,
    form: formKey,
    mode: 'template',
    base,
    startedAt: startIso,
    signers: signers.map((s) => ({ ...s, address: s.addressForm || s.address })),
    steps: [],
    passed: false,
    failReason: null,
    videoPath: null,
    screenshots: [],
    signingUrl: null,
    signerViewText: null,
    consoleErrors: [],
    apiResponses: [],
  };

  function step(name, ok, extra = {}) {
    evidence.steps.push({ name, ok, at: new Date().toISOString(), ...extra });
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${extra.note ? ' — ' + extra.note : ''}`);
  }

  // Generate mailinator addresses for each signer up front.
  const signerAddresses = signers.map((s, i) => s.addressForm || newAddress(formKey, s.roleValue, i + 1));
  evidence.signerAddresses = signerAddresses;

  let session = null;
  const apiResponses = [];
  try {
    // Seed a test transaction (patch demo user's first dossier).
    const txCtx = await ensureTestTransaction();
    step('seed test transaction', true, { transactionId: txCtx.transactionId, propertyAddress: txCtx.propertyAddress });

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

    evidence.screenshots.push(await screenshot(page, path.join(outDir, 'T1-signed-in.png')));

    // Open the dossier (same fallback strategy as 20-19 spec).
    await page.waitForTimeout(3500);
    const dealCandidates = [
      `text="${txCtx.propertyAddress}"`,
      `text=/${txCtx.sentinel}/`,
      `text=/Test Ln/i`,
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
    if (!opened) {
      await page.goto(`${base}/workspace.html?dossierId=${txCtx.transactionId}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      }).catch(() => {});
      await page.waitForTimeout(4000);
      const inDetail = await page.$('button:has-text("Generate + Sign"), button:has-text("Fill Contract")').catch(() => null);
      if (inDetail) opened = true;
    }
    step('open seeded dossier', opened);
    evidence.screenshots.push(await screenshot(page, path.join(outDir, 'T2-dossier-open.png')));
    if (!opened) throw new Error('Could not open dossier.');

    // Click "Generate + Sign".
    const genSelectors = [
      'button:has-text("Generate + Sign")',
      'button:has-text("✍ Generate + Sign")',
      'button:has-text("Generate")',
    ];
    let clickedGen = false;
    for (const sel of genSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click().catch(() => {});
        await page.waitForTimeout(2000);
        clickedGen = true;
        break;
      }
    }
    step('click Generate + Sign', clickedGen);
    evidence.screenshots.push(await screenshot(page, path.join(outDir, 'T3-esign-modal.png')));
    if (!clickedGen) throw new Error('Could not click Generate + Sign.');

    await page.waitForTimeout(2000);

    // Fill each signer.
    for (let i = 0; i < signers.length; i++) {
      const s = signers[i];
      const addr = signerAddresses[i];

      // Add signer rows if there aren't enough yet.
      const currentNameInputs = await page.$$('input[placeholder="Full name"]');
      if (currentNameInputs.length <= i) {
        const addBtn = await page.$('button:has-text("+ Add signer")');
        if (addBtn) {
          await addBtn.click();
          await page.waitForTimeout(500);
        }
      }

      const nameInputs = await page.$$('input[placeholder="Full name"]');
      const emailInputs = await page.$$('input[type="email"][placeholder="Email address"]');
      if (nameInputs[i]) await nameInputs[i].fill(s.name);
      if (emailInputs[i]) await emailInputs[i].fill(addr);

      const roleSelects = await page.$$('select');
      // Find the select for this signer index that has the roleValue option.
      let assigned = false;
      for (let sIdx = i; sIdx < roleSelects.length; sIdx++) {
        try {
          const options = await roleSelects[sIdx].$$eval('option', (opts) => opts.map((o) => o.value));
          if (options.includes(s.roleValue)) {
            await roleSelects[sIdx].selectOption(s.roleValue).catch(() => {});
            assigned = true;
            break;
          }
        } catch {}
      }
      step(`fill signer ${i + 1} (${s.name} / ${s.roleValue})`, true, { note: `${addr}${assigned ? '' : ' [role select fallthrough]'}` });
    }
    evidence.screenshots.push(await screenshot(page, path.join(outDir, 'T4-signers-filled.png')));

    // Select the target template. The template list lives inside the modal
    // (a Send for Signature dialog). Search the buttons that are inside the
    // template list container to avoid picking up unrelated buttons in the
    // dossier detail nav (e.g. "Draft Amendment" toolbar button).
    //
    // TemplatePicker button structure (EsignModal.jsx line 424): each button
    // has an internal div with fontWeight:700 for the template label.
    // Scope to buttons that have "TREC" or "OP-" in the label div text.
    const templateBtns = await page.$$('button');
    let clickedTemplate = false;
    for (const btn of templateBtns) {
      try {
        const text = await btn.textContent();
        if (!text) continue;
        // Skip buttons that don't look like a template picker entry.
        if (!/TREC|OP-[LH]|Sellers Disclosure|Lead-Based|Amendment to Contract|Third Party Financing|Lender Appraisal|HOA Addendum|Resale Contract|Groundwater|Farm|Condominium|New Home|Backup|Seller Financing/i.test(text)) continue;
        if (!templateLabelRe.test(text)) continue;
        const isDisabled = await btn.evaluate((el) => el.disabled);
        if (isDisabled) continue;
        await btn.click().catch(() => {});
        clickedTemplate = true;
        break;
      } catch {}
    }
    step('select template', clickedTemplate);
    await page.waitForTimeout(1500);
    evidence.screenshots.push(await screenshot(page, path.join(outDir, 'T5-template-selected.png')));
    if (!clickedTemplate) throw new Error(`Could not find template matching ${templateLabelRe}`);

    // Click Send.
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
    if (!clickedSend) throw new Error('Send button not enabled.');

    // Wait for API 200 response.
    let sendResponse = null;
    for (let i = 0; i < 45; i++) {
      await page.waitForTimeout(2000);
      sendResponse = apiResponses.find((r) => r.body && r.body.ok && r.body.submissionId);
      if (sendResponse) break;
      const anyErr = apiResponses.find((r) => r.body && r.body.ok === false);
      if (anyErr) {
        step('send confirmation', false, { error: anyErr.body.error });
        throw new Error(`Send API error: ${anyErr.body.error}`);
      }
    }
    step('send confirmation', !!sendResponse, sendResponse ? { submissionId: sendResponse.body.submissionId } : {});
    evidence.screenshots.push(await screenshot(page, path.join(outDir, 'T6-send-confirmed.png')));
    if (!sendResponse) throw new Error('No successful send response after 90s.');

    evidence.submissionId = sendResponse.body.submissionId;
    evidence.apiResponses = apiResponses;

    // Poll mailinator for the FIRST signer's email. Timeout generously — the
    // public inbox has ingest latency spikes when the domain sees many test
    // messages in quick succession (running all 7 specs back-to-back triggers
    // this). 5 minutes covers observed worst-case delivery.
    const firstAddress = signerAddresses[0];
    console.log(`[e2e] polling mailinator for ${firstAddress}...`);
    const msg = await pollInbox(firstAddress, {
      timeoutMs: 300_000,
      pollMs: 10_000,
      subjectMatch: /sign|Dossie|DocuSeal|action required/i,
      olderThanIso: startIso,
    });
    step('email arrived in mailinator', true, { subject: msg.subject });
    fs.writeFileSync(path.join(outDir, 'email.html'), msg.html, 'utf8');

    const signingUrl = extractSigningUrl(msg.html);
    step('extract signing URL', !!signingUrl, { signingUrl });
    evidence.signingUrl = signingUrl;
    if (!signingUrl) throw new Error('No signing URL in email.');

    // Open signer view.
    const signerTab = await ctx.newPage();
    await signerTab.goto(signingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await signerTab.waitForTimeout(8000);
    step('open signing URL', true);
    evidence.screenshots.push(await screenshot(signerTab, path.join(outDir, 'T7-signer-view.png'), { fullPage: true }));

    const bodyText = await signerTab.evaluate(() => document.body.innerText).catch(() => '');
    evidence.signerViewText = bodyText.slice(0, 4000);
    fs.writeFileSync(path.join(outDir, 'signer-view-text.txt'), bodyText, 'utf8');

    let allRendered = true;
    for (const check of expectedRenders) {
      const ok = check.re.test(bodyText);
      step(`signer view renders ${check.key} (${check.sample})`, ok);
      if (!ok) allRendered = false;
    }
    if (!allRendered && bodyText.length < 200) {
      const html = await signerTab.content();
      fs.writeFileSync(path.join(outDir, 'signer-view.html'), html, 'utf8');
      let recheckAllRendered = true;
      for (const check of expectedRenders) {
        const ok = check.re.test(html);
        step(`signer HTML fallback renders ${check.key}`, ok);
        if (!ok) recheckAllRendered = false;
      }
      allRendered = recheckAllRendered;
    }

    evidence.passed = allRendered;
    if (!allRendered) evidence.failReason = 'One or more expected values missing from signer view.';
  } catch (err) {
    evidence.passed = false;
    evidence.failReason = err.message;
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
    fs.writeFileSync(path.join(outDir, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');

    console.log('\n=== EVIDENCE ===');
    console.log(`  Run dir     : ${outDir}`);
    console.log(`  Passed      : ${evidence.passed}`);
    console.log(`  Fail reason : ${evidence.failReason || '—'}`);
    console.log(`  Video       : ${evidence.videoPath || '—'}`);
    console.log(`  Signing URL : ${evidence.signingUrl || '—'}`);
    console.log(`  Screenshots : ${evidence.screenshots.length}`);
    console.log(`  Signer 1 inbox: https://www.mailinator.com/v4/public/inbox.jsp?to=${encodeURIComponent(signerAddresses[0] || '')}`);
  }

  return evidence;
}

module.exports = { runTemplateWalk };
