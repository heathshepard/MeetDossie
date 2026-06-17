// Quick test of DocuSeal prefill API integration
// Run: node .tmp-test-docuseal-pivot.js

const https = require('https');

const DOCUSEAL_API_KEY = 'y2FBCNLnLrUC7bhuRi3uKR3ZLVnWJ1QpB3uiv4A4pnu';

async function testDocuSealPrefill() {
  const templateId = 4018208; // TREC 20-17 Resale

  const payload = {
    template_id: templateId,
    send_email: false,
    submitters: [
      {
        role: 'Buyer 1',
        email: 'buyer1@test.local',
        send_email: false,
        values: {}
      },
      {
        role: 'Seller 2',
        email: 'seller@test.local',
        send_email: false,
        values: {}
      }
    ]
  };

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.docuseal.com',
      path: '/submissions',
      method: 'POST',
      headers: {
        'X-Auth-Token': DOCUSEAL_API_KEY,
        'Content-Type': 'application/json',
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
    req.write(JSON.stringify(payload));
    req.end();
  });
}

(async () => {
  try {
    console.log('Testing DocuSeal Prefill API...');
    const result = await testDocuSealPrefill();
    console.log('Status:', result.status);
    console.log('Response:', JSON.stringify(result.body, null, 2));

    if (result.body.id && result.body.documents && result.body.documents[0]) {
      console.log('\nSUCCESS: Submission created');
      console.log('Submission ID:', result.body.id);
      console.log('PDF URL:', result.body.documents[0].url);
    } else {
      console.log('\nWARNING: Unexpected response structure');
    }
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  }
})();
