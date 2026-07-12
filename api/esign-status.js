// Vercel Serverless Function: /api/esign-status
// GET ?submissionId=xxx
//     ?documentId=xxx    (returns ALL signature requests for a document)
// Authorization: Bearer <supabase user JWT>
//
// Returns the current status of a signature request (or list of requests for
// a document). Used by the frontend to poll/render signature status badges.
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');
const { applyCorsHeaders } = require('./_middleware/cors');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'GET, OPTIONS' });
}

function supa(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
}

// Derive a human-readable overall status from the per-signer statuses.
// 'completed' — all signed
// 'partially_signed' — at least one signed, not all
// 'viewed' — at least one viewed, none signed
// 'in_progress' — at least one started, none signed
// 'sent' — no one has opened yet
function deriveOverallStatus(dbRow) {
  if (!dbRow) return 'unknown';
  if (dbRow.status === 'completed') return 'completed';
  const signers = Array.isArray(dbRow.signers) ? dbRow.signers : [];
  if (signers.length === 0) return dbRow.status || 'sent';
  const allSigned = signers.every((s) => s.status === 'signed');
  if (allSigned) return 'completed';
  const anySigned = signers.some((s) => s.status === 'signed');
  if (anySigned) return 'partially_signed';
  const anyInProgress = signers.some((s) => s.status === 'in_progress');
  if (anyInProgress) return 'in_progress';
  const anyViewed = signers.some((s) => s.status === 'viewed');
  if (anyViewed) return 'viewed';
  return dbRow.status || 'sent';
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(corsAllowed ? 204 : 403).end();
    return;
  }
  if (!corsAllowed) {
    res.status(403).json({ ok: false, error: 'Origin not allowed.' });
    return;
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ ok: false, error: 'Service not configured.' });
    return;
  }

  try {
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'esign-status', 120, 60 * 1000);

    const { userId } = await verifySupabaseToken(req);

    const query = req.query || {};
    const submissionId = typeof query.submissionId === 'string' ? query.submissionId.trim() : '';
    const documentId = typeof query.documentId === 'string' ? query.documentId.trim() : '';

    if (!submissionId && !documentId) {
      return res.status(400).json({ ok: false, error: 'submissionId or documentId query param is required.' });
    }

    let filter;
    if (submissionId) {
      filter = `docuseal_submission_id=eq.${encodeURIComponent(submissionId)}&user_id=eq.${encodeURIComponent(userId)}`;
    } else {
      filter = `document_id=eq.${encodeURIComponent(documentId)}&user_id=eq.${encodeURIComponent(userId)}`;
    }

    const dbRes = await supa(
      `signature_requests?${filter}&select=*&order=created_at.desc&limit=20`
    );
    if (!dbRes.ok) {
      const text = await dbRes.text().catch(() => '');
      console.error('[esign-status] DB error:', dbRes.status, text.slice(0, 200));
      return res.status(502).json({ ok: false, error: 'Database error.' });
    }

    const rows = await dbRes.json().catch(() => []);
    if (!Array.isArray(rows)) {
      return res.status(502).json({ ok: false, error: 'Unexpected database response.' });
    }

    if (submissionId) {
      // Single request lookup.
      const row = rows[0] || null;
      if (!row) {
        return res.status(404).json({ ok: false, error: 'Signature request not found.' });
      }
      return res.status(200).json({
        ok: true,
        signatureRequest: {
          ...row,
          overallStatus: deriveOverallStatus(row),
        },
      });
    }

    // All requests for a document — return list.
    return res.status(200).json({
      ok: true,
      signatureRequests: rows.map((r) => ({
        ...r,
        overallStatus: deriveOverallStatus(r),
      })),
      // Convenience: latest overall status for the badge.
      latestStatus: rows.length > 0 ? deriveOverallStatus(rows[0]) : null,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.status || 401).json({ ok: false, error: error.message });
    }
    if (error instanceof RateLimitError) {
      if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: 'Too many requests. Try again later.' });
    }
    console.error('[esign-status] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not fetch signature status.' });
  }
};
