// ============================================================================
// POST /api/agent-bus/write
// Body: { agent, role, content, in_reply_to?, routing_target?, metadata? }
//
// Writes one message to the shared agent bus. Used by Cole (when spawning
// sub-agents), by sub-agents (when reporting output / status), and by
// passive observers (when capturing observations).
//
// Auth: CRON_SECRET bearer.
//
// Owner: Atlas (SV-ENG-AGENT-BUS-PHASE-A / 2026-06-12)
// ============================================================================

const { writeMessage } = require('../_lib/agent-bus');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const auth = req.headers.authorization || '';
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  let body = req.body;
  // Vercel auto-parses JSON when content-type is application/json, but be defensive
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      return res.status(400).json({ ok: false, error: 'invalid_json' });
    }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'body required' });
  }

  const result = await writeMessage({
    agent: body.agent,
    role: body.role,
    content: body.content,
    in_reply_to: body.in_reply_to,
    routing_target: body.routing_target,
    metadata: body.metadata,
  });

  if (!result.ok) {
    return res.status(400).json(result);
  }
  return res.status(200).json(result);
};
