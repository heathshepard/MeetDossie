/**
 * Cold Email Recipient Lookup API
 * Serves per-recipient event timeline and metrics
 * Auth: requires logged-in user with email = heath.shepard@kw.com
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth check
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized - no token' });
  }

  const token = authHeader.replace('Bearer ', '');
  const supabase = createClient(supabaseUrl, supabaseKey);

  // Verify token and get user
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);

  if (authError || !user) {
    return res.status(401).json({ error: 'Unauthorized - invalid token' });
  }

  // Check if user email is heath.shepard@kw.com
  if (user.email !== 'heath.shepard@kw.com') {
    return res.status(403).json({ error: 'Forbidden - admin only' });
  }

  const email = req.query.email;
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid email parameter' });
  }

  try {
    // Fetch all events for this recipient
    const { data: events, error: eventsError } = await supabase
      .from('email_events')
      .select('*')
      .ilike('recipient_email', email)
      .order('event_ts', { ascending: false });

    if (eventsError) throw eventsError;

    if (!events || events.length === 0) {
      return res.status(404).json({ error: 'No events found for this email' });
    }

    // Calculate per-event counts
    const counts = {
      sent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      bounced: 0,
      complained: 0,
    };

    events.forEach(event => {
      if (event.event_type in counts) {
        counts[event.event_type]++;
      }
    });

    return res.status(200).json({
      events,
      counts,
    });
  } catch (err) {
    console.error('[cold-email-recipient] error:', err && err.message);
    return res.status(500).json({ error: 'Failed to fetch recipient events' });
  }
}
