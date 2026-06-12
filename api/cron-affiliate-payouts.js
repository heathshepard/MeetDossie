import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const method = req.query.method || 'credit_to_subscription';
  const minPayoutCents = 5000; // $50 minimum

  try {
    // Get all affiliates with unpaid balance >= $50
    const { data: affiliates } = await supabase
      .from('affiliate_links')
      .select(`
        id,
        user_id,
        code,
        earnings_cents,
        paid_out_cents,
        profiles(full_name, email)
      `)
      .gt('earnings_cents', minPayoutCents)
      .gt('earnings_cents', supabase.raw('paid_out_cents'));

    if (!affiliates || affiliates.length === 0) {
      return res.status(200).json({ message: 'No payouts to process' });
    }

    const results = [];

    for (const affiliate of affiliates) {
      const unpaidCents = affiliate.earnings_cents - affiliate.paid_out_cents;

      if (unpaidCents < minPayoutCents) {
        continue;
      }

      try {
        const { data: payout, error: insertError } = await supabase
          .from('affiliate_payouts')
          .insert({
            user_id: affiliate.user_id,
            amount_cents: unpaidCents,
            payout_method: method,
            status: method === 'credit_to_subscription' ? 'sent' : 'pending',
            paid_at: method === 'credit_to_subscription' ? new Date().toISOString() : null,
          })
          .select('id')
          .single();

        if (insertError) {
          results.push({
            code: affiliate.code,
            status: 'failed',
            error: insertError.message,
          });
          continue;
        }

        // If credit_to_subscription: create Stripe customer credit
        if (method === 'credit_to_subscription') {
          const { data: subscription } = await supabase
            .from('subscriptions')
            .select('stripe_customer_id')
            .eq('user_id', affiliate.user_id)
            .eq('status', 'active')
            .single();

          if (subscription?.stripe_customer_id) {
            await stripe.creditNotes.create({
              customer: subscription.stripe_customer_id,
              amount: unpaidCents,
              reason: 'affiliate_reward',
              memo: `Affiliate reward for ${affiliate.referrals_count} referrals`,
            });
          }
        }

        // Update affiliate paid_out_cents
        await supabase
          .from('affiliate_links')
          .update({ paid_out_cents: affiliate.earnings_cents })
          .eq('id', affiliate.id);

        // Send email
        if (affiliate.profiles?.email) {
          const amountFormatted = (unpaidCents / 100).toFixed(2);
          await resend.emails.send({
            from: 'heath@meetdossie.com',
            to: affiliate.profiles.email,
            subject: `💸 Your $${amountFormatted} Dossie affiliate payout is credited`,
            html: `
              <p>Hi ${affiliate.profiles.full_name},</p>
              <p>Your monthly affiliate payout of <strong>$${amountFormatted}</strong> has been processed.</p>
              <p>${method === 'credit_to_subscription' ? 'The credit has been applied to your next subscription invoice.' : 'Please allow 2-3 business days for the transfer to complete.'}</p>
              <p>Thanks for spreading the word about Dossie!</p>
              <p>—Cole</p>
            `,
          });
        }

        results.push({
          code: affiliate.code,
          status: 'processed',
          amount: (unpaidCents / 100).toFixed(2),
        });
      } catch (error) {
        results.push({
          code: affiliate.code,
          status: 'failed',
          error: error.message,
        });
      }
    }

    return res.status(200).json({ processed: results });
  } catch (error) {
    console.error('Payout cron error:', error);
    return res.status(500).json({ error: error.message });
  }
}
