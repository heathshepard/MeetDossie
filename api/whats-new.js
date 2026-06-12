// Vercel Serverless Function: /api/whats-new
// Manages "What's New" announcements and dismissals.
//
// GET /api/whats-new — returns active announcements user hasn't dismissed
// POST /api/whats-new { announcement_id } — record dismissal
//
// Authorization: Bearer <supabase user JWT>

const { createClient } = require('@supabase/supabase-js');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function handleGet(userId, res) {
  try {
    // Get all active announcements
    const { data: announcements, error: announcementsError } = await supabase
      .from('whats_new_announcements')
      .select('id, slug, title, body, cta_label, cta_url, created_at')
      .eq('active', true)
      .order('created_at', { ascending: false });

    if (announcementsError) {
      console.error('Announcements query error:', announcementsError);
      return res.status(500).json({ ok: false, error: 'Failed to fetch announcements' });
    }

    // Get dismissed announcements for this user
    const { data: dismissals, error: dismissalsError } = await supabase
      .from('whats_new_dismissals')
      .select('announcement_id')
      .eq('user_id', userId);

    if (dismissalsError) {
      console.error('Dismissals query error:', dismissalsError);
      return res.status(500).json({ ok: false, error: 'Failed to fetch dismissals' });
    }

    const dismissedIds = new Set((dismissals || []).map((d) => d.announcement_id));

    // Filter to un-dismissed announcements
    const visibleAnnouncements = (announcements || []).filter(
      (a) => !dismissedIds.has(a.id)
    );

    return res.status(200).json({
      ok: true,
      announcements: visibleAnnouncements,
    });
  } catch (err) {
    console.error('Get announcements error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
}

async function handlePost(userId, body, res) {
  const { announcement_id } = body || {};

  if (!announcement_id) {
    return res.status(400).json({ ok: false, error: 'announcement_id required' });
  }

  try {
    const { error } = await supabase
      .from('whats_new_dismissals')
      .insert({
        user_id: userId,
        announcement_id,
      });

    if (error) {
      if (error.code === '23505') {
        // Already dismissed
        return res.status(200).json({ ok: true, already_dismissed: true });
      }
      console.error('Insert dismissal error:', error);
      return res.status(500).json({ ok: false, error: 'Failed to record dismissal' });
    }

    return res.status(200).json({ ok: true, dismissed: true });
  } catch (err) {
    console.error('Post dismissal error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
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

  if (req.method === 'GET') {
    return handleGet(userId, res);
  } else {
    return handlePost(userId, req.body, res);
  }
};
