/**
 * ADMIN: Fix Stripe billing for customers with missing subscription IDs
 *
 * Endpoint: POST /api/admin-fix-stripe-billing
 * Auth: CRON_SECRET (bearer token)
 * Query: ?dry_run=true (default) or ?dry_run=false (execute)
 *
 * Creates recurring subscriptions for 7 customers and retries 2 past-due charges.
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FOUNDING_PRICE_ID = 'price_1TPxxNL920SKTEEiN7Gphq8T';

// Customers with no subscription ID (need to create)
const CUSTOMERS_TO_FIX = [
  { name: 'Natalie Megerson', email: 'natalie@localchoicegroup.com', stripeId: 'cus_UYs8AwZ6sWFA4w' },
  { name: 'Zelda Cain', email: 'zelda@a2zrealestateconsultants.com', stripeId: 'cus_UYTPKySd3YCa0W' },
  { name: 'Amanda Nuckles', email: 'amanda@amandanuckles.com', stripeId: 'cus_UYQSHs1waN5ttH' },
  { name: 'Cecilia Whitley', email: 'cecilia@sterlingassociatesre.com', stripeId: 'cus_UYMnDLsF8JFPP6' },
  { name: 'Miki Mccarthy', email: 'mikirgvrealtor@gmail.com', stripeId: 'cus_UYMCvH2WrDxGy2' },
  { name: 'Kim Herrera', email: 'kimberlyherrera@kw.com', stripeId: 'cus_UXthETBewrALK2' },
  { name: 'Tiffany Gill', email: 'tgill@phyllisbrowning.com', stripeId: 'cus_UWlrdrLcCjrxHG' },
];

export default async function handler(req, res) {
  // Auth check
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');

  if (token !== process.env.CRON_SECRET) {
    return res.status(403).json({ ok: false, error: 'Unauthorized' });
  }

  const dryRun = req.query.dry_run !== 'false'; // Default true for safety

  console.log(`[admin-fix-stripe-billing] Mode: ${dryRun ? 'DRY_RUN' : 'EXECUTE'}`);

  const results = {
    mode: dryRun ? 'DRY_RUN' : 'EXECUTE',
    success: [],
    failed: [],
    skipped: [],
  };

  // Fix customers with no subscription ID
  for (const customer of CUSTOMERS_TO_FIX) {
    try {
      console.log(`Processing ${customer.name}...`);

      if (dryRun) {
        results.skipped.push({
          name: customer.name,
          email: customer.email,
          action: 'Would create subscription',
        });
        continue;
      }

      // Create subscription in Stripe
      const subscription = await stripe.subscriptions.create({
        customer: customer.stripeId,
        items: [{ price: FOUNDING_PRICE_ID }],
        payment_behavior: 'error_if_incomplete',
        expand: ['latest_invoice.payment_intent'],
      });

      console.log(`✓ Created subscription ${subscription.id} for ${customer.name}`);

      // Find the subscription record in our DB and update it
      const { data: subs, error: fetchErr } = await supabase
        .from('subscriptions')
        .select('id')
        .eq('stripe_customer_id', customer.stripeId)
        .eq('plan', 'founding')
        .single();

      if (fetchErr) {
        throw new Error(`Could not find subscription record: ${fetchErr.message}`);
      }

      // Update with the new Stripe subscription ID
      const { error: updateErr } = await supabase
        .from('subscriptions')
        .update({ stripe_subscription_id: subscription.id })
        .eq('id', subs.id);

      if (updateErr) {
        throw new Error(`Could not update DB: ${updateErr.message}`);
      }

      results.success.push({
        name: customer.name,
        email: customer.email,
        stripeSubscriptionId: subscription.id,
        amount: 29.00,
        status: subscription.status,
      });

    } catch (error) {
      console.error(`✗ Failed for ${customer.name}: ${error.message}`);
      results.failed.push({
        name: customer.name,
        email: customer.email,
        error: error.message,
      });
    }
  }

  // Summary
  const totalRevenue = results.success.length * 29;

  return res.status(200).json({
    ok: true,
    ...results,
    summary: {
      mode: dryRun ? 'DRY_RUN' : 'LIVE',
      charged: results.success.length,
      failed: results.failed.length,
      totalRevenue: `$${totalRevenue.toFixed(2)}`,
    },
  });
}
