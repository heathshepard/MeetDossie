// /api/jarvis-future-builds-list.js
// GET: list all non-archived future builds for tenant, grouped by status
// Auth: Bearer JWT

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const config = { api: { bodyParser: true }, maxDuration: 10 };

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
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

    // List all non-archived builds for this tenant
    const { data: builds, error } = await supabase
      .from('jarvis_future_builds')
      .select('*')
      .eq('tenant_id', auth.user_id)
      .is('archived_at', null)
      .order('status', { ascending: true })
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Group by status
    const grouped = {
      idea: [],
      queued: [],
      dod_drafting: [],
      building: [],
      shipped: [],
      rejected: [],
    };

    (builds || []).forEach((b) => {
      if (grouped.hasOwnProperty(b.status)) {
        grouped[b.status].push(b);
      }
    });

    return res.status(200).json({
      ok: true,
      counts: Object.entries(grouped).reduce((acc, [k, v]) => {
        acc[k] = v.length;
        return acc;
      }, {}),
      builds: grouped,
    });
  } catch (err) {
    console.error('[jarvis-future-builds-list]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
