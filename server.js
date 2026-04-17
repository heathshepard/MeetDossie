const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8787;
const BASE_DIR = __dirname;
const GENERATED_DIR = path.join(BASE_DIR, 'generated-docs');
const SCRIPT_PATH = path.join(BASE_DIR, 'scripts', 'generate_documents_from_transaction.py');

fs.mkdirSync(GENERATED_DIR, { recursive: true });

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(payload));
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 2_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function runGenerator(transaction, documentKey = 'all') {
  return new Promise((resolve, reject) => {
    const tempInput = path.join(GENERATED_DIR, `transaction-${Date.now()}.json`);
    fs.writeFileSync(tempInput, JSON.stringify(transaction, null, 2));

    const child = spawn('python', [SCRIPT_PATH, tempInput, documentKey], {
      cwd: BASE_DIR,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => stdout += chunk.toString());
    child.stderr.on('data', chunk => stderr += chunk.toString());
    child.on('error', reject);
    child.on('close', code => {
      try { fs.unlinkSync(tempInput); } catch {}
      if (code !== 0) {
        reject(new Error(stderr || stdout || `Generator exited with code ${code}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

function routeDocuments(payload) {
  const salePrice = Number(payload.sale_price || 0);
  const docs = ['resale-contract'];
  if (payload.financing_type || payload.loan_amount || payload.lender_name) docs.push('third-party-financing-addendum');
  if ((payload.stage || '') === 'option-period' || (payload.notes || '').toLowerCase().includes('amend')) docs.push('amendment');
  if ((payload.status || '') === 'terminated' || (payload.notes || '').toLowerCase().includes('terminate')) docs.push('termination-notice');
  if (salePrice <= 0) return [];
  return docs;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true, service: 'dossie-doc-bridge' });
    return;
  }

  if (req.method === 'POST' && req.url === '/generate/resale-contract') {
    try {
      const body = await collectBody(req);
      const transaction = JSON.parse(body || '{}');
      const result = await runGenerator(transaction, 'resale-contract');
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/generate/document-center') {
    try {
      const body = await collectBody(req);
      const transaction = JSON.parse(body || '{}');
      const result = await runGenerator(transaction, 'all');
      sendJson(res, 200, { ok: true, recommendedDocuments: routeDocuments(transaction), ...result });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/download/')) {
    const filename = decodeURIComponent(req.url.replace('/download/', ''));
    const filePath = path.join(GENERATED_DIR, filename);
    if (!fs.existsSync(filePath)) {
      sendJson(res, 404, { ok: false, error: 'File not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${path.basename(filePath)}"`,
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`Dossie document bridge listening on http://localhost:${PORT}`);
});
