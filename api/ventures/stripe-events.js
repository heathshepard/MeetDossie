// api/ventures/stripe-events.js
// Returns last 5 Stripe events for the ventures dashboard
// Refreshed every 60s by the frontend

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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

    const formatted = events.data.map(ev => {
      let amount = null;
      let description = '';

      if (ev.type === 'payment_intent.succeeded') {
        const pi = ev.data.object;
        amount = pi.amount ? `$${(pi.amount / 100).toFixed(2)}` : null;
        description = 'Payment succeeded';
      } else if (ev.type === 'customer.subscription.created') {
        description = 'Subscription created';
      } else if (ev.type === 'customer.subscription.updated') {
        description = 'Subscription updated';
      } else if (ev.type === 'customer.subscription.deleted') {
        description = 'Subscription cancelled';
      } else if (ev.type === 'invoice.payment_succeeded') {
        const inv = ev.data.object;
        amount = inv.amount_paid ? `$${(inv.amount_paid / 100).toFixed(2)}` : null;
        description = 'Invoice paid';
      } else if (ev.type === 'invoice.payment_failed') {
        description = 'Invoice payment failed';
      } else {
        description = ev.type.replace(/_/g, ' ');
      }

      return {
        id: ev.id,
        type: ev.type,
        description,
        amount,
        timestamp: new Date(ev.created * 1000).toISOString(),
      };
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ events: formatted });
  } catch (e) {
    console.error('[stripe-events] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
