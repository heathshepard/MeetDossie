// Get submission details to find the PDF URL
// Run: node .tmp-test-get-submission.js

const https = require('https');

const DOCUSEAL_API_KEY = 'y2FBCNLnLrUC7bhuRi3uKR3ZLVnWJ1QpB3uiv4A4pnu';

async function getSubmission(submissionId) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.docuseal.com',
      path: `/submissions/${submissionId}`,
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
    const result = await getSubmission(8545145);
    console.log('Status:', result.status);
    console.log('Submission:', JSON.stringify(result.body, null, 2));
    if (result.body.documents && result.body.documents[0]) {
      console.log('\nPDF URLs:');
      result.body.documents.forEach(d => console.log(' -', d.url));
    }
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  }
})();
