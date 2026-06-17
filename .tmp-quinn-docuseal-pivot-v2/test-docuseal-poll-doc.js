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
  // Poll the submission we created
  const submissionId = 8508714;
  console.log(`Polling submission ${submissionId}...`);

  for (let i = 0; i < 4; i++) {
    const resp = await fetch(`https://api.docuseal.com/submissions/${submissionId}`, {
      headers: { 'X-Auth-Token': KEY },
    });
    const data = await resp.json();
    console.log(`\n[Try ${i+1}] status=${data.status}, documents=${(data.documents||[]).length}`);
    if (data.documents && data.documents.length > 0) {
      console.log('Documents:', JSON.stringify(data.documents, null, 2).slice(0, 1500));
      break;
    }
    if (data.submitters) {
      for (const s of data.submitters) {
        console.log(`  ${s.role} status=${s.status} values:`, JSON.stringify(s.values).slice(0, 200));
      }
    }
    if (data.audit_log_url) console.log('  audit_log_url:', data.audit_log_url);
    if (data.combined_document_url) console.log('  combined_document_url:', data.combined_document_url);

    await new Promise(r => setTimeout(r, 2000));
  }

  // Try the documents endpoint
  console.log('\n=== Try GET /submissions/{id}/documents ===');
  const docResp = await fetch(`https://api.docuseal.com/submissions/${submissionId}/documents`, {
    headers: { 'X-Auth-Token': KEY },
  });
  console.log('Status:', docResp.status);
  console.log('Body:', (await docResp.text()).slice(0, 1000));
}

main().catch(err => console.error('FATAL:', err));
