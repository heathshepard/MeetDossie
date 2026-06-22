#!/usr/bin/env node
/**
 * Stripe Subscription Backfill Script
 *
 * Purpose: Pull the current state of all active subscriptions from Stripe API
 * and sync into Supabase subscriptions table. Used to fix stale period dates
 * when invoice.paid events were missed or the database got out of sync.
 *
 * Usage:
 *   node scripts/stripe-sync-all-subs.js [--dry-run] [--limit N]
 *
 * Env vars required:
 *   STRIPE_SECRET_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Safety:
 *   - Read-only from Stripe (no mutations)
 *   - Dry-run mode by default (pass --dry-run=false to commit)
 *   - Logs every update before executing
 *   - Idempotent (safe to re-run)
 */

const Stripe = require('stripe');
// Load .env.local if it exists (optional)
try {
  require('dotenv').config({ path: '.env.local' });
} catch (err) {
  // dotenv not installed, use process.env directly (Vercel deployment)
}

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Parse CLI args
const isDryRun = !process.argv.includes('--dry-run=false');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

const FOUNDING_PRICE_ID = 'price_1TPxxNL920SKTEEiN7Gphq8T';

if (!STRIPE_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing env vars: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

async function supabaseFetch(path, init = {}) {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Supabase ${init.method || 'GET'} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getAllActiveSubscriptionsFromDB() {
  const rows = await supabaseFetch('/rest/v1/subscriptions?status=eq.active&select=id,user_id,stripe_subscription_id&order=created_at.asc');
  return Array.isArray(rows) ? rows : [];
}

async function updateSubscription(subId, patch) {
  const encoded = encodeURIComponent(subId);
  await supabaseFetch(`/rest/v1/subscriptions?stripe_subscription_id=eq.${encoded}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

async function logPayment({ invoiceId, subscriptionId, customerId, amountCents, currency, paidAt, hostedInvoiceUrl }) {
  if (!invoiceId) return;
  try {
    await supabaseFetch('/rest/v1/stripe_payment_log', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        stripe_invoice_id: invoiceId,
        stripe_subscription_id: subscriptionId,
        stripe_customer_id: customerId,
        amount_paid_cents: amountCents,
        currency: currency || 'USD',
        paid_at: paidAt,
        hosted_invoice_url: hostedInvoiceUrl,
      }),
    });
  } catch (err) {
    if (!err.message.includes('duplicate')) {
      console.warn('  ⚠ logPayment failed:', err.message);
    }
  }
}

async function syncSub(stripeSubId) {
  try {
    const sub = await stripe.subscriptions.retrieve(stripeSubId);

    // Check if founding tier
    const priceId = sub?.items?.data?.[0]?.price?.id || null;
    if (priceId !== FOUNDING_PRICE_ID) {
      console.log(`  SKIP sub=${stripeSubId}: not founding tier`);
      return { status: 'skip', reason: 'not founding tier' };
    }

    const currentPeriodStart = sub.current_period_start
      ? new Date(sub.current_period_start * 1000).toISOString()
      : null;
    const currentPeriodEnd = sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null;

    // Map Stripe status to our status
    let statusToSet = sub.status;
    if (sub.status === 'active') {
      statusToSet = 'active';
    } else if (sub.status === 'past_due') {
      statusToSet = 'past_due';
    } else if (sub.status === 'canceled') {
      statusToSet = 'cancelled';
    }

    const patch = {
      status: statusToSet,
      current_period_start: currentPeriodStart,
      current_period_end: currentPeriodEnd,
      cancel_at_period_end: sub.cancel_at_period_end || false,
    };

    if (isDryRun) {
      console.log(`  DRY-RUN: would update sub=${stripeSubId} status=${statusToSet} period_end=${currentPeriodEnd}`);
    } else {
      await updateSubscription(stripeSubId, patch);
      console.log(`  ✓ updated sub=${stripeSubId} status=${statusToSet} period_end=${currentPeriodEnd}`);
    }

    // Fetch last 3 invoices and log them
    try {
      const invoices = await stripe.invoices.list({
        subscription: stripeSubId,
        status: 'paid',
        limit: 3,
      });

      if (invoices && invoices.data && Array.isArray(invoices.data)) {
        for (const inv of invoices.data) {
          if (!isDryRun) {
            await logPayment({
              invoiceId: inv.id,
              subscriptionId: stripeSubId,
              customerId: sub.customer,
              amountCents: inv.amount_paid,
              currency: inv.currency,
              paidAt: new Date(inv.paid_date * 1000).toISOString(),
              hostedInvoiceUrl: inv.hosted_invoice_url,
            });
          }
        }
        if (invoices.data.length > 0) {
          console.log(`  → logged ${invoices.data.length} payment(s) from Stripe`);
        }
      }
    } catch (err) {
      console.warn(`  ⚠ failed to fetch invoices for sub=${stripeSubId}:`, err.message);
    }

    return { status: 'updated', patch };
  } catch (err) {
    console.error(`  ERROR sub=${stripeSubId}:`, err.message);
    return { status: 'error', error: err.message };
  }
}

async function main() {
  console.log('Stripe Subscription Backfill Script');
  console.log('====================================');
  console.log(`Dry-run mode: ${isDryRun}`);
  if (isDryRun) {
    console.log('  (Pass --dry-run=false to commit changes)');
  }
  if (limit) {
    console.log(`Limit: ${limit} subscriptions`);
  }
  console.log('');

  console.log('Fetching active subscriptions from Supabase...');
  const dbSubs = await getAllActiveSubscriptionsFromDB();
  console.log(`Found ${dbSubs.length} active subscriptions`);
  console.log('');

  const toProcess = limit ? dbSubs.slice(0, limit) : dbSubs;
  console.log(`Processing ${toProcess.length} subscriptions...`);
  console.log('');

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const { stripe_subscription_id: subId } = toProcess[i];
    console.log(`[${i + 1}/${toProcess.length}] ${subId}`);

    const result = await syncSub(subId);
    if (result.status === 'updated') updated++;
    else if (result.status === 'skip') skipped++;
    else if (result.status === 'error') failed++;
  }

  console.log('');
  console.log('====================================');
  console.log('Summary:');
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Failed:  ${failed}`);
  console.log('');

  if (isDryRun) {
    console.log('⚠️  DRY-RUN MODE — no changes committed.');
    console.log('To commit, run with: --dry-run=false');
  } else {
    console.log('✓ Backfill complete. Check stripe_payment_log table for payment audit trail.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
