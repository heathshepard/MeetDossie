/**
 * api/dossiesign-fetch-field-map.js
 *
 * GET /api/dossiesign-fetch-field-map?job_id=<uuid>
 *
 * Fetches the current field map and returns:
 * {
 *   "ok": true,
 *   "job_id": "uuid",
 *   "status": "awaiting_hadley_qa|in_progress|approved",
 *   "fields": [...],
 *   "pdf_signed_url": "https://storage.supabase.co/...",
 *   "page_count": 3,
 *   "doc_name": "Contract"
 * }
 *
 * Auth: Bearer <supabase user JWT>. User can only fetch their own maps.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const BUCKET = 'documents';

async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed. Use GET.' });
  }

  const jobId = req.query.job_id;
  if (!jobId) {
    return res.status(400).json({ ok: false, error: 'job_id query param required' });
  }

  let user;
  try {
    user = await verifySupabaseToken(req);
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(err.statusCode).json({ ok: false, error: err.message });
    }
    return res.status(500).json({ ok: false, error: 'Auth error' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  try {
    // Fetch the auto-map run
    const { data, error } = await supabase
      .from('dossiesign_auto_map_runs')
      .select('id, fields, pdf_url, page_count, doc_name, qa_status, created_by')
      .eq('id', jobId)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    if (!data) {
      return res.status(404).json({ ok: false, error: 'Job not found' });
    }

    // Auth check: only created_by user or admin can fetch
    const isAdmin = user.email === 'heath.shepard@kw.com';
    if (data.created_by && data.created_by !== user.id && !isAdmin) {
      return res.status(403).json({ ok: false, error: 'Unauthorized' });
    }

    // Generate signed URL for the PDF if available
    let pdfSignedUrl = null;
    if (data.pdf_url) {
      try {
        const anonSupabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        const { data: signedData } = await anonSupabase
          .storage
          .from(BUCKET)
          .createSignedUrl(data.pdf_url.split(`/${BUCKET}/`)[1], 3600);
        pdfSignedUrl = signedData?.signedUrl || null;
      } catch (e) {
        // Fallback: return the raw URL if signing fails
        pdfSignedUrl = data.pdf_url;
      }
    }

    return res.status(200).json({
      ok: true,
      job_id: data.id,
      status: data.qa_status,
      fields: data.fields || [],
      pdf_url: pdfSignedUrl,
      page_count: data.page_count,
      doc_name: data.doc_name,
    });
  } catch (err) {
    console.error('[dossiesign-fetch-field-map]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = handler;
