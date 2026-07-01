/**
 * api/admin-dossiesign-auto-map-preview.js
 * 
 * GET /api/admin-dossiesign-auto-map-preview?limit=10&offset=0
 * 
 * Returns the last N auto-map run records with their field counts + QA status.
 * Used by frontend admin preview UI (full HTML view is a follow-up).
 * 
 * Response:
 * {
 *   "ok": true,
 *   "runs": [
 *     {
 *       "id": "uuid",
 *       "doc_name": "TREC 25-17 Farm & Ranch",
 *       "vertical": "land",
 *       "field_count": 348,
 *       "page_count": 12,
 *       "qa_status": "pending" | "approved" | "rejected",
 *       "created_at": "ISO timestamp",
 *       "model_cost_usd": "1.02"
 *     },
 *     ...
 *   ],
 *   "total": 42
 * }
 * 
 * Auth: Bearer $CRON_SECRET (admin-only in v1).
 */

const { createClient } = require('@supabase/supabase-js');

const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function isAuthed(req) {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  return Boolean(CRON_SECRET) && h === `Bearer ${CRON_SECRET}`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (!isAuthed(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed. Use GET.' });
  }

  const limit = Math.min(parseInt(req.query.limit || '10'), 100);
  const offset = Math.max(parseInt(req.query.offset || '0'), 0);
  const qaStatusFilter = req.query.qa_status; // optional filter

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // Fetch total count
    let countQuery = supabase
      .from('dossiesign_auto_map_runs')
      .select('id', { count: 'exact', head: true });

    if (qaStatusFilter) {
      countQuery = countQuery.eq('qa_status', qaStatusFilter);
    }

    const { count: total } = await countQuery;

    // Fetch records
    let dataQuery = supabase
      .from('dossiesign_auto_map_runs')
      .select(
        'id, doc_name, vertical, field_count, page_count, qa_status, created_at, model_cost_cents, template_id'
      )
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (qaStatusFilter) {
      dataQuery = dataQuery.eq('qa_status', qaStatusFilter);
    }

    const { data: runs, error } = await dataQuery;

    if (error) {
      console.error('[admin-dossiesign-auto-map-preview] Query error:', error);
      return res.status(500).json({ ok: false, error: 'Database query failed' });
    }

    return res.status(200).json({
      ok: true,
      runs: (runs || []).map(r => ({
        id: r.id,
        doc_name: r.doc_name,
        vertical: r.vertical,
        field_count: r.field_count,
        page_count: r.page_count,
        qa_status: r.qa_status,
        template_id: r.template_id,
        created_at: r.created_at,
        model_cost_usd: r.model_cost_cents ? (r.model_cost_cents / 100).toFixed(2) : '0.00',
      })),
      total,
      limit,
      offset,
    });

  } catch (e) {
    console.error('[admin-dossiesign-auto-map-preview]', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
