// /api/jarvis-future-builds-create.js
// POST: create a new future build idea
// Auth: Bearer JWT token (Heath only for manual creation)

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const config = { api: { bodyParser: true }, maxDuration: 10 };

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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

    const { title, description, source, score, prerequisite, source_doc_path, bridges_personal_assistant } = req.body;
    if (!title || !source) {
      return res.status(400).json({ error: 'Missing required fields: title, source' });
    }

    const { data: build, error } = await supabase
      .from('jarvis_future_builds')
      .insert([
        {
          tenant_id: auth.user_id,
          title,
          description: description || null,
          source,
          score: score || null,
          prerequisite: prerequisite || null,
          source_doc_path: source_doc_path || null,
          bridges_personal_assistant: bridges_personal_assistant || false,
          status: 'idea',
        },
      ])
      .select();

    if (error) throw error;

    return res.status(201).json({ ok: true, build: build[0] });
  } catch (err) {
    console.error('[jarvis-future-builds-create]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
