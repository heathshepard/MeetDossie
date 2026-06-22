// Vercel Serverless Function: /api/heath-actions-create
//
// POST — Creates a new action item for Heath to complete.
// Called by orchestrator agents (Cole/Atlas/Hadley/etc) via:
// POST /api/heath-actions-create
// { title, body, source, priority, deadline, evidence_url }
//
// Auth: Bearer JWT (heath.shepard@kw.com) OR Bearer ${CRON_SECRET}.
//
// Returns:
//   200 { ok: true, id: UUID }
//   400 { ok: false, error: "..." }

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function authorizeHealthTenant(req, supabase) {
  corsHeaders({
    setHeader: () => {},
  });

  const auth = req.headers.authorization;
  if (!auth) return { ok: false, status: 401, error: 'Missing Authorization header' };

  const token = auth.replace('Bearer ', '');

  // Check if it's CRON_SECRET
  if (token === CRON_SECRET) {
    return { ok: true, user_id: 'system' }; // system actions bypass tenant check
  }

  // Verify JWT
  try {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user) return { ok: false, status: 401, error: 'Invalid token' };
    return { ok: true, user_id: user.id };
  } catch (err) {
    return { ok: false, status: 401, error: err.message };
  }
}

module.exports = async function handler(req, res) {
  corsHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase env not configured' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const auth = await authorizeHealthTenant(req, supabase);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  try {
    const { title, body, source, priority, deadline, evidence_url } = req.body || {};

    if (!title || !source) {
      return res.status(400).json({ ok: false, error: 'title and source are required' });
    }

    // Get Heath's user_id
    const { data: heath_user } = await supabase
      .from('auth.users')
      .select('id')
      .eq('email', 'heath.shepard@kw.com')
      .single();

    if (!heath_user) {
      return res.status(400).json({ ok: false, error: 'Heath user not found' });
    }

    const tenant_id = heath_user.id;

    // Insert the action
    const { data, error } = await supabase.from('heath_actions').insert({
      tenant_id,
      title,
      body: body || null,
      source,
      priority: priority || 'whenever',
      deadline: deadline || null,
      status: 'pending',
      evidence_url: evidence_url || null,
    });

    if (error) throw error;

    // Get the inserted ID from the response
    const { data: inserted, error: fetchErr } = await supabase
      .from('heath_actions')
      .select('id')
      .eq('tenant_id', tenant_id)
      .eq('title', title)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (fetchErr) throw fetchErr;

    return res.status(200).json({ ok: true, id: inserted.id });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
