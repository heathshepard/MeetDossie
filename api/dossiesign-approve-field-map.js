/**
 * api/dossiesign-approve-field-map.js
 *
 * POST /api/dossiesign-approve-field-map
 * {
 *   "job_id": "uuid"
 * }
 *
 * Takes the approved fields from dossiesign_auto_map_runs, creates a DocuSeal
 * template, and saves the template_id back.
 *
 * Auth: Bearer <supabase user JWT>. User must own the job or be admin.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const DOCUSEAL_API_URL = 'https://api.docuseal.co';

async function createDocuSealTemplate(pdfUrl, fields) {
  // Convert Dossie field map to DocuSeal template format
  const docusealFields = fields.map((f) => {
    const typeMap = {
      text: 'text',
      checkbox: 'checkbox',
      date: 'date',
      signature: 'signature',
    };

    return {
      uuid: f.id,
      name: f.name,
      type: typeMap[f.type] || 'text',
      x: f.x_pct,
      y: f.y_pct,
      width: f.w_pct,
      height: f.h_pct,
      page: f.page,
      required: f.required !== false,
    };
  });

  const payload = {
    name: 'Auto-mapped Document',
    pdf_url: pdfUrl,
    fields: docusealFields,
  };

  return new Promise((resolve, reject) => {
    const url = new URL(`${DOCUSEAL_API_URL}/api/v1/templates`);
    const postData = JSON.stringify(payload);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': postData.length,
        'Authorization': `Bearer ${DOCUSEAL_API_KEY}`,
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(`DocuSeal API error ${res.statusCode}: ${json.error || data}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse DocuSeal response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('DocuSeal API timeout'));
    });

    req.write(postData);
    req.end();
  });
}

async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed. Use POST.' });
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

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  body = body || {};

  const jobId = body.job_id;

  if (!jobId) {
    return res.status(400).json({ ok: false, error: 'job_id required' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  try {
    // Fetch the existing row
    const { data, error: fetchErr } = await supabase
      .from('dossiesign_auto_map_runs')
      .select('id, fields, pdf_url, created_by')
      .eq('id', jobId)
      .maybeSingle();

    if (fetchErr) {
      return res.status(500).json({ ok: false, error: fetchErr.message });
    }

    if (!data) {
      return res.status(404).json({ ok: false, error: 'Job not found' });
    }

    // Auth check
    const isAdmin = user.email === 'heath.shepard@kw.com';
    if (data.created_by && data.created_by !== user.id && !isAdmin) {
      return res.status(403).json({ ok: false, error: 'Unauthorized' });
    }

    if (!data.fields || data.fields.length === 0) {
      return res.status(400).json({ ok: false, error: 'No fields to approve' });
    }

    if (!data.pdf_url) {
      return res.status(400).json({ ok: false, error: 'No PDF URL found' });
    }

    // Create DocuSeal template
    const templateResult = await createDocuSealTemplate(data.pdf_url, data.fields);
    const templateId = templateResult.uuid || templateResult.id;

    if (!templateId) {
      return res.status(500).json({ ok: false, error: 'DocuSeal template creation failed' });
    }

    // Update the row with template_id and approve status
    // Note: dossiesign_auto_map_runs has no updated_at column; qa_reviewed_at
    // records when the map was signed off.
    const { error: updateErr } = await supabase
      .from('dossiesign_auto_map_runs')
      .update({
        template_id: templateId,
        qa_status: 'approved',
        qa_reviewed_at: new Date().toISOString(),
        qa_reviewed_by: user.id,
      })
      .eq('id', jobId);

    if (updateErr) {
      return res.status(500).json({ ok: false, error: updateErr.message });
    }

    return res.status(200).json({
      ok: true,
      job_id: jobId,
      template_id: templateId,
      status: 'approved',
    });
  } catch (err) {
    console.error('[dossiesign-approve-field-map]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = handler;
