/**
 * Admin Billing Pulse API
 * Returns billing/payment metrics for the dashboard BILLING PULSE widget
 * Fetches: MRR, past-due count, active subs, recent payments, failed payments
 * Auth: requires logged-in user with email = heath.shepard@kw.com
 */

import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth check
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized - no token' });
  }

  const token = authHeader.replace('Bearer ', '');
  const supabase = createClient(supabaseUrl, supabaseKey);

  // Verify token and get user
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);

  if (authError || !user) {
    return res.status(401).json({ error: 'Unauthorized - invalid token' });
  }

  // Admin check
  if (user.email !== 'heath.shepard@kw.com') {
    return res.status(403).json({ error: 'Forbidden - admin only' });
  }

  try {
    // 1. Get subscription counts and MRR
    const { data: activeSubs, error: subError } = await supabase
      .from('subscriptions')
      .select('id, status, current_period_end, stripe_price_id')
      .eq('status', 'active');

    if (subError) {
      throw new Error(`Failed to fetch subscriptions: ${subError.message}`);
    }

    const activeSusbCount = activeSubs?.length || 0;
    // Assume founding price = $29/mo; other prices calculated proportionally
    // For now, simple calc: count * $29
    const mrr = activeSusbCount * 2900; // in cents

    // 2. Get past-due count
    const { data: pastDueSubs, error: pastDueError } = await supabase
      .from('subscriptions')
      .select('id, status')
      .eq('status', 'past_due');

    if (pastDueError) {
      throw new Error(`Failed to fetch past-due subs: ${pastDueError.message}`);
    }

    const pastDueCount = pastDueSubs?.length || 0;

    // 3. Get recent successful payments (last 5)
    const { data: recentPayments, error: payError } = await supabase
      .from('stripe_payment_log')
      .select('id, stripe_invoice_id, amount_paid_cents, currency, paid_at, stripe_customer_id')
      .order('paid_at', { ascending: false })
      .limit(5);

    if (payError) {
      console.warn('[admin-billing-pulse] Failed to fetch recent payments:', payError.message);
      // Non-fatal, continue
    }

    // 4. Enrich recent payments with customer names
    let recentPaymentsEnriched = [];
    if (recentPayments && Array.isArray(recentPayments)) {
      for (const payment of recentPayments) {
        // Look up customer email/name via subscription
        let customerName = 'Unknown';
        try {
          if (payment.stripe_customer_id) {
            const { data: subData } = await supabase
              .from('subscriptions')
              .select('user_id')
              .eq('stripe_customer_id', payment.stripe_customer_id)
              .limit(1);

            if (subData && subData.length > 0 && subData[0].user_id) {
              const { data: profileData } = await supabase
                .from('profiles')
                .select('full_name')
                .eq('id', subData[0].user_id)
                .limit(1);

              if (profileData && profileData.length > 0 && profileData[0].full_name) {
                customerName = profileData[0].full_name.split(' ')[0]; // First name only
              }
            }
          }
        } catch (err) {
          console.warn('[admin-billing-pulse] Failed to enrich payment customer name:', err.message);
        }

        recentPaymentsEnriched.push({
          invoiceId: payment.stripe_invoice_id,
          customerName,
          amountCents: payment.amount_paid_cents,
          currency: payment.currency || 'USD',
          paidAt: payment.paid_at,
        });
      }
    }

    // 5. Get failed payments (from subscriptions with past_due status)
    let failedPayments = [];
    if (pastDueSubs && Array.isArray(pastDueSubs) && pastDueSubs.length > 0) {
      // Fetch the profile data for each past-due subscription
      for (const sub of pastDueSubs.slice(0, 5)) {
        try {
          const { data: subData } = await supabase
            .from('subscriptions')
            .select('user_id, status, updated_at')
            .eq('id', sub.id)
            .limit(1);

          if (subData && subData.length > 0 && subData[0].user_id) {
            const { data: profileData } = await supabase
              .from('profiles')
              .select('full_name')
              .eq('id', subData[0].user_id)
              .limit(1);

            if (profileData && profileData.length > 0) {
              failedPayments.push({
                customerName: profileData[0].full_name.split(' ')[0],
                status: subData[0].status || 'past_due',
                since: subData[0].updated_at,
              });
            }
          }
        } catch (err) {
          console.warn('[admin-billing-pulse] Failed to enrich failed payment:', err.message);
        }
      }
    }

    // 6. Live Stripe balance — our stripe_payment_log misses invoice.paid
    // events (webhook only handles checkout.session.completed), so recurring
    // renewals aren't recorded locally. Hit the Balance API directly.
    let stripeAvailableUsd = null;
    let stripePendingUsd = null;
    let stripeBalanceError = null;
    try {
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (stripeKey) {
        const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });
        const balance = await stripe.balance.retrieve();
        let availCents = 0;
        let pendCents = 0;
        for (const b of (balance.available || [])) {
          if (b.currency === 'usd') availCents += b.amount;
        }
        for (const b of (balance.pending || [])) {
          if (b.currency === 'usd') pendCents += b.amount;
        }
        stripeAvailableUsd = Number((availCents / 100).toFixed(2));
        stripePendingUsd = Number((pendCents / 100).toFixed(2));
      } else {
        stripeBalanceError = 'STRIPE_SECRET_KEY not configured';
      }
    } catch (err) {
      stripeBalanceError = err.message || String(err);
      console.warn('[admin-billing-pulse] Stripe balance fetch failed:', stripeBalanceError);
    }

    res.status(200).json({
      success: true,
      billing: {
        mrr, // in cents
        mrrFormatted: `$${(mrr / 100).toFixed(2)}`,
        activeSubscriptions: activeSusbCount,
        pastDueCount,
        recentPayments: recentPaymentsEnriched,
        failedPayments,
        stripeAvailableUsd,
        stripePendingUsd,
        stripeBalanceError,
      },
    });
  } catch (error) {
    console.error('[admin-billing-pulse] Error:', error.message);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
