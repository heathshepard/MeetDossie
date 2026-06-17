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
  const allFields = {
    buyer_name: 'Heath Shepherd',
    seller_name: 'Josh Sissam',
    property_address: '123 Main St',
    county: 'Kendall',
    sales_price: '500000',
    earnest_money_amount: '5000',
    option_fee: '100',
    option_period_days: '10',
    closing_date: '2026-07-16',
    title_company_name: 'Kendall County Abstract',
    escrow_agent_name: 'Kendall County Abstract',
  };

  const fields = Object.entries(allFields).map(([name, val]) => ({
    name,
    default_value: String(val),
    readonly: true,
  }));

  console.log('1) Create submission...');
  const createResp = await fetch('https://api.docuseal.com/submissions', {
    method: 'POST',
    headers: { 'X-Auth-Token': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template_id: 4018208,
      send_email: false,
      submitters: [
        { role: 'Buyer', email: 'b@b.com' },
        { role: 'Seller', email: 's@s.com' },
      ],
      fields,
    }),
  });
  if (!createResp.ok) {
    console.error('Create failed:', createResp.status, await createResp.text());
    return;
  }
  const submitters = await createResp.json();
  console.log('Submitters created:', submitters.map(s => ({ id: s.id, role: s.role, status: s.status })));
  const submissionId = submitters[0].submission_id;
  console.log('Submission ID:', submissionId);

  // 2) Auto-complete each submitter via PUT
  console.log('\n2) Auto-completing each submitter...');
  for (const s of submitters) {
    const putResp = await fetch(`https://api.docuseal.com/submitters/${s.id}`, {
      method: 'PUT',
      headers: { 'X-Auth-Token': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ completed: true }),
    });
    const text = await putResp.text();
    console.log(`  Submitter ${s.id} (${s.role}):`, putResp.status, text.slice(0, 200));
  }

  // 3) Poll for documents
  console.log('\n3) Polling for documents...');
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const docResp = await fetch(`https://api.docuseal.com/submissions/${submissionId}/documents`, {
      headers: { 'X-Auth-Token': KEY },
    });
    if (docResp.ok) {
      const data = await docResp.json();
      const url = data.documents && data.documents[0] && data.documents[0].url;
      if (url) {
        console.log(`[Try ${i+1}] Got URL`);
        const pdfBuf = await fetch(url);
        const buffer = Buffer.from(await pdfBuf.arrayBuffer());
        const outPath = `.tmp-quinn-docuseal-pivot-v2/autosign-${submissionId}.pdf`;
        fs.writeFileSync(outPath, buffer);
        console.log('Saved to:', outPath, 'size:', buffer.length);

        // Text presence check
        console.log('\nText content check:');
        console.log('  "Heath Shepherd":', buffer.includes('Heath Shepherd'));
        console.log('  "Josh Sissam":', buffer.includes('Josh Sissam'));
        console.log('  "Kendall County Abstract":', buffer.includes('Kendall County Abstract'));
        console.log('  "500000":', buffer.includes('500000'));
        console.log('  "Kendall":', buffer.includes('Kendall'));
        return;
      }
    }
    console.log(`  [Try ${i+1}] no documents yet`);
  }
}

main().catch(err => console.error('FATAL:', err));
