// /api/jarvis-future-builds-update.js
// PATCH: update status, score, description, or archive an idea
// Auth: Bearer JWT (Heath only for status changes)

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const config = { api: { bodyParser: true }, maxDuration: 10 };

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

async function authorizeHealthTenant(req) {
  const auth = req.headers.authorization;
  if (!auth) return { ok: false, status: 401, error: 'Missing Authorization header' };

  const token = auth.replace('Bearer ', '');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return { ok: false, status: 401, error: 'Invalid token' };
    return { ok: true, user_id: user.id };
  } catch (err) {
    return { ok: false, status: 401, error: err.message };
  }
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).json({});

  const auth = await authorizeHealthTenant(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { id, status, score, description, archived } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'Missing build id' });
    }

    const updateBody = {
      updated_at: new Date().toISOString(),
    };

    if (status !== undefined) updateBody.status = status;
    if (score !== undefined) updateBody.score = score;
    if (description !== undefined) updateBody.description = description;
    if (archived === true) updateBody.archived_at = new Date().toISOString();

    const { data: result, error } = await supabase
      .from('jarvis_future_builds')
      .update(updateBody)
      .eq('id', id)
      .select();

    if (error) throw error;

    return res.status(200).json({ ok: true, build: result[0] });
  } catch (err) {
    console.error('[jarvis-future-builds-update]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
