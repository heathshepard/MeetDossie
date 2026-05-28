// Vercel Serverless Function: /api/transactions/download-zip
// GET /api/transactions/download-zip?transaction_id=X
// Authorization: Bearer <supabase user JWT>
//
// Downloads all documents for a transaction from Supabase Storage
// and streams them back as a ZIP file with:
//   Content-Disposition: attachment; filename="compliance-package-[address].zip"
//
// Uses the Node.js built-in `zlib` + a minimal ZIP format writer.
// No third-party zip library needed — avoids adding dependencies.
//
// ZIP format reference: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
// This implementation uses STORE (no compression) for simplicity and reliability.
// Files are rarely compressible PDFs so DEFLATE adds latency with minimal size gain.

const { verifySupabaseToken, AuthError } = require('../_middleware/auth');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'documents';

// Max total raw bytes we'll ZIP and stream.
// Vercel Hobby serverless caps the response payload at 6 MB (uncompressed body).
// We cap source bytes at 5 MB — ZIP overhead (STORE = no compression + headers)
// adds <1% so the final ZIP stays comfortably under 6 MB.
// Most compliance packages are 2-5 typical PDFs which fit easily.
// For larger packages, agents should use "Send to Compliance" email (Resend 40MB cap).
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function applyCors(req, res) {
  const origin = (req.headers && req.headers.origin) || '';
  const allowed =
    (typeof origin === 'string' && origin.length > 0) &&
    (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN_RE.test(origin));
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization');
  }
  return allowed;
}

// ─── Supabase helpers ────────────────────────────────────────────────────────

async function supaFetch(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// Download a Storage object directly using the service role key.
// This matches the pattern in send-compliance-packet.js and avoids the
// extra round trip that signed URLs require.
async function downloadStorageObject(storagePath) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Storage download ${res.status} for ${storagePath}: ${errText.slice(0, 200)}`);
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

// ─── Minimal ZIP writer ──────────────────────────────────────────────────────
// Produces a valid ZIP without third-party deps using STORE (no compression).
// Each file entry: local file header + data. Then central directory + EOCD.

function uint16LE(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function uint32LE(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function dosDateTime() {
  const now = new Date();
  const dosDate =
    ((now.getFullYear() - 1980) << 9) |
    ((now.getMonth() + 1) << 5) |
    now.getDate();
  const dosTime =
    (now.getHours() << 11) |
    (now.getMinutes() << 5) |
    Math.floor(now.getSeconds() / 2);
  return { time: dosTime, date: dosDate };
}

// CRC-32 (standard ZIP CRC). Uses a pre-computed table for performance.
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
  // files: Array<{ name: string, data: Buffer }>
  const chunks = [];
  const centralDir = [];
  let offset = 0;

  const dt = dosDateTime();
  const modTime = uint16LE(dt.time);
  const modDate = uint16LE(dt.date);

  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = uint32LE(crc32(data));
    const size = uint32LE(data.length);
    const nameLen = uint16LE(nameBytes.length);

    // Local file header (signature 0x04034b50)
    const lfh = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), // signature
      uint16LE(20),   // version needed: 2.0
      uint16LE(0),    // general purpose bit flag
      uint16LE(0),    // compression method: STORE
      modTime,
      modDate,
      crc,
      size,           // compressed size (same as uncompressed for STORE)
      size,           // uncompressed size
      nameLen,
      uint16LE(0),    // extra field length
      nameBytes,
    ]);

    chunks.push(lfh);

    // Central directory record (signature 0x02014b50)
    const cdr = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]), // signature
      uint16LE(20),   // version made by
      uint16LE(20),   // version needed
      uint16LE(0),    // flags
      uint16LE(0),    // compression: STORE
      modTime,
      modDate,
      crc,
      size,
      size,
      nameLen,
      uint16LE(0),    // extra field length
      uint16LE(0),    // file comment length
      uint16LE(0),    // disk number start
      uint16LE(0),    // internal file attributes
      uint32LE(0),    // external file attributes
      uint32LE(offset), // relative offset of local header
      nameBytes,
    ]);

    centralDir.push(cdr);
    offset += lfh.length + data.length;
    chunks.push(data);
  }

  const cdOffset = offset;
  const cdData = Buffer.concat(centralDir);

  // End of central directory record (signature 0x06054b50)
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]), // signature
    uint16LE(0),                            // disk number
    uint16LE(0),                            // disk with central dir start
    uint16LE(files.length),                 // entries on this disk
    uint16LE(files.length),                 // total entries
    uint32LE(cdData.length),                // size of central dir
    uint32LE(cdOffset),                     // offset of central dir
    uint16LE(0),                            // comment length
  ]);

  return Buffer.concat([...chunks, cdData, eocd]);
}

// ─── Sanitize filename for ZIP entry ─────────────────────────────────────────

function sanitizeFilename(name) {
  // Remove path traversal, null bytes, and non-printable chars.
  return (name || 'document')
    .replace(/\0/g, '')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 200);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Auth: Supabase user JWT ──────────────────────────────────────────────
  let userId;
  try {
    const auth = await verifySupabaseToken(req);
    userId = auth.userId;
  } catch (err) {
    if (err instanceof AuthError || err.status === 401) {
      return res.status(401).json({ error: err.message || 'Unauthorized' });
    }
    return res.status(500).json({ error: 'Auth service error' });
  }

  // ── Input: transaction_id ────────────────────────────────────────────────
  const transactionId = (req.query && req.query.transaction_id) || '';
  if (!transactionId || typeof transactionId !== 'string' || !transactionId.trim()) {
    return res.status(400).json({ error: 'Missing transaction_id query parameter' });
  }
  const txId = transactionId.trim();

  // ── Verify the user owns this transaction ────────────────────────────────
  const txRes = await supaFetch(
    `transactions?id=eq.${encodeURIComponent(txId)}&user_id=eq.${encodeURIComponent(userId)}&select=id,property_address`,
  );
  if (!txRes.ok || !Array.isArray(txRes.data) || txRes.data.length === 0) {
    return res.status(404).json({ error: 'Transaction not found or access denied' });
  }
  const transaction = txRes.data[0];
  const propertyAddress = (transaction.property_address || 'transaction')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 80)
    .toLowerCase();

  // ── Fetch document records ───────────────────────────────────────────────
  const docsRes = await supaFetch(
    `documents?transaction_id=eq.${encodeURIComponent(txId)}&select=id,file_name,storage_path,document_type&order=created_at.asc`,
  );
  if (!docsRes.ok) {
    return res.status(500).json({ error: 'Failed to load document records' });
  }
  const docs = Array.isArray(docsRes.data) ? docsRes.data : [];
  if (docs.length === 0) {
    return res.status(404).json({ error: 'No documents found for this transaction' });
  }

  // ── Download each document from Storage ─────────────────────────────────
  const files = [];
  let totalBytes = 0;

  for (const doc of docs) {
    const storagePath = doc.storage_path || '';
    if (!storagePath) {
      console.warn(`[download-zip] doc ${doc.id} has no storage_path — skipping`);
      continue;
    }

    let fileData;
    try {
      fileData = await downloadStorageObject(storagePath);
    } catch (err) {
      console.warn(`[download-zip] download failed for doc ${doc.id}:`, err.message, '— skipping');
      continue;
    }

    totalBytes += fileData.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      // Truncate gracefully — include what we have so far and stop.
      console.warn(`[download-zip] total size limit hit at doc ${doc.id} — truncating ZIP`);
      break;
    }

    // Build a clean filename for the ZIP entry.
    const rawName = doc.file_name || `document-${doc.id}`;
    const safeName = sanitizeFilename(rawName);
    files.push({ name: safeName, data: fileData });
  }

  if (files.length === 0) {
    return res.status(404).json({ error: 'No downloadable documents found (storage paths may be missing)' });
  }

  // ── Build ZIP in memory ──────────────────────────────────────────────────
  let zipBuffer;
  try {
    zipBuffer = buildZip(files);
  } catch (err) {
    console.error('[download-zip] ZIP build failed:', err.message);
    return res.status(500).json({ error: 'Failed to build ZIP archive' });
  }

  // ── Stream ZIP back ──────────────────────────────────────────────────────
  const filename = `compliance-package-${propertyAddress || 'transaction'}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', zipBuffer.length);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).end(zipBuffer);
};
