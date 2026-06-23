// Vercel Serverless Function: /api/stripe-billing-audit
// READ-ONLY Stripe audit for the 13 founding customers.
// Returns per-customer: latest invoice status, payment date, sub state,
// current_period_end. Used by atlas_14 to determine which founders silently
// failed to renew month 2 vs which renewed cleanly vs which our DB just lost
// track of (webhook gap).
//
// Auth: Bearer CRON_SECRET
// Verb: GET
//
// Does NOT mutate any Stripe object.

const Stripe = require('stripe');

const CRON_SECRET = process.env.CRON_SECRET;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// The 13 founding customers (Stripe IDs from Supabase profiles + subscriptions tables).
const TARGETS = [
  { name: 'Kay Suzanne Page',     customer: 'cus_URHCyoyRmQr3N2', sub: 'sub_1TSOeFL920SKTEEiTkMJOiaF' },
  { name: 'Brittney Y Barbo',     customer: 'cus_UT2U7lYED1SyUZ', sub: 'sub_1TU6PEL920SKTEEim9a1rKoR' },
  { name: 'Tiffany Gill-Teich',   customer: 'cus_UWlrdrLcCjrxHG', sub: 'sub_1TiHzrL920SKTEEiB9eKdyxq' },
  { name: 'Kim Herrera',          customer: 'cus_UXthETBewrALK2', sub: 'sub_1TiHzqL920SKTEEiKITdZCRk' },
  { name: 'Miki Mccarthy',        customer: 'cus_UYMCvH2WrDxGy2', sub: 'sub_1TiHzpL920SKTEEiXpmWUNeA' },
  { name: 'Cecilia Whitley',      customer: 'cus_UYMnDLsF8JFPP6', sub: 'sub_1TiHznL920SKTEEiVzn8fGXT' },
  { name: 'Terry Katz',           customer: 'cus_UYMdCPErsZoasn', sub: 'sub_1TZFtxL920SKTEEi3lutifH8' },
  { name: 'Amanda Nuckles',       customer: 'cus_UYQSHs1waN5ttH', sub: 'sub_1TiHzmL920SKTEEioPlxuS3A' },
  { name: 'Zelda Cain',           customer: 'cus_UYTPKySd3YCa0W', sub: 'sub_1TiHzkL920SKTEEiXzTYYtKq' },
  { name: 'Natalie Megerson',     customer: 'cus_UYs8AwZ6sWFA4w', sub: 'sub_1TiHzjL920SKTEEi0FNq2KID' },
  { name: 'Jennifer Beltran',     customer: 'cus_UZ6xik4OAbWZ2A', sub: 'sub_1TZyjUL920SKTEEitnzGZVfd' },
  { name: 'Lisa Nilsson',         customer: 'cus_Ub4PaZFpbh3DBF', sub: 'sub_1TbsGbL920SKTEEiy1KWatM1' },
  { name: 'Tiffany Gill (dup)',   customer: 'cus_UWlrdrLcCjrxHG', sub: 'sub_1TXiJRL920SKTEEi9DzVpx0F' },
];

function isoOrNull(unix) {
  if (!unix && unix !== 0) return null;
  return new Date(unix * 1000).toISOString();
}

async function auditOne(t) {
  const out = {
    name: t.name,
    customer_id: t.customer,
    target_sub_id: t.sub,
    sub: null,
    invoices: [],
    latest_invoice_state: null,
    error: null,
  };

  try {
    // Pull the subscription (expanded with latest_invoice + default_payment_method)
    let sub;
    try {
      sub = await stripe.subscriptions.retrieve(t.sub, {
        expand: ['latest_invoice', 'latest_invoice.payment_intent', 'default_payment_method'],
      });
    } catch (e) {
      // Fall back: look up the customer's subs in case the given sub_id is the wrong one
      const subList = await stripe.subscriptions.list({ customer: t.customer, status: 'all', limit: 10 });
      sub = subList.data[0] || null;
      out.sub_retrieve_error = e.message;
    }

    if (sub) {
      out.sub = {
        id: sub.id,
        status: sub.status,
        cancel_at_period_end: sub.cancel_at_period_end,
        current_period_start: isoOrNull(sub.current_period_start),
        current_period_end: isoOrNull(sub.current_period_end),
        canceled_at: isoOrNull(sub.canceled_at),
        ended_at: isoOrNull(sub.ended_at),
        latest_invoice_id: sub.latest_invoice?.id || null,
        latest_invoice_status: sub.latest_invoice?.status || null,
        latest_invoice_amount_paid: sub.latest_invoice?.amount_paid ?? null,
        latest_invoice_payment_intent_status: sub.latest_invoice?.payment_intent?.status || null,
        latest_invoice_payment_intent_failure: sub.latest_invoice?.payment_intent?.last_payment_error?.message || null,
        default_payment_method_brand: sub.default_payment_method?.card?.brand || null,
        default_payment_method_last4: sub.default_payment_method?.card?.last4 || null,
      };
    }

    // Pull last 6 invoices for this customer (covers month 1 + month 2 + retries)
    const invs = await stripe.invoices.list({ customer: t.customer, limit: 6 });
    out.invoices = invs.data.map(inv => ({
      id: inv.id,
      number: inv.number,
      status: inv.status,
      collection_method: inv.collection_method,
      amount_due: inv.amount_due,
      amount_paid: inv.amount_paid,
      attempt_count: inv.attempt_count,
      next_payment_attempt: isoOrNull(inv.next_payment_attempt),
      created: isoOrNull(inv.created),
      due_date: isoOrNull(inv.due_date),
      status_transitions: {
        finalized_at: isoOrNull(inv.status_transitions?.finalized_at),
        paid_at: isoOrNull(inv.status_transitions?.paid_at),
        voided_at: isoOrNull(inv.status_transitions?.voided_at),
        marked_uncollectible_at: isoOrNull(inv.status_transitions?.marked_uncollectible_at),
      },
      period_start: isoOrNull(inv.period_start),
      period_end: isoOrNull(inv.period_end),
      billing_reason: inv.billing_reason,
      subscription: inv.subscription,
      hosted_invoice_url: inv.hosted_invoice_url,
    }));

    // Latest invoice state synthesis
    if (out.invoices.length > 0) {
      const latest = out.invoices[0];
      out.latest_invoice_state = {
        status: latest.status,
        paid_at: latest.status_transitions.paid_at,
        billing_reason: latest.billing_reason,
      };
    }
  } catch (e) {
    out.error = e.message;
  }

  return out;
}

module.exports = async (req, res) => {
  const auth = req.headers.authorization || '';
  const bearer = auth.replace(/^Bearer\s+/i, '').trim();
  if (!CRON_SECRET || bearer !== CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY not set' });
  }

  const results = [];
  for (const t of TARGETS) {
    // eslint-disable-next-line no-await-in-loop
    const r = await auditOne(t);
    results.push(r);
  }

  return res.status(200).json({
    ran_at: new Date().toISOString(),
    target_count: TARGETS.length,
    stripe_api_version: '2024-06-20',
    results,
  });
};
