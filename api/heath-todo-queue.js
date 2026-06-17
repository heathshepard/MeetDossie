// Vercel Serverless Function: /api/heath-todo-queue
//
// POST — Cole (or any agent) queues a new personal action item for Heath.
// Shows up on the Jarvis HUD one-at-a-time via /api/heath-todo-next.
//
// Auth: Bearer ${CRON_SECRET} (agents have it locally; this is server-only).
//
// Body:
//   {
//     title: "Text Lisa Nilsson from your phone",   // required, <= 200 chars
//     detail?: "Long instructions / copy-paste body",
//     action_type?: "sms" | "email" | "approve" | "decision" | "install" | "other",
//     priority?: 1-5 (default 3),
//     deadline?: ISO-8601 string,
//     venture?: "dossie" | "paralegal" | "personal-agents" | "shepard-ventures" | "general",
//     metadata?: { ... },
//     created_by?: "cole" | "jarvis" | "atlas" | "carter" | "sage" | "pierce" | "hadley" | ...
//   }
//
// Returns:
//   200 { ok: true, id, created_at }
//   400 on validation error
//   401 on bad auth
//
// Owner: Atlas (SV-ENG-HEATH-TODO / 2026-06-17)

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const VALID_ACTION_TYPES = new Set(['sms','email','approve','decision','install','other']);
const VALID_VENTURES = new Set(['dossie','paralegal','personal-agents','shepard-ventures','general']);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
}

function checkAuth(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return false;
  return !!CRON_SECRET && h.slice('Bearer '.length).trim() === CRON_SECRET;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase env not configured' });
  }
  if (!checkAuth(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {
      return res.status(400).json({ ok: false, error: 'invalid JSON body' });
    }
  }
  body = body || {};

  const title = String(body.title || '').trim();
  if (!title || title.length > 200) {
    return res.status(400).json({ ok: false, error: 'title required, max 200 chars' });
  }

  const detail = body.detail != null ? String(body.detail) : null;

  const action_type = body.action_type ? String(body.action_type).toLowerCase().trim() : 'other';
  if (!VALID_ACTION_TYPES.has(action_type)) {
    return res.status(400).json({ ok: false, error: `invalid action_type. must be one of: ${[...VALID_ACTION_TYPES].join(', ')}` });
  }

  const priority = Number.isFinite(body.priority) ? Math.floor(body.priority) : 3;
  if (priority < 1 || priority > 5) {
    return res.status(400).json({ ok: false, error: 'priority must be 1-5' });
  }

  let deadline = null;
  if (body.deadline) {
    const d = new Date(body.deadline);
    if (Number.isNaN(d.getTime())) {
      return res.status(400).json({ ok: false, error: 'deadline must be a valid ISO-8601 timestamp' });
    }
    deadline = d.toISOString();
  }

  const venture = body.venture ? String(body.venture).toLowerCase().trim() : 'general';
  if (!VALID_VENTURES.has(venture)) {
    return res.status(400).json({ ok: false, error: `invalid venture. must be one of: ${[...VALID_VENTURES].join(', ')}` });
  }

  const created_by = body.created_by ? String(body.created_by).toLowerCase().trim().slice(0, 40) : 'cole';
  const metadata = (body.metadata && typeof body.metadata === 'object') ? body.metadata : {};

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data, error } = await supabase
    .from('heath_todo')
    .insert({
      title,
      detail,
      action_type,
      priority,
      deadline,
      venture,
      created_by,
      metadata,
    })
    .select('id, created_at')
    .single();

  if (error) {
    return res.status(500).json({ ok: false, error: `insert failed: ${error.message}` });
  }

  return res.status(200).json({
    ok: true,
    id: data.id,
    created_at: data.created_at,
    priority,
    action_type,
    venture,
  });
};
