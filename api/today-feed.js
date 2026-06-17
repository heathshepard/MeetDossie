/**
 * /api/today-feed — POST
 *
 * Canonical Cole/agent → Heath status feed writer.
 * Cole + every agent hits this when starting, heart-beating, or finishing a job.
 *
 * Auth: shared secret via `Authorization: Bearer <CRON_SECRET>` OR Heath's
 *       Supabase JWT. Anything else 401.
 *
 * Body:
 *   {
 *     agent:   "cole" | "carter" | "atlas" | "sage" | "pierce" | "hadley" | "quinn" | "sterling" | string,
 *     action:  "start" | "heartbeat" | "complete" | "block",
 *     task:    "string description",            // required for start, optional for heartbeat/complete
 *     id:      "uuid"                            // optional — if provided, heartbeat/complete target this row
 *     metadata: { ... }                          // free-form
 *   }
 *
 * Returns: { ok, id, status }
 *
 * Updated: 2026-06-17 — initial build (Atlas).
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const ALLOWED_AGENTS = new Set([
  'cole', 'carter', 'atlas', 'sage', 'pierce', 'hadley', 'quinn', 'sterling',
  'content_verifier', 'system',
]);

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'supabase env not configured' });
  }

  // Auth: accept either CRON_SECRET or Heath's JWT.
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'unauthorized - no token' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let authedAs = null;
  if (CRON_SECRET && token === CRON_SECRET) {
    authedAs = 'cron_secret';
  } else {
    try {
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user && user.email === 'heath.shepard@kw.com') authedAs = 'heath';
    } catch {}
  }
  if (!authedAs) return res.status(401).json({ error: 'unauthorized' });

  const body = req.body || {};
  const agent = String(body.agent || '').toLowerCase().trim();
  const action = String(body.action || '').toLowerCase().trim();
  const task = body.task ? String(body.task).slice(0, 500) : null;
  const targetId = body.id ? String(body.id) : null;
  const metadata = (typeof body.metadata === 'object' && body.metadata !== null) ? body.metadata : {};

  if (!agent) return res.status(400).json({ error: 'agent required' });
  if (!ALLOWED_AGENTS.has(agent)) {
    return res.status(400).json({ error: `unknown agent "${agent}"` });
  }
  if (!['start', 'heartbeat', 'complete', 'block'].includes(action)) {
    return res.status(400).json({ error: 'action must be start|heartbeat|complete|block' });
  }

  const nowIso = new Date().toISOString();

  try {
    if (action === 'start') {
      if (!task) return res.status(400).json({ error: 'task required for start' });
      const { data, error } = await supabase
        .from('agent_activity')
        .insert({
          agent_name: agent,
          task_summary: task,
          status: 'working',
          metadata,
          started_at: nowIso,
          last_heartbeat: nowIso,
        })
        .select('id, status')
        .single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, id: data.id, status: data.status });
    }

    if (action === 'heartbeat') {
      // If targetId provided, update that row. Otherwise update the most recent
      // working row for this agent.
      let row;
      if (targetId) {
        const { data, error } = await supabase
          .from('agent_activity')
          .update({
            last_heartbeat: nowIso,
            ...(task ? { task_summary: task } : {}),
            ...(Object.keys(metadata).length ? { metadata } : {}),
          })
          .eq('id', targetId)
          .select('id, status')
          .single();
        if (error) return res.status(404).json({ error: error.message });
        row = data;
      } else {
        const { data: existing } = await supabase
          .from('agent_activity')
          .select('id')
          .eq('agent_name', agent)
          .in('status', ['working', 'waiting'])
          .order('started_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!existing) {
          // No active row → create one as a fresh start.
          const { data, error } = await supabase
            .from('agent_activity')
            .insert({
              agent_name: agent,
              task_summary: task || `${agent} heartbeat`,
              status: 'working',
              metadata,
              started_at: nowIso,
              last_heartbeat: nowIso,
            })
            .select('id, status')
            .single();
          if (error) return res.status(500).json({ error: error.message });
          row = data;
        } else {
          const { data, error } = await supabase
            .from('agent_activity')
            .update({
              last_heartbeat: nowIso,
              ...(task ? { task_summary: task } : {}),
            })
            .eq('id', existing.id)
            .select('id, status')
            .single();
          if (error) return res.status(500).json({ error: error.message });
          row = data;
        }
      }
      return res.status(200).json({ ok: true, id: row.id, status: row.status });
    }

    if (action === 'complete') {
      let query = supabase
        .from('agent_activity')
        .update({
          status: 'done',
          completed_at: nowIso,
          last_heartbeat: nowIso,
          ...(task ? { task_summary: task } : {}),
        });
      if (targetId) {
        query = query.eq('id', targetId);
      } else {
        // Most recent working row for this agent.
        const { data: existing } = await supabase
          .from('agent_activity')
          .select('id')
          .eq('agent_name', agent)
          .in('status', ['working', 'waiting', 'blocked'])
          .order('started_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!existing) return res.status(404).json({ error: 'no active row to complete' });
        query = query.eq('id', existing.id);
      }
      const { data, error } = await query.select('id, status').single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, id: data.id, status: data.status });
    }

    if (action === 'block') {
      let query = supabase
        .from('agent_activity')
        .update({
          status: 'blocked',
          last_heartbeat: nowIso,
          ...(task ? { task_summary: task } : {}),
          ...(Object.keys(metadata).length ? { metadata } : {}),
        });
      if (targetId) {
        query = query.eq('id', targetId);
      } else {
        const { data: existing } = await supabase
          .from('agent_activity')
          .select('id')
          .eq('agent_name', agent)
          .in('status', ['working', 'waiting'])
          .order('started_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!existing) {
          // Create a fresh blocked row if no active one.
          const { data, error } = await supabase
            .from('agent_activity')
            .insert({
              agent_name: agent,
              task_summary: task || `${agent} blocked`,
              status: 'blocked',
              metadata,
              started_at: nowIso,
              last_heartbeat: nowIso,
            })
            .select('id, status')
            .single();
          if (error) return res.status(500).json({ error: error.message });
          return res.status(200).json({ ok: true, id: data.id, status: data.status });
        }
        query = query.eq('id', existing.id);
      }
      const { data, error } = await query.select('id, status').single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, id: data.id, status: data.status });
    }

    return res.status(400).json({ error: 'unhandled action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
