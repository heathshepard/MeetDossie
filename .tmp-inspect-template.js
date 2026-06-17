// Inspect a single DocuSeal template in detail
// Run: node .tmp-inspect-template.js

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
          resolve(json);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

(async () => {
  try {
    const tmpl = await fetchTemplate(4018208);
    console.log('Template ID: 4018208');
    console.log('Name:', tmpl.name);
    console.log('\nSubmitters:');
    console.log(JSON.stringify(tmpl.submitters, null, 2));
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  }
})();
