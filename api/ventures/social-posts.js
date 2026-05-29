/**
 * GET /api/ventures/social-posts?platform=facebook&limit=5
 * Returns the last N posts for a given platform.
 * Used by the ventures dashboard clickable social stat cards.
 *
 * Auth: Bearer token via Supabase JWT — heath emails only.
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AUTHORIZED_EMAILS = new Set([
  'heath.shepard@kw.com',
  'heath@meetdossie.com',
  'heath.shepard@gmail.com',
  'heathshepard@meetdossie.com',
]);

const ALLOWED_ORIGINS = new Set(['https://meetdossie.com', 'https://www.meetdossie.com']);
const PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;
const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const VALID_PLATFORMS = new Set(['facebook', 'twitter', 'instagram', 'linkedin', 'tiktok']);

function applyCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin) || PREVIEW_RE.test(origin) || LOCAL_RE.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
}

function supa(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
}

async function verifyAuth(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return AUTHORIZED_EMAILS.has(u.email) ? u : null;
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { platform, limit = '5' } = req.query;
  const safeLimit = Math.min(Number(limit) || 5, 20);

  try {
    let qs;
    if (platform && VALID_PLATFORMS.has(platform)) {
      qs = `social_posts?select=id,platform,hook,content,status,created_at,posted_at&platform=eq.${encodeURIComponent(platform)}&order=created_at.desc&limit=${safeLimit}`;
    } else {
      // All platforms — no platform filter
      qs = `social_posts?select=id,platform,hook,content,status,created_at,posted_at&order=created_at.desc&limit=${safeLimit}`;
    }

    const r = await supa(qs);
    if (!r.ok) {
      const err = await r.text();
      console.error('[ventures/social-posts] supabase error:', err);
      return res.status(500).json({ error: 'Failed to fetch posts' });
    }

    const posts = await r.json();
    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      platform: platform || 'all',
      posts: posts.map(p => ({
        id: p.id,
        platform: p.platform,
        hook: p.hook || (p.content ? p.content.slice(0, 80) : '(no content)'),
        status: p.status,
        createdAt: p.created_at,
        postedAt: p.posted_at,
      })),
    });
  } catch (err) {
    console.error('[ventures/social-posts] error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}
