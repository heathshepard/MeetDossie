const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8787;
const BASE_DIR = __dirname;
const GENERATED_DIR = path.join(BASE_DIR, 'generated-docs');
const SCRIPT_PATH = path.join(BASE_DIR, 'scripts', 'generate_resale_contract_from_transaction.py');

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

function runGenerator(transaction) {
  return new Promise((resolve, reject) => {
    const tempInput = path.join(GENERATED_DIR, `transaction-${Date.now()}.json`);
    fs.writeFileSync(tempInput, JSON.stringify(transaction, null, 2));

    const child = spawn('python', [SCRIPT_PATH, tempInput], {
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
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      const outputPath = lines[lines.length - 1];
      resolve({ outputPath, stdout });
    });
  });
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
      const { outputPath, stdout } = await runGenerator(transaction);
      sendJson(res, 200, {
        ok: true,
        outputPath,
        downloadPath: '/download/' + encodeURIComponent(path.basename(outputPath)),
        log: stdout,
      });
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
