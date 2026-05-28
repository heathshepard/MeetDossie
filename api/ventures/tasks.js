/**
 * /api/ventures/tasks
 * GET  — list tasks (filter by assigned_to, status, limit)
 * POST — create a new task
 * PATCH — update task status (id in body)
 *
 * Auth: Bearer token via Supabase JWT — heath.shepard@kw.com only.
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Pattern: direct REST fetch with service role key — no supabase-js client.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AUTHORIZED_EMAILS = new Set(['heath.shepard@kw.com', 'heath@meetdossie.com', 'heath.shepard@gmail.com']);

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;
const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function applyCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin) || PREVIEW_RE.test(origin) || LOCAL_RE.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
}

function supa(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
}

async function verifyAuth(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return AUTHORIZED_EMAILS.has(u.email) ? u : null;
}

// Valid agents and statuses — used for input validation
const VALID_AGENTS = new Set(['cole', 'hadley', 'pierce', 'atlas', 'carter', 'sage', 'content_verifier']);
const VALID_STATUSES = new Set(['pending', 'in_progress', 'blocked', 'completed', 'idea', 'in_spec', 'in_build', 'shipped', 'parked']);
const VALID_PRODUCTS = new Set(['dossie', 'paralegal', 'cross']);

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // ---------- GET ----------
  if (req.method === 'GET') {
    const { assigned_to, status, limit = '20', include_planning, completed } = req.query;

    // Build filter string
    let filters = [];

    if (assigned_to && VALID_AGENTS.has(assigned_to)) {
      filters.push(`assigned_to=eq.${encodeURIComponent(assigned_to)}`);
    }

    if (completed === 'true') {
      // Completed history view — return last N completed tasks ordered by completion date
      filters.push('status=eq.completed');
      const qs = [
        'select=id,title,description,status,assigned_to,product,priority,created_at,completed_at,blocked_reason',
        ...filters,
        `limit=${Math.min(Number(limit) || 10, 50)}`,
        'order=completed_at.desc.nullslast',
      ].join('&');
      const r = await supa(`organization_tasks?${qs}`);
      if (!r.ok) {
        const err = await r.text();
        console.error('[ventures/tasks GET completed] supabase error', err);
        return res.status(500).json({ error: 'Failed to fetch completed tasks' });
      }
      const tasks = await r.json();
      return res.status(200).json({ tasks });
    }

    if (status) {
      // status can be comma-separated list for planning view
      const statuses = status.split(',').filter(s => VALID_STATUSES.has(s.trim()));
      if (statuses.length === 1) {
        filters.push(`status=eq.${encodeURIComponent(statuses[0])}`);
      } else if (statuses.length > 1) {
        filters.push(`status=in.(${statuses.map(encodeURIComponent).join(',')})`);
      }
    } else if (!include_planning) {
      // By default show open tasks only (exclude completed + planning-only statuses)
      filters.push('status=in.(pending,in_progress,blocked)');
    }

    const qs = [
      'select=id,title,description,status,assigned_to,product,priority,created_at,completed_at,blocked_reason',
      ...filters,
      `limit=${Math.min(Number(limit) || 20, 100)}`,
      'order=created_at.desc',
    ].join('&');

    const r = await supa(`organization_tasks?${qs}`);
    if (!r.ok) {
      const err = await r.text();
      console.error('[ventures/tasks GET] supabase error', err);
      return res.status(500).json({ error: 'Failed to fetch tasks' });
    }
    const tasks = await r.json();
    return res.status(200).json({ tasks });
  }

  // ---------- POST (create) ----------
  if (req.method === 'POST') {
    let body;
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
    catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

    const { title, description, assigned_to, product, priority, status: reqStatus } = body || {};

    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return res.status(400).json({ error: 'title is required' });
    }
    if (assigned_to && !VALID_AGENTS.has(assigned_to)) {
      return res.status(400).json({ error: `Invalid assigned_to: ${assigned_to}` });
    }
    if (product && !VALID_PRODUCTS.has(product)) {
      return res.status(400).json({ error: `Invalid product: ${product}` });
    }
    const finalStatus = (reqStatus && VALID_STATUSES.has(reqStatus)) ? reqStatus : 'pending';

    const row = {
      title: title.trim(),
      description: description ? String(description).trim() : null,
      assigned_to: assigned_to || null,
      product: product || null,
      priority: priority ? Math.min(Math.max(Number(priority) || 3, 1), 5) : 3,
      status: finalStatus,
    };

    const r = await supa('organization_tasks', {
      method: 'POST',
      body: JSON.stringify(row),
    });
    if (!r.ok) {
      const err = await r.text();
      console.error('[ventures/tasks POST] supabase error', err);
      return res.status(500).json({ error: 'Failed to create task' });
    }
    const created = await r.json();
    return res.status(201).json({ task: Array.isArray(created) ? created[0] : created });
  }

  // ---------- PATCH (update status / blocked_reason) ----------
  if (req.method === 'PATCH') {
    let body;
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
    catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

    const { id, status, blocked_reason } = body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });
    if (!status || !VALID_STATUSES.has(status)) {
      return res.status(400).json({ error: `Invalid status: ${status}` });
    }

    const patch = { status };
    if (status === 'completed') patch.completed_at = new Date().toISOString();
    if (status === 'blocked' && blocked_reason) patch.blocked_reason = String(blocked_reason).trim();

    const r = await supa(`organization_tasks?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    if (!r.ok) {
      const err = await r.text();
      console.error('[ventures/tasks PATCH] supabase error', err);
      return res.status(500).json({ error: 'Failed to update task' });
    }
    const updated = await r.json();
    return res.status(200).json({ task: Array.isArray(updated) ? updated[0] : updated });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
