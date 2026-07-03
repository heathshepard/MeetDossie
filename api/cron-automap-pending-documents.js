/**
 * api/cron-automap-pending-documents.js
 *
 * Runs every 2 min via vercel cron. Finds documents with scan_status='pending'
 * (up to `limit`, default 10), downloads each from Supabase Storage, runs the
 * Fable 5 field-extraction pipeline, and updates the document row with
 * scan_status='complete' + form_type + scan_result. Documents that fail 3+
 * times are marked scan_status='failed'.
 *
 * Auth: GET with `Authorization: Bearer $CRON_SECRET` (or Vercel cron infra).
 * Method: GET (Vercel cron fires GET). ?limit=N override supported.
 *
 * This is the auto-map pipeline that was structurally missing — uploads
 * inserted rows with scan_status='pending' but no worker ever processed them,
 * leaving 455 documents stranded across all customers. This cron closes the
 * loop.
 *
 * Failure model:
 *   - PDF download 404 / storage-signing failure  → transient, no retry bump
 *     (row stays 'pending', will be picked up next tick)
 *   - PDF corrupt / 0 bytes / not %PDF            → 'failed' immediately
 *   - Fable 5 5xx / timeout / rate-limit          → retry bump; 'failed' at 3
 *   - Fable 5 parse error                         → retry bump; 'failed' at 3
 *   - Fable 5 success                             → 'complete'
 *
 * scan_result JSONB shape on complete:
 *   {
 *     form_number: "TXR-1501",
 *     form_name:   "Buyer Representation Agreement",
 *     total_pages: 12,
 *     field_count: 84,
 *     model_cost_cents: 43,
 *     processed_at: "2026-07-03T..."
 *   }
 *
 * scan_result JSONB shape on failed:
 *   {
 *     attempts: 3,
 *     last_error: "PDF is 0 bytes",
 *     failed_at: "2026-07-03T..."
 *   }
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { callFable5Chunked, postProcessFieldMap } = require('./_lib/fable5-field-mapper.js');
const { pdfToImages } = require('./_lib/pdf-to-images.js');
const { withTelemetry } = require('./_lib/cron-telemetry.js');

const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const DEFAULT_BATCH_LIMIT = 10;
const MAX_BATCH_LIMIT = 20;
const MAX_PAGE_COUNT = 40;
const MAX_RETRY_ATTEMPTS = 3;

function isAuthed(req) {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const bearerOk = Boolean(CRON_SECRET) && h === `Bearer ${CRON_SECRET}`;
  // Vercel cron sends x-vercel-cron: 1 (no bearer); treat as authorized when present.
  const vercelCron = req.headers && req.headers['x-vercel-cron'] === '1';
  return bearerOk || vercelCron;
}

function log(msg, extra) {
  if (extra !== undefined) {
    console.log(`[cron-automap-pending-documents] ${msg}`, extra);
  } else {
    console.log(`[cron-automap-pending-documents] ${msg}`);
  }
}

function warn(msg, extra) {
  if (extra !== undefined) {
    console.warn(`[cron-automap-pending-documents] ${msg}`, extra);
  } else {
    console.warn(`[cron-automap-pending-documents] ${msg}`);
  }
}

async function supabaseStorageSignedUrl(supabase, storagePath, expiresInSeconds) {
  const { data, error } = await supabase.storage
    .from('documents')
    .createSignedUrl(storagePath, expiresInSeconds || 3600);
  if (error) throw new Error(`signed-url failed: ${error.message}`);
  if (!data || !data.signedUrl) throw new Error('signed-url returned empty');
  return data.signedUrl;
}

async function downloadPdf(urlStr) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) {
      return reject(new Error(`invalid pdf url: ${e.message}`));
    }
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(urlStr, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`PDF fetch HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
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

/**
 * Process a single document. Returns:
 *   { ok: true, form_type, field_count } on success
 *   { ok: false, transient: bool, error: string } on failure
 *
 * A `transient` failure means the underlying condition (rate limit, timeout,
 * missing PII env var) may resolve on its own — safe to retry. A non-transient
 * failure is a permanent data condition (0 bytes, missing storage object,
 * >40 pages) — the row goes straight to 'failed'.
 */
async function processDocument(supabase, doc) {
  if (!doc.storage_path) {
    return { ok: false, transient: false, error: 'missing storage_path' };
  }

  let signedUrl;
  try {
    signedUrl = await supabaseStorageSignedUrl(supabase, doc.storage_path, 3600);
  } catch (e) {
    return { ok: false, transient: true, error: `sign-url: ${e.message}` };
  }

  let pdfBuffer;
  try {
    pdfBuffer = await downloadPdf(signedUrl);
  } catch (e) {
    if (/HTTP 404/i.test(String(e.message))) {
      return { ok: false, transient: false, error: 'storage object missing (404)' };
    }
    return { ok: false, transient: true, error: `download: ${e.message}` };
  }

  if (!pdfBuffer || pdfBuffer.length === 0) {
    return { ok: false, transient: false, error: 'PDF is 0 bytes' };
  }

  let docBlocks, pageCount;
  try {
    const wrapped = await pdfToImages(pdfBuffer);
    docBlocks = wrapped.blocks;
    pageCount = wrapped.pageCount;
  } catch (e) {
    return { ok: false, transient: false, error: `pdf-prep: ${e.message}` };
  }

  if (pageCount > MAX_PAGE_COUNT) {
    return {
      ok: false,
      transient: false,
      error: `PDF is ${pageCount} pages; max supported is ${MAX_PAGE_COUNT}`,
    };
  }

  let fableResult;
  try {
    fableResult = await callFable5Chunked(docBlocks, doc.file_name || 'document', {
      vertical: 'residential',
      pageCount,
    });
  } catch (e) {
    return { ok: false, transient: true, error: `fable5: ${e.message}` };
  }

  const processedFields = postProcessFieldMap(fableResult.parsed.fields || []);
  const formType = fableResult.parsed.form_number || fableResult.parsed.doc_slug || null;
  const formName = fableResult.parsed.form_name || null;
  const modelCostCents = fableResult.model_cost_cents || 0;
  const totalPages = fableResult.parsed.total_pages || pageCount;
  const pdfHash = hashPdf(pdfBuffer);

  // scan_result stores ONLY schema metadata — no extracted PII (values). Field
  // values are extracted lazily at fill-time via the existing dossiesign flow.
  const scanResult = {
    form_number: formType,
    form_name: formName,
    total_pages: totalPages,
    field_count: processedFields.length,
    model_cost_cents: modelCostCents,
    pdf_hash: pdfHash,
    processed_at: new Date().toISOString(),
  };

  const { error: updErr } = await supabase
    .from('documents')
    .update({
      scan_status: 'complete',
      form_type: formType,
      scan_result: scanResult,
    })
    .eq('id', doc.id);

  if (updErr) {
    return { ok: false, transient: true, error: `documents update: ${updErr.message}` };
  }

  // Mirror the field map into dossiesign_auto_map_runs so the admin QA
  // viewer keeps working. Best-effort; failure here does NOT fail the doc.
  try {
    await supabase.from('dossiesign_auto_map_runs').insert({
      id: crypto.randomUUID(),
      pdf_url: signedUrl.split('?')[0],
      pdf_hash: pdfHash,
      doc_name: doc.file_name || 'document',
      vertical: 'residential',
      page_count: totalPages,
      field_count: processedFields.length,
      fields: processedFields,
      model_used: 'claude-fable-5',
      model_cost_cents: modelCostCents,
      qa_status: 'awaiting_hadley_qa',
      qa_notes: fableResult.parsed.notes || '',
    });
  } catch (e) {
    warn(`auto_map_runs insert failed for doc ${doc.id}: ${e.message}`);
  }

  return { ok: true, form_type: formType, field_count: processedFields.length };
}

/**
 * Bump the retry counter or terminally fail. `forceTerminal` when true
 * routes non-transient errors straight to 'failed' regardless of prior count.
 */
async function bumpRetryOrFail(supabase, doc, errorMsg, forceTerminal) {
  const prevAttempts =
    (doc.scan_result && typeof doc.scan_result.attempts === 'number')
      ? doc.scan_result.attempts
      : 0;
  const attempts = prevAttempts + 1;

  if (forceTerminal || attempts >= MAX_RETRY_ATTEMPTS) {
    await supabase
      .from('documents')
      .update({
        scan_status: 'failed',
        scan_result: {
          attempts,
          last_error: String(errorMsg).slice(0, 500),
          failed_at: new Date().toISOString(),
        },
      })
      .eq('id', doc.id);
    return 'failed';
  }

  await supabase
    .from('documents')
    .update({
      scan_result: {
        attempts,
        last_error: String(errorMsg).slice(0, 500),
        last_error_at: new Date().toISOString(),
      },
    })
    .eq('id', doc.id);
  return 'retry';
}

async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (!isAuthed(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const rawLimit = parseInt(String((req.query && req.query.limit) || ''), 10);
  const limit = Math.max(
    1,
    Math.min(MAX_BATCH_LIMIT, isNaN(rawLimit) ? DEFAULT_BATCH_LIMIT : rawLimit)
  );

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: pendingDocs, error: listErr } = await supabase
    .from('documents')
    .select('id, storage_path, file_name, file_type, scan_result, uploaded_at')
    .in('scan_status', ['pending'])
    .order('uploaded_at', { ascending: true, nullsFirst: true })
    .limit(limit);

  if (listErr) {
    return res.status(500).json({ ok: false, error: `list: ${listErr.message}` });
  }

  const results = {
    ok: true,
    scanned: pendingDocs ? pendingDocs.length : 0,
    completed: 0,
    failed: 0,
    retried: 0,
    doc_results: [],
  };

  if (!pendingDocs || pendingDocs.length === 0) {
    return res.status(200).json(results);
  }

  log(`processing ${pendingDocs.length} pending docs (limit=${limit})`);

  for (const doc of pendingDocs) {
    try {
      const outcome = await processDocument(supabase, doc);
      if (outcome.ok) {
        results.completed += 1;
        results.doc_results.push({
          id: doc.id,
          status: 'completed',
          form_type: outcome.form_type,
          field_count: outcome.field_count,
        });
        log(`doc ${doc.id} → completed (${outcome.form_type}, ${outcome.field_count} fields)`);
      } else {
        // Non-transient => straight to 'failed'. Transient => retry counter.
        const forceTerminal = outcome.transient === false;
        const nextStatus = await bumpRetryOrFail(supabase, doc, outcome.error, forceTerminal);
        if (nextStatus === 'failed') {
          results.failed += 1;
          results.doc_results.push({ id: doc.id, status: 'failed', error: outcome.error });
          warn(`doc ${doc.id} → failed (${outcome.error})`);
        } else {
          results.retried += 1;
          results.doc_results.push({ id: doc.id, status: 'retry', error: outcome.error });
          warn(`doc ${doc.id} → retry (${outcome.error})`);
        }
      }
    } catch (e) {
      const msg = e && e.message ? e.message : 'crash';
      warn(`doc ${doc.id} crashed: ${msg}`);
      try {
        const nextStatus = await bumpRetryOrFail(supabase, doc, `crash: ${msg}`, false);
        if (nextStatus === 'failed') results.failed += 1;
        else results.retried += 1;
      } catch (bumpErr) {
        warn(`bumpRetryOrFail also crashed for ${doc.id}: ${bumpErr.message}`);
      }
    }
  }

  log(`batch done: completed=${results.completed} failed=${results.failed} retried=${results.retried}`);
  return res.status(200).json(results);
}

module.exports = withTelemetry('cron-automap-pending-documents', handler);
