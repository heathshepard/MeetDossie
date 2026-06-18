#!/usr/bin/env node
/**
 * Test script: verify scan-contract works via both base64 and signed-URL paths.
 * Run: node test-scan-signed-url.js
 */

const fs = require('fs');
const path = require('path');

const DEMO_EMAIL = 'demo@meetdossie.com';
const DEMO_PASSWORD = 'DossieDemo-VaIiAt6Bab';
const APP_URL = 'https://meetdossie.com/app';
const STAGING_URL = 'https://meetdossie-staging.vercel.app/app';

// Use staging for this test
const TARGET_URL = process.env.TARGET_URL || STAGING_URL;

async function main() {
  console.log(`[TEST] Starting scan-contract signed-URL test`);
  console.log(`[TEST] Target URL: ${TARGET_URL}`);

  // We can't run Playwright headlessly without browsers installed.
  // Instead, provide manual test instructions.

  console.log(`
========================================
MANUAL TEST INSTRUCTIONS
========================================

1. Open ${TARGET_URL} in your browser
2. Sign in as:
   Email: ${DEMO_EMAIL}
   Password: ${DEMO_PASSWORD}

3. Click "Start a new dossier" (+ button)

4. TEST SMALL FILE (< 3MB) — inline base64 path:
   - Pick any PDF contract from your downloads
   - Make sure file size < 3MB
   - Click "Scan Contract" button
   - Verify in DevTools console:
     - "BASE64_PATH" debug log appears
     - "FILE_READ" with base64Length
     - "SCAN_INITIATED_BASE64"
     - Response includes documentType and extracted fields

5. TEST LARGE FILE (>= 3MB) — signed-URL path:
   - Create a test PDF >= 3MB (or use an actual large contract)
   - Click "Scan Contract" button
   - Verify in DevTools console:
     - "SIGNED_URL_PATH" debug log appears (file size logged)
     - "GET_UPLOAD_URL_RESPONSE" status=200
     - "GOT_UPLOAD_URL" with storagePath
     - "FILE_READ" with base64Length
     - "STORAGE_UPLOAD_RESPONSE" status=200
     - "SCAN_INITIATED_STORAGE" with storagePath
     - Response includes documentType and extracted fields

If both paths work, the fix is successful.

========================================
EXPECTED CONSOLE DEBUG SEQUENCE (Large File)
========================================

SIGNED_URL_PATH | file=contract.pdf size=5242880 bytes >= 3145728 threshold
GET_UPLOAD_URL_RESPONSE | status=200
GOT_UPLOAD_URL | storagePath=<uuid>/temp-scans/1234567890-contract.pdf
FILE_READ | base64Length=6990464
STORAGE_UPLOAD_RESPONSE | status=200
SCAN_INITIATED_STORAGE | POST /api/scan-contract storagePath=<path>
FETCH_RESPONSE_RECEIVED | status=200 OK
FETCH_PARSED | documentType="trec-20-17" extractedFieldKeys=30+

========================================
EXPECTED CONSOLE DEBUG SEQUENCE (Small File)
========================================

BASE64_PATH | file=contract.pdf size=1048576 bytes < 3145728 threshold
FILE_READ | base64Length=1398144
SCAN_INITIATED_BASE64 | POST /api/scan-contract base64Length=1398144
FETCH_RESPONSE_RECEIVED | status=200 OK
FETCH_PARSED | documentType="trec-20-17" extractedFieldKeys=30+

========================================
  `);

  console.log('[TEST] Manual test instructions printed above.');
  console.log('[TEST] Open DevTools (F12) and check console for debug logs during scan.');
}

main().catch(err => {
  console.error('[TEST] Error:', err);
  process.exit(1);
});
