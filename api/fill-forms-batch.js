// Vercel Serverless Function: /api/fill-forms-batch
// Fills multiple TREC forms in one call.
// Takes a forms array and transaction context, returns all PDFs.
//
// POST {
//   transaction_id: string,
//   forms: ['resale-contract', 'financing-addendum', 'hoa-addendum', 'lead-paint-addendum'],
//   field_values: { buyer_name, seller_name, ... }
// }
// Returns: { ok: true, pdfs: [{ form_type, pdf_url, documentId }, ...] }
//
// Authorization: Bearer <supabase user JWT>

const fetch = require('node-fetch');

const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { checkRateLimit, RateLimitError, clientIpFromReq } = require('./_middleware/rateLimit');

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  if (!origin) return true;
  let allowOrigin = null;
  if (
    ALLOWED_ORIGINS.has(origin) ||
    LOCALHOST_ORIGIN_RE.test(origin) ||
    VERCEL_PREVIEW_RE.test(origin)
  ) {
    allowOrigin = origin;
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin);
}

module.exports = async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  const ip = clientIpFromReq(req);
  try {
    await checkRateLimit(ip, 'fill-forms-batch', 10, 60 * 60 * 1000);
    const { userId } = await verifySupabaseToken(req);

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    const transactionId = sanitizeString(body.transaction_id, { maxLength: 200 });
    const forms = Array.isArray(body.forms) ? body.forms : [];
    const fieldValues = (body.field_values && typeof body.field_values === 'object') ? body.field_values : {};
    const strictValidate = body.strict_validate === true;
    const intake = (body.intake && typeof body.intake === 'object') ? body.intake : null;
    const sourceMessage = typeof body.source_message === 'string' ? body.source_message : null;

    if (!transactionId) throw new ValidationError('transaction_id is required.');
    if (!forms || forms.length === 0) throw new ValidationError('forms array is required and must not be empty.');

    // Call /api/fill-form for each form
    const results = [];
    const baseUrl = req.headers['x-forwarded-proto'] ? `${req.headers['x-forwarded-proto']}://${req.headers['x-forwarded-host']}` : 'https://meetdossie.com';

    for (const formType of forms) {
      const fillUrl = `${baseUrl}/api/fill-form`;
      const fillReq = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': req.headers.authorization || ''
        },
        body: JSON.stringify({
          transaction_id: transactionId,
          form_type: formType,
          field_values: fieldValues,
          // Forward strict_validate only when the form supports it (TREC 20-18 resale).
          // /api/fill-form is the gate — it ignores the flag for non-supported form types.
          strict_validate: strictValidate && formType === 'resale-contract',
          intake: strictValidate && formType === 'resale-contract' ? intake : undefined,
          source_message: strictValidate && formType === 'resale-contract' ? sourceMessage : undefined,
        })
      };

      try {
        const fillRes = await fetch(fillUrl, fillReq);
        const fillData = await fillRes.json();

        if (fillData.ok) {
          // fill-form returns `signedUrl` — carry it forward as pdf_url so the
          // client and the allSuccess check both see it. Also preserve the raw
          // signedUrl key for callers that ask for it.
          results.push({
            form_type: formType,
            pdf_url: fillData.signedUrl || fillData.pdf_url || null,
            signedUrl: fillData.signedUrl || null,
            documentId: fillData.documentId,
            storagePath: fillData.storagePath
          });
        } else {
          console.warn(`[fill-forms-batch] ${formType} failed:`, fillData.error);
          results.push({
            form_type: formType,
            ok: false,
            error: fillData.error
          });
        }
      } catch (e) {
        console.error(`[fill-forms-batch] ${formType} exception:`, e.message);
        results.push({
          form_type: formType,
          ok: false,
          error: 'Failed to fill form: ' + e.message
        });
      }
    }

    // Check if all succeeded
    const allSuccess = results.every(r => r.pdf_url || !r.form_type); // accept if pdf_url exists
    if (!allSuccess) {
      const failures = results.filter(r => !r.pdf_url).map(r => r.form_type);
      return res.status(500).json({
        ok: false,
        error: `Failed to fill some forms: ${failures.join(', ')}`,
        results: results
      });
    }

    return res.status(200).json({
      ok: true,
      pdfs: results
    });

  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err instanceof AuthError) {
      return res.status(err.status || 401).json({ ok: false, error: err.message });
    }
    if (err instanceof RateLimitError) {
      return res.status(429).json({ ok: false, error: err.message, resetAt: err.resetAt });
    }

    console.error('[fill-forms-batch] Unexpected error:', err);
    res.status(500).json({ ok: false, error: 'Internal server error.' });
  }
};
