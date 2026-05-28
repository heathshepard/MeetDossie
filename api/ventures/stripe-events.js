// api/ventures/stripe-events.js
// Returns last 5 Stripe events for the ventures dashboard
// Refreshed every 60s by the frontend

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Resolve a Stripe customer ID to a human name via subscriptions -> profiles join
async function resolveCustomerName(stripeCustomerId) {
  if (!stripeCustomerId) return null;
  try {
    // Look up subscription row with matching stripe_customer_id
    const subRes = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?select=user_id&stripe_customer_id=eq.${encodeURIComponent(stripeCustomerId)}&limit=1`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    if (!subRes.ok) return null;
    const subs = await subRes.json();
    if (!subs.length) return null;
    const userId = subs[0].user_id;

    // Fetch the profile name
    const profRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?select=full_name,email&id=eq.${encodeURIComponent(userId)}&limit=1`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    if (!profRes.ok) return null;
    const profiles = await profRes.json();
    if (!profiles.length) return null;
    return profiles[0].full_name || profiles[0].email || null;
  } catch {
    return null;
  }
}

async function verifyToken(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const events = await stripe.events.list({
      limit: 5,
      types: [
        'payment_intent.succeeded',
        'customer.subscription.created',
        'customer.subscription.updated',
        'customer.subscription.deleted',
        'invoice.payment_succeeded',
        'invoice.payment_failed',
      ],
    });

    // Process events and resolve customer names in parallel
    const formatted = await Promise.all(events.data.map(async ev => {
      let amount = null;
      let description = '';
      const customerId = ev.data.object?.customer || null;

      // Resolve customer name from Supabase
      const customerName = await resolveCustomerName(customerId);

      if (ev.type === 'payment_intent.succeeded') {
        const pi = ev.data.object;
        amount = pi.amount ? `$${(pi.amount / 100).toFixed(2)}` : null;
        description = customerName ? `${customerName} - Payment succeeded` : 'Payment succeeded';
      } else if (ev.type === 'customer.subscription.created') {
        description = customerName ? `${customerName} - Subscription created` : 'Subscription created';
      } else if (ev.type === 'customer.subscription.updated') {
        description = customerName ? `${customerName} - Subscription updated` : 'Subscription updated';
      } else if (ev.type === 'customer.subscription.deleted') {
        description = customerName ? `${customerName} - Subscription cancelled` : 'Subscription cancelled';
      } else if (ev.type === 'invoice.payment_succeeded') {
        const inv = ev.data.object;
        amount = inv.amount_paid ? `$${(inv.amount_paid / 100).toFixed(2)}` : null;
        description = customerName ? `${customerName} - Invoice paid` : 'Invoice paid';
      } else if (ev.type === 'invoice.payment_failed') {
        description = customerName ? `${customerName} - Invoice payment failed` : 'Invoice payment failed';
      } else {
        description = (customerName ? `${customerName} - ` : '') + ev.type.replace(/_/g, ' ');
      }

      return {
        id: ev.id,
        type: ev.type,
        description,
        amount,
        customerName,
        timestamp: new Date(ev.created * 1000).toISOString(),
      };
    }));

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ events: formatted });
  } catch (e) {
    console.error('[stripe-events] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
