import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Find all referrals pending qualification where 6 months have passed
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const sixMonthsAgoISO = sixMonthsAgo.toISOString();

    const { data: pendingReferrals, error: fetchError } = await supabase
      .from('affiliate_referrals')
      .select(`
        id,
        affiliate_user_id,
        referred_user_id,
        referred_email,
        paid_at,
        reward_cents,
        profiles:affiliate_user_id(full_name, email)
      `)
      .eq('status', 'pending_qualification')
      .lt('paid_at', sixMonthsAgoISO);

    if (fetchError) {
      console.error('Error fetching pending referrals:', fetchError);
      return res.status(500).json({ error: fetchError.message });
    }

    if (!pendingReferrals || pendingReferrals.length === 0) {
      return res.status(200).json({ message: 'No referrals to qualify', processed: 0 });
    }

    const results = [];

    for (const referral of pendingReferrals) {
      try {
        // Check if the referred user still has an active subscription
        const { data: subscription } = await supabase
          .from('subscriptions')
          .select('status')
          .eq('user_id', referral.referred_user_id)
          .eq('status', 'active')
          .single();

        // If subscription is still active, qualify. Otherwise, reverse.
        const newStatus = subscription ? 'qualified' : 'reversed';
        const qualifiedAt = new Date().toISOString();

        // Update referral status
        const { error: updateError } = await supabase
          .from('affiliate_referrals')
          .update({
            status: newStatus,
            qualified_at: qualifiedAt,
          })
          .eq('id', referral.id);

        if (updateError) {
          results.push({
            referral_id: referral.id,
            status: 'failed',
            error: updateError.message,
          });
          continue;
        }

        // If qualified, send notification to affiliate
        if (newStatus === 'qualified' && referral.profiles?.email) {
          const amountFormatted = (referral.reward_cents / 100).toFixed(2);
          await resend.emails.send({
            from: 'heath@meetdossie.com',
            to: referral.profiles.email,
            subject: `🎉 Your referral earned $${amountFormatted} — now available for payout`,
            html: `
              <p>Hi ${referral.profiles.full_name},</p>
              <p>Your referral for ${referral.referred_email} has been active for 6 months.</p>
              <p>The <strong>$${amountFormatted}</strong> referral reward is now qualified and available for payout when you request it.</p>
              <p>Visit your affiliate dashboard to claim your earnings.</p>
              <p>Thanks for growing Dossie!</p>
              <p>—Cole</p>
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
        results.push({
          referral_id: referral.id,
          status: 'failed',
          error: error.message,
        });
      }
    }

    return res.status(200).json({ processed: results.length, results });
  } catch (error) {
    console.error('Affiliate qualify cron error:', error);
    return res.status(500).json({ error: error.message });
  }
}
