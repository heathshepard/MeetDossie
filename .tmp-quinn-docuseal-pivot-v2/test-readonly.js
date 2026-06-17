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
  // Try with readonly: true - this should bake values into PDF immediately
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

  console.log('Creating submission with readonly fields...');
  const resp = await fetch('https://api.docuseal.com/submissions', {
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
  const text = await resp.text();
  console.log('Status:', resp.status);
  if (resp.status !== 200) {
    console.log('Body:', text.slice(0, 500));
    return;
  }
  const subs = JSON.parse(text);
  const submissionId = subs[0].submission_id;
  console.log('Submission ID:', submissionId);

  // Poll documents
  console.log('\nPolling for documents...');
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const docResp = await fetch(`https://api.docuseal.com/submissions/${submissionId}/documents`, {
      headers: { 'X-Auth-Token': KEY },
    });
    if (docResp.ok) {
      const data = await docResp.json();
      if (data.documents && data.documents.length > 0) {
        const pdfUrl = data.documents[0].url;
        console.log(`[Try ${i+1}] Got document URL`);
        const pdfBuf = await fetch(pdfUrl);
        const buffer = Buffer.from(await pdfBuf.arrayBuffer());
        const outPath = `.tmp-quinn-docuseal-pivot-v2/readonly-test-${submissionId}.pdf`;
        fs.writeFileSync(outPath, buffer);
        console.log('Saved to:', outPath, 'size:', buffer.length);

        // Quick text check
        console.log('\nText content check:');
        console.log('  "Heath Shepherd" present:', buffer.includes('Heath Shepherd'));
        console.log('  "Josh Sissam" present:', buffer.includes('Josh Sissam'));
        console.log('  "Kendall County Abstract" present:', buffer.includes('Kendall County Abstract'));
        console.log('  "500000" present:', buffer.includes('500000'));
        return;
      }
    }
  }
  console.log('Did not get filled PDF within 5 polls');
}

main().catch(err => console.error('FATAL:', err));
