/**
 * Cold Email Metrics API
 * Serves aggregate campaign metrics and per-campaign breakdowns
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

  try {
    // Fetch all email events
    const { data: events, error: eventsError } = await supabase
      .from('email_events')
      .select('*')
      .order('event_ts', { ascending: false });

    if (eventsError) throw eventsError;

    // Calculate aggregate metrics
    const aggregate = {
      total_sent: 0,
      total_delivered: 0,
      total_opened: 0,
      total_clicked: 0,
      total_bounced: 0,
      total_complained: 0,
    };

    const eventCounts = {};

    (events || []).forEach(event => {
      if (event.event_type === 'sent') {
        aggregate.total_sent++;
      } else if (event.event_type === 'delivered') {
        aggregate.total_delivered++;
      } else if (event.event_type === 'opened') {
        aggregate.total_opened++;
      } else if (event.event_type === 'clicked') {
        aggregate.total_clicked++;
      } else if (event.event_type === 'bounced') {
        aggregate.total_bounced++;
      } else if (event.event_type === 'complained') {
        aggregate.total_complained++;
      }

      // Tally per-campaign metrics
      const campaignId = event.campaign_id || '(uncategorized)';
      if (!eventCounts[campaignId]) {
        eventCounts[campaignId] = {
          campaign_id: campaignId,
          sent: 0,
          delivered: 0,
          opened: 0,
          clicked: 0,
          bounced: 0,
          complained: 0,
        };
      }
      eventCounts[campaignId][event.event_type === 'sent' ? 'sent' : event.event_type]++;
    });

    // If no 'sent' events but we have delivery/open/click, estimate sent count from unique email IDs
    if (aggregate.total_sent === 0 && events && events.length > 0) {
      const uniqueEmails = new Set(events.map(e => e.resend_email_id).filter(Boolean));
      aggregate.total_sent = uniqueEmails.size;
    }

    // Build 7-day daily metrics
    const dailyMetrics = {};
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const dateStr = d.toISOString().split('T')[0];
      dailyMetrics[dateStr] = {
        date: dateStr,
        sent: 0,
        opened: 0,
        replied: 0,
      };
    }

    // Tally daily metrics
    (events || []).forEach(event => {
      const eventDate = new Date(event.event_ts).toISOString().split('T')[0];
      if (dailyMetrics[eventDate]) {
        if (event.event_type === 'sent') {
          dailyMetrics[eventDate].sent++;
        } else if (event.event_type === 'opened') {
          dailyMetrics[eventDate].opened++;
        }
      }
    });

    const dailyArray = Object.values(dailyMetrics).sort((a, b) => new Date(a.date) - new Date(b.date));
    const campaigns = Object.values(eventCounts).sort((a, b) => b.sent - a.sent);

    return res.status(200).json({
      aggregate,
      campaigns,
      daily_metrics: dailyArray,
    });
  } catch (err) {
    console.error('[cold-email-metrics] error:', err && err.message);
    return res.status(500).json({ error: 'Failed to fetch metrics' });
  }
}
