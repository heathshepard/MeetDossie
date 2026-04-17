const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8787;
const BASE_DIR = __dirname;
const GENERATED_DIR = path.join(BASE_DIR, 'generated-docs');
const DOC_SCRIPT_PATH = path.join(BASE_DIR, 'scripts', 'generate_documents_from_transaction.py');
const INTEL_SCRIPT_PATH = path.join(BASE_DIR, 'scripts', 'transaction_intelligence_cli.py');
const APP_HTML_PATH = path.join(BASE_DIR, 'app.html');
const INDEX_HTML_PATH = path.join(BASE_DIR, 'index.html');

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

function writeTempTransaction(transaction) {
  const tempInput = path.join(GENERATED_DIR, `transaction-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(tempInput, JSON.stringify(transaction, null, 2));
  return tempInput;
}

function runPython(scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('python', [scriptPath, ...args], {
      cwd: BASE_DIR,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => stdout += chunk.toString());
    child.stderr.on('data', chunk => stderr += chunk.toString());
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `Generator exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function runGenerator(transaction, documentKey = 'all') {
  const tempInput = writeTempTransaction(transaction);
  try {
    const stdout = await runPython(DOC_SCRIPT_PATH, [tempInput, documentKey]);
    return JSON.parse(stdout);
  } finally {
    try { fs.unlinkSync(tempInput); } catch {}
  }
}

async function runIntelligence(transaction, command, message = '') {
  const tempInput = writeTempTransaction(transaction);
  try {
    const args = [command, tempInput];
    if (message) args.push(message);
    const stdout = await runPython(INTEL_SCRIPT_PATH, args);
    return JSON.parse(stdout);
  } finally {
    try { fs.unlinkSync(tempInput); } catch {}
  }
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

function sendFile(res, filePath, contentType = 'text/html; charset=utf-8') {
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { ok: false, error: 'File not found' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
  });
  fs.createReadStream(filePath).pipe(res);
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

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  if (req.method === 'GET' && pathname === '/health') {
    sendJson(res, 200, { ok: true, service: 'dossie-doc-bridge' });
    return;
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    sendFile(res, INDEX_HTML_PATH);
    return;
  }

  if (req.method === 'GET' && pathname === '/app.html') {
    sendFile(res, APP_HTML_PATH);
    return;
  }

  if (req.method === 'GET' && pathname === '/signin.html') {
    sendFile(res, path.join(BASE_DIR, 'signin.html'));
    return;
  }

  if (req.method === 'GET' && pathname === '/agents') {
    sendFile(res, APP_HTML_PATH);
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

  if (req.method === 'POST' && req.url === '/intelligence/analyze') {
    try {
      const body = await collectBody(req);
      const transaction = JSON.parse(body || '{}');
      const result = await runIntelligence(transaction, 'analyze');
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/intelligence/conversation') {
    try {
      const body = await collectBody(req);
      const payload = JSON.parse(body || '{}');
      const result = await runIntelligence(payload.transaction || {}, 'conversation', payload.message || '');
      sendJson(res, 200, { ok: true, ...result });
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
