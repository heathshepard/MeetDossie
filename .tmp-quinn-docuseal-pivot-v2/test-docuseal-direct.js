// Test DocuSeal directly to find the 500 error cause
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
const TEMPLATE_ID = 4018208;

// Mirror what the server is sending
const docusealFields = {
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
  possession_closing: true,
};

const payload = {
  template_id: TEMPLATE_ID,
  send_email: false,
  submitters: [
    { role: 'Buyer', email: 'buyer@placeholder.local', values: docusealFields },
    { role: 'Seller', email: 'seller@placeholder.local', values: docusealFields },
  ],
};

async function main() {
  console.log('Sending payload:', JSON.stringify(payload, null, 2));
  const resp = await fetch('https://api.docuseal.com/submissions', {
    method: 'POST',
    headers: {
      'X-Auth-Token': KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  console.log('\nStatus:', resp.status);
  console.log('Response:', text);
}

main().catch(err => console.error('ERROR:', err));
