// Vercel Serverless Function: /api/member-form-templates
//
// A member's own brokerage/standard PDF forms — stored once at the member
// level (not tied to one transaction), attachable and sendable on any
// dossier. See supabase/migrations/20260921_member_form_templates.sql for
// the "why" (Heath's KW City View CMA Acknowledgement, the localStorage-only
// bug it replaces).
//
// GET    ?scope=list                      -> list the caller's own templates
// POST   { action: 'upload_url', fileName, fileType }
//                                          -> signed PUT URL for a NEW template's PDF
// POST   { action: 'create', label, fileName, fileType, fileSize, storagePath }
//                                          -> insert the row once the PUT above succeeds
// PATCH  { id, label? }                    -> rename
// DELETE ?id=<uuid>                        -> remove one (Storage object + row)
//
// Authorization: Bearer <supabase user JWT>. user_id is ALWAYS derived from
// the verified session, never accepted as a request parameter — same rule
// as api/_lib/member-memory.js and the 2026-09-17 impersonation-bug fix.

const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { checkRateLimit, RateLimitError, clientIpFromReq } = require('./_middleware/rateLimit');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'documents';
const ALLOWED_EXT = /\.(pdf|doc|docx|jpg|jpeg|png)$/i;

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
    if (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN_RE.test(origin) || origin.endsWith('.vercel.app') || origin.endsWith('.meetdossie.com')) {
      allowOrigin = origin;
    }
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin) || !origin;
}

function sanitizeFileName(name) {
  const cleaned = sanitizeString(name, { maxLength: 200 }) || '';
  const safe = cleaned
    .replace(/[\\/]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/[^A-Za-z0-9._\-\s()]/g, '_')
    .trim();
  return safe.length > 0 ? safe : 'document';
}

// Cleaned display name from a filename: "KWCV_CMA_Ack_4-21.pdf" -> "KWCV CMA Ack 4-21".
function deriveLabelFromFileName(fileName) {
  const base = String(fileName || '').replace(/\.[A-Za-z0-9]+$/, '');
  return base.replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled form';
}

async function supa(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
}

async function supabaseStorageSignedPutUrl(storagePath, expiresInSeconds = 3600) {
  const url = `${SUPABASE_URL}/storage/v1/object/upload/sign/${BUCKET}/${storagePath}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: expiresInSeconds }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Failed to generate PUT URL (${response.status}): ${text.slice(0, 300)}`);
  }
  const json = await response.json().catch(() => null);
  const signedPath = json && (json.url || json.signedURL || json.path);
  if (!signedPath) throw new Error(`No signed URL in response. Got: ${JSON.stringify(json).slice(0, 200)}`);
  const path = signedPath.startsWith('/') ? signedPath : `/${signedPath}`;
  return { fullUrl: `${SUPABASE_URL}/storage/v1${path}`, token: json.token };
}

async function removeStorageObject(storagePath) {
  if (!storagePath) return true;
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  return response.ok || response.status === 404;
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (!corsAllowed) return res.status(403).json({ ok: false, error: 'Origin not allowed.' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Storage is not configured.' });
  }

  try {
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'member-form-templates', 60, 60 * 60 * 1000);

    const { userId } = await verifySupabaseToken(req);
    const safeUid = encodeURIComponent(userId);

    if (req.method === 'GET') {
      const listResp = await supa(`member_form_templates?user_id=eq.${safeUid}&select=*&order=created_at.desc`);
      if (!listResp.ok) throw new Error(`list failed (${listResp.status})`);
      const rows = await listResp.json();
      return res.status(200).json({ ok: true, templates: Array.isArray(rows) ? rows : [] });
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      body = body || {};
      const action = sanitizeString(body.action, { maxLength: 30 });

      if (action === 'upload_url') {
        const fileNameRaw = body.fileName;
        if (!fileNameRaw || typeof fileNameRaw !== 'string') throw new ValidationError('fileName is required');
        const fileName = sanitizeFileName(fileNameRaw);
        if (!ALLOWED_EXT.test(fileName)) throw new ValidationError('Unsupported file type. Allowed: pdf, doc, docx, jpg, png');
        const storagePath = `${userId}/member-forms/${Date.now()}-${fileName}`;
        const { fullUrl, token } = await supabaseStorageSignedPutUrl(storagePath, 3600);
        return res.status(200).json({
          ok: true,
          url: fullUrl,
          token,
          storagePath,
          fileType: sanitizeString(body.fileType, { maxLength: 200 }) || 'application/octet-stream',
          suggestedLabel: deriveLabelFromFileName(fileName),
        });
      }

      if (action === 'create') {
        const storagePath = sanitizeString(body.storagePath, { maxLength: 500 });
        if (!storagePath || !storagePath.startsWith(`${userId}/member-forms/`)) {
          throw new ValidationError('storagePath is required and must belong to this member.');
        }
        const label = sanitizeString(body.label, { maxLength: 200 }) || deriveLabelFromFileName(body.fileName);
        const payload = {
          user_id: userId,
          label,
          description: sanitizeString(body.description, { maxLength: 2000 }) || null,
          file_name: sanitizeString(body.fileName, { maxLength: 300 }) || null,
          file_type: sanitizeString(body.fileType, { maxLength: 200 }) || null,
          file_size: Number.isFinite(Number(body.fileSize)) ? Number(body.fileSize) : null,
          storage_path: storagePath,
        };
        const insertResp = await supa('member_form_templates', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify(payload),
        });
        if (!insertResp.ok) {
          const text = await insertResp.text().catch(() => '');
          throw new Error(`insert failed (${insertResp.status}): ${text.slice(0, 300)}`);
        }
        const rows = await insertResp.json();
        return res.status(200).json({ ok: true, template: Array.isArray(rows) ? rows[0] : rows });
      }

      if (action === 'migrate_legacy_labels') {
        // One-time client-side migration path: carry over label-only rows
        // from the old localStorage flow (dossie_broker_docs) so nobody
        // loses what they'd already typed. storage_path stays null — these
        // are placeholders until the member attaches a real file.
        const labels = Array.isArray(body.labels) ? body.labels.slice(0, 50) : [];
        const created = [];
        for (const item of labels) {
          const label = sanitizeString(item && item.label, { maxLength: 200 });
          if (!label) continue;
          const payload = {
            user_id: userId,
            label,
            description: sanitizeString(item && item.description, { maxLength: 2000 }) || null,
            storage_path: null,
          };
          const insertResp = await supa('member_form_templates', {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify(payload),
          });
          if (insertResp.ok) {
            const rows = await insertResp.json();
            created.push(Array.isArray(rows) ? rows[0] : rows);
          }
        }
        return res.status(200).json({ ok: true, migrated: created.length, templates: created });
      }

      throw new ValidationError('Unknown action.');
    }

    if (req.method === 'PATCH') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      body = body || {};
      const id = sanitizeString(body.id, { maxLength: 200 });
      if (!id) throw new ValidationError('id is required.');
      const updates = {};
      if (body.label != null) updates.label = sanitizeString(body.label, { maxLength: 200 });
      if (body.description != null) updates.description = sanitizeString(body.description, { maxLength: 2000 });
      updates.updated_at = new Date().toISOString();
      const patchResp = await supa(`member_form_templates?id=eq.${encodeURIComponent(id)}&user_id=eq.${safeUid}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(updates),
      });
      if (!patchResp.ok) throw new Error(`update failed (${patchResp.status})`);
      const rows = await patchResp.json();
      return res.status(200).json({ ok: true, template: Array.isArray(rows) ? rows[0] : rows });
    }

    if (req.method === 'DELETE') {
      const id = sanitizeString(req.query && req.query.id, { maxLength: 200 });
      if (!id) throw new ValidationError('id query param required.');
      const getResp = await supa(`member_form_templates?id=eq.${encodeURIComponent(id)}&user_id=eq.${safeUid}&select=storage_path`);
      const rows = getResp.ok ? await getResp.json().catch(() => []) : [];
      const row = Array.isArray(rows) ? rows[0] : null;
      if (row && row.storage_path) await removeStorageObject(row.storage_path);
      const delResp = await supa(`member_form_templates?id=eq.${encodeURIComponent(id)}&user_id=eq.${safeUid}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' },
      });
      if (!delResp.ok) throw new Error(`delete failed (${delResp.status})`);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  } catch (error) {
    if (error instanceof AuthError) return res.status(error.status || 401).json({ ok: false, error: error.message });
    if (error instanceof ValidationError) return res.status(error.status || 400).json({ ok: false, error: error.message });
    if (error instanceof RateLimitError) {
      if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: 'Too many requests. Try again later.' });
    }
    console.error('[member-form-templates] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not process that request.' });
  }
};
