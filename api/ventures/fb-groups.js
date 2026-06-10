// Vercel Serverless Function: /api/ventures/fb-groups
//
// Read-only Atlas dashboard endpoint that lists every Facebook group in the
// fb_groups tracker table plus a few rollups. Powers the
// /ventures/social/fb-groups dashboard page.
//
// GET /api/ventures/fb-groups
//   Returns:
//     {
//       groups: [ { group_url, group_name, posting_status, ... } ],
//       rollups: {
//         total, instant_approve, admin_moderated, no_composer,
//         posts_never_approved, comment_only, unknown,
//         total_comments, ready_to_unlock_count, pending_unlock_count
//       },
//       generated_at: ISO8601
//     }
//
// Auth: Supabase JWT (Bearer token) belonging to one of AUTHORIZED_EMAILS.
//       Same pattern as the other /api/ventures/* endpoints.
// Env:  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const AUTHORIZED_EMAILS = new Set([
  'heath.shepard@kw.com',
  'heath@meetdossie.com',
  'heath.shepard@gmail.com',
  'heathshepard@meetdossie.com',
]);

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;
const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function applyCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin) || PREVIEW_RE.test(origin) || LOCAL_RE.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
}

function supa(path) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  // ----- auth -----
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized - no token' });
  }
  const token = authHeader.slice(7);

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!userRes.ok) return res.status(401).json({ error: 'Unauthorized - invalid token' });
  const userData = await userRes.json();
  if (!AUTHORIZED_EMAILS.has(userData.email)) {
    return res.status(403).json({ error: 'Forbidden - admin only', debug_email: userData.email });
  }

  // ----- fetch -----
  // Sort: ready-to-unlock groups first, then most-recently-active, then by yield score.
  // Pulled as a single query and sorted client-side for flexibility.
  const groupsRes = await supa('fb_groups?select=*&order=updated_at.desc&limit=500');
  if (!groupsRes.ok) {
    const txt = await groupsRes.text();
    return res.status(500).json({ error: 'Failed to fetch fb_groups', detail: txt.slice(0, 200) });
  }
  const groups = await groupsRes.json();

  // Compute rollups
  const rollups = {
    total: groups.length,
    instant_approve:      groups.filter(g => g.posting_status === 'instant_approve').length,
    admin_moderated:      groups.filter(g => g.posting_status === 'admin_moderated').length,
    no_composer:          groups.filter(g => g.posting_status === 'no_composer').length,
    posts_never_approved: groups.filter(g => g.posting_status === 'posts_never_approved').length,
    comment_only:         groups.filter(g => g.posting_status === 'comment_only').length,
    unknown:              groups.filter(g => g.posting_status === 'unknown').length,
    total_comments:       groups.reduce((sum, g) => sum + (g.comment_count || 0), 0),
    ready_to_unlock_count:
      groups.filter(g =>
        g.posting_status === 'comment_only' &&
        (g.comment_count || 0) >= 5 &&
        (g.admin_unlock_status === 'not_needed' || g.admin_unlock_status === null)
      ).length,
    pending_unlock_count: groups.filter(g => g.admin_unlock_status === 'pending').length,
    members:    groups.filter(g => g.member_status === 'member').length,
    followers:  groups.filter(g => g.member_status === 'follower').length,
    not_joined: groups.filter(g => g.member_status === 'not_joined').length,
  };

  return res.status(200).json({
    groups,
    rollups,
    generated_at: new Date().toISOString(),
  });
}
