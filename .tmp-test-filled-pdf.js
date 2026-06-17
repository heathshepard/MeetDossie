// Try to construct the filled PDF URL from submission
// Run: node .tmp-test-filled-pdf.js

const https = require('https');

const DOCUSEAL_API_KEY = 'y2FBCNLnLrUC7bhuRi3uKR3ZLVnWJ1QpB3uiv4A4pnu';

async function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'X-Auth-Token': DOCUSEAL_API_KEY } }, (res) => {
      console.log(`Status: ${res.statusCode} for ${url}`);
      resolve(res.statusCode);
    }).on('error', reject);
  });
}

(async () => {
  try {
    const submissionId = 8545145;
    const slugSlug = 'xoCJPgoTPme7cY';

    // Try various potential PDF URL patterns
    const urls = [
      `https://api.docuseal.com/submissions/${submissionId}/documents`,
      `https://docuseal.com/submissions/${submissionId}/documents`,
      `https://docuseal.com/s/${slugSlug}/documents`,
      `https://api.docuseal.com/submissions/${submissionId}/combined_document`,
    ];

    for (const url of urls) {
      await fetchUrl(url);
    }
  } catch (err) {
    console.error('ERROR:', err.message);
  }
})();
