#!/usr/bin/env node
// One-shot helper: create the permanent Stripe Payment Link for the founding
// member subscription. Print the URL so it can be pasted into Vercel as
// STRIPE_FOUNDING_PAYMENT_LINK. Run once; the URL never expires.
//
// Usage (PowerShell):
//   $env:STRIPE_SECRET_KEY = "sk_live_..."
//   node scripts/create-founding-payment-link.js
//
// Usage (bash):
//   STRIPE_SECRET_KEY=sk_live_... node scripts/create-founding-payment-link.js

const Stripe = require('stripe');

const FOUNDING_PRICE_ID = 'price_1TPxxNL920SKTEEiN7Gphq8T';
const REDIRECT_URL = 'https://meetdossie.com/welcome.html?session_id={CHECKOUT_SESSION_ID}';

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error('STRIPE_SECRET_KEY not set in env. Aborting.');
    process.exit(1);
  }
  const stripe = new Stripe(key, { apiVersion: '2024-06-20' });

  const link = await stripe.paymentLinks.create({
    line_items: [{ price: FOUNDING_PRICE_ID, quantity: 1 }],
    allow_promotion_codes: false,
    after_completion: {
      type: 'redirect',
      redirect: { url: REDIRECT_URL },
    },
    metadata: { source: 'founding_approval' },
    subscription_data: { metadata: { source: 'founding_approval' } },
  });

  console.log('');
  console.log('✅ Payment Link created');
  console.log('');
  console.log('  id:  ' + link.id);
  console.log('  url: ' + link.url);
  console.log('');
  console.log('Add to Vercel env:  STRIPE_FOUNDING_PAYMENT_LINK=' + link.url);
}

main().catch((err) => {
  console.error('Failed to create payment link:', (err && err.message) || err);
  process.exit(1);
});
