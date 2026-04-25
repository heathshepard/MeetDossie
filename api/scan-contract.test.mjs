// Local test for /api/scan-contract — imports the handler directly and runs
// it against the blank TREC 20-17 PDF. Pass criteria: handler returns ok=true
// and an `extracted` object. We do NOT assert specific field values because
// the source PDF is a blank/unfilled TREC form.
//
// Run with:  node api/scan-contract.test.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const handler = require('./scan-contract.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PDF_PATH = resolve(
  __dirname,
  '..',
  '..',
  'Dossie',
  'Dossie Forms',
  'TREC Base',
  'One-to-Four-Family-Residential-Contract-Resale.pdf',
);

function makeMockReqRes(body) {
  const req = { method: 'POST', body };
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    send(payload) { this.body = payload; return this; },
    end() { return this; },
  };
  return { req, res };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('FAIL: ANTHROPIC_API_KEY env var is not set. Cannot run live test.');
    process.exit(1);
  }

  console.log('Reading PDF from:', PDF_PATH);
  const pdfBuffer = await readFile(PDF_PATH);
  const pdfBase64 = pdfBuffer.toString('base64');
  console.log(`PDF loaded: ${pdfBuffer.length} bytes -> ${pdfBase64.length} base64 chars`);

  const { req, res } = makeMockReqRes({ pdfBase64 });

  console.log('Calling handler...');
  const startedAt = Date.now();
  await handler(req, res);
  const elapsed = Date.now() - startedAt;
  console.log(`Handler returned in ${elapsed}ms with status ${res.statusCode}`);

  console.log('\n----- RESPONSE BODY -----');
  console.log(JSON.stringify(res.body, null, 2));
  console.log('----- END RESPONSE -----\n');

  // Assertions — minimal, per task spec
  const failures = [];
  if (res.statusCode !== 200) failures.push(`expected statusCode 200, got ${res.statusCode}`);
  if (!res.body || res.body.ok !== true) failures.push('expected res.body.ok === true');
  if (!res.body || typeof res.body.extracted !== 'object' || res.body.extracted === null) {
    failures.push('expected res.body.extracted to be an object');
  }

  if (failures.length) {
    console.error('TEST FAILED:');
    for (const f of failures) console.error('  -', f);
    process.exit(1);
  }

  console.log('TEST PASSED: handler ran without crashing and returned valid JSON.');
}

main().catch((err) => {
  console.error('TEST CRASHED:', err);
  process.exit(1);
});
