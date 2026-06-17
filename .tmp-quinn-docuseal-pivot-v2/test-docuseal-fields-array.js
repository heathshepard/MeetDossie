const fs = require('fs');
function loadEnv(p) {
  const txt = fs.readFileSync(p, 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^([A-Z_]+)=["']?([^"'\r\n]+?)["']?\s*$/);
    if (m) process.env[m[1]] = m[2];
  }
}
loadEnv('C:\\Users\\Heath Shepard\\Desktop\\MeetDossie\\.env.local');
const KEY = process.env.DOCUSEAL_API_KEY;

async function tryPayload(label, payload) {
  console.log(`\n=== ${label} ===`);
  const resp = await fetch('https://api.docuseal.com/submissions', {
    method: 'POST',
    headers: { 'X-Auth-Token': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  console.log('Status:', resp.status);
  if (resp.status === 200) {
    const data = JSON.parse(text);
    console.log('Submission ID:', data[0].submission_id);
    return data[0].submission_id;
  } else {
    console.log('Body:', text.slice(0, 400));
    return null;
  }
}

async function main() {
  // FULL FIELD VALUES via fields array at top level
  const allFields = {
    buyer_name: 'Heath Shepherd',
    seller_name: 'Josh Sissam',
    property_address: '123 Main St',
    county: 'Kendall',
    sales_price: '500000',
    earnest_money_amount: '5000',
    option_fee: '100',
    option_period_days: '10',
    loan_amount: '482500',
    closing_date: '2026-07-16',
    title_company_name: 'Kendall County Abstract',
    escrow_agent_name: 'Kendall County Abstract',
  };

  const fields = Object.entries(allFields).map(([name, val]) => ({ name, default_value: String(val) }));

  const submissionId = await tryPayload('FINAL: fields array with all values', {
    template_id: 4018208,
    send_email: false,
    submitters: [
      { role: 'Buyer', email: 'b@b.com' },
      { role: 'Seller', email: 's@s.com' },
    ],
    fields,
  });

  if (submissionId) {
    console.log('\n=== Verify submission - fetch and look at values ===');
    const resp = await fetch(`https://api.docuseal.com/submissions/${submissionId}`, {
      headers: { 'X-Auth-Token': KEY },
    });
    const data = await resp.json();
    console.log('Submitters:');
    for (const s of data.submitters) {
      console.log(`  ${s.role} (${s.email}) values:`, JSON.stringify(s.values).slice(0, 500));
    }
    console.log('\nDocuments:', JSON.stringify(data.documents, null, 2).slice(0, 800));

    // Try possession_closing checkbox too
    console.log('\n=== Bonus: try with possession_closing checkbox ===');
    const fieldsWithCheckbox = [...fields, { name: 'possession_closing', default_value: 'true' }];
    await tryPayload('Checkbox test', {
      template_id: 4018208,
      send_email: false,
      submitters: [{ role: 'Buyer', email: 'b@b.com' }, { role: 'Seller', email: 's@s.com' }],
      fields: fieldsWithCheckbox,
    });
  }
}

main().catch(err => console.error('FATAL:', err));
