#!/usr/bin/env node
/**
 * STANDALONE STRIPE BILLING FIX
 *
 * Creates recurring subscriptions for 7 customers with no stripe_subscription_id.
 *
 * Usage: node fix-stripe-billing-standalone.js [--execute]
 * Default is DRY_RUN=true. Add --execute flag to actually charge.
 */

// Load .env.local manually
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');

envContent.split('\n').forEach(line => {
  const match = line.match(/^([^=]+)="?([^"]*)"?$/);
  if (match && !process.env[match[1]]) {
    process.env[match[1]] = match[2];
  }
});

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const FOUNDING_PRICE_ID = 'price_1TPxxNL920SKTEEiN7Gphq8T';
const DRY_RUN = !process.argv.includes('--execute');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CUSTOMERS_TO_FIX = [
  { name: 'Natalie Megerson', email: 'natalie@localchoicegroup.com', stripeId: 'cus_UYs8AwZ6sWFA4w', subId: '842289ea-8e32-4ef7-90d6-0c9dffca18c6' },
  { name: 'Zelda Cain', email: 'zelda@a2zrealestateconsultants.com', stripeId: 'cus_UYTPKySd3YCa0W', subId: '9c2a0fab-cf19-4d24-87f1-e688984e487e' },
  { name: 'Amanda Nuckles', email: 'amanda@amandanuckles.com', stripeId: 'cus_UYQSHs1waN5ttH', subId: 'f14f6b85-140c-41b5-81c1-f0d8fbcdd2ad' },
  { name: 'Cecilia Whitley', email: 'cecilia@sterlingassociatesre.com', stripeId: 'cus_UYMnDLsF8JFPP6', subId: 'aeeda5fd-41bd-4efd-bc9b-23304bbbf460' },
  { name: 'Miki Mccarthy', email: 'mikirgvrealtor@gmail.com', stripeId: 'cus_UYMCvH2WrDxGy2', subId: '06071312-e5bd-4386-9bcb-84aa1a183118' },
  { name: 'Kim Herrera', email: 'kimberlyherrera@kw.com', stripeId: 'cus_UXthETBewrALK2', subId: 'e3e77fba-363c-4969-8b2a-e75718bd29a3' },
  { name: 'Tiffany Gill', email: 'tgill@phyllisbrowning.com', stripeId: 'cus_UWlrdrLcCjrxHG', subId: '89ad55ad-179f-4335-9984-021d8b7c5759' },
];

async function main() {
  console.log('═══ STRIPE BILLING FIX — EXECUTION ═══\n');
  console.log(`MODE: ${DRY_RUN ? 'DRY_RUN (no charges)' : 'LIVE EXECUTION'}\n`);

  if (DRY_RUN) {
    console.log('To execute charges, run: node fix-stripe-billing-standalone.js --execute\n');
  }

  const results = {
    success: [],
    failed: [],
    skipped: [],
  };

  for (const customer of CUSTOMERS_TO_FIX) {
    console.log(`\n>>> ${customer.name} (${customer.email})`);

    try {
      if (DRY_RUN) {
        console.log(`    [DRY] Would create subscription for ${customer.stripeId}`);
        console.log(`    [DRY] Would charge $29.00`);
        results.skipped.push(customer);
        continue;
      }

      // CREATE SUBSCRIPTION IN STRIPE
      console.log(`    Creating Stripe subscription...`);
      const subscription = await stripe.subscriptions.create({
        customer: customer.stripeId,
        items: [{ price: FOUNDING_PRICE_ID }],
        payment_behavior: 'error_if_incomplete',
        expand: ['latest_invoice.payment_intent'],
      });

      console.log(`    ✓ Stripe subscription created: ${subscription.id}`);
      console.log(`    ✓ Status: ${subscription.status}`);
      console.log(`    ✓ Amount charged: $${(subscription.items.data[0].price.unit_amount / 100).toFixed(2)}`);

      // UPDATE DATABASE
      console.log(`    Updating database...`);
      const { data, error } = await supabase
        .from('subscriptions')
        .update({ stripe_subscription_id: subscription.id })
        .eq('id', customer.subId);

      if (error) {
        throw new Error(`DB update failed: ${error.message}`);
      }

      console.log(`    ✓ Database updated`);

      results.success.push({
        ...customer,
        stripeSubscriptionId: subscription.id,
        amount: 29.00,
      });

    } catch (error) {
      console.log(`    ✗ FAILED: ${error.message}`);
      results.failed.push({
        ...customer,
        error: error.message,
      });
    }
  }

  // SUMMARY
  console.log(`\n\n═══ EXECUTION SUMMARY ═══\n`);

  if (DRY_RUN) {
    console.log(`Dry-run complete. Ready to charge ${CUSTOMERS_TO_FIX.length} customers.`);
    console.log(`Potential revenue: $${CUSTOMERS_TO_FIX.length * 29}`);
  } else {
    const totalRevenue = results.success.length * 29;
    console.log(`✓ Successfully charged: ${results.success.length}`);
    console.log(`✗ Failed: ${results.failed.length}`);
    console.log(`Total revenue recovered: $${totalRevenue.toFixed(2)}`);

    if (results.failed.length > 0) {
      console.log(`\nFailed customers:`);
      results.failed.forEach(c => {
        console.log(`  • ${c.name}: ${c.error}`);
      });
    }
  }

  process.exit(results.failed.length > 0 && !DRY_RUN ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
