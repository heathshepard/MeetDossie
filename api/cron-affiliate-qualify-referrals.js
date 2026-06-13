import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Find all referrals that have reached their 6-month qualification date
    const { data: pendingReferrals, error: queryError } = await supabase
      .from('affiliate_referrals')
      .select(`
        id,
        affiliate_user_id,
        referred_user_id,
        referred_email,
        reward_cents,
        payout_eligible_at
      `)
      .eq('status', 'pending_qualification')
      .lt('payout_eligible_at', new Date().toISOString())
      .order('payout_eligible_at', { ascending: true });

    if (queryError) {
      console.error('[cron-affiliate-qualify] query failed:', queryError.message);
      return res.status(500).json({ error: 'Query failed' });
    }

    if (!pendingReferrals || pendingReferrals.length === 0) {
      console.log('[cron-affiliate-qualify] no pending referrals to process');
      return res.status(200).json({ message: 'No referrals to process', processed: 0 });
    }

    const results = [];

    for (const referral of pendingReferrals) {
      try {
        // Check if the referred user's subscription is still active
        const { data: subscription, error: subError } = await supabase
          .from('subscriptions')
          .select('status, user_id')
          .eq('user_id', referral.referred_user_id)
          .eq('status', 'active')
          .single();

        let status = 'reversed';
        let reversalReason = 'canceled_within_qualification_period';

        if (!subError && subscription && subscription.status === 'active') {
          status = 'qualified';
          reversalReason = null;

          // Update the referral to qualified and set qualified_at
          const { error: updateError } = await supabase
            .from('affiliate_referrals')
            .update({
              status: 'qualified',
              qualified_at: new Date().toISOString(),
            })
            .eq('id', referral.id);

          if (updateError) {
            console.error('[cron-affiliate-qualify] update to qualified failed:', updateError.message);
            results.push({
              referral_id: referral.id,
              status: 'failed',
              reason: updateError.message,
            });
            continue;
          }

          // Increment affiliate's earnings_cents
          const { data: affiliateLink, error: fetchError } = await supabase
            .from('affiliate_links')
            .select('earnings_cents')
            .eq('user_id', referral.affiliate_user_id)
            .single();

          if (!fetchError && affiliateLink) {
            const { error: patchError } = await supabase
              .from('affiliate_links')
              .update({
                earnings_cents: affiliateLink.earnings_cents + referral.reward_cents,
              })
              .eq('user_id', referral.affiliate_user_id);

            if (patchError) {
              console.warn('[cron-affiliate-qualify] earnings increment failed:', patchError.message);
            }
          }

          // Send qualified notification to affiliate
          try {
            const { data: affiliateProfile } = await supabase
              .from('profiles')
              .select('full_name, email')
              .eq('id', referral.affiliate_user_id)
              .single();

            if (affiliateProfile?.email) {
              const affiliateName = (affiliateProfile.full_name || '').split(' ')[0] || 'Friend';
              const referredName = (referral.referred_email || '').split('@')[0] || 'your referral';
              const rewardFormatted = (referral.reward_cents / 100).toFixed(2);

              await resend.emails.send({
                from: 'heath@meetdossie.com',
                to: affiliateProfile.email,
                subject: `🎉 Your $${rewardFormatted} Dossie affiliate reward just qualified`,
                html: `
                  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #FDFCFA; color: #1A1A2E;">
                    <h2 style="margin-top: 0;">Hey ${affiliateName}!</h2>
                    <p>Good news: <strong>${referredName}'s subscription is still active</strong>, so your $${rewardFormatted} affiliate reward just qualified.</p>
                    <p style="font-weight: bold; color: #8BA888; font-size: 16px;">✅ Qualified and ready</p>
                    <p>This credit will apply to your next monthly invoice or can be used toward premium add-ons.</p>
                    <p>Thanks for the referral!</p>
                    <p>—Cole</p>
                  </div>
                `,
              });
            }
          } catch (err) {
            console.warn('[cron-affiliate-qualify] qualified notification failed:', err && err.message);
          }

          results.push({
            referral_id: referral.id,
            status: 'qualified',
            amount: (referral.reward_cents / 100).toFixed(2),
          });
        } else {
          // Subscription not active — mark as reversed
          const { error: updateError } = await supabase
            .from('affiliate_referrals')
            .update({
              status: 'reversed',
              reversal_reason: reversalReason,
            })
            .eq('id', referral.id);

          if (updateError) {
            console.error('[cron-affiliate-qualify] update to reversed failed:', updateError.message);
            results.push({
              referral_id: referral.id,
              status: 'failed',
              reason: updateError.message,
            });
            continue;
          }

          // Send reversal notification to affiliate
          try {
            const { data: affiliateProfile } = await supabase
              .from('profiles')
              .select('full_name, email')
              .eq('id', referral.affiliate_user_id)
              .single();

            if (affiliateProfile?.email) {
              const affiliateName = (affiliateProfile.full_name || '').split(' ')[0] || 'Friend';
              const referredName = (referral.referred_email || '').split('@')[0] || 'your referral';
              const rewardFormatted = (referral.reward_cents / 100).toFixed(2);

              await resend.emails.send({
                from: 'heath@meetdossie.com',
                to: affiliateProfile.email,
                subject: `Heads up: Your $${rewardFormatted} Dossie affiliate reward was voided`,
                html: `
                  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #FDFCFA; color: #1A1A2E;">
                    <h2 style="margin-top: 0;">Hey ${affiliateName}!</h2>
                    <p><strong>${referredName}'s subscription was cancelled before the 6-month qualification period</strong>, so the $${rewardFormatted} affiliate reward has been voided.</p>
                    <p style="font-size: 14px; color: #5C6B7A;">This is part of our anti-gaming policy — we only credit rewards for referrals that stay active for 6 months.</p>
                    <p>No worries though — keep sharing, and we'll get plenty of long-term subscribers coming your way.</p>
                    <p>—Cole</p>
                  </div>
                `,
              });
            }
          } catch (err) {
            console.warn('[cron-affiliate-qualify] reversal notification failed:', err && err.message);
          }

          results.push({
            referral_id: referral.id,
            status: 'reversed',
            reason: reversalReason,
          });
        }
      } catch (error) {
        console.error('[cron-affiliate-qualify] processing referral failed:', error && error.message);
        results.push({
          referral_id: referral.id,
          status: 'failed',
          reason: error && error.message,
        });
      }
    }

    console.log('[cron-affiliate-qualify] processing complete:', results);
    return res.status(200).json({ processed: results });
  } catch (error) {
    console.error('[cron-affiliate-qualify] handler error:', error);
    return res.status(500).json({ error: error.message });
  }
}
