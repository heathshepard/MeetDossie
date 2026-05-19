// Vercel Serverless Function: /api/studio/chat
// Send message to Chief of Staff
// Authorization: Bearer <supabase user JWT>, restricted to heath.shepard@kw.com

const { verifySupabaseToken, AuthError } = require('../_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function applyCors(req, res) {
  const origin = req.headers.origin || '';
  const allowedOrigins = ['https://meetdossie.com', 'https://www.meetdossie.com', 'https://staging.meetdossie.com'];
  const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const isVercel = origin.endsWith('.vercel.app');

  if (allowedOrigins.includes(origin) || isLocalhost || isVercel) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
  return data;
}

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const user = await verifySupabaseToken(req);

    // Restrict to heath.shepard@kw.com
    if (user.email !== 'heath.shepard@kw.com') {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (req.method === 'GET') {
      // Fetch message history
      const { limit = '50', offset = '0' } = req.query;

      const messagesData = await supabaseFetch(
        `/rest/v1/studio_messages?user_id=eq.${user.id}&select=*&order=created_at.desc&limit=${limit}&offset=${offset}`
      );

      const messages = messagesData.map(msg => ({
        id: msg.id,
        agentName: msg.agent_name,
        message: msg.message,
        response: msg.response,
        status: msg.status,
        createdAt: msg.created_at,
        respondedAt: msg.responded_at,
      }));

      return res.status(200).json({
        success: true,
        data: messages.reverse(), // Return oldest first for chat display
      });
    }

    if (req.method === 'POST') {
      // Send new message
      const { message, agent = 'Chief of Staff' } = req.body;

      if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'Message is required' });
      }

      // Store message
      const newMessage = await supabaseFetch('/rest/v1/studio_messages', {
        method: 'POST',
        body: JSON.stringify({
          user_id: user.id,
          agent_name: agent,
          message: message.trim(),
          status: 'pending',
        }),
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
      });

      // TODO Phase 2: Trigger actual Claude Code agent response
      // For now, return a placeholder response
      const autoResponse = `Message received. In Phase 2, this will trigger a real Chief of Staff agent to process your request.`;

      // Update with auto-response
      await supabaseFetch(`/rest/v1/studio_messages?id=eq.${newMessage[0].id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          response: autoResponse,
          status: 'completed',
          responded_at: new Date().toISOString(),
        }),
      });

      return res.status(200).json({
        success: true,
        data: {
          id: newMessage[0].id,
          message: message.trim(),
          response: autoResponse,
          agentName: agent,
        },
      });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(401).json({ error: err.message });
    }
    console.error('Error in studio chat:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
