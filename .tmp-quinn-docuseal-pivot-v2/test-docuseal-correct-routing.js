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
  return resp.status === 200;
}

async function main() {
  // T6: all values to Buyer only, Seller empty
  await tryPayload('T6: all values to Buyer, Seller empty values', {
    template_id: 4018208,
    send_email: false,
    submitters: [
      { role: 'Buyer', email: 'b@b.com', values: {
        buyer_name: 'Heath Shepherd',
        seller_name: 'Josh Sissam',
        property_address: '123 Main St',
        sales_price: '500000',
      } },
      { role: 'Seller', email: 's@s.com' },
    ],
  });

  // T7: Buyer-owned only to Buyer, Seller-owned only to Seller
  await tryPayload('T7: properly-routed values', {
    template_id: 4018208,
    send_email: false,
    submitters: [
      { role: 'Buyer', email: 'b@b.com', values: {
        buyer_name: 'Heath Shepherd',
        seller_name: 'Josh Sissam',
        property_address: '123 Main St',
      } },
      { role: 'Seller', email: 's@s.com', values: {
        seller_notice_address: '999 Oak St',
      } },
    ],
  });
}

main().catch(err => console.error('FATAL:', err));
