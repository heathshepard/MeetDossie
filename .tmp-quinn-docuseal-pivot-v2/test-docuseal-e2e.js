// Quinn E2E DocuSeal verification
// Tests: login → extract-form-fields → fill-form-via-docuseal → download PDF
const fs = require('fs');
const path = require('path');

// Load .env.local manually (no dotenv dep)
function loadEnv(p) {
  const txt = fs.readFileSync(p, 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^([A-Z_]+)=["']?([^"'\r\n]+?)["']?\s*$/);
    if (m) process.env[m[1]] = m[2];
  }
}
loadEnv('C:\\Users\\Heath Shepard\\Desktop\\MeetDossie\\.env.local');

const STAGING_URL = 'https://staging.meetdossie.com';
const DEMO_EMAIL = 'demo@meetdossie.com';
const DEMO_PASSWORD = 'DossieDemo-VaIiAt6Bab';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const HEATH_PROMPT = "Please fill out a contract for me address is 123 main st, buyer is heath shepherd, seller is Josh sissam, purchase price is $500,000, 3.5% down-payment using FHA, 10 day option period, 1% earnest money, $100 option fee. Title company is kendall county abstract here in Boerne, title escrow officer is Ashley phiffer, 30 day close from today, 3% buyers agent commission, I will represent myself on this deal so and the sellers agent will be Bizzy Darling license number 123964, her Brokerage is phyllis browning company the Boerne office.";

async function main() {
  const results = {
    timestamp: new Date().toISOString(),
    staging_url: STAGING_URL,
    steps: [],
  };

  function log(step, data) {
    console.log(`\n[STEP] ${step}`);
    if (data) console.log(JSON.stringify(data, null, 2).slice(0, 1000));
    results.steps.push({ step, data, ts: new Date().toISOString() });
  }

  try {
    // Step 1: Login as demo user via Supabase Auth
    log('login-start', { email: DEMO_EMAIL });
    const loginResp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
    });
    const loginData = await loginResp.json();
    if (!loginResp.ok || !loginData.access_token) {
      throw new Error(`Login failed: ${loginResp.status} ${JSON.stringify(loginData).slice(0, 300)}`);
    }
    const accessToken = loginData.access_token;
    const userId = loginData.user.id;
    log('login-success', { userId, hasToken: !!accessToken });

    // Step 2: Use a known demo transaction for Sarah Whitley
    const transactionId = '807dd591-d589-4019-89cf-3a805e14d421';
    log('using-transaction', { transactionId, address: '987 Magnolia Creek Dr' });

    // Step 3: Call /api/extract-form-fields with Heath's prompt
    log('extract-form-fields-start', { prompt_length: HEATH_PROMPT.length });
    const extractResp = await fetch(`${STAGING_URL}/api/extract-form-fields`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Origin': STAGING_URL,
      },
      body: JSON.stringify({
        message: HEATH_PROMPT,
        form_type: 'resale-contract',
        transaction: { id: transactionId, property_address: '987 Magnolia Creek Dr' },
      }),
    });
    const extractText = await extractResp.text();
    let extractData;
    try { extractData = JSON.parse(extractText); } catch { extractData = { raw: extractText }; }
    log('extract-form-fields-response', {
      status: extractResp.status,
      data: extractData
    });

    if (!extractResp.ok) {
      throw new Error(`extract-form-fields failed: ${extractResp.status}`);
    }

    const fieldValues = extractData.field_values || extractData.fields || extractData;
    log('extracted-field-values', fieldValues);

    // Step 4: Call /api/fill-form-via-docuseal
    log('fill-form-via-docuseal-start', { transactionId, formType: 'resale-contract' });
    const fillResp = await fetch(`${STAGING_URL}/api/fill-form-via-docuseal`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Origin': STAGING_URL,
      },
      body: JSON.stringify({
        transaction_id: transactionId,
        form_type: 'resale-contract',
        field_values: fieldValues,
      }),
    });
    const fillText = await fillResp.text();
    let fillData;
    try { fillData = JSON.parse(fillText); } catch { fillData = { raw: fillText }; }
    log('fill-form-via-docuseal-response', {
      status: fillResp.status,
      data: fillData
    });

    if (!fillResp.ok) {
      throw new Error(`fill-form-via-docuseal failed: ${fillResp.status}`);
    }

    // Step 5: Download the PDF
    const signedUrl = fillData.signedUrl;
    if (!signedUrl) {
      throw new Error('No signedUrl in fill response');
    }
    log('downloading-pdf', { signedUrl: signedUrl.slice(0, 100) + '...' });
    const pdfResp = await fetch(signedUrl);
    if (!pdfResp.ok) {
      throw new Error(`PDF download failed: ${pdfResp.status}`);
    }
    const pdfBuffer = Buffer.from(await pdfResp.arrayBuffer());
    const pdfPath = path.join(__dirname, 'rendered-contract.pdf');
    fs.writeFileSync(pdfPath, pdfBuffer);
    log('pdf-downloaded', { path: pdfPath, size_bytes: pdfBuffer.length });

    // Step 6: Verify document row exists
    log('verifying-document-row', { documentId: fillData.documentId });
    const docResp = await fetch(`${SUPABASE_URL}/rest/v1/documents?id=eq.${fillData.documentId}&select=*`, {
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    const docData = await docResp.json();
    log('document-row', { found: docData.length > 0, row: docData[0] });

    results.success = true;
    results.pdfPath = pdfPath;
    results.documentId = fillData.documentId;
    results.signedUrl = signedUrl;
    results.extractedFields = fieldValues;
  } catch (err) {
    log('ERROR', { message: err.message, stack: err.stack });
    results.success = false;
    results.error = err.message;
  }

  fs.writeFileSync(path.join(__dirname, 'test-results.json'), JSON.stringify(results, null, 2));
  console.log('\n=== RESULT ===');
  console.log(JSON.stringify({ success: results.success, error: results.error, pdfPath: results.pdfPath, documentId: results.documentId }, null, 2));
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
