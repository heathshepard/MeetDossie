// ============================================================================
// GET /api/agent-bus/recent?agent=carter&limit=30[&since=ISO]
//
// Returns recent shared-context messages for a calling agent. This is the
// endpoint sub-agents call at the start of a task so they have team-wide
// situational awareness before acting.
//
// Auth: CRON_SECRET bearer (internal agent traffic only — never exposed to
// end users in Phase A).
//
// Owner: Atlas (SV-ENG-AGENT-BUS-PHASE-A / 2026-06-12)
// ============================================================================

const { readRecentContext, readDispatches } = require('../_lib/agent-bus');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const auth = req.headers.authorization || '';
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const agent = String(req.query.agent || '').trim();
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
  const since = req.query.since ? String(req.query.since) : undefined;
  const includeDispatches = req.query.include_dispatches !== '0';

  if (!agent) {
    return res.status(400).json({ ok: false, error: 'agent query param required' });
  }

  const ctx = await readRecentContext({ agent, limit, since });
  if (!ctx.ok) {
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  let dispatches = [];
  if (includeDispatches) {
    const d = await readDispatches({ target: agent, limit: 20 });
    if (d.ok) dispatches = d.dispatches;
  }

  return res.status(200).json({
    ok: true,
    agent,
    count: ctx.messages.length,
    messages: ctx.messages,
    pending_dispatches: dispatches,
    fetched_at: new Date().toISOString(),
  });
};
