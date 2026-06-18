#!/usr/bin/env node
/**
 * Step 4: Build comprehensive KEY_MAP for resale-contract (4018208), test with master prompt data,
 * and verify round-trip validation.
 *
 * Usage: node scripts/step4-resale-keymap-test.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Read the live schema
const schemaPath = path.join(__dirname, '.docuseal-fields-live-4018208.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

// Build submitter UUID -> name map
const submitterMap = {};
schema.submitters.forEach(sub => {
  submitterMap[sub.uuid] = sub.name;
});

// Group DocuSeal fields by submitter
const fieldsBySubmitter = {};
schema.submitters.forEach(sub => {
  fieldsBySubmitter[sub.name] = [];
});

schema.fields.forEach(field => {
  const submitterName = submitterMap[field.submitter_uuid];
  if (submitterName) {
    fieldsBySubmitter[submitterName].push(field.name);
  }
});

// === STEP 1: BUILD KEY_MAP ===
// The DocuSeal label names are already in snake_case, so most map 1:1.

const KEY_MAP_RESALE = {};
schema.fields.forEach(field => {
  KEY_MAP_RESALE[field.name] = field.name;
});

console.log('\n=== STEP 4.2: KEY_MAP for resale-contract (4018208) ===\n');
console.log(`Total mappings: ${Object.keys(KEY_MAP_RESALE).length}`);
console.log(`Buyer 1 fields: ${fieldsBySubmitter['Buyer 1'].length}`);
console.log(`Seller 1 fields: ${fieldsBySubmitter['Seller 1'].length}`);
console.log(`Buyer 2 fields: ${fieldsBySubmitter['Buyer 2'].length}`);
console.log(`Seller 2 fields: ${fieldsBySubmitter['Seller 2'].length}`);

// === STEP 2: TEST DATA (from Master Prompt v3) ===
const masterPromptData = {
  // Parties
  buyer_name: 'Heath Shepard',
  seller_name: 'Josh Sissam',
  buyer_email: 'heath@meetdossie.com',
  seller_email: 'josh@meetdossie.com',

  // Property
  property_address: '123 Main St, Boerne, TX 78006',
  legal_lot: 'LOT 15',
  legal_block: 'BLOCK 3',
  addition_city: 'Boerne',
  county: 'Kendall',
  legal_description: 'Lot 15, Block 3, Oak Hill Subdivision',

  // Sales Price & Financing
  sales_price: '500000',
  down_payment: '17500',
  loan_amount: '482500',

  // Earnest Money & Option
  earnest_money_amount: '5000',
  option_period_days: '10',
  option_fee: '100',

  // Title & Survey
  title_company_name: 'Kendall County Abstract',
  escrow_agent_name: 'Ashley Phiffer',
  title_seller_pays: true,
  survey_not_amended: false,
  survey_amend_seller: true,

  // Property Condition
  as_is: false,
  as_is_with_repairs: false,

  // Dates
  closing_date: '2026-07-17',
  closing_year: '2026',

  // Possession
  possession_closing: true,

  // Broker/Agent Info
  listing_agent_name: 'Bizzy Darling',
  listing_agent_license: '123964',
  listing_broker_firm: 'Phyllis Browning Company',
  listing_broker_supervisor_license: 'REF',
  selling_associate_name: 'Heath Shepard',

  // Addendums
  addendum_financing: true,
  addendum_lead_paint: true,
  third_party_financing: true,

  // Special Provisions
  special_provisions: 'Seller paying $5000 toward buyer\'s closing costs.',
  seller_closing_cost_credit: '5000',

  // Buyer notice
  buyer_notice_address: '123 Main St, Boerne, TX 78006',
  buyer_phone: '(210) 555-1234',

  // Execution
  execution_day: '17',
  execution_month: '06',
  execution_year: '2026',
};

console.log(`\n=== STEP 4.3: Test data prepared ===`);
console.log(`Fields in test data: ${Object.keys(masterPromptData).length}`);

// === STEP 3: BUILD PER-SUBMITTER VALUES OBJECTS ===

const submitterValues = {
  'Buyer 1': {},
  'Seller 1': {},
  'Buyer 2': {},
  'Seller 2': {},
};

Object.entries(masterPromptData).forEach(([key, value]) => {
  Object.entries(fieldsBySubmitter).forEach(([submitterName, fields]) => {
    if (fields.includes(key)) {
      submitterValues[submitterName][key] = value;
    }
  });
});

console.log(`\n=== STEP 4.4: Per-submitter field scoping ===`);
Object.entries(submitterValues).forEach(([name, vals]) => {
  console.log(`${name}: ${Object.keys(vals).length} fields`);
});

// === STEP 4: SANITIZATION ===
function sanitizeValue(v) {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'boolean') return v ? 'X' : '';
  return String(v);
}

Object.keys(submitterValues).forEach(submitter => {
  const vals = submitterValues[submitter];
  Object.keys(vals).forEach(key => {
    vals[key] = sanitizeValue(vals[key]);
  });
});

console.log(`\n=== STEP 4.5: Sanitization complete ===`);

// === STEP 5: BUILD PREFILL PAYLOAD ===
const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
if (!DOCUSEAL_API_KEY) {
  console.error('Error: DOCUSEAL_API_KEY not set');
  process.exit(1);
}

const submitters = schema.submitters.map(sub => ({
  role: sub.name,  // "Buyer 1", "Seller 1", etc.
  email: (sub.name.includes('Buyer') ? 'buyer' : 'seller') + '-placeholder@meetdossie.com',
  send_email: false,
  values: submitterValues[sub.name] || {},
}));

const payload = {
  template_id: 4018208,
  send_email: false,
  submitters: submitters,
};

console.log(`\n=== STEP 4.6: Test submission payload ready ===`);
console.log(`Submitters in payload: ${payload.submitters.length}`);
console.log(`Payload: ${JSON.stringify(payload, null, 2).slice(0, 500)}...`);

// === STEP 6: SUBMIT TO DOCUSEAL ===
console.log(`\n=== STEP 4.6: Submitting to DocuSeal... ===`);

function makeDocuSealRequest(method, path_part, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.docuseal.com',
      path: path_part,
      method: method,
      headers: {
        'X-Auth-Token': DOCUSEAL_API_KEY,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse failed: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runTest() {
  try {
    const submission = await makeDocuSealRequest('POST', '/submissions', payload);
    console.log(`\nSubmission created: ${submission.id}`);
    console.log(`PDF URL: ${submission.documents[0].url}`);

    // === STEP 7: ROUND-TRIP VALIDATION ===
    console.log(`\n=== STEP 4.7: Round-trip validation ===\n`);

    // Fetch the submission to verify stored values
    const fetchedSubmission = await makeDocuSealRequest('GET', `/submissions/${submission.id}`, null);

    console.log(`Submission fetched. Submitters: ${fetchedSubmission.submitters.length}`);

    // Build assertion table
    const assertionTable = [];

    fetchedSubmission.submitters.forEach(fetchedSub => {
      const expectedSub = submitters.find(s => (s.role || s.name) === (fetchedSub.role || fetchedSub.name));
      if (!expectedSub) {
        console.warn(`Submitter ${fetchedSub.role || fetchedSub.name} not found in expected submitters`);
        return;
      }

      console.log(`\n--- ${fetchedSub.role} ---`);

      Object.entries(expectedSub.values).forEach(([fieldLabel, sentValue]) => {
        const storedValue = fetchedSub.values && fetchedSub.values[fieldLabel];
        const passed = sentValue === storedValue;

        assertionTable.push({
          internal_key: fieldLabel,
          label_targeted: fieldLabel,
          sent_value: sentValue,
          stored_value: storedValue,
          submitter: fetchedSub.role,
          result: passed ? 'PASS' : 'FAIL',
        });

        if (!passed) {
          console.log(`FAIL: ${fieldLabel}`);
          console.log(`  Sent: ${JSON.stringify(sentValue)}`);
          console.log(`  Stored: ${JSON.stringify(storedValue)}`);
        }
      });
    });

    // Print summary
    const passCount = assertionTable.filter(r => r.result === 'PASS').length;
    const failCount = assertionTable.filter(r => r.result === 'FAIL').length;

    console.log(`\n\n=== SUMMARY ===`);
    console.log(`PASS: ${passCount}`);
    console.log(`FAIL: ${failCount}`);

    if (failCount > 0) {
      console.log(`\nFailed fields:`);
      assertionTable.filter(r => r.result === 'FAIL').forEach(r => {
        console.log(`  ${r.internal_key} (${r.submitter}): sent=${r.sent_value}, stored=${r.stored_value}`);
      });
    }

    // Save outputs
    const outputDir = __dirname;
    fs.writeFileSync(
      path.join(outputDir, `.tmp-step4-submission-id.txt`),
      submission.id
    );
    fs.writeFileSync(
      path.join(outputDir, `.tmp-step4-pdf-url.txt`),
      submission.documents[0].url
    );
    fs.writeFileSync(
      path.join(outputDir, `.tmp-step4-assertion-table.json`),
      JSON.stringify(assertionTable, null, 2)
    );

    console.log(`\nSubmission ID saved: ${submission.id}`);
    console.log(`PDF URL saved: ${submission.documents[0].url}`);
    console.log(`Assertion table saved to .tmp-step4-assertion-table.json`);

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

runTest();
