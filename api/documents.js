// Vercel Serverless Function: /api/documents
// GET    /api/documents?transactionId=X        -> list ACTIVE documents (archived_at IS NULL), with fresh signed URLs
// DELETE /api/documents?documentId=Y            -> archive one document
// DELETE /api/documents?documentIds=A,B,C        -> archive several (bulk action)
// Authorization: Bearer <supabase user JWT>
//
// 2026-09-21 CARTER — document/offer model, Rule A: "Nothing is ever
// destroyed. 'Delete' means archive... He may have to prove what was in
// force on a given date." DELETE used to remove the Storage object AND the
// row outright — a member's own client record, gone permanently on one
// click and one confirm dialog. Now sets archived_at instead; the row and
// the Storage object are never removed by member action. GET filters
// archived_at IS NULL so an archived document disappears from the working
// view exactly like a real delete did, but nothing is gone.

const { sanitizeString, ValidationError } = require('./_middleware/validate');
const {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { resolveBlankTemplatePdf } = require('./_lib/resolve-blank-template-pdf');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'documents';
const SIGNED_URL_TTL_SECONDS = 3600;

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
  'https://staging.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  let allowOrigin = null;
  if (typeof origin === 'string' && origin.length > 0) {
    // Allow explicit origins, localhost, and all Vercel preview URLs
    if (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN_RE.test(origin) || origin.endsWith('.vercel.app') || origin.endsWith('.meetdossie.com')) {
      allowOrigin = origin;
    }
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  // Same-origin requests have no Origin header — let them through.
  return Boolean(allowOrigin) || !origin;
}

async function supabaseRest(path, init) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...((init && init.headers) || {}),
  };
  return fetch(url, { ...init, headers });
}

async function signUrl(storagePath) {
  const url = `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${storagePath}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
  });
  if (!response.ok) return null;
  const json = await response.json().catch(() => null);
  if (!json || !json.signedURL) return null;
  const path = json.signedURL.startsWith('/') ? json.signedURL : `/${json.signedURL}`;
  return `${SUPABASE_URL}/storage/v1${path}`;
}

function shapeDocumentRow(row, signedUrl, isBlankTemplate) {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    fileName: row.file_name,
    fileType: row.file_type,
    documentType: row.document_type || null,
    storagePath: row.storage_path,
    fileSize: row.file_size || null,
    createdAt: row.created_at,
    signedUrl: signedUrl || null,
    // 2026-07-13 CARTER — blank form_template docs have no signable file in
    // Storage (placeholder path "template/{id}.pdf"). Frontend surfaces
    // "Fill this out" instead of a preview link when this is true.
    isBlankTemplate: Boolean(isBlankTemplate),
  };
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(corsAllowed ? 204 : 403).end();
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[documents] Supabase not configured.');
    res.status(500).json({ ok: false, error: 'Document storage is not configured.' });
    return;
  }

  try {
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'documents', 120, 60 * 60 * 1000);

    const { userId } = await verifySupabaseToken(req);

    if (req.method === 'GET') {
      const transactionId = sanitizeString(
        (req.query && req.query.transactionId) || '',
        { maxLength: 200 },
      );
      if (!transactionId) {
        throw new ValidationError('transactionId query parameter is required.');
      }

      const safeUid = encodeURIComponent(userId);
      const safeTx = encodeURIComponent(transactionId);
      const listResp = await supabaseRest(
        `documents?select=*&user_id=eq.${safeUid}&transaction_id=eq.${safeTx}&archived_at=is.null&order=created_at.desc`,
        { method: 'GET' },
      );
      if (!listResp.ok) {
        const text = await listResp.text().catch(() => '');
        throw new Error(`documents list failed (${listResp.status}): ${text.slice(0, 200)}`);
      }
      const rows = await listResp.json();
      const items = Array.isArray(rows) ? rows : [];
      const documents = await Promise.all(
        items.map(async (row) => {
          // 2026-07-13 CARTER — blank form_template placeholders have no
          // Storage object. signUrl() would return null anyway (400 from
          // Storage), but the resolver check makes the intent explicit and
          // lets the UI show a "Fill this out" CTA instead of a broken link.
          const resolvedBlank = await resolveBlankTemplatePdf(row);
          if (resolvedBlank) {
            return shapeDocumentRow(row, null, true);
          }
          const signed = await signUrl(row.storage_path);
          return shapeDocumentRow(row, signed, false);
        }),
      );
      return res.status(200).json({ ok: true, documents });
    }

    if (req.method === 'DELETE') {
      const singleId = sanitizeString((req.query && req.query.documentId) || '', { maxLength: 200 });
      const idsParam = sanitizeString((req.query && req.query.documentIds) || '', { maxLength: 2000 });
      const documentIds = idsParam
        ? idsParam.split(',').map((s) => s.trim()).filter(Boolean)
        : (singleId ? [singleId] : []);
      if (!documentIds.length) {
        throw new ValidationError('documentId or documentIds query parameter is required.');
      }
      // Same bound as a packet's MAX_PACKET_DOCUMENTS-style caps elsewhere —
      // a bulk action still has a sane ceiling, not an unbounded batch.
      if (documentIds.length > 100) {
        throw new ValidationError('Too many documents in one request (max 100).');
      }

      const safeUid = encodeURIComponent(userId);
      const idList = documentIds.map((id) => `"${id}"`).join(',');

      // Confirm ownership: only rows that are actually this member's, and
      // not already archived (archiving twice is a no-op, not an error, but
      // the count returned should reflect what actually changed).
      const fetchResp = await supabaseRest(
        `documents?select=id,file_name&id=in.(${idList})&user_id=eq.${safeUid}&archived_at=is.null`,
        { method: 'GET' },
      );
      if (!fetchResp.ok) {
        const text = await fetchResp.text().catch(() => '');
        throw new Error(`documents fetch failed (${fetchResp.status}): ${text.slice(0, 200)}`);
      }
      const rows = await fetchResp.json();
      const owned = Array.isArray(rows) ? rows : [];
      if (!owned.length) {
        return res.status(404).json({ ok: false, error: 'No matching document found to archive.' });
      }
      const ownedIdList = owned.map((r) => `"${r.id}"`).join(',');

      // Archive, never delete — Rule A. The Storage object and the row both
      // stay; only archived_at is set. See the file header for why.
      const archiveResp = await supabaseRest(
        `documents?id=in.(${ownedIdList})&user_id=eq.${safeUid}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ archived_at: new Date().toISOString() }),
        },
      );
      if (!archiveResp.ok) {
        const text = await archiveResp.text().catch(() => '');
        throw new Error(`documents archive failed (${archiveResp.status}): ${text.slice(0, 200)}`);
      }

      return res.status(200).json({ ok: true, archivedCount: owned.length, archivedIds: owned.map((r) => r.id) });
    }

    res.setHeader('Allow', 'GET, DELETE, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.status || 401).json({ ok: false, error: error.message });
    }
    if (error instanceof ValidationError) {
      return res.status(error.status || 400).json({ ok: false, error: error.message });
    }
    if (error instanceof RateLimitError) {
      if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: 'Too many requests. Try again later.' });
    }
    console.error('[documents] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not load documents.' });
  }
};
