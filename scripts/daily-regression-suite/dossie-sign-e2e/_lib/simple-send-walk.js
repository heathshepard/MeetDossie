/**
 * simple-send-walk.js — reusable "Simple Send" flow driver.
 *
 * Simple Send flow (per EsignModal.jsx mode='simple' + api/esign-create.js):
 *   1. Agent has an already-uploaded/attached document row in Supabase.
 *   2. Agent clicks "Send for sig." on the doc row in workspace.
 *   3. EsignModal opens with `document={doc}` prop.
 *   4. Simple send tab is default (mode='simple' when doc is present).
 *   5. Agent fills signer name + email + role, optionally message.
 *   6. Clicks "Send for Signature" → POST /api/esign-create with documentId
 *      + signers array. Backend downloads PDF, POSTs to DocuSeal /templates/pdf
 *      to create a fresh template, then creates a submission.
 *
 * This walk automates that flow via Playwright, then verifies:
 *   - envelope created (submissionId returned)
 *   - Dossie signing email delivered to mailinator
 *   - signer link opens without error
 *
 * Config shape:
 *   {
 *     formKey: '20-19',
 *     base: 'https://meetdossie.com',
 *     headless: true,
 *     formTemplateId: 'a6114e4e-35b7-42af-8a90-375ae7ff608f',
 *     signers: [
 *       { name: 'Alex Testbuyer', roleValue: 'Buyer 1' },
 *     ],
 *     expectedRenders: [                // regexes to test the signer view
 *       { key, re, sample },
 *     ],
 *   }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { makeSignedInSession, ensureTestTransaction, screenshot } = require('./browser-walk');
const { pollInbox, extractSigningUrl, newAddress } = require('./mailinator');

// Late-resolved so the spec's loadDotenv() can populate before we read.
function supaUrl() { return process.env.SUPABASE_URL; }
function supaKey() { return process.env.SUPABASE_SERVICE_ROLE_KEY; }

/**
 * Attach a form_template to the demo user's dossier via /api/form-templates
 * (bypasses the workspace UI's FormLibraryModal because it's deep in a nested
 * autocomplete dropdown — direct REST call to the same endpoint the UI uses
 * gives a stable prerequisite state).
 *
 * Returns { documentId }.
 */
async function attachFormTemplate({ base, session, formTemplateId, transactionId }) {
  const res = await session.page.evaluate(async ({ apiBase, token, tid, ftid }) => {
    const r = await fetch(`${apiBase}/api/form-templates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action: 'attach', templateId: ftid, transactionId: tid }),
    });
    const text = await r.text();
    return { status: r.status, text };
  }, { apiBase: base, token: process.env.__DEMO_ACCESS_TOKEN__ || null, tid: transactionId, ftid: formTemplateId });

  if (res.status !== 200) {
    throw new Error(`form-templates attach failed (${res.status}): ${res.text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(res.text);
  if (!parsed.ok || !parsed.documentId) {
    throw new Error(`form-templates attach returned no documentId: ${res.text.slice(0, 200)}`);
  }
  return { documentId: parsed.documentId };
}

/**
 * Delete a document row via the Supabase service-role key.
 * Used to clean up after each spec so the workspace doesn't drift.
 */
async function deleteDocument(documentId) {
  if (!supaUrl() || !supaKey()) return;
  await fetch(`${supaUrl()}/rest/v1/documents?id=eq.${encodeURIComponent(documentId)}`, {
    method: 'DELETE',
    headers: {
      apikey: supaKey(),
      Authorization: `Bearer ${supaKey()}`,
    },
  }).catch(() => {});
}

async function runSimpleSendWalk(cfg) {
  const { formKey, base, headless, formTemplateId, signers, expectedRenders } = cfg;
  const runId = cfg.runId || `${formKey}-simplesend-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = cfg.outDir || path.resolve(__dirname, '..', '..', '..', '..', '.tmp', 'dossie-sign-e2e-runs', runId);
  const videoDir = path.join(outDir, 'video');
  fs.mkdirSync(outDir, { recursive: true });

  const startIso = new Date().toISOString();
  const evidence = {
    runId,
    form: formKey,
    mode: 'simple',
    base,
    startedAt: startIso,
    signers: signers.map((s) => ({ ...s })),
    steps: [],
    passed: false,
    failReason: null,
    videoPath: null,
    screenshots: [],
    signingUrl: null,
    signerViewText: null,
    consoleErrors: [],
    apiResponses: [],
    createdDocumentId: null,
  };

  function step(name, ok, extra = {}) {
    evidence.steps.push({ name, ok, at: new Date().toISOString(), ...extra });
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${extra.note ? ' — ' + extra.note : ''}`);
  }

  const signerAddresses = signers.map((s, i) => s.addressForm || newAddress(formKey, s.roleValue, i + 1));
  evidence.signerAddresses = signerAddresses;

  let session = null;
  const apiResponses = [];
  try {
    const txCtx = await ensureTestTransaction();
    step('seed test transaction', true, { transactionId: txCtx.transactionId });

    session = await makeSignedInSession({ base, headless, videoDir, consoleErrors: evidence.consoleErrors });
    const { page, ctx } = session;
    step('sign in as demo', true);

    // Grab the demo user's supabase access token so we can attach the form via API.
    // Dossie's supabase-client.js uses storageKey: 'supabase.auth.token' — check
    // that first, then fall back to the auto-derived sb-<projectRef>-auth-token key
    // in case a future refactor moves back to the default.
    const token = await page.evaluate(() => {
      try {
        const custom = localStorage.getItem('supabase.auth.token');
        if (custom) {
          const parsed = JSON.parse(custom);
          // Supabase v2 wraps under `.session.access_token` OR stores flat `.access_token`.
          const t = parsed?.access_token
            || parsed?.session?.access_token
            || parsed?.currentSession?.access_token
            || (parsed?.[1] && parsed[1].access_token)
            || null;
          if (t) return t;
        }
        for (const k of Object.keys(localStorage)) {
          if (/sb-.*-auth-token/.test(k) || /supabase.*auth/i.test(k)) {
            const parsed = JSON.parse(localStorage.getItem(k));
            const t = parsed?.access_token
              || parsed?.session?.access_token
              || parsed?.currentSession?.access_token
              || (parsed?.[1] && parsed[1].access_token)
              || null;
            if (t) return t;
          }
        }
      } catch {}
      return null;
    });
    if (!token) throw new Error('Could not extract supabase access token from browser session.');
    process.env.__DEMO_ACCESS_TOKEN__ = token;

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

    // Attach the form template — creates a documents row so the UI has
    // something to click "Send for sig." on.
    const attachResult = await attachFormTemplate({
      base, session, formTemplateId, transactionId: txCtx.transactionId,
    });
    const documentId = attachResult.documentId;
    // Read the attached doc's file_name so we can target its "Send for sig."
    // button precisely (the demo user's workspace has many pre-existing
    // signed docs — picking the LAST button hits the wrong doc).
    let attachedFileName = null;
    try {
      const r = await fetch(`${supaUrl()}/rest/v1/documents?id=eq.${encodeURIComponent(documentId)}&select=file_name`, {
        headers: {
          apikey: supaKey(),
          Authorization: `Bearer ${supaKey()}`,
        },
      });
      if (r.ok) {
        const rows = await r.json();
        attachedFileName = rows?.[0]?.file_name || null;
      }
    } catch {}
    evidence.createdDocumentId = documentId;
    evidence.attachedFileName = attachedFileName;
    step('attach form template', true, { documentId, fileName: attachedFileName });

    // Reload workspace so the new document row renders.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    // Dismiss any modal.
    await page.keyboard.press('Escape').catch(() => {});

    // Open the seeded dossier.
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
      opened = true;
    }
    step('open seeded dossier', opened);
    evidence.screenshots.push(await screenshot(page, path.join(outDir, 'T1-dossier-open.png')));

    // Scroll down to the documents section and find the doc we just attached.
    // The button is styled with "✍ Send for sig." per dossie-app.jsx:10739.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(1500);

    // Find the send button belonging to our attached document. Each doc row
    // has "Send for sig." — target the row containing the attached filename.
    // Falls back to any Send for sig. button if the filename is unknown.
    let btn = null;
    let clickedByName = false;
    if (attachedFileName) {
      // The doc row contains the filename text + the "Send for sig." button.
      // Find a button ancestor of a row that contains the filename.
      btn = await page.evaluateHandle((fileName) => {
        const allBtns = Array.from(document.querySelectorAll('button'));
        // "Send for sig." button text can vary — match "Send for sig" prefix.
        const sendBtns = allBtns.filter((b) => /Send for sig/i.test(b.textContent || ''));
        for (const b of sendBtns) {
          // Walk up looking for a container that also contains the filename.
          let node = b.parentElement;
          for (let i = 0; i < 8 && node; i++) {
            if (node.textContent && node.textContent.includes(fileName)) {
              return b;
            }
            node = node.parentElement;
          }
        }
        return null;
      }, attachedFileName);
      const isValid = btn && await btn.evaluate((el) => !!el).catch(() => false);
      if (isValid) {
        clickedByName = true;
      } else {
        btn = null;
      }
    }
    if (!btn) {
      const sendBtns = await page.$$('button:has-text("Send for sig")');
      if (sendBtns.length === 0) throw new Error('No "Send for sig." button found — workspace did not render attached doc.');
      btn = sendBtns[sendBtns.length - 1];
    }
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click();
    await page.waitForTimeout(2500);
    step('click Send for sig.', true, { note: clickedByName ? `matched by filename: ${attachedFileName}` : 'fallback to last button' });
    evidence.screenshots.push(await screenshot(page, path.join(outDir, 'T2-esign-modal.png')));

    // Confirm we're on Simple send tab (default when doc is present).
    // Also handle the case where the modal defaults to another tab: click "Simple send".
    const simpleTab = await page.$('button:has-text("Simple send")');
    if (simpleTab) {
      await simpleTab.click().catch(() => {});
      await page.waitForTimeout(500);
    }
    step('open Simple send tab', true);

    // Fill signers.
    for (let i = 0; i < signers.length; i++) {
      const s = signers[i];
      const addr = signerAddresses[i];

      const currentNameInputs = await page.$$('input[placeholder="Full name"]');
      if (currentNameInputs.length <= i) {
        const addBtn = await page.$('button:has-text("+ Add another signer"), button:has-text("+ Add signer")');
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
      step(`fill signer ${i + 1} (${s.name} / ${s.roleValue})`, true, { note: `${addr}${assigned ? '' : ' [role fallthrough]'}` });
    }
    evidence.screenshots.push(await screenshot(page, path.join(outDir, 'T3-signers-filled.png')));

    // Click "Send for Signature".
    const sendBtn = await page.$('button:has-text("Send for Signature")');
    let clickedSend = false;
    if (sendBtn) {
      const isDisabled = await sendBtn.evaluate((el) => el.disabled);
      if (!isDisabled) {
        await sendBtn.click().catch(() => {});
        clickedSend = true;
      }
    }
    step('click Send for Signature', clickedSend);
    if (!clickedSend) throw new Error('Send for Signature button not enabled/found.');

    // Wait for API 200.
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
    evidence.screenshots.push(await screenshot(page, path.join(outDir, 'T4-send-confirmed.png')));
    if (!sendResponse) throw new Error('No successful send response after 90s.');

    evidence.submissionId = sendResponse.body.submissionId;
    evidence.apiResponses = apiResponses;

    // Poll mailinator for the first signer.
    const firstAddress = signerAddresses[0];
    console.log(`[e2e-simplesend] polling mailinator for ${firstAddress}...`);
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
    evidence.screenshots.push(await screenshot(signerTab, path.join(outDir, 'T5-signer-view.png'), { fullPage: true }));

    const bodyText = await signerTab.evaluate(() => document.body.innerText).catch(() => '');
    evidence.signerViewText = bodyText.slice(0, 4000);
    fs.writeFileSync(path.join(outDir, 'signer-view-text.txt'), bodyText, 'utf8');

    let allRendered = true;
    for (const check of expectedRenders || []) {
      const ok = check.re.test(bodyText);
      step(`signer view renders ${check.key} (${check.sample})`, ok);
      if (!ok) allRendered = false;
    }

    evidence.passed = allRendered;
    if (!allRendered) evidence.failReason = 'One or more expected values missing from signer view.';
  } catch (err) {
    evidence.passed = false;
    evidence.failReason = err.message;
    console.error(`[e2e-simplesend] FATAL: ${err.message}`);
  } finally {
    if (session) {
      try {
        const video = session.page.video();
        if (video) evidence.videoPath = await video.path();
      } catch {}
      await session.dispose();
    }
    if (evidence.createdDocumentId) {
      await deleteDocument(evidence.createdDocumentId).catch(() => {});
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
    if (signerAddresses[0]) {
      console.log(`  Signer 1 inbox: https://www.mailinator.com/v4/public/inbox.jsp?to=${encodeURIComponent(signerAddresses[0])}`);
    }
  }

  return evidence;
}

module.exports = { runSimpleSendWalk };
