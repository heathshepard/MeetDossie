// Vercel Serverless Function: /api/founding-count
// Returns the number of founding-member spots remaining.
//
// GET → { ok: true, total: 25, taken: <n>, remaining: <25-n> }
//
// FOUNDING CAP REDUCED 2026-07-09: cap was 50, now 25. All 25 founding
// members are locked at $29/mo for LIFE of membership. Never revised.
//
// "Taken" is read from the subscriptions table (source of truth for billing
// state) where plan='founding' AND status='active', then filtered to EXCLUDE:
//   - demo profiles (profiles.is_demo = true)
//   - Shepard Ventures internal accounts (profiles.is_founder = true) — Heath's
//     own logins / test accounts. Same exclusion pattern as is_demo.
//   - the $1 founding-friend (Suzanne — k.suzanne.page@gmail.com)
// This keeps the homepage "X of 25 taken" honest — only real paying $29 founders.
//
// Heath's internal subscriptions are ALSO flipped to status='internal' on the
// subscriptions row, so the raw status=eq.active query won't return them even
// before this profile join — belt-and-suspenders.
//
// Subscriptions cascade from auth.users on delete and Stripe webhook updates
// the row directly, so this auto-reflects cancellations without a separate
// profiles-sync hop. No auth — the count is intentionally public so the
// homepage banner reads it.
//
// Environment:
//   SUPABASE_URL              — Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY — service-role JWT (server-side only)

const FOUNDING_TOTAL = 25;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Keep in sync with api/cron-morning-brief.js FOUNDING_FRIEND_EMAILS.
const FOUNDING_FRIEND_EMAILS = new Set(['k.suzanne.page@gmail.com']);

function isExcludedEmail(email) {
  if (!email) return false;
  const e = email.toLowerCase();
  if (FOUNDING_FRIEND_EMAILS.has(e)) return true;
  return false;
}

module.exports = async function handler(req, res) {
  // Cache lightly so a homepage burst doesn't hammer Supabase.
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(200).json({ ok: true, total: FOUNDING_TOTAL, taken: 0, remaining: FOUNDING_TOTAL, fallback: true });
  }

  try {
    // 1. Pull active founding subscriptions with user_id.
    const subResp = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?select=user_id&plan=eq.founding&status=eq.active`,
      {
        method: 'GET',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
    );
    if (!subResp.ok) {
      return res.status(200).json({ ok: true, total: FOUNDING_TOTAL, taken: 0, remaining: FOUNDING_TOTAL, fallback: true });
    }
    const subs = await subResp.json();
    const userIds = (Array.isArray(subs) ? subs : []).map((s) => s.user_id).filter(Boolean);
    if (userIds.length === 0) {
      return res.status(200).json({ ok: true, total: FOUNDING_TOTAL, taken: 0, remaining: FOUNDING_TOTAL });
    }

    // 2. Fetch matching profiles to apply is_demo + is_founder + email filters.
    const profFilter = userIds.map((id) => `"${id}"`).join(',');
    const profResp = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=in.(${profFilter})&select=id,email,is_demo,is_founder`,
      {
        method: 'GET',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
    );
    if (!profResp.ok) {
      // Fall back to the raw subscription count rather than blocking the banner.
      return res.status(200).json({
        ok: true,
        total: FOUNDING_TOTAL,
        taken: userIds.length,
        remaining: Math.max(0, FOUNDING_TOTAL - userIds.length),
        fallback: true,
      });
    }
    const profiles = await profResp.json();
    const profilesById = new Map((Array.isArray(profiles) ? profiles : []).map((p) => [p.id, p]));

    // 3. Count only real paying founders.
    let taken = 0;
    for (const uid of userIds) {
      const p = profilesById.get(uid);
      if (!p) continue; // orphan subscription without profile — skip rather than inflate
      if (p.is_demo) continue;
      if (p.is_founder) continue; // Shepard Ventures internal — never counts toward founding spots
      if (isExcludedEmail(p.email)) continue;
      taken += 1;
    }

    const remaining = Math.max(0, FOUNDING_TOTAL - taken);
    return res.status(200).json({ ok: true, total: FOUNDING_TOTAL, taken, remaining });
  } catch (err) {
    console.error('[founding-count] error:', err && err.message);
    return res.status(200).json({ ok: true, total: FOUNDING_TOTAL, taken: 0, remaining: FOUNDING_TOTAL, fallback: true });
  }
};
