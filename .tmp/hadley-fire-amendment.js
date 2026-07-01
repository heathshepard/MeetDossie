#!/usr/bin/env node
// Hadley: fire draft-amendment against PROD to obtain a rendered Amendment PDF for audit.
const fs = require('fs');
const path = require('path');

const BASE = 'https://meetdossie.com';
const JWT = fs.readFileSync(path.join(__dirname, 'dossie-sign-e2e-loop/jwt.txt'), 'utf8').trim();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEMO_USER_ID = 'c29ce34c-1434-44e5-a260-8d1a45213ec3';
const OUT = path.join(__dirname, 'hadley-audit-2026-07-01');

async function supaInsert(table, row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SVC, Authorization: `Bearer ${SVC}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`insert ${table} ${r.status}: ${await r.text()}`);
  return (await r.json())[0];
}

async function getSignedUrl(storagePath) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/documents/${storagePath}`, {
    method: 'POST',
    headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  const j = await r.json();
  return `${SUPABASE_URL}/storage/v1${j.signedURL}`;
}

(async () => {
  // 1. Create transaction with signed contract state (needed for amendment)
  const tx = await supaInsert('transactions', {
    user_id: DEMO_USER_ID,
    transaction_type: 'buyer_purchase',
    dossier_number: `HADLEY-AMENDMENT-${Date.now()}`,
    stage: 'under-contract',
    role: 'buyer',
    buyer_name: 'Heath Shepard',
    seller_name: 'Josh Sissam',
    property_address: '123 Main St',
    city_state_zip: 'Boerne, TX 78006',
    county: 'Kendall',
    sale_price: '500000',
    closing_date: '2026-07-31',
  });
  console.log('tx:', tx.id);

  // 2. Fire draft-amendment (closing_date change scenario)
  const r = await fetch(`${BASE}/api/draft-amendment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://meetdossie.com',
      Authorization: `Bearer ${JWT}`,
    },
    body: JSON.stringify({
      transactionId: tx.id,
      amendmentType: 'closing_date',
      newValue: '2026-08-15',
      notes: 'Closing pushed 2 weeks to accommodate lender underwriting delay.',
    }),
  });
  const j = await r.json();
  console.log('draft-amendment status:', r.status);
  fs.writeFileSync(path.join(OUT, 'amendment-response.json'), JSON.stringify(j, null, 2));
  if (!r.ok) { console.error('FAIL:', JSON.stringify(j)); process.exit(1); }

  // 3. Download PDF
  const storagePath = j.storagePath || j.storage_path;
  if (!storagePath) { console.error('no storagePath in response', JSON.stringify(j)); process.exit(1); }
  const signed = await getSignedUrl(storagePath);
  const pdfR = await fetch(signed);
  const buf = Buffer.from(await pdfR.arrayBuffer());
  const outPdf = path.join(OUT, 'amendment.pdf');
  fs.writeFileSync(outPdf, buf);
  console.log('wrote', outPdf, buf.length, 'bytes');
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
