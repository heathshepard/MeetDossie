// Vercel Serverless Function: /api/cron-affiliate-qualify-referrals
// Daily 0 8 * * * (8:00 UTC). Walks affiliate_referrals where status='pending_qualification'
// and paid_at >= 6 months ago, then qualifies (if subscription still active) or
// reverses (if churned). Sends a Resend notification to the affiliate on qualify.
//
// 2026-06-25 fix (atlas_30):
//   - Converted from ESM → CommonJS so it can use the withTelemetry wrapper.
//     Without telemetry, cron_runs never recorded a row, surfacing as
//     "never recorded a run" RED on the Ridge diagnostic.
//   - Removed the PostgREST implicit join `profiles:affiliate_user_id(...)`
//     because no FK exists between affiliate_referrals.affiliate_user_id and
//     profiles.id; the join produced "Could not find a relationship" 500s.
//     Replaced with two separate queries.
//   - Replaced "—Cole" sign-off (legacy persona) with "— The Dossie team".

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

async function sb(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data, raw: text };
}

async function resendSend(payload) {
  if (!RESEND_API_KEY) return { ok: false, skipped: 'no_resend_key' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

module.exports = withTelemetry('cron-affiliate-qualify-referrals', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase env vars not configured' });
  }

  // Find all referrals pending qualification where 6 months have passed.
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const sixMonthsAgoISO = sixMonthsAgo.toISOString();

  const pendingRes = await sb(
    `/rest/v1/affiliate_referrals?status=eq.pending_qualification&paid_at=lt.${encodeURIComponent(sixMonthsAgoISO)}&select=id,affiliate_user_id,referred_user_id,referred_email,paid_at,reward_cents`,
  );
  if (!pendingRes.ok) {
    return res.status(502).json({ ok: false, error: 'failed to load pending referrals', status: pendingRes.status });
  }
  const pending = Array.isArray(pendingRes.data) ? pendingRes.data : [];
  if (pending.length === 0) {
    return res.status(200).json({ ok: true, processed: 0, message: 'no referrals to qualify' });
  }

  // Batch-load affiliate profile info (no FK exists, so do it via IN filter).
  const affiliateIds = [...new Set(pending.map((r) => r.affiliate_user_id).filter(Boolean))];
  const profileMap = new Map();
  if (affiliateIds.length > 0) {
    const filter = affiliateIds.map((id) => `"${id}"`).join(',');
    const profRes = await sb(`/rest/v1/profiles?id=in.(${filter})&select=id,full_name,email`);
    if (profRes.ok && Array.isArray(profRes.data)) {
      for (const p of profRes.data) profileMap.set(p.id, p);
    }
  }

  const results = [];

  for (const referral of pending) {
    try {
      // Check if the referred user still has an active subscription.
      const subRes = await sb(
        `/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(referral.referred_user_id)}&status=eq.active&select=status&limit=1`,
      );
      const isActive = subRes.ok && Array.isArray(subRes.data) && subRes.data.length > 0;
      const newStatus = isActive ? 'qualified' : 'reversed';
      const qualifiedAt = new Date().toISOString();

      const updRes = await sb(
        `/rest/v1/affiliate_referrals?id=eq.${encodeURIComponent(referral.id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ status: newStatus, qualified_at: qualifiedAt }),
        }
      );
      if (!updRes.ok) {
        results.push({ referral_id: referral.id, status: 'failed', error: `update ${updRes.status}` });
        continue;
      }

      // If qualified, notify the affiliate.
      const profile = profileMap.get(referral.affiliate_user_id);
      if (newStatus === 'qualified' && profile?.email) {
        const amountFormatted = (referral.reward_cents / 100).toFixed(2);
        await resendSend({
          from: 'heath@meetdossie.com',
          to: profile.email,
          subject: `Your referral earned $${amountFormatted} — now available for payout`,
          html: `
            <p>Hi ${profile.full_name || 'there'},</p>
            <p>Your referral for ${referral.referred_email} has been active for 6 months.</p>
            <p>The <strong>$${amountFormatted}</strong> referral reward is now qualified and available for payout when you request it.</p>
            <p>Visit your affiliate dashboard to claim your earnings.</p>
            <p>Thanks for growing Dossie!</p>
            <p>— The Dossie team</p>
          `,
        });
      }

      results.push({
        referral_id: referral.id,
        referred_email: referral.referred_email,
        status: newStatus,
        amount: (referral.reward_cents / 100).toFixed(2),
      });
    } catch (error) {
      results.push({ referral_id: referral.id, status: 'failed', error: error.message });
    }
  }

  return res.status(200).json({ ok: true, processed: results.length, results });
});
