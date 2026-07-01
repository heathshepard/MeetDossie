#!/usr/bin/env node
// Dossie Sign E2E loop — runs full pipeline 5+ times on staging
// Atlas overnight run 2026-06-27 for Heath demo tomorrow.
//
// Usage:
//   DEMO_JWT=<jwt> node run-loop.js
//
// Steps per iteration:
//   1. Create test transaction (Supabase service role)
//   2. POST /api/fill-form with TREC 20-18 (resale) payload — validates voice→fields
//   3. POST /api/fill-form-via-docuseal — validates DocuSeal template prefill
//   4. POST /api/dossiesign-prepare — validates packet prep
//   5. POST /api/esign-create — validates envelope creation
//   6. Verify envelope status via DocuSeal API directly
//   7. Trigger completion via DocuSeal test-mode-style signing (best effort) + esign-download
//   8. Verify signed PDF in dossier documents
//
// On any step failure: log + continue to next iteration (track consec passes vs failures).

const fs = require('fs');
const path = require('path');

const BASE = process.env.STAGING_BASE || 'https://staging.meetdossie.com';
const CORS_ORIGIN = 'https://meetdossie.com'; // spoof for CORS-restricted endpoints
const DEMO_JWT = process.env.DEMO_JWT;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const DEMO_USER_ID = 'c29ce34c-1434-44e5-a260-8d1a45213ec3';
const TARGET_PASSES = parseInt(process.env.TARGET_PASSES || '5', 10);
const MAX_ITERATIONS = parseInt(process.env.MAX_ITERATIONS || '15', 10);
const ARTIFACTS = __dirname;

if (!DEMO_JWT) { console.error('Missing DEMO_JWT'); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { console.error('Missing SUPABASE env'); process.exit(1); }
if (!DOCUSEAL_API_KEY) { console.error('Missing DOCUSEAL_API_KEY'); process.exit(1); }
if (!CRON_SECRET) { console.error('Missing CRON_SECRET'); process.exit(1); }

const logFile = path.join(ARTIFACTS, `loop-${Date.now()}.log`);
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(logFile, line + '\n');
}

async function supaInsert(table, row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Supabase insert ${table} failed (${r.status}): ${t.slice(0, 300)}`);
  }
  const rows = await r.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

async function supaSelect(table, query) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!r.ok) throw new Error(`Supabase select ${table} failed (${r.status})`);
  return await r.json();
}

async function apiCall(routePath, body, opts = {}) {
  const url = `${BASE}${routePath}`;
  const useCron = opts.useCron === true;
  const headers = {
    'Content-Type': 'application/json',
    'Origin': CORS_ORIGIN,
    'Authorization': useCron ? `Bearer ${CRON_SECRET}` : `Bearer ${DEMO_JWT}`,
  };
  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: r.status, body: json || text, raw: text };
}

async function docusealApi(routePath, method = 'GET', body = null) {
  const r = await fetch(`https://api.docuseal.com${routePath}`, {
    method,
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* */ }
  return { status: r.status, body: json || text, raw: text };
}

// TREC 20-18 (resale) field values payload — what voice → fill-form should output.
function buildResalePayload() {
  const iter = Date.now();
  return {
    buyer_name: 'Atlas Test Buyer ' + iter,
    seller_name: 'Atlas Test Seller ' + iter,
    property_address: '1234 Loop Test Lane',
    city_state_zip: 'San Antonio, TX 78230',
    county: 'Bexar',
    sale_price: '450000',
    earnest_money: '5000',
    option_fee: '250',
    option_days: '7',
    closing_date: '2026-08-31',
    title_company: 'Atlas Title Co',
    buyer_email: 'atlas+buyer@meetdossie.com',
    seller_email: 'atlas+seller@meetdossie.com',
    third_party_financing: true,
    title_buyer_pays: true,
    as_is: true,
    sdn_received: true,
    possession: 'closing',
    legal_description: 'Lot 1, Block A, Atlas Test Subdivision',
    loan_amount: '405000',
    down_payment: '45000',
  };
}

async function createTransaction(iterNum) {
  const tx = {
    user_id: DEMO_USER_ID,
    transaction_type: 'buyer_purchase',
    dossier_number: `ATLAS-E2E-${Date.now()}-${iterNum}`,
    stage: 'under-contract',
    role: 'buyer',
    buyer_name: `Atlas Buyer ${iterNum}`,
    seller_name: `Atlas Seller ${iterNum}`,
    property_address: `1234 Loop Test Lane #${iterNum}`,
    city_state_zip: 'San Antonio, TX 78230',
    county: 'Bexar',
    sale_price: '450000',
    earnest_money: '5000',
    option_fee: '250',
    option_days: '7',
    closing_date: '2026-08-31',
    title_company: 'Atlas Title Co',
    buyer_email: 'atlas+buyer@meetdossie.com',
    seller_email: 'atlas+seller@meetdossie.com',
  };
  return await supaInsert('transactions', tx);
}

async function uploadPdfToStorage(transactionId, pdfBuffer, fileName) {
  const storagePath = `${DEMO_USER_ID}/${transactionId}/${fileName}`;
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/documents/${storagePath}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/pdf',
      'x-upsert': 'true',
    },
    body: pdfBuffer,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Storage upload failed (${r.status}): ${t.slice(0, 200)}`);
  }
  return storagePath;
}

// Step: Sign a DocuSeal submission as a submitter (simulate the signer clicking + signing).
// Uses the DocuSeal Submitters PATCH API to mark complete.
async function signDocusealSubmitter(submitterId) {
  // First try /submitters/:id PATCH with completed status (simulates fill+complete)
  const r = await docusealApi(`/submitters/${submitterId}`, 'PATCH', {
    completed: true,
  });
  return r;
}

async function runIteration(iterNum) {
  log(`=== Iteration ${iterNum} START ===`);
  const result = {
    iteration: iterNum,
    steps: {},
    pass: false,
  };

  let txId = null;
  try {
    // Step 1: Create transaction
    const tx = await createTransaction(iterNum);
    txId = tx.id;
    result.transactionId = txId;
    result.steps.create_tx = { ok: true, transactionId: txId };
    log(`[${iterNum}] tx created: ${txId}`);

    // Step 2: POST /api/fill-form with TREC 20-18 resale payload (voice→fields)
    const fillFormBody = {
      transaction_id: txId,
      form_type: 'resale-contract',
      field_values: buildResalePayload(),
    };
    const fillForm = await apiCall('/api/fill-form', fillFormBody);
    result.steps.fill_form = { status: fillForm.status, ok: fillForm.status === 200 };
    if (fillForm.status !== 200) {
      const errMsg = (fillForm.body && fillForm.body.error) || fillForm.raw.slice(0, 200);
      result.steps.fill_form.error = errMsg;
      log(`[${iterNum}] fill-form FAIL ${fillForm.status}: ${errMsg}`);
      throw new Error(`fill-form failed: ${errMsg}`);
    }
    log(`[${iterNum}] fill-form OK documentId=${fillForm.body.documentId}`);
    result.steps.fill_form.documentId = fillForm.body.documentId;

    // Step 3: POST /api/fill-form-via-docuseal — DocuSeal prefill path
    const fillViaDocuseal = await apiCall('/api/fill-form-via-docuseal', fillFormBody);
    result.steps.fill_via_docuseal = { status: fillViaDocuseal.status, ok: fillViaDocuseal.status === 200 };
    if (fillViaDocuseal.status !== 200) {
      const errMsg = (fillViaDocuseal.body && fillViaDocuseal.body.error) || fillViaDocuseal.raw.slice(0, 200);
      result.steps.fill_via_docuseal.error = errMsg;
      log(`[${iterNum}] fill-via-docuseal FAIL ${fillViaDocuseal.status}: ${errMsg}`);
      throw new Error(`fill-via-docuseal failed: ${errMsg}`);
    }
    log(`[${iterNum}] fill-via-docuseal OK submissionId=${fillViaDocuseal.body.submissionId} documentId=${fillViaDocuseal.body.documentId}`);
    result.steps.fill_via_docuseal.submissionId = fillViaDocuseal.body.submissionId;
    result.steps.fill_via_docuseal.documentId = fillViaDocuseal.body.documentId;

    // Step 4: POST /api/dossiesign-prepare — full packet prep
    const prep = await apiCall('/api/dossiesign-prepare', { transaction_id: txId });
    result.steps.dossiesign_prepare = { status: prep.status, ok: prep.status === 200 };
    if (prep.status !== 200) {
      const errMsg = (prep.body && prep.body.error) || prep.raw.slice(0, 200);
      result.steps.dossiesign_prepare.error = errMsg;
      log(`[${iterNum}] dossiesign-prepare FAIL ${prep.status}: ${errMsg}`);
      throw new Error(`dossiesign-prepare failed: ${errMsg}`);
    }
    const formsCount = (prep.body.forms || []).length;
    log(`[${iterNum}] dossiesign-prepare OK forms=${formsCount}`);
    result.steps.dossiesign_prepare.formsCount = formsCount;

    // Pick the resale-contract preview to use for esign-create
    const resaleForm = (prep.body.forms || []).find((f) => f.form_type === 'resale-contract');
    if (!resaleForm || !resaleForm.document_id) {
      log(`[${iterNum}] WARN: no resale-contract preview document in prepare response; using fill-form documentId`);
    }
    const docIdForSign = (resaleForm && resaleForm.document_id) || fillForm.body.documentId;

    // Step 5: POST /api/esign-create — create envelope w/ demo as Buyer + a test Seller
    const esignBody = {
      documentId: docIdForSign,
      signers: [
        { name: 'Atlas Test Buyer', email: 'atlas+buyer@meetdossie.com', role: 'Buyer' },
        { name: 'Atlas Test Seller', email: 'atlas+seller@meetdossie.com', role: 'Seller' },
      ],
      message: 'E2E loop test — please disregard',
    };
    const esign = await apiCall('/api/esign-create', esignBody);
    result.steps.esign_create = { status: esign.status, ok: esign.status === 200 };
    if (esign.status !== 200) {
      const errMsg = (esign.body && esign.body.error) || esign.raw.slice(0, 200);
      result.steps.esign_create.error = errMsg;
      log(`[${iterNum}] esign-create FAIL ${esign.status}: ${errMsg}`);
      throw new Error(`esign-create failed: ${errMsg}`);
    }
    const submissionId = esign.body.submissionId;
    log(`[${iterNum}] esign-create OK submissionId=${submissionId} signers=${(esign.body.signers||[]).length}`);
    result.steps.esign_create.submissionId = submissionId;
    result.steps.esign_create.signatureRequestId = esign.body.signatureRequestId;

    // Step 6: Verify the DocuSeal envelope shows submitters w/ "sent" status
    const subResp = await docusealApi(`/submissions/${submissionId}`);
    result.steps.docuseal_status = { status: subResp.status, ok: subResp.status === 200 };
    if (subResp.status !== 200) {
      log(`[${iterNum}] DocuSeal status FAIL ${subResp.status}`);
      throw new Error(`DocuSeal submission status failed`);
    }
    const submitters = subResp.body.submitters || [];
    log(`[${iterNum}] DocuSeal envelope status=${subResp.body.status} submitters=${submitters.length}`);
    result.steps.docuseal_status.envelopeStatus = subResp.body.status;
    result.steps.docuseal_status.submitterCount = submitters.length;

    // Step 7: Simulate all signers completing via DocuSeal API
    // Sign each submitter via PATCH /submitters/:id with completed=true
    let allSigned = true;
    for (const sub of submitters) {
      const sig = await signDocusealSubmitter(sub.id);
      if (sig.status >= 400) {
        log(`[${iterNum}] Submitter ${sub.id} sign FAIL ${sig.status}: ${(sig.raw || '').slice(0, 200)}`);
        allSigned = false;
      } else {
        log(`[${iterNum}] Submitter ${sub.id} (${sub.email}) signed OK`);
      }
    }
    result.steps.sign_all = { ok: allSigned };
    if (!allSigned) {
      throw new Error('Could not sign all submitters via DocuSeal API');
    }

    // Wait a moment for DocuSeal to finalize the PDF
    await new Promise((r) => setTimeout(r, 2000));

    // Step 8: Pull signed PDF via /api/esign-download (this is the path the webhook also uses)
    const dl = await apiCall('/api/esign-download', { submissionId }, { useCron: true });
    result.steps.esign_download = { status: dl.status, ok: dl.status === 200 };
    if (dl.status !== 200) {
      const errMsg = (dl.body && dl.body.error) || dl.raw.slice(0, 200);
      result.steps.esign_download.error = errMsg;
      log(`[${iterNum}] esign-download FAIL ${dl.status}: ${errMsg}`);
      // Retry once after 3s — DocuSeal may still be rendering
      await new Promise((r) => setTimeout(r, 3000));
      const dl2 = await apiCall('/api/esign-download', { submissionId }, { useCron: true });
      result.steps.esign_download = { status: dl2.status, ok: dl2.status === 200, retried: true };
      if (dl2.status !== 200) {
        const e2 = (dl2.body && dl2.body.error) || dl2.raw.slice(0, 200);
        log(`[${iterNum}] esign-download retry FAIL: ${e2}`);
        throw new Error(`esign-download failed after retry: ${e2}`);
      }
    }
    log(`[${iterNum}] esign-download OK signedDocumentId=${dl.body?.signedDocumentId || result.steps.esign_download.signedDocumentId}`);
    result.steps.esign_download.signedDocumentId = (dl.body && dl.body.signedDocumentId) || null;

    // Step 9: Verify the signed PDF exists in documents table
    const docs = await supaSelect(
      'documents',
      `transaction_id=eq.${txId}&document_type=eq.signed&select=id,file_name,storage_path,document_type`
    );
    result.steps.verify_signed_doc = { ok: docs.length > 0, docs: docs.length };
    if (!docs.length) {
      throw new Error('No signed document found in dossier after esign-download');
    }
    log(`[${iterNum}] verified signed doc in dossier: ${docs[0].file_name}`);

    // Step 10: Verify signature_requests row marked completed
    const srs = await supaSelect(
      'signature_requests',
      `docuseal_submission_id=eq.${submissionId}&select=id,status,signed_document_id,completed_at`
    );
    const sr = srs[0];
    result.steps.verify_sr_completed = {
      ok: sr && sr.status === 'completed' && sr.signed_document_id,
      status: sr ? sr.status : null,
    };
    if (!sr || sr.status !== 'completed') {
      throw new Error(`signature_request not marked completed (status=${sr?.status})`);
    }
    log(`[${iterNum}] verified signature_request status=completed`);

    result.pass = true;
    log(`=== Iteration ${iterNum} PASS ===`);
    return result;

  } catch (err) {
    result.pass = false;
    result.error = err.message;
    log(`=== Iteration ${iterNum} FAIL: ${err.message} ===`);
    return result;
  }
}

(async () => {
  log(`Starting Dossie Sign E2E loop. TARGET_PASSES=${TARGET_PASSES} MAX_ITERATIONS=${MAX_ITERATIONS}`);
  log(`BASE=${BASE}`);

  const results = [];
  let consecPasses = 0;
  let totalIters = 0;
  let lastBlocker = null;
  let sameBlockerCount = 0;

  while (consecPasses < TARGET_PASSES && totalIters < MAX_ITERATIONS) {
    totalIters += 1;
    if (totalIters > 1) {
      // Small pause between iterations — also clear rate-limit rows pre-emptively below if hit.
      const waitMs = parseInt(process.env.ITERATION_DELAY_MS || '3000', 10);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    const r = await runIteration(totalIters);
    results.push(r);
    if (r.pass) {
      consecPasses += 1;
      lastBlocker = null;
      sameBlockerCount = 0;
      log(`Consecutive passes: ${consecPasses}/${TARGET_PASSES}`);
    } else {
      consecPasses = 0;
      // Track repeat blocker
      const blocker = (r.error || '').slice(0, 80);
      if (blocker === lastBlocker) {
        sameBlockerCount += 1;
      } else {
        lastBlocker = blocker;
        sameBlockerCount = 1;
      }
      log(`Same-blocker count: ${sameBlockerCount} ("${blocker}")`);
      if (sameBlockerCount >= 5) {
        log(`HARD BLOCK: same error 5 iterations in a row. Stopping.`);
        break;
      }
    }
  }

  const summary = {
    totalIterations: totalIters,
    consecutivePasses: consecPasses,
    targetReached: consecPasses >= TARGET_PASSES,
    finalBlocker: lastBlocker,
    results,
  };
  const summaryPath = path.join(ARTIFACTS, `summary-${Date.now()}.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  log(`SUMMARY written: ${summaryPath}`);
  log(`Final: ${consecPasses}/${TARGET_PASSES} consecutive passes after ${totalIters} iterations`);
  process.exit(summary.targetReached ? 0 : 1);
})().catch((err) => {
  log(`FATAL: ${err.stack || err.message}`);
  process.exit(2);
});
