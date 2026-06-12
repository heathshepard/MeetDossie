import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  const { ref, dest } = req.query;

  if (!ref || !dest) {
    return res.status(400).json({ error: 'ref and dest query params required' });
  }

  // Look up affiliate code
  const { data: affiliate } = await supabase
    .from('affiliate_links')
    .select('user_id')
    .eq('code', ref)
    .eq('active', true)
    .single();

  if (!affiliate) {
    // Invalid code, redirect without tracking
    return res.redirect(302, dest);
  }

  // Insert click tracking
  await supabase
    .from('affiliate_referrals')
    .insert({
      affiliate_user_id: affiliate.user_id,
      ref_code: ref,
      status: 'clicked',
    })
    .select('id')
    .single();

  // Set cookie for 30 days
  const thirtyDaysFromNow = new Date();
  thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

  res.setHeader(
    'Set-Cookie',
    `affiliate_ref=${ref}; Path=/; Expires=${thirtyDaysFromNow.toUTCString()}; SameSite=Lax`
  );

  return res.redirect(302, dest);
}
