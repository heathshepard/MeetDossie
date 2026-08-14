// Vercel Serverless Function: /api/esign-verify-document
// =============================================================================
// (C) Run signature verification on a PDF and say — honestly — whether the
// signatures actually rendered on the page.
//
// This is the endpoint behind the differentiating claim. It never trusts a
// provider's "completed" status; it looks at the document. See
// api/_lib/signature-verifier.js for why both a structural and a visual layer
// are required and why the visual layer wins.
//
// POST { documentId }                     — verify a document already on file
// POST { pdfBase64, fileName? }           — verify bytes directly (used by the
//                                           failure-case test, and by any UI
//                                           that wants to check a file before
//                                           it is filed)
// Optional: { expectedSigners: ["Thomas Linton", "Carol Linton"] }
//
// Authorization: Bearer <supabase user JWT>
//
// Owner: Carter, 2026-08-14 (SV-ENG-ESIGN-COMPLETION)
// =============================================================================

'use strict';

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { applyCorsHeaders } = require('./_middleware/cors');
const { verifyExecutedPdf } = require('./_lib/signature-verifier');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const MAX_PDF_BYTES = 12 * 1024 * 1024;

async function sb(pathAndQuery) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function downloadFromStorage(storagePath) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/documents/${storagePath}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCorsHeaders(req, res, { methods: 'POST, OPTIONS' });
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (!corsAllowed) return res.status(403).json({ ok: false, error: 'Origin not allowed.' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  let userId;
  try {
    ({ userId } = await verifySupabaseToken(req));
  } catch (err) {
    return res.status(err instanceof AuthError && err.status ? err.status : 401).json({ ok: false, error: 'Unauthorized' });
  }

  const body = req.body || {};
  const { documentId, pdfBase64, expectedSigners } = body;
  let buffer = null;
  let fileName = body.fileName || null;

  if (documentId) {
    const { ok, data } = await sb(
      `documents?select=id,file_name,storage_path&id=eq.${encodeURIComponent(documentId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
    );
    if (!ok || !Array.isArray(data) || !data.length) {
      return res.status(404).json({ ok: false, error: 'Document not found' });
    }
    fileName = data[0].file_name;
    buffer = await downloadFromStorage(data[0].storage_path);
    if (!buffer) return res.status(500).json({ ok: false, error: 'Could not read the document from storage.' });
  } else if (pdfBase64) {
    try {
      buffer = Buffer.from(String(pdfBase64), 'base64');
    } catch (_) {
      return res.status(400).json({ ok: false, error: 'pdfBase64 is not valid base64.' });
    }
    if (buffer.length > MAX_PDF_BYTES) {
      return res.status(413).json({ ok: false, error: 'PDF exceeds 12MB.' });
    }
  } else {
    return res.status(400).json({ ok: false, error: 'documentId or pdfBase64 is required.' });
  }

  const result = await verifyExecutedPdf({
    buffer,
    expectedSigners: Array.isArray(expectedSigners) ? expectedSigners.slice(0, 8) : [],
    apiKey: ANTHROPIC_API_KEY,
    providerStatus: body.providerStatus || null,
  });

  return res.status(200).json({
    ok: true,
    fileName,
    verdict: result.verdict,
    // The flag callers branch on. False means: surface this, do not file it as
    // done and do not forward it.
    safeToFileAsExecuted: result.safeToFileAsExecuted,
    problems: result.problems,
    signerNamesSeen: result.signerNamesSeen,
    datesSeen: result.datesSeen,
    sha256: result.sha256,
    structural: {
      isPdf: result.structural.isPdf,
      parseable: result.structural.parseable,
      parseError: result.structural.parseError,
      pageCount: result.structural.pageCount,
      cryptoSignature: result.structural.cryptoSignature,
      acroForm: result.structural.acroForm,
      imageXObjects: result.structural.imageXObjects,
      providerHints: result.structural.providerHints,
    },
    visual: result.visual,
    checkedAt: result.checkedAt,
  });
};
