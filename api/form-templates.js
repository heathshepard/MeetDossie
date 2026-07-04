// Vercel Serverless Function: /api/form-templates
// GET  — returns active form_templates grouped by category
// POST { action: 'attach', templateId, transactionId } — attaches a blank TREC
//       form to a transaction by inserting a row into public.documents
//
// Authorization: Bearer <supabase user JWT>
//
// ==========================================================================
// SQL — RUN IN SUPABASE SQL EDITOR BEFORE DEPLOYING (already applied)
// ==========================================================================
//
//   CREATE TABLE IF NOT EXISTS public.form_templates (
//     id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//     name            TEXT NOT NULL,
//     short_name      TEXT NOT NULL,
//     category        TEXT NOT NULL,  -- 'purchase', 'addendum', 'disclosure', 'listing', 'lease', 'other'
//     trec_number     TEXT,           -- e.g. '20-16', '24-14'
//     description     TEXT,
//     storage_path    TEXT,           -- path in 'form-templates' bucket, null until PDF uploaded
//     source_url      TEXT,           -- trec.texas.gov direct PDF URL
//     is_active       BOOLEAN NOT NULL DEFAULT true,
//     created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
//   );
//
//   CREATE INDEX IF NOT EXISTS idx_ft_category ON public.form_templates(category);
//   ALTER TABLE public.form_templates ENABLE ROW LEVEL SECURITY;
//   CREATE POLICY "auth_read" ON public.form_templates FOR SELECT USING (auth.role() = 'authenticated');
//   CREATE POLICY "service_all" ON public.form_templates FOR ALL USING (auth.role() = 'service_role');
//
//   -- Extra columns added to public.documents:
//   ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS source_url TEXT;
//   ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS form_template_id UUID REFERENCES public.form_templates(id) ON DELETE SET NULL;
//   ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS status TEXT;
//
// ==========================================================================

const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  // No origin = same-origin request (browser omits header). Always allow.
  if (!origin) return true;
  let allowOrigin = null;
  if (typeof origin === 'string' && origin.length > 0) {
    if (
      ALLOWED_ORIGINS.has(origin) ||
      LOCALHOST_ORIGIN_RE.test(origin) ||
      VERCEL_PREVIEW_RE.test(origin)
    ) {
      allowOrigin = origin;
    }
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin);
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

// ---------------------------------------------------------------------------
// GET handler — returns all active form_templates grouped by category
// ---------------------------------------------------------------------------
async function handleGet(req, res) {
  const { userId } = await verifySupabaseToken(req);
  if (!userId) throw new AuthError('Not authenticated.');

  const r = await supa(
    'form_templates?is_active=eq.true&order=category.asc,trec_number.asc&select=id,name,short_name,category,trec_number,description,source_url,storage_path'
  );
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`form_templates fetch failed (${r.status}): ${text.slice(0, 200)}`);
  }
  const rows = await r.json();

  const grouped = {};
  for (const row of rows) {
    const cat = row.category || 'other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(row);
  }

  return res.status(200).json({ ok: true, forms: grouped });
}

// ---------------------------------------------------------------------------
// POST action: attach — copies a template into the transaction's documents
// ---------------------------------------------------------------------------
async function handleAttach(req, res, userId) {
  const body = req.body || {};
  const templateId = sanitizeString(body.templateId, { maxLength: 200 });
  const transactionId = sanitizeString(body.transactionId, { maxLength: 200 });

  if (!templateId) throw new ValidationError('templateId is required.');
  if (!transactionId) throw new ValidationError('transactionId is required.');

  // Verify the user owns the transaction.
  const txRes = await supa(
    `transactions?id=eq.${encodeURIComponent(transactionId)}&user_id=eq.${encodeURIComponent(userId)}&select=id`
  );
  if (!txRes.ok) {
    const text = await txRes.text().catch(() => '');
    throw new Error(`transactions fetch failed (${txRes.status}): ${text.slice(0, 200)}`);
  }
  const txRows = await txRes.json();
  if (!Array.isArray(txRows) || txRows.length === 0) {
    throw new ValidationError('Transaction not found or does not belong to you.', 404);
  }

  // Fetch the template row.
  const tmplRes = await supa(
    `form_templates?id=eq.${encodeURIComponent(templateId)}&is_active=eq.true&select=id,name,short_name,trec_number,storage_path,source_url`
  );
  if (!tmplRes.ok) {
    const text = await tmplRes.text().catch(() => '');
    throw new Error(`form_templates fetch failed (${tmplRes.status}): ${text.slice(0, 200)}`);
  }
  const tmplRows = await tmplRes.json();
  if (!Array.isArray(tmplRows) || tmplRows.length === 0) {
    throw new ValidationError('Form template not found.', 404);
  }
  const template = tmplRows[0];

  // Insert a document row.
  // NOTE (2026-07-04): file_type + storage_path are NOT NULL in the documents
  // schema. Blank template attachments have no uploaded file yet, so we stamp
  // a stable placeholder storage_path derived from the template id — the
  // fill-form pipeline reads storage_path only when status !== 'blank', so
  // the placeholder is inert until a rendered PDF replaces it.
  const docRow = {
    user_id: userId,
    transaction_id: transactionId,
    file_name: `${template.name}.pdf`,
    file_type: 'application/pdf',
    document_type: 'form_template',
    storage_path: template.storage_path || `template/${template.id}.pdf`,
    source_url: template.source_url || null,
    form_template_id: template.id,
    status: 'blank',
  };

  const insertRes = await supa('documents', {
    method: 'POST',
    body: JSON.stringify(docRow),
  });
  if (!insertRes.ok) {
    const text = await insertRes.text().catch(() => '');
    throw new Error(`documents insert failed (${insertRes.status}): ${text.slice(0, 300)}`);
  }
  const inserted = await insertRes.json();
  const newDoc = Array.isArray(inserted) ? inserted[0] : inserted;

  return res.status(200).json({
    ok: true,
    documentId: newDoc?.id || null,
    message: 'Form attached to transaction',
  });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
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
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[form-templates] Supabase not configured.');
    res.status(500).json({ ok: false, error: 'Service not configured.' });
    return;
  }

  try {
    if (req.method === 'GET') {
      return await handleGet(req, res);
    }

    if (req.method === 'POST') {
      const { userId } = await verifySupabaseToken(req);
      const body = req.body || {};
      const action = sanitizeString(body.action, { maxLength: 50 });

      if (action === 'attach') {
        return await handleAttach(req, res, userId);
      }

      throw new ValidationError(`Unknown action: ${action || '(none)'}`);
    }

    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.status || 401).json({ ok: false, error: error.message });
    }
    if (error instanceof ValidationError) {
      return res.status(error.status || 400).json({ ok: false, error: error.message });
    }
    console.error('[form-templates] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'An unexpected error occurred.' });
  }
};
