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
  console.log('Body:', text.slice(0, 400));
}

async function main() {
  // Test 1: single Buyer with one value
  await tryPayload('T1: Buyer + buyer_name only', {
    template_id: 4018208,
    submitters: [{ role: 'Buyer', email: 'a@a.com', values: { buyer_name: 'Heath' } }],
  });

  // Test 2: single Buyer with send_email: false
  await tryPayload('T2: Buyer + buyer_name + send_email false', {
    template_id: 4018208,
    send_email: false,
    submitters: [{ role: 'Buyer', email: 'a@a.com', values: { buyer_name: 'Heath' } }],
  });

  // Test 3: 2 submitters, no values
  await tryPayload('T3: Buyer + Seller no values', {
    template_id: 4018208,
    submitters: [
      { role: 'Buyer', email: 'b@b.com' },
      { role: 'Seller', email: 's@s.com' },
    ],
  });

  // Test 4: 2 submitters with values
  await tryPayload('T4: Buyer + Seller with values', {
    template_id: 4018208,
    submitters: [
      { role: 'Buyer', email: 'b@b.com', values: { buyer_name: 'Heath' } },
      { role: 'Seller', email: 's@s.com', values: { seller_name: 'Josh' } },
    ],
  });

  // Test 5: 2 submitters with send_email false
  await tryPayload('T5: 2 submitters send_email false', {
    template_id: 4018208,
    send_email: false,
    submitters: [
      { role: 'Buyer', email: 'b@b.com', values: { buyer_name: 'Heath' } },
      { role: 'Seller', email: 's@s.com', values: { seller_name: 'Josh' } },
    ],
  });
}

main().catch(err => console.error('FATAL:', err));
