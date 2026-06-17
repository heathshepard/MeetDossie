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
  console.log('Payload:', JSON.stringify(payload, null, 2));
  const resp = await fetch('https://api.docuseal.com/submissions', {
    method: 'POST',
    headers: { 'X-Auth-Token': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  console.log('Status:', resp.status);
  console.log('Response:', text.slice(0, 500));
}

async function main() {
  // Test 1: minimal - only buyer name to buyer
  await tryPayload('TEST 1: minimal text-only single submitter', {
    template_id: 4018208,
    send_email: false,
    submitters: [
      { role: 'Buyer', email: 'test@example.com', values: { buyer_name: 'Heath Shepherd' } },
    ],
  });

  // Test 2: minimal - both submitters
  await tryPayload('TEST 2: both submitters, single field', {
    template_id: 4018208,
    send_email: false,
    submitters: [
      { role: 'Buyer', email: 'buyer@example.com', values: { buyer_name: 'Heath' } },
      { role: 'Seller', email: 'seller@example.com', values: { seller_name: 'Josh' } },
    ],
  });

  // Test 3: text fields no checkboxes
  await tryPayload('TEST 3: text fields no checkboxes', {
    template_id: 4018208,
    send_email: false,
    submitters: [
      { role: 'Buyer', email: 'buyer@example.com', values: {
        buyer_name: 'Heath Shepherd',
        seller_name: 'Josh Sissam',
        sales_price: '500000',
        property_address: '123 Main St',
      } },
      { role: 'Seller', email: 'seller@example.com', values: {
        buyer_name: 'Heath Shepherd',
        seller_name: 'Josh Sissam',
      } },
    ],
  });

  // Test 4: with possession checkbox boolean
  await tryPayload('TEST 4: with possession_closing: true', {
    template_id: 4018208,
    send_email: false,
    submitters: [
      { role: 'Buyer', email: 'buyer@example.com', values: {
        buyer_name: 'Heath',
        possession_closing: true,
      } },
      { role: 'Seller', email: 'seller@example.com', values: {} },
    ],
  });

  // Test 5: with possession checkbox as string
  await tryPayload('TEST 5: with possession_closing: "true"', {
    template_id: 4018208,
    send_email: false,
    submitters: [
      { role: 'Buyer', email: 'buyer@example.com', values: {
        buyer_name: 'Heath',
        possession_closing: 'true',
      } },
      { role: 'Seller', email: 'seller@example.com', values: {} },
    ],
  });
}

main().catch(err => console.error('FATAL:', err));
