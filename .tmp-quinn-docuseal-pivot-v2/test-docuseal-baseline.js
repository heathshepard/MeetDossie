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

async function main() {
  // Test: just get the template - does API key even work?
  console.log('=== TEST A: GET /templates/4018208 ===');
  let resp = await fetch('https://api.docuseal.com/templates/4018208', {
    method: 'GET',
    headers: { 'X-Auth-Token': KEY },
  });
  console.log('Status:', resp.status);
  if (resp.ok) {
    const data = await resp.json();
    console.log('Template name:', data.name, 'fields:', data.fields ? data.fields.length : 'n/a');
  } else {
    console.log('Body:', (await resp.text()).slice(0,300));
  }

  // Test B: bare-minimum payload (just template_id)
  console.log('\n=== TEST B: bare minimum submission ===');
  resp = await fetch('https://api.docuseal.com/submissions', {
    method: 'POST',
    headers: { 'X-Auth-Token': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template_id: 4018208,
      submitters: [{ role: 'Buyer', email: 'test@example.com' }],
    }),
  });
  console.log('Status:', resp.status);
  console.log('Body:', (await resp.text()).slice(0, 500));

  // Test C: list submissions to confirm API is alive
  console.log('\n=== TEST C: GET /submissions ===');
  resp = await fetch('https://api.docuseal.com/submissions?limit=2', {
    method: 'GET',
    headers: { 'X-Auth-Token': KEY },
  });
  console.log('Status:', resp.status);
  console.log('Body:', (await resp.text()).slice(0, 500));
}

main().catch(err => console.error('FATAL:', err));
