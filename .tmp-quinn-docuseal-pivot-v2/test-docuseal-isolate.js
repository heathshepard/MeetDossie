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
  console.log('Payload:', JSON.stringify(payload));
  const resp = await fetch('https://api.docuseal.com/submissions', {
    method: 'POST',
    headers: { 'X-Auth-Token': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  console.log('Status:', resp.status, 'Body:', text.slice(0, 300));
  return resp.status === 200;
}

async function main() {
  // The smallest possible failing test
  await tryPayload('TA: just role Buyer with values:{buyer_name}', {
    template_id: 4018208,
    submitters: [{ role: 'Buyer', email: 'a@a.com', values: { buyer_name: 'Heath' } }],
  });

  // What if we use the email key as identifier (not role)
  await tryPayload('TB: role+name field instead of values', {
    template_id: 4018208,
    submitters: [{ role: 'Buyer', email: 'a@a.com', name: 'Heath' }],
  });

  // What if we use fields array instead
  await tryPayload('TC: fields array (default_value)', {
    template_id: 4018208,
    submitters: [{ role: 'Buyer', email: 'a@a.com' }],
    fields: [{ name: 'buyer_name', default_value: 'Heath' }],
  });

  // With send_email
  await tryPayload('TD: fields array + send_email false', {
    template_id: 4018208,
    send_email: false,
    submitters: [{ role: 'Buyer', email: 'a@a.com' }],
    fields: [{ name: 'buyer_name', default_value: 'Heath Shepherd' }],
  });

  // Maybe values needs to use field UUIDs not names?
  // Buyer-owned buyer_name field UUID from template
  await tryPayload('TE: values keyed by submitter+field UUID?', {
    template_id: 4018208,
    submitters: [{
      role: 'Buyer',
      email: 'a@a.com',
      values: {},
      fields: [{ name: 'buyer_name', default_value: 'Heath' }]
    }],
  });
}

main().catch(err => console.error('FATAL:', err));
