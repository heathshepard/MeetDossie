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

  // Check if user is admin
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Get top affiliates by earnings
  const { data: leaderboard } = await supabase
    .from('affiliate_links')
    .select(`
      code,
      user_id,
      referrals_count,
      earnings_cents,
      paid_out_cents,
      created_at,
      profiles(full_name, email)
    `)
    .eq('active', true)
    .order('earnings_cents', { ascending: false })
    .limit(100);

  return res.status(200).json({
    leaderboard: (leaderboard || []).map(item => ({
      code: item.code,
      userId: item.user_id,
      name: item.profiles?.full_name || 'Anonymous',
      email: item.profiles?.email,
      referrals: item.referrals_count,
      earningsCents: item.earnings_cents,
      paidOutCents: item.paid_out_cents,
      joinedAt: item.created_at,
    })),
  });
}
