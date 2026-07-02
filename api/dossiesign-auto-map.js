/**
 * api/dossiesign-auto-map.js
 * 
 * POST /api/dossiesign-auto-map
 * 
 * Request body:
 * {
 *   "pdfUrl": "https://storage.supabase.co/.../buyer-rep.pdf",
 *   "vertical": "residential" | "land" | "rental" | "commercial",
 *   "requested_form_number": "TXR-1501" (optional)
 * }
 * 
 * Response:
 * {
 *   "ok": true,
 *   "job_id": "uuid",
 *   "status": "queued" | "fable_running" | "awaiting_hadley_qa",
 *   "field_count_estimate": 80,
 *   "preview_url_when_ready": null (populated after render completes)
 * }
 * 
 * Auth: Bearer $CRON_SECRET (admin-only in v1).
 * Flow:
 *   1. Download PDF from pdfUrl
 *   2. Wrap as Anthropic document content block (Fable 5 accepts PDF natively —
 *      no server-side rasterization required)
 *   3. Call Fable 5 to extract field map
 *   4. Post-process to fix paired-Y/N inconsistencies
 *   5. Insert row into dossiesign_auto_map_runs (status='awaiting_hadley_qa')
 *   6. Return job_id + status
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { callFable5Chunked, postProcessFieldMap, calculateCost } = require('./_lib/fable5-field-mapper.js');
const { pdfToImages } = require('./_lib/pdf-to-images.js');

const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function isAuthed(req) {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  return Boolean(CRON_SECRET) && h === `Bearer ${CRON_SECRET}`;
}

function logError(msg, err) {
  console.error(`[dossiesign-auto-map] ${msg}`, err && err.message);
}

async function downloadPdf(urlStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const client = url.protocol === 'https:' ? https : http;
    
    const req = client.get(urlStr, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`PDF fetch returned HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('PDF download timeout'));
    });
  });
}

function hashPdf(pdfBuffer) {
  return crypto.createHash('sha256').update(pdfBuffer).digest('hex');
}

async function processAutoMap(req, res) {
  if (!isAuthed(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  // Parse request body
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const pdfUrl = body.pdfUrl || body.pdf_url;
  const vertical = body.vertical || 'residential';
  const requestedFormNumber = body.requested_form_number;
  const docName = body.doc_name || 'Untitled';

  if (!pdfUrl) {
    return res.status(400).json({ ok: false, error: 'pdfUrl required' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  try {
    // Step 1: Download PDF
    logError('', null);
    console.log(`[dossiesign-auto-map] Downloading PDF from ${pdfUrl}`);
    const pdfBuffer = await downloadPdf(pdfUrl);
    const pdfHash = hashPdf(pdfBuffer);

    // Check for duplicate (same PDF hash). Admin-only in v1 — created_by is null.
    // Use limit(1) rather than maybeSingle() so multiple historical matches
    // don't cause a 406-style error.
    const { data: existingRows } = await supabase
      .from('dossiesign_auto_map_runs')
      .select('id, qa_status, field_count, page_count, model_cost_cents')
      .eq('pdf_hash', pdfHash)
      .order('created_at', { ascending: false })
      .limit(1);

    const existing = existingRows && existingRows[0];
    if (existing) {
      return res.status(200).json({
        ok: true,
        job_id: existing.id,
        status: existing.qa_status,
        field_count: existing.field_count,
        page_count: existing.page_count,
        model_cost_usd: existing.model_cost_cents != null ? (existing.model_cost_cents / 100).toFixed(2) : null,
        note: 'PDF already processed (duplicate hash)',
      });
    }

    // Step 2: Wrap PDF as Anthropic document block
    // Claude Fable 5 natively supports PDF input — no rasterization required.
    let docBlocks = [];
    let pageCount = 0;
    try {
      const wrapped = await pdfToImages(pdfBuffer);
      docBlocks = wrapped.blocks;
      pageCount = wrapped.pageCount;
    } catch (e) {
      logError('Failed to wrap PDF for Fable 5', e);
      return res.status(400).json({
        ok: false,
        error: `PDF prep failed: ${e.message}`,
      });
    }

    if (pageCount > 40) {
      return res.status(400).json({
        ok: false,
        error: `PDF is ${pageCount} pages. Auto-mapping supports up to 40 pages per request; use the Hadley batched flow for larger forms.`,
      });
    }

    // Step 3: Call Fable 5 with chunked processing for large PDFs
    console.log(`[dossiesign-auto-map] Calling Fable 5 for ${pageCount}-page PDF`);
    const fableResult = await callFable5Chunked(docBlocks, docName, {
      vertical,
      requested_form_number: requestedFormNumber,
      pageCount,
    });

    // Step 4: Post-process field map
    const processedFields = postProcessFieldMap(fableResult.parsed.fields || []);

    // Step 5: Insert into Supabase
    const jobId = crypto.randomUUID();
    const { error: insertErr } = await supabase
      .from('dossiesign_auto_map_runs')
      .insert({
        id: jobId,
        pdf_url: pdfUrl,
        pdf_hash: pdfHash,
        doc_name: docName,
        vertical,
        requested_form_number: requestedFormNumber,
        page_count: fableResult.parsed.total_pages || pageCount,
        field_count: processedFields.length,
        fields: processedFields,
        model_used: 'claude-fable-5',
        model_cost_cents: fableResult.model_cost_cents,
        qa_status: 'awaiting_hadley_qa',
        qa_notes: fableResult.parsed.notes || '',
      });

    if (insertErr) {
      logError('Failed to insert job record', insertErr);
      return res.status(500).json({ ok: false, error: 'Database insert failed: ' + insertErr.message });
    }

    return res.status(202).json({
      ok: true,
      job_id: jobId,
      status: 'awaiting_hadley_qa',
      field_count: processedFields.length,
      field_count_estimate: processedFields.length,
      page_count: fableResult.parsed.total_pages || pageCount,
      model_cost_cents: fableResult.model_cost_cents,
      model_cost_usd: (fableResult.model_cost_cents / 100).toFixed(2),
    });

  } catch (e) {
    logError('Unhandled error', e);
    if (e.message.includes('PDF fetch returned HTTP 404')) {
      return res.status(400).json({ ok: false, error: 'PDF URL not found' });
    }
    if (e.message.includes('Fable 5 HTTP')) {
      return res.status(503).json({ ok: false, error: 'Fable 5 API error. Retry later.' });
    }
    return res.status(500).json({ ok: false, error: e.message });
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method === 'POST') {
    return processAutoMap(req, res);
  }
  
  res.status(405).json({ ok: false, error: 'Method not allowed. Use POST.' });
};
