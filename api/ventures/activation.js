/**
 * GET /api/ventures/activation
 * User activation metrics for the ventures dashboard.
 * Queries auth.users (via service role) for login activity.
 *
 * Auth: Bearer token via Supabase JWT — heath emails only.
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Note: auth.users is queried via the admin REST endpoint (not /rest/v1/).
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

function applyCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin) || PREVIEW_RE.test(origin) || LOCAL_RE.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
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

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // Query profiles table (non-demo users) — source of truth for customer accounts
    // We join this with subscriptions to get paying customers only
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Get all non-demo profiles
    const profilesRes = await supa(
      'profiles?select=id,email,full_name,is_demo,created_at&is_demo=eq.false&limit=200'
    );
    if (!profilesRes.ok) {
      const err = await profilesRes.text();
      console.error('[ventures/activation] profiles fetch error:', err);
      return res.status(500).json({ error: 'Failed to fetch profiles' });
    }
    const profiles = await profilesRes.json();

    // Get active subscriptions
    const subsRes = await supa(
      'subscriptions?select=user_id,plan,status&status=eq.active&limit=200'
    );
    const subs = subsRes.ok ? await subsRes.json() : [];
    const activeSubUserIds = new Set(subs.map(s => s.user_id));

    // Query auth.users via admin endpoint to get last_sign_in_at
    // Supabase admin API: GET /auth/v1/admin/users
    const adminRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    });

    let authUsers = [];
    if (adminRes.ok) {
      const adminData = await adminRes.json();
      authUsers = adminData.users || [];
    }

    // Build a map of user_id -> last_sign_in_at from auth.users
    const lastSignInMap = {};
    for (const au of authUsers) {
      lastSignInMap[au.id] = au.last_sign_in_at || null;
    }

    // Compute activation metrics — paying customers only
    const payingProfiles = profiles.filter(p => activeSubUserIds.has(p.id));
    const totalPaying = payingProfiles.length;

    let loggedInThisWeek = 0;
    let neverLoggedIn = 0;
    const customers = [];

    for (const p of payingProfiles) {
      const lastSignIn = lastSignInMap[p.id] || null;
      const loggedInRecently = lastSignIn && new Date(lastSignIn) >= new Date(sevenDaysAgo);

      if (!lastSignIn) {
        neverLoggedIn++;
      } else if (loggedInRecently) {
        loggedInThisWeek++;
      }

      customers.push({
        id: p.id,
        name: p.full_name || p.email || 'Unknown',
        email: p.email,
        createdAt: p.created_at,
        lastSignIn,
        activatedThisWeek: Boolean(loggedInRecently),
        neverLoggedIn: !lastSignIn,
      });
    }

    // Also count all non-demo, non-paying registered users (leads who made accounts but didn't pay)
    const nonPayingProfiles = profiles.filter(p => !activeSubUserIds.has(p.id));

    const activationRate = totalPaying > 0
      ? Math.round(((totalPaying - neverLoggedIn) / totalPaying) * 100)
      : 0;

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      totalPaying,
      loggedInThisWeek,
      neverLoggedIn,
      activationRate,
      registeredNonPaying: nonPayingProfiles.length,
      customers: customers.sort((a, b) => {
        // Sort: never logged in first (activation risk), then by last sign in desc
        if (a.neverLoggedIn && !b.neverLoggedIn) return -1;
        if (!a.neverLoggedIn && b.neverLoggedIn) return 1;
        if (!a.lastSignIn && !b.lastSignIn) return 0;
        if (!a.lastSignIn) return -1;
        if (!b.lastSignIn) return 1;
        return new Date(b.lastSignIn) - new Date(a.lastSignIn);
      }),
    });
  } catch (err) {
    console.error('[ventures/activation] error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}
