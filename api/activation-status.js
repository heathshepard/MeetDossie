// Vercel Serverless Function: /api/activation-status
// Returns activation funnel state for a user.
//
// GET ?user_id=<UUID>
// Authorization: Bearer <supabase user JWT>
//
// Response: { user_id, email, full_name, activation_complete, days_since_signup, events: {...} }

const { createClient } = require('@supabase/supabase-js');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const EVENT_TYPES = [
  'signup_completed',
  'profile_completed',
  'first_login',
  'first_dossier_created',
  'first_document_uploaded',
  'first_email_queued',
  'first_action_item_completed',
  'first_amendment_drafted',
  'first_form_attached',
  'first_milestone_created',
  'first_morning_brief_listened',
  'first_voice_command',
];

const ACTIVATION_REQUIRED = new Set([
  'first_dossier_created',
  'first_document_uploaded',
  'first_morning_brief_listened',
]);

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  let userId;
  try {
    const auth = await verifySupabaseToken(req);
    userId = auth.userId;
  } catch (err) {
    const status = err instanceof AuthError && err.status ? err.status : 401;
    return res.status(status).json({ ok: false, error: 'Unauthorized' });
  }

  const targetUserId = req.query.user_id;
  if (!targetUserId) {
    return res.status(400).json({ ok: false, error: 'user_id query param required' });
  }

  // Users can only view their own status (admin override TBD)
  if (userId !== targetUserId) {
    return res.status(403).json({ ok: false, error: 'Cannot view other user status' });
  }

  try {
    // Get user profile
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, email, full_name, created_at')
      .eq('id', userId)
      .single();

    if (profileError) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    // Get activation events for this user
    const { data: events, error: eventsError } = await supabase
      .from('activation_events')
      .select('event_type, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (eventsError) {
      console.error('Events query error:', eventsError);
      return res.status(500).json({ ok: false, error: 'Failed to fetch events' });
    }

    // Build event map
    const eventMap = {};
    (events || []).forEach((evt) => {
      eventMap[evt.event_type] = evt.created_at;
    });

    // Compute activation complete: has all three required milestones
    const activation_complete =
      ACTIVATION_REQUIRED.has('first_dossier_created') &&
      eventMap['first_dossier_created'] &&
      eventMap['first_document_uploaded'] &&
      eventMap['first_morning_brief_listened'];

    const daysElapsed = profile?.created_at
      ? Math.floor((Date.now() - new Date(profile.created_at).getTime()) / (1000 * 60 * 60 * 24))
      : null;

    return res.status(200).json({
      ok: true,
      user_id: userId,
      email: profile?.email,
      full_name: profile?.full_name,
      signup_date: profile?.created_at,
      days_since_signup: daysElapsed,
      activation_complete,
      events: Object.fromEntries(
        EVENT_TYPES.map((type) => [type, eventMap[type] || null])
      ),
    });
  } catch (err) {
    console.error('Activation status error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
};
