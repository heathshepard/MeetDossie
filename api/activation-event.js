// Vercel Serverless Function: /api/activation-event
// Logs activation milestones for funnel tracking.
//
// POST { event_type, metadata? }
// Authorization: Bearer <supabase user JWT>
//
// event_type: one of 'signup_completed', 'profile_completed', 'first_login',
// 'first_dossier_created', 'first_document_uploaded', 'first_email_queued',
// 'first_action_item_completed', 'first_amendment_drafted', 'first_form_attached',
// 'first_milestone_created', 'first_morning_brief_listened', 'first_voice_command'
//
// UPSERT on (user_id, event_type) — each milestone fires ONCE only.
// Response: { ok: true, event_id?, already_fired?: true }

const { createClient } = require('@supabase/supabase-js');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const VALID_EVENT_TYPES = new Set([
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
]);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
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

  const { event_type, metadata } = req.body || {};

  if (!event_type || !VALID_EVENT_TYPES.has(event_type)) {
    return res.status(400).json({
      ok: false,
      error: `Invalid event_type. Must be one of: ${Array.from(VALID_EVENT_TYPES).join(', ')}`,
    });
  }

  if (metadata && typeof metadata !== 'object') {
    return res.status(400).json({ ok: false, error: 'metadata must be an object' });
  }

  try {
    const { data, error } = await supabase
      .from('activation_events')
      .upsert(
        {
          user_id: userId,
          event_type,
          metadata: metadata || {},
        },
        { onConflict: 'user_id,event_type' }
      )
      .select('id, created_at');

    if (error) {
      console.error('Supabase upsert error:', error);
      return res.status(500).json({ ok: false, error: 'Failed to log event' });
    }

    const isNew = data && data.length > 0 && data[0].created_at;
    return res.status(200).json({
      ok: true,
      event_id: data?.[0]?.id,
      already_fired: !isNew,
    });
  } catch (err) {
    console.error('Activation event error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
};
