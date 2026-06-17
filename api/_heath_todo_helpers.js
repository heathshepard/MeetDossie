// Shared helpers for /api/heath-todo-* endpoints.
//
// - authorizeHeath(req, supabase): Bearer JWT must belong to heath.shepard@kw.com.
//   CRON_SECRET also accepted (so Cole/agents can drive the HUD via cron too).
// - pickNext(supabase): the picker. Reads heath_todo_ready view, returns the
//   single highest-priority oldest item, or null. Includes computed age_minutes.
//
// Owner: Atlas (SV-ENG-HEATH-TODO / 2026-06-17)

const CRON_SECRET = process.env.CRON_SECRET;
const ALLOWED_EMAIL = 'heath.shepard@kw.com';

async function authorizeHeath(req, supabase) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'no token' };
  }
  const token = h.slice('Bearer '.length).trim();

  if (CRON_SECRET && token === CRON_SECRET) {
    return { ok: true, principal: 'cron' };
  }

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return { ok: false, status: 401, error: 'invalid token' };
  }
  if (user.email !== ALLOWED_EMAIL) {
    return { ok: false, status: 403, error: 'forbidden — not heath' };
  }
  return { ok: true, principal: 'heath' };
}

// Returns the next item Heath should see, or null. Shape matches the HUD contract:
//   { id, title, detail, action_type, priority, deadline, venture, age_minutes }
async function pickNext(supabase) {
  const { data, error } = await supabase
    .from('heath_todo_ready')
    .select('id, title, detail, action_type, priority, deadline, venture, created_at, created_by, metadata')
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(1);

  if (error) throw new Error(`pickNext failed: ${error.message}`);
  if (!data || data.length === 0) return null;

  const row = data[0];
  const age_minutes = Math.max(
    0,
    Math.round((Date.now() - new Date(row.created_at).getTime()) / 60000)
  );

  return {
    id: row.id,
    title: row.title,
    detail: row.detail,
    action_type: row.action_type,
    priority: row.priority,
    deadline: row.deadline,
    venture: row.venture,
    created_by: row.created_by,
    age_minutes,
  };
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
}

module.exports = { authorizeHeath, pickNext, cors };
