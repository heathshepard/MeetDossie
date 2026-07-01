#!/usr/bin/env node
// Atlas v3-FHA verification — 2026-06-27
// Fires the master prompt through the LIVE extract-form-fields -> fill-forms-batch
// pipeline on staging, downloads each PDF, runs basic text checks.
//
// Usage: DEMO_JWT=<jwt> node v3-fha-verify.js
//
// Requires staging deploy of commit 572068fa+ (Opus 4.7 extract + expanded KEY_MAP).

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = process.env.STAGING_BASE || 'https://staging.meetdossie.com';
const CORS_ORIGIN = 'https://meetdossie.com';
const DEMO_JWT = process.env.DEMO_JWT;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEMO_USER_ID = 'c29ce34c-1434-44e5-a260-8d1a45213ec3'; // demo@meetdossie.com matches JWT
const ARTIFACT_DIR = path.join(__dirname, 'v3-fha-verify');
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

if (!DEMO_JWT) { console.error('Missing DEMO_JWT'); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { console.error('Missing SUPABASE env'); process.exit(1); }

const MASTER_PROMPT = `Please fill out a contract for me address is 123 main st boerne tx 78006, buyer is heath shepard, seller is Josh sissam, purchase price is 500k, 3.5% down-payment using FHA, 10 day option period, 1% earnest money, $100 option fee. Title company is kendall country abstract here in Boerne, please look up the address, title escrow officer is Ashley phiffer, seller will peivide t47 or survey. If no survey is available seller will pau for a new one, 30 day close from today, 3% buyers agenrt commission, I will represent myself on this deal so and the sellers agent will be Bizzy Darling license number 123964, her Brokerage is phyllis browning company the Boerne office. Possession at closing. Home warranty 500 dollars paid by seller. Home was built in 1972 so include the lead based paint addendum. Property is in the Cibolo Canyons HOA monthly dues 145 transfer fee 200 include the HOA addendum. No special provisions. No property exclusions. Seller paying 5000 toward buyers closing costs.`;

const FORMS = ['resale-contract', 'financing-addendum', 'hoa-addendum', 'lead-paint-addendum'];

const TX_CONTEXT = {
  property_address: '123 Main St',
  city_state_zip: 'Boerne, TX 78006',
  buyer_name: 'Heath Shepard',
  seller_name: 'Josh Sissam',
  agent_role: 'buyer',
};

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(ARTIFACT_DIR, 'verify.log'), line + '\n');
}

async function api(routePath, body, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Origin': CORS_ORIGIN,
    'Authorization': `Bearer ${DEMO_JWT}`,
  };
  const r = await fetch(`${BASE}${routePath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* */ }
  return { status: r.status, body: json || text, raw: text };
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

async function downloadPdf(signedUrl, outPath) {
  const r = await fetch(signedUrl);
  if (!r.ok) throw new Error(`download failed ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(outPath, buf);
  return buf;
}

async function getSignedUrl(storagePath) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/documents/${storagePath}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  if (!r.ok) throw new Error(`sign failed ${r.status}`);
  const j = await r.json();
  return `${SUPABASE_URL}/storage/v1${j.signedURL}`;
}

function pdfText(filePath) {
  try {
    return execSync(`pdftotext "${filePath}" -`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return '';
  }
}

(async () => {
  log(`v3-FHA verification start. BASE=${BASE}`);

  // 1. Create a test transaction (Heath's user)
  const tx = await supaInsert('transactions', {
    user_id: DEMO_USER_ID,
    transaction_type: 'buyer_purchase',
    dossier_number: `ATLAS-V3FHA-${Date.now()}`,
    stage: 'under-contract',
    role: 'buyer',
    buyer_name: 'Heath Shepard',
    seller_name: 'Josh Sissam',
    property_address: '123 Main St',
    city_state_zip: 'Boerne, TX 78006',
    county: 'Kendall',
    sale_price: '500000',
  });
  const txId = tx.id;
  log(`tx created: ${txId}`);

  // 2. Extract fields per form via Opus 4.7
  let merged = {};
  for (const ft of FORMS) {
    log(`extract: ${ft}`);
    const r = await api('/api/extract-form-fields', {
      form_type: ft,
      message: MASTER_PROMPT,
      transaction: TX_CONTEXT,
    });
    log(`  status=${r.status} keys=${r.body && r.body.field_values ? Object.keys(r.body.field_values).length : 0}`);
    if (r.status !== 200 || !r.body?.ok) {
      log(`  ERROR: ${JSON.stringify(r.body).slice(0, 300)}`);
      process.exit(1);
    }
    fs.writeFileSync(path.join(ARTIFACT_DIR, `extract-${ft}.json`), JSON.stringify(r.body.field_values, null, 2));
    merged = { ...merged, ...r.body.field_values };
  }
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'merged-fields.json'), JSON.stringify(merged, null, 2));
  log(`merged fields: ${Object.keys(merged).length}`);

  // 3. Fill all 4 forms via batch
  log('fill-forms-batch...');
  const fill = await api('/api/fill-forms-batch', {
    transaction_id: txId,
    forms: FORMS,
    field_values: merged,
  });
  log(`  status=${fill.status}`);
  // fill-forms-batch has a pre-existing bug: checks fillData.pdf_url but fill-form
  // returns signedUrl. That makes it return 500 even when each form succeeded.
  // Pull results either from .results (failure mode) or .pdfs (success mode).
  const innerResults = fill.body?.results || fill.body?.pdfs || [];
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'batch-response.json'), JSON.stringify(fill.body, null, 2));

  // Treat per-form documentId+storagePath as success regardless of batch-level status.
  const pdfs = innerResults.filter((r) => r.documentId && r.storagePath);
  if (!pdfs.length) {
    log(`  no PDFs returned`);
    process.exit(1);
  }
  log(`pdfs returned: ${pdfs.length}`);

  // 4. Download each PDF and pdftotext-verify
  const checks = {
    'Heath Shepard': false,
    'Cibolo Canyons': false,
    '145': false,
    '200': false,
    'Boerne': false,
    '500,000': false,
    '500000': false,
  };
  const downloadedPdfs = [];

  for (const pdf of pdfs) {
    const formType = pdf.form_type;
    const outName = `${formType}.pdf`;
    const outPath = path.join(ARTIFACT_DIR, outName);
    try {
      const signedUrl = pdf.storagePath ? await getSignedUrl(pdf.storagePath) : pdf.pdf_url;
      await downloadPdf(signedUrl, outPath);
      log(`downloaded ${formType} -> ${outPath} (${fs.statSync(outPath).size} bytes)`);
      downloadedPdfs.push({ formType, outPath });
      const text = pdfText(outPath);
      fs.writeFileSync(path.join(ARTIFACT_DIR, `${formType}.txt`), text);
      for (const k of Object.keys(checks)) {
        if (text.includes(k)) checks[k] = true;
      }
    } catch (e) {
      log(`  download ${formType} FAILED: ${e.message}`);
    }
  }

  log(`text checks: ${JSON.stringify(checks)}`);
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'checks.json'), JSON.stringify({ checks, pdfs: downloadedPdfs }, null, 2));

  const hits = Object.values(checks).filter(Boolean).length;
  log(`hits ${hits}/${Object.keys(checks).length}`);

  process.exit(hits >= 4 ? 0 : 2);
})().catch((err) => {
  log(`FATAL: ${err.stack || err.message}`);
  process.exit(2);
});
