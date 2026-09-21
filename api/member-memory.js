// Vercel Serverless Function: /api/member-memory
//
// Member-facing surface for Dossie's per-subscriber memory
// (public.member_memory) — what she's learned about THIS member, visible,
// editable, and deletable by them. Required because a memory the member
// can't inspect or correct is a liability, and it's also where a
// source='stated' fact (status='pending_confirmation') gets confirmed or
// rejected before it is ever reused — api/chat.js's load step only ever
// pulls status='active' rows, so this endpoint (or the minimal UI in front
// of it, member-memory.html) is the ONLY path a pending fact has to
// becoming usable.
//
// GET    -> { ok, memories: [...] }               every row the member owns,
//                                                   most recent first
// PATCH  { id, action: 'confirm'|'reject'|'edit'|'reactivate', title?, content?, category? }
//        confirm    -> pending_confirmation fact becomes source='confirmed', status='active'
//        reject     -> any row -> status='retired' (never reused again)
//        reactivate -> a retired row -> status='active' (source unchanged)
//        edit       -> member rewrites title/content/category themselves;
//                       since THEY authored the final wording, it is treated
//                       as confirmed and set active in the same call
// DELETE ?id=...     -> hard delete, no soft-delete fallback (the member
//                       asked Dossie to forget it — status='retired' still
//                       leaves the row on file, which is not what "delete"
//                       promised)
//
// Authorization: Bearer <supabase user JWT>
//
// SECURITY. Every read/write here is scoped to the verified session's
// user_id — never a request parameter. RLS on member_memory backstops this
// independently (auth.uid() = user_id) even though this endpoint uses the
// service-role key, same defense-in-depth shape as api/seller-intake.js.
//
// Owner: Carter, 2026-09-21.

const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { applyCorsHeaders } = require('./_middleware/cors');
const { VALID_CATEGORIES, sbGet, sbPatch, sbDelete } = require('./_lib/member-memory');

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'GET, PATCH, DELETE, OPTIONS' });
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);
  if (req.method === 'OPTIONS') { res.status(corsAllowed ? 204 : 403).end(); return; }
  if (!corsAllowed) { res.status(403).json({ ok: false, error: 'Origin not allowed.' }); return; }
  if (!['GET', 'PATCH', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, PATCH, DELETE, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  try {
    const { userId } = await verifySupabaseToken(req);

    if (req.method === 'GET') {
      const rows = await sbGet(
        `member_memory?select=id,category,title,content,source,status,usage_count,last_used_at,created_at,updated_at` +
        `&user_id=eq.${userId}&order=created_at.desc&limit=200`
      );
      return res.status(200).json({ ok: true, memories: rows || [] });
    }

    if (req.method === 'DELETE') {
      const id = sanitizeString(req.query && req.query.id, { maxLength: 200 });
      if (!id) throw new ValidationError('id is required.');
      // Scope the delete to this user via the filter itself — never trust
      // the id alone. A delete matching zero rows (not theirs / already
      // gone) still returns ok so the UI can treat it as done either way.
      const deleted = await sbDelete(`member_memory?id=eq.${encodeURIComponent(id)}&user_id=eq.${userId}`);
      return res.status(200).json({ ok: true, deleted: Array.isArray(deleted) ? deleted.length : 0 });
    }

    // ------------------------------------------------------------- PATCH
    const body = req.body || {};
    const id = sanitizeString(body.id, { maxLength: 200 });
    const action = sanitizeString(body.action, { maxLength: 20 });
    if (!id) throw new ValidationError('id is required.');
    if (!['confirm', 'reject', 'edit', 'reactivate'].includes(action)) {
      throw new ValidationError('action must be one of: confirm, reject, edit, reactivate.');
    }

    // Prove ownership before writing anything — a PATCH filtered by
    // user_id alone would silently no-op on someone else's row rather than
    // telling the member their edit didn't take.
    const existingRows = await sbGet(`member_memory?id=eq.${encodeURIComponent(id)}&user_id=eq.${userId}&limit=1`);
    const existing = Array.isArray(existingRows) && existingRows[0];
    if (!existing) throw new ValidationError('No such memory.', 404);

    let patch = {};
    if (action === 'confirm') {
      patch = { source: 'confirmed', status: 'active' };
    } else if (action === 'reject') {
      patch = { status: 'retired' };
    } else if (action === 'reactivate') {
      patch = { status: 'active' };
    } else if (action === 'edit') {
      const title = body.title !== undefined ? sanitizeString(body.title, { maxLength: 200 }) : existing.title;
      const content = body.content !== undefined ? sanitizeString(body.content, { maxLength: 4000 }) : existing.content;
      const category = body.category !== undefined && VALID_CATEGORIES.has(body.category) ? body.category : existing.category;
      if (!title || title.length < 3) throw new ValidationError('title is too short.');
      if (!content || content.length < 5) throw new ValidationError('content is too short.');
      // The member wrote or approved this wording themselves, so it is
      // treated as confirmed rather than left pending review of their own
      // edit.
      patch = { title, content, category, source: 'confirmed', status: 'active' };
    }

    const updated = await sbPatch(`member_memory?id=eq.${encodeURIComponent(id)}&user_id=eq.${userId}`, patch);
    const saved = Array.isArray(updated) ? updated[0] : updated;
    return res.status(200).json({ ok: true, memory: saved || null });

  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.status || 401).json({ ok: false, error: error.message });
    }
    if (error instanceof ValidationError) {
      return res.status(error.status || 400).json({ ok: false, error: error.message });
    }
    console.error('[member-memory] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not load your memory. Try again.' });
  }
};
