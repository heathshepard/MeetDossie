import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.slice(7);
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);

  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Get affiliate link
  const { data: affiliate, error: afError } = await supabase
    .from('affiliate_links')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (afError || !affiliate) {
    return res.status(404).json({ error: 'No affiliate link found' });
  }

  // Get recent referrals
  const { data: referrals } = await supabase
    .from('affiliate_referrals')
    .select('id, referred_email, status, reward_cents, click_at, paid_at')
    .eq('affiliate_user_id', user.id)
    .order('click_at', { ascending: false });

  // Get payouts
  const { data: payouts } = await supabase
    .from('affiliate_payouts')
    .select('id, amount_cents, payout_method, status, created_at, paid_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  // Calculate available balance
  const availableBalance = affiliate.earnings_cents - affiliate.paid_out_cents;

  return res.status(200).json({
    code: affiliate.code,
    active: affiliate.active,
    totalReferrals: affiliate.referrals_count,
    earningsCents: affiliate.earnings_cents,
    paidOutCents: affiliate.paid_out_cents,
    availableBalanceCents: availableBalance,
    createdAt: affiliate.created_at,
    recentReferrals: referrals || [],
    payoutHistory: payouts || [],
  });
}
