// api/ventures/attention-brief.js
// Calls Claude Haiku to generate a 2-sentence "what needs your attention today" brief
// Based on current dashboard data snapshot (MRR, customers, social, cron health)

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function verifyToken(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch {}

  const { snapshot = {} } = body;

  // Build a concise data string for the prompt
  const lines = [];
  if (snapshot.mrr !== undefined) lines.push(`MRR: $${snapshot.mrr}`);
  if (snapshot.customers !== undefined) lines.push(`Paying customers: ${snapshot.customers}`);
  if (snapshot.neverLoggedIn !== undefined) lines.push(`Never logged in: ${snapshot.neverLoggedIn}`);
  if (snapshot.loggedInThisWeek !== undefined) lines.push(`Active this week: ${snapshot.loggedInThisWeek}`);
  if (snapshot.postsThisWeek !== undefined) lines.push(`Social posts this week: ${snapshot.postsThisWeek}`);
  if (snapshot.approvalRate !== undefined) lines.push(`Social approval rate: ${snapshot.approvalRate}%`);
  if (snapshot.cronErrors !== undefined) lines.push(`Cron errors: ${snapshot.cronErrors}`);
  if (snapshot.foundingSpots !== undefined) lines.push(`Founding spots taken: ${snapshot.foundingSpots}/50`);
  if (snapshot.netRevenue !== undefined) lines.push(`Net (MRR - burn): $${snapshot.netRevenue}`);

  const dataStr = lines.length ? lines.join('. ') : 'No data available.';

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 150,
      messages: [
        {
          role: 'user',
          content: `You are the Chief of Staff AI for Shepard Ventures, a startup studio. Based on today's dashboard snapshot, write exactly 2 sentences telling Heath Shepard (founder) what needs his attention most urgently today. Be specific, direct, and action-oriented. No fluff. No greetings.

Dashboard snapshot: ${dataStr}

Respond with exactly 2 sentences.`,
        },
      ],
    });

    const brief = msg.content[0]?.text?.trim() || 'Dashboard loaded. Check cron health and activation metrics.';
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ brief });
  } catch (e) {
    console.error('[attention-brief] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
