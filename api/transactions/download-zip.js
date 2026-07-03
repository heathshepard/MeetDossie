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
// Vercel Hobby serverless response payload cap is ~5 MB for edge, but Vercel
// serverless functions support up to 4.5 MB response size on Hobby.
// We cap source bytes at 25 MB to match the spec — but note that very large
// packages may exceed Vercel's 5 MB response limit and should use the
// "Send to Compliance" email (Resend 40 MB cap) instead.
// In practice, most agent compliance packages are 2-10 PDFs totalling < 25 MB.
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

function applyCors(req, res) {
  const origin = (req.headers && req.headers.origin) || '';
  const allowed =
    (typeof origin === 'string' && origin.length > 0) &&
    (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN_RE.test(origin) || VERCEL_PREVIEW_RE.test(origin));
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

// ─── Document type priority sort (SkySlope / Dotloop order) ──────────────────
// Returns 0-100: lower = earlier in the ZIP.

const DOC_TYPE_PRIORITY = {
  'executed-contract':    0,
  'resale-contract':      0,
  'purchase-agreement':   0,
  'contract':             1,
  'amendment':            10,
  'repair-amendment':     11,
  'addendum':             20,
  'financing-addendum':   21,
  'hoa-addendum':         22,
  'lead-paint-addendum':  23,
  'disclosure':           30,
  'sellers-disclosure':   31,
  'wire-fraud-warning':   32,
  'iabs':                 33,
  'inspection-report':    40,
  'appraisal':            50,
  'title-commitment':     60,
  'survey':               61,
  'closing-disclosure':   70,
  'correspondence':       80,
  'other':                90,
};

function docTypePriority(documentType) {
  if (!documentType) return 90;
  const key = String(documentType).toLowerCase().replace(/\s+/g, '-');
  if (DOC_TYPE_PRIORITY[key] !== undefined) return DOC_TYPE_PRIORITY[key];
  // Partial match
  for (const [k, v] of Object.entries(DOC_TYPE_PRIORITY)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  return 90;
}

// Human-readable label for the numeric prefix line in filenames.
function docTypeLabel(documentType) {
  if (!documentType) return 'Document';
  return String(documentType)
    .replace(/-/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Build the 00-COVER.txt content for SkySlope/Dotloop compatibility.
function buildCoverText({ propertyAddress, buyerName, sellerName, agentName, dateRange, fileCount }) {
  const lines = [
    'DOSSIE COMPLIANCE PACKAGE',
    '='.repeat(40),
    '',
    `Property: ${propertyAddress || 'Unknown'}`,
    `Buyer: ${buyerName || 'Unknown'}`,
    `Seller: ${sellerName || 'Unknown'}`,
    `Agent: ${agentName || 'Unknown'}`,
    `Generated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`,
    `Documents included: ${fileCount}`,
    '',
    'Documents are sorted in SkySlope / Dotloop upload order:',
    '  01 - Contract',
    '  02 - Amendments',
    '  03 - Addenda',
    '  04 - Disclosures',
    '  05 - Inspection / Appraisal',
    '  06 - Title / Survey',
    '  07 - Closing Documents',
    '  08 - Correspondence',
    '',
    'Generated by Dossie — meetdossie.com',
  ];
  return lines.join('\n');
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
    `transactions?id=eq.${encodeURIComponent(txId)}&user_id=eq.${encodeURIComponent(userId)}&select=id,property_address,buyer_name,seller_name,contract_effective_date,closing_date`,
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
    `documents?transaction_id=eq.${encodeURIComponent(txId)}&select=id,file_name,storage_path,document_type,created_at&order=created_at.asc`,
  );
  if (!docsRes.ok) {
    return res.status(500).json({ error: 'Failed to load document records' });
  }
  const rawDocs = Array.isArray(docsRes.data) ? docsRes.data : [];
  if (rawDocs.length === 0) {
    return res.status(404).json({ error: 'No documents found for this transaction' });
  }

  // Sort by document type priority (contract first, correspondence last).
  const sortedDocs = [...rawDocs].sort((a, b) => {
    const pa = docTypePriority(a.document_type);
    const pb = docTypePriority(b.document_type);
    if (pa !== pb) return pa - pb;
    // Secondary sort by created_at (oldest first within same type).
    return (a.created_at || '').localeCompare(b.created_at || '');
  });

  // ── Download each document from Storage ─────────────────────────────────
  const files = [];
  let totalBytes = 0;
  let docCounter = 1;

  for (const doc of sortedDocs) {
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

    // Build a SkySlope/Dotloop-ready filename with numeric prefix.
    // Format: 01-Contract.pdf, 02-Amendment.pdf, etc.
    const rawName = doc.file_name || `document-${doc.id}`;
    const ext = rawName.includes('.') ? rawName.slice(rawName.lastIndexOf('.')) : '.pdf';
    const typeLabel = doc.document_type
      ? sanitizeFilename(docTypeLabel(doc.document_type)).replace(/_/g, '-')
      : sanitizeFilename(rawName.slice(0, rawName.lastIndexOf('.') || rawName.length));
    const prefix = String(docCounter).padStart(2, '0');
    const skySllopeName = `${prefix}-${typeLabel}${ext}`;

    files.push({ name: skySllopeName, data: fileData });
    docCounter++;
  }

  if (files.length === 0) {
    return res.status(404).json({ error: 'No downloadable documents found (storage paths may be missing)' });
  }

  // ── Build 00-COVER.txt ───────────────────────────────────────────────────
  const coverText = buildCoverText({
    propertyAddress: transaction.property_address || '',
    buyerName: transaction.buyer_name || '',
    sellerName: transaction.seller_name || '',
    agentName: '',
    dateRange: [transaction.contract_effective_date, transaction.closing_date].filter(Boolean).join(' to '),
    fileCount: files.length,
  });
  const coverFile = { name: '00-COVER.txt', data: Buffer.from(coverText, 'utf8') };

  // ── Build ZIP in memory ──────────────────────────────────────────────────
  let zipBuffer;
  try {
    zipBuffer = buildZip([coverFile, ...files]);
  } catch (err) {
    console.error('[download-zip] ZIP build failed:', err.message);
    return res.status(500).json({ error: 'Failed to build ZIP archive' });
  }

  // ── Stream ZIP back ──────────────────────────────────────────────────────
  // ZIP filename format: [address-slug]-compliance-package.zip
  const zipSlug = propertyAddress || 'transaction';
  const filename = `${zipSlug}-compliance-package.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', zipBuffer.length);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).end(zipBuffer);
};
