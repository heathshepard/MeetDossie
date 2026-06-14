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
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return;

  const eqIdx = trimmed.indexOf('=');
  if (eqIdx < 0) return;

  const key = trimmed.substring(0, eqIdx);
  let val = trimmed.substring(eqIdx + 1);

  // Strip quotes
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }

  // Strip trailing \n if present
  val = val.replace(/\\n$/, '');

  if (!process.env[key]) {
    process.env[key] = val;
  }
});

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const FOUNDING_PRICE_ID = 'price_1TPxxNL920SKTEEiN7Gphq8T';
const DRY_RUN = !process.argv.includes('--execute');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) throw new Error('SUPABASE_URL not set');
if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

// GROUP B: Create recurring (no charge today)
const GROUP_B = [
  { name: 'Natalie Megerson', email: 'natalie@localchoicegroup.com', stripeId: 'cus_UYs8AwZ6sWFA4w', subId: '842289ea-8e32-4ef7-90d6-0c9dffca18c6', group: 'B' },
  { name: 'Zelda Cain', email: 'zelda@a2zrealestateconsultants.com', stripeId: 'cus_UYTPKySd3YCa0W', subId: '9c2a0fab-cf19-4d24-87f1-e688984e487e', group: 'B' },
  { name: 'Amanda Nuckles', email: 'amanda@amandanuckles.com', stripeId: 'cus_UYQSHs1waN5ttH', subId: 'f14f6b85-140c-41b5-81c1-f0d8fbcdd2ad', group: 'B' },
  { name: 'Cecilia Whitley', email: 'cecilia@sterlingassociatesre.com', stripeId: 'cus_UYMnDLsF8JFPP6', subId: 'aeeda5fd-41bd-4efd-bc9b-23304bbbf460', group: 'B' },
  { name: 'Miki Mccarthy', email: 'mikirgvrealtor@gmail.com', stripeId: 'cus_UYMCvH2WrDxGy2', subId: '06071312-e5bd-4386-9bcb-84aa1a183118', group: 'B' },
  { name: 'Kim Herrera', email: 'kimberlyherrera@kw.com', stripeId: 'cus_UXthETBewrALK2', subId: 'e3e77fba-363c-4969-8b2a-e75718bd29a3', group: 'B' },
  { name: 'Tiffany Gill', email: 'tgill@phyllisbrowning.com', stripeId: 'cus_UWlrdrLcCjrxHG', subId: '89ad55ad-179f-4335-9984-021d8b7c5759', group: 'B' },
];

// GROUP A: Retry past-due invoices
const GROUP_A = [
  { name: 'Brittney YBarbo', email: 'brittney@setxrealtors.com', group: 'A' },
  { name: 'Suzanne Page', email: 'k.suzanne.page@gmail.com', group: 'A' },
];

const CUSTOMERS_TO_FIX = [...GROUP_A, ...GROUP_B];

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
    console.log(`\n>>> [${customer.group}] ${customer.name} (${customer.email})`);

    try {
      if (customer.group === 'A') {
        // GROUP A: Retry past-due invoices
        console.log(`    Querying subscription for ${customer.email}...`);

        if (DRY_RUN) {
          console.log(`    [DRY] Would look up subscription and retry past-due invoice`);
          results.skipped.push(customer);
          continue;
        }

        // Get profile by email to find subscription ID
        const { data: profiles, error: profileError } = await supabase
          .from('profiles')
          .select('id, stripe_subscription_id')
          .eq('email', customer.email)
          .limit(1);

        if (profileError || !profiles || profiles.length === 0) {
          throw new Error('Profile not found');
        }

        const profile = profiles[0];
        if (!profile.stripe_subscription_id) {
          throw new Error('No stripe_subscription_id in database');
        }

        // Get subscription status
        const sub = await stripe.subscriptions.retrieve(profile.stripe_subscription_id);
        console.log(`    Sub status: ${sub.status}`);

        if (sub.status === 'past_due' && sub.latest_invoice) {
          console.log(`    Retrying past-due invoice...`);
          const paid = await stripe.invoices.pay(sub.latest_invoice);
          console.log(`    ✓ Invoice ${sub.latest_invoice} status: ${paid.status}`);
          results.success.push({
            ...customer,
            action: 'invoice_retry',
            invoiceId: sub.latest_invoice,
            newStatus: paid.status,
          });
        } else if (sub.status === 'active') {
          console.log(`    ✓ Already active, no action needed`);
          results.skipped.push(customer);
        } else {
          throw new Error(`Unexpected subscription status: ${sub.status}`);
        }

      } else {
        // GROUP B: Create recurring subscriptions
        console.log(`    Creating recurring subscription (trial_end +30d)...`);

        if (DRY_RUN) {
          console.log(`    [DRY] Would create subscription for ${customer.stripeId}`);
          console.log(`    [DRY] Would charge $29.00 at trial end`);
          results.skipped.push(customer);
          continue;
        }

        // CREATE SUBSCRIPTION IN STRIPE
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
      }

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

  const groupASuccess = results.success.filter(r => r.group === 'A');
  const groupBSuccess = results.success.filter(r => r.group === 'B');
  const groupAFailed = results.failed.filter(r => r.group === 'A');
  const groupBFailed = results.failed.filter(r => r.group === 'B');

  if (DRY_RUN) {
    console.log(`Dry-run complete.\n`);
    console.log(`Group A (retries):      ${GROUP_A.length} customers`);
    console.log(`Group B (recurring):    ${GROUP_B.length} customers`);
    console.log(`\nTo execute, run: node scripts/fix-stripe-billing-standalone.js --execute`);
  } else {
    console.log(`GROUP A (PAST-DUE RETRIES):`);
    console.log(`  ✓ Retried: ${groupASuccess.length}`);
    console.log(`  ✗ Failed: ${groupAFailed.length}`);

    console.log(`\nGROUP B (RECURRING SETUP):`);
    console.log(`  ✓ Created: ${groupBSuccess.length}`);
    console.log(`  ✗ Failed: ${groupBFailed.length}`);

    const totalRevenue = groupASuccess.length * 29 + groupBSuccess.length * 29;
    console.log(`\nTOTAL:`);
    console.log(`  ✓ Successful: ${results.success.length}`);
    console.log(`  ✗ Failed: ${results.failed.length}`);
    console.log(`  Revenue: $${totalRevenue.toFixed(2)}`);

    if (results.failed.length > 0) {
      console.log(`\nFailed customers:`);
      results.failed.forEach(c => {
        console.log(`  • [${c.group}] ${c.name}: ${c.error}`);
      });
    }
  }

  process.exit(results.failed.length > 0 && !DRY_RUN ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
