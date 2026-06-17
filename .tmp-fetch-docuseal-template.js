// Fetch DocuSeal template schema to see role names
// Run: node .tmp-fetch-docuseal-template.js

const https = require('https');

const DOCUSEAL_API_KEY = 'y2FBCNLnLrUC7bhuRi3uKR3ZLVnWJ1QpB3uiv4A4pnu';

async function fetchTemplate(templateId) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.docuseal.com',
      path: `/templates/${templateId}`,
      method: 'GET',
      headers: {
        'X-Auth-Token': DOCUSEAL_API_KEY,
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, body: json });
        } catch (e) {
          reject(new Error(`Parse error (${res.statusCode}): ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

(async () => {
  try {
    for (const templateId of [4018208, 4023463, 4111321, 4023469]) {
      console.log(`\n========== Template ${templateId} ==========`);
      const result = await fetchTemplate(templateId);
      if (result.status !== 200) {
        console.log(`Status ${result.status}:`, JSON.stringify(result.body));
        continue;
      }
      const tmpl = result.body;
      console.log('Name:', tmpl.name);
      console.log('Submitters:', tmpl.submitters ? tmpl.submitters.map(s => `${s.name} (role: ${s.role})`).join(', ') : 'none');
      if (tmpl.submitters && tmpl.submitters.length > 0) {
        console.log('Roles:', tmpl.submitters.map(s => s.role).join(', '));
      }
      if (tmpl.fields && tmpl.fields.length > 0) {
        console.log('Fields (first 5):');
        tmpl.fields.slice(0, 5).forEach(f => {
          console.log(`  - ${f.name} (type: ${f.type}, role: ${f.submitter_uuid})`);
        });
      }
    }
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  }
})();
