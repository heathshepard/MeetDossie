// Vercel Serverless Function: /api/queue-task
//
// POST — enqueue a new task for an agent. The single Cole-facing helper for
// populating agent_queue. Cole/Jarvis calls this instead of spawning agents
// directly; the queue picker handles assignment.
//
// Auth: Bearer JWT (must be heath.shepard@kw.com) OR Bearer ${CRON_SECRET}
//       (so Cole's cron orchestrator can also enqueue without a user token).
//
// Body:
//   {
//     agent: "carter" | "atlas" | "sage" | "pierce" | "hadley" | "quinn" | "sterling" | "cole" | "ridge",
//     task_subject: "string (max 200)",
//     task_brief: "string (full prompt)",
//     priority?: 1-5 (default 3),
//     depends_on?: ["uuid",...],
//     venture?: "dossie" | "paralegal" | "personal-agents" | "shepard-ventures" | "general",
//     metadata?: { ... }
//   }
//
// Returns:
//   200 { ok: true, id: "uuid", queued_at, position_in_agent_queue }
//   400 on validation error
//   401/403 on auth
//
// Owner: Atlas (SV-ENG-AGENT-QUEUE / 2026-06-17)

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const ALLOWED_EMAIL = 'heath.shepard@kw.com';

const VALID_AGENTS = new Set([
  'cole','atlas','carter','sage','pierce',
  'hadley','quinn','sterling','ridge',
]);
const VALID_VENTURES = new Set([
  'dossie','paralegal','personal-agents','shepard-ventures','general',
]);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
}

async function authorize(req, supabase) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'no token' };
  }
  const token = h.slice('Bearer '.length).trim();

  // CRON_SECRET path — Cole's orchestrator can post too.
  if (CRON_SECRET && token === CRON_SECRET) {
    return { ok: true, principal: 'cron' };
  }

  // User JWT path — only Heath.
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return { ok: false, status: 401, error: 'invalid token' };
  }
  if (user.email !== ALLOWED_EMAIL) {
    return { ok: false, status: 403, error: 'forbidden — not heath' };
  }
  return { ok: true, principal: 'heath' };
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

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const auth = await authorize(req, supabase);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  let body = req.body;
  // Vercel auto-parses JSON when content-type is JSON, but be defensive.
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {
      return res.status(400).json({ ok: false, error: 'invalid JSON body' });
    }
  }
  body = body || {};

  // Validate.
  const agent = String(body.agent || '').toLowerCase().trim();
  if (!VALID_AGENTS.has(agent)) {
    return res.status(400).json({ ok: false, error: `invalid agent. must be one of: ${[...VALID_AGENTS].join(', ')}` });
  }

  const task_subject = String(body.task_subject || '').trim();
  if (!task_subject || task_subject.length > 200) {
    return res.status(400).json({ ok: false, error: 'task_subject required, max 200 chars' });
  }

  const task_brief = String(body.task_brief || '').trim();
  if (!task_brief) {
    return res.status(400).json({ ok: false, error: 'task_brief required' });
  }

  const priority = Number.isFinite(body.priority) ? Math.floor(body.priority) : 3;
  if (priority < 1 || priority > 5) {
    return res.status(400).json({ ok: false, error: 'priority must be 1-5' });
  }

  const venture = body.venture ? String(body.venture).toLowerCase().trim() : 'general';
  if (!VALID_VENTURES.has(venture)) {
    return res.status(400).json({ ok: false, error: `invalid venture. must be one of: ${[...VALID_VENTURES].join(', ')}` });
  }

  const depends_on = Array.isArray(body.depends_on) ? body.depends_on.filter(Boolean) : [];
  // Basic UUID shape check — db will hard-validate.
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const u of depends_on) {
    if (typeof u !== 'string' || !uuidRe.test(u)) {
      return res.status(400).json({ ok: false, error: `depends_on contains invalid uuid: ${u}` });
    }
  }

  const metadata = (body.metadata && typeof body.metadata === 'object') ? body.metadata : {};
  metadata._queued_by = auth.principal;

  // Insert.
  const { data, error } = await supabase
    .from('agent_queue')
    .insert({
      agent_name: agent,
      task_subject,
      task_brief,
      priority,
      depends_on,
      venture,
      metadata,
    })
    .select('id, created_at')
    .single();

  if (error) {
    return res.status(500).json({ ok: false, error: `insert failed: ${error.message}` });
  }

  // Position info — how many pending ahead of this one for that agent.
  const { count: ahead } = await supabase
    .from('agent_queue')
    .select('id', { count: 'exact', head: true })
    .eq('agent_name', agent)
    .eq('status', 'pending')
    .or(`priority.lt.${priority},and(priority.eq.${priority},created_at.lt.${data.created_at})`);

  return res.status(200).json({
    ok: true,
    id: data.id,
    queued_at: data.created_at,
    agent,
    priority,
    venture,
    position_in_agent_queue: (ahead || 0) + 1, // 1-indexed
  });
};
