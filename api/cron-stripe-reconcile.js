// Vercel Serverless Function: /api/cron-stripe-reconcile
// Nightly safety net: reconciles active Stripe founding subscriptions against
// the Supabase subscriptions table. Any customer who paid but was never
// provisioned (webhook gap) gets a subscription row created automatically.
// Phase 3 (Atlas, 2026-08-22) extends the same safety net to the Email
// Integration add-on's separate subscription — see that section below for why.
//
// Logic:
//   1. Fetch all active Stripe subscriptions with price_id = FOUNDING_PRICE_ID.
//   2. For each, check if a subscriptions row exists by stripe_subscription_id.
//   3. If missing: look up or create the auth user, then insert the row.
//   4. Send a Telegram alert to Heath listing every gap fixed (or "all clear").
//   5. Log each gap to ventures_activity_events for audit trail.
//   6. (Phase 3) Same gap-heal, scoped to ADDON_EMAIL_INTEGRATION_PRICE_ID,
//      flipping subscriptions.email_integration_enabled instead of creating a
//      new row (the addon rides on an existing base-plan customer).
//
// Auth: Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Schedule: NOT in vercel.json crons array — trigger via cron-job.org at
//           06:00 UTC daily (1:00 AM CST). Manual: curl -H "Authorization:
//           Bearer $CRON_SECRET" https://meetdossie.com/api/cron-stripe-reconcile
//
// Environment:
//   STRIPE_SECRET_KEY               — Stripe secret key
//   SUPABASE_URL                    — Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY       — service-role JWT
//   TELEGRAM_BOT_TOKEN              — Claudy bot token for Heath alerts
//   TELEGRAM_CHAT_ID                — Heath's Telegram chat ID
//   CRON_SECRET                     — bearer token for manual auth
//   ADDON_EMAIL_INTEGRATION_PRICE_ID — Stripe price id for the Email
//                                      Integration add-on; Phase 3 is skipped
//                                      (logged, not an error) if unset.

// Scheduled-Telegram kill switch (Atlas 2026-08-16). Gates unattended pushes
// to Heath behind TELEGRAM_CRON_NOTIFICATIONS. Two-way chat is unaffected.
require('./_lib/telegram-gate').install('cron-stripe-reconcile');

const Stripe = require('stripe');
const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_MARKETING_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

const FOUNDING_PRICE_ID = 'price_1TPxxNL920SKTEEiN7Gphq8T';
const ADDON_EMAIL_INTEGRATION_PRICE_ID = process.env.ADDON_EMAIL_INTEGRATION_PRICE_ID;

// ---------------------------------------------------------------------------
// Supabase helpers — direct REST fetch, no supabase-js
// ---------------------------------------------------------------------------

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

// ---------------------------------------------------------------------------
// Auth user helpers
// ---------------------------------------------------------------------------

async function findAuthUserIdByEmail(email) {
  if (!email) return null;
  try {
    const encoded = encodeURIComponent(email);
    const r = await supabaseFetch(`/auth/v1/admin/users?email=${encoded}`);
    if (!r.ok) return null;
    const users = Array.isArray(r.data?.users) ? r.data.users : (Array.isArray(r.data) ? r.data : []);
    const match = users.find((u) => String(u.email || '').toLowerCase() === String(email).toLowerCase());
    return match ? match.id : null;
  } catch (err) {
    console.warn('[cron-stripe-reconcile] findAuthUserIdByEmail failed:', err && err.message);
    return null;
  }
}

function toTitleCase(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

async function createAuthUser({ email, fullName }) {
  const buf = require('crypto').randomBytes(36);
  const unusablePassword = buf.toString('base64').replace(/[+/=]/g, '').slice(0, 48);
  try {
    const r = await supabaseFetch('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password: unusablePassword,
        email_confirm: true,
        user_metadata: { full_name: fullName || '' },
      }),
    });
    if (r.ok && r.data && r.data.id) return { userId: r.data.id, created: true };
    if (r.ok && r.data && r.data.user && r.data.user.id) return { userId: r.data.user.id, created: true };
    // 422 = already registered — recover by email lookup
    if (!r.ok) {
      const bodyStr = typeof r.data === 'string' ? r.data : JSON.stringify(r.data || '');
      if (r.status === 422 || bodyStr.toLowerCase().includes('already') || bodyStr.toLowerCase().includes('registered')) {
        const existing = await findAuthUserIdByEmail(email);
        if (existing) return { userId: existing, created: false };
      }
    }
    return { userId: null, created: false };
  } catch (err) {
    console.warn('[cron-stripe-reconcile] createAuthUser threw:', err && err.message);
    return { userId: null, created: false };
  }
}

// ---------------------------------------------------------------------------
// Supabase subscription check + insert
// ---------------------------------------------------------------------------

// Returns true if a subscriptions row already exists for this stripe_subscription_id.
async function subscriptionRowExists(stripeSubscriptionId) {
  if (!stripeSubscriptionId) return false;
  const encoded = encodeURIComponent(stripeSubscriptionId);
  const r = await supabaseFetch(
    `/rest/v1/subscriptions?stripe_subscription_id=eq.${encoded}&select=id&limit=1`,
  );
  return r.ok && Array.isArray(r.data) && r.data.length > 0;
}

// Returns true if a subscriptions row already exists for this user_id.
// Needed because the unique constraint is on user_id — a user may already be
// provisioned under a DIFFERENT stripe_subscription_id (e.g. resubscribe).
// Without this, the reconciler attempts INSERT and catches a 409 that it
// mislabels as an error in the digest.
async function subscriptionRowExistsForUser(userId) {
  if (!userId) return false;
  const encoded = encodeURIComponent(userId);
  const r = await supabaseFetch(
    `/rest/v1/subscriptions?user_id=eq.${encoded}&select=id,stripe_subscription_id&limit=1`,
  );
  return r.ok && Array.isArray(r.data) && r.data.length > 0;
}

// Insert a new subscription row. Uses ON CONFLICT DO NOTHING (idempotent).
async function insertSubscriptionRow({
  userId, stripeCustomerId, stripeSubscriptionId, stripePriceId,
  currentPeriodStart, currentPeriodEnd,
}) {
  const r = await supabaseFetch('/rest/v1/subscriptions?on_conflict=stripe_subscription_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({
      user_id: userId,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      stripe_price_id: stripePriceId,
      plan: 'founding',
      status: 'active',
      current_period_start: currentPeriodStart,
      current_period_end: currentPeriodEnd,
    }),
  });
  return r;
}

// Also patch the profiles row so subscription_status reflects 'active'.
async function patchProfileByUserId(userId) {
  if (!userId) return;
  const encoded = encodeURIComponent(userId);
  await supabaseFetch(`/rest/v1/profiles?id=eq.${encoded}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ subscription_status: 'active', plan: 'founding', subscription_tier: 'founding' }),
  });
}

// ---------------------------------------------------------------------------
// ventures_activity_events logging
// ---------------------------------------------------------------------------

async function logActivity({ summary, detail }) {
  try {
    await supabaseFetch('/rest/v1/ventures_activity_events', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        agent_name: 'cron-stripe-reconcile',
        company: 'Dossie',
        event_type: 'stripe_reconcile',
        summary,
        detail,
      }),
    });
  } catch (err) {
    console.warn('[cron-stripe-reconcile] logActivity failed:', err && err.message);
  }
}

// ---------------------------------------------------------------------------
// Telegram alert
// ---------------------------------------------------------------------------

async function sendTelegramAlert(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[cron-stripe-reconcile] Telegram not configured — skipping alert');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error('[cron-stripe-reconcile] Telegram alert failed:', res.status, t.slice(0, 200));
    }
  } catch (err) {
    console.error('[cron-stripe-reconcile] Telegram alert threw:', err && err.message);
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

module.exports = withTelemetry('cron-stripe-reconcile', async function handler(req, res) {
  // Auth: accept Vercel's built-in cron header OR manual Bearer token.
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!STRIPE_SECRET_KEY) {
    return res.status(500).json({ ok: false, error: 'STRIPE_SECRET_KEY not configured' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

  console.log('[cron-stripe-reconcile] starting reconcile run at', new Date().toISOString());

  // Fetch all active Stripe subscriptions for the founding price.
  // Stripe paginates at 100 items — loop through all pages.
  const allStripeSubs = [];
  let startingAfter = undefined;
  let page = 0;
  try {
    while (true) {
      page += 1;
      const params = {
        price: FOUNDING_PRICE_ID,
        status: 'active',
        limit: 100,
      };
      if (startingAfter) params.starting_after = startingAfter;

      const list = await stripe.subscriptions.list(params);
      console.log(`[cron-stripe-reconcile] page ${page}: fetched ${list.data.length} subscriptions`);
      allStripeSubs.push(...list.data);

      if (!list.has_more) break;
      startingAfter = list.data[list.data.length - 1].id;
    }
  } catch (err) {
    console.error('[cron-stripe-reconcile] Stripe subscriptions.list failed:', err && err.message);
    return res.status(500).json({ ok: false, error: 'Failed to fetch Stripe subscriptions: ' + String(err && err.message || err) });
  }

  console.log(`[cron-stripe-reconcile] total active founding subscriptions in Stripe: ${allStripeSubs.length}`);

  const gaps = [];         // subscriptions newly provisioned this run
  const errors = [];       // REAL errors only — actual failures (network, perm, malformed data).
                           // Constraint-violation 409s on existing rows are NOT errors; they get
                           // counted in alreadyProvisioned via the SELECT-first check below.
  let alreadyProvisioned = 0;
  let skippedDemoAccounts = 0;

  for (const sub of allStripeSubs) {
    const stripeSubscriptionId = sub.id;
    const stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id) || null;
    const stripePriceId = sub?.items?.data?.[0]?.price?.id || FOUNDING_PRICE_ID;

    const currentPeriodStart = sub.current_period_start
      ? new Date(sub.current_period_start * 1000).toISOString() : null;
    const currentPeriodEnd = sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString() : null;

    // Idempotency: if row exists, skip.
    let rowExists = false;
    try {
      rowExists = await subscriptionRowExists(stripeSubscriptionId);
    } catch (err) {
      console.warn('[cron-stripe-reconcile] subscriptionRowExists check failed for', stripeSubscriptionId, ':', err && err.message);
    }

    if (rowExists) {
      alreadyProvisioned += 1;
      continue;
    }

    // Gap detected — this Stripe subscription has no Supabase row.
    console.log('[cron-stripe-reconcile] GAP detected: sub=', stripeSubscriptionId, 'customer=', stripeCustomerId);

    // Resolve customer email from Stripe.
    let customerEmail = null;
    let customerName = '';
    if (stripeCustomerId) {
      try {
        const customer = await stripe.customers.retrieve(stripeCustomerId);
        if (customer && !customer.deleted) {
          customerEmail = customer.email ? String(customer.email).toLowerCase() : null;
          customerName = toTitleCase(customer.name || '');
        }
      } catch (err) {
        console.warn('[cron-stripe-reconcile] customers.retrieve failed for', stripeCustomerId, ':', err && err.message);
      }
    }

    if (!customerEmail) {
      const errMsg = `No customer email found for sub=${stripeSubscriptionId} customer=${stripeCustomerId}`;
      console.error('[cron-stripe-reconcile]', errMsg);
      errors.push({ stripeSubscriptionId, stripeCustomerId, error: errMsg });
      continue;
    }

    // Skip demo accounts.
    if (customerEmail === 'demo@meetdossie.com' || customerEmail === 'demo2@meetdossie.com' || customerEmail === 'heath.shepard@gmail.com') {
      console.log('[cron-stripe-reconcile] skipping demo/test account:', customerEmail);
      skippedDemoAccounts += 1;
      continue;
    }

    // Resolve or create auth user.
    let userId = null;
    try {
      userId = await findAuthUserIdByEmail(customerEmail);
      if (!userId) {
        const result = await createAuthUser({ email: customerEmail, fullName: customerName });
        userId = result.userId;
        console.log('[cron-stripe-reconcile] created placeholder auth user for', customerEmail, 'userId=', userId);
      } else {
        console.log('[cron-stripe-reconcile] found existing auth user for', customerEmail, 'userId=', userId);
      }
    } catch (err) {
      const errMsg = `Failed to resolve userId for ${customerEmail}: ${err && err.message}`;
      console.error('[cron-stripe-reconcile]', errMsg);
      errors.push({ stripeSubscriptionId, customerEmail, error: errMsg });
      continue;
    }

    if (!userId) {
      const errMsg = `No userId resolved for ${customerEmail}`;
      console.error('[cron-stripe-reconcile]', errMsg);
      errors.push({ stripeSubscriptionId, customerEmail, error: errMsg });
      continue;
    }

    // SELECT-first by user_id — the unique constraint is on user_id, so a row
    // may already exist under a different stripe_subscription_id (e.g. resub).
    // This avoids the INSERT-and-catch-409 noise that was polluting the digest.
    let userAlreadyHasSubscription = false;
    try {
      userAlreadyHasSubscription = await subscriptionRowExistsForUser(userId);
    } catch (err) {
      console.warn('[cron-stripe-reconcile] subscriptionRowExistsForUser check failed for', userId, ':', err && err.message);
    }

    if (userAlreadyHasSubscription) {
      console.log('[cron-stripe-reconcile] user already provisioned (different sub_id):', customerEmail, 'userId=', userId);
      alreadyProvisioned += 1;
      continue;
    }

    // Insert the missing subscription row.
    try {
      const ins = await insertSubscriptionRow({
        userId, stripeCustomerId, stripeSubscriptionId, stripePriceId,
        currentPeriodStart, currentPeriodEnd,
      });
      if (!ins.ok) {
        // 409 conflict means the row was inserted between our SELECT and INSERT
        // (race), OR another unique constraint matched. Either way the user IS
        // provisioned — count as alreadyProvisioned, not an error.
        if (ins.status === 409) {
          console.log('[cron-stripe-reconcile] insert hit 409 (already provisioned via race) for', customerEmail);
          alreadyProvisioned += 1;
          continue;
        }
        const errMsg = `Insert failed status=${ins.status} body=${JSON.stringify(ins.data).slice(0, 200)}`;
        console.error('[cron-stripe-reconcile]', errMsg, 'for', customerEmail);
        errors.push({ stripeSubscriptionId, customerEmail, error: errMsg });
        continue;
      }
      console.log('[cron-stripe-reconcile] inserted subscription row for', customerEmail, 'sub=', stripeSubscriptionId);
    } catch (err) {
      const errMsg = `Insert threw: ${err && err.message}`;
      console.error('[cron-stripe-reconcile]', errMsg, 'for', customerEmail);
      errors.push({ stripeSubscriptionId, customerEmail, error: errMsg });
      continue;
    }

    // Patch the profile row to reflect active subscription.
    try {
      await patchProfileByUserId(userId);
    } catch (err) {
      console.warn('[cron-stripe-reconcile] patchProfileByUserId failed for', userId, ':', err && err.message);
      // Non-fatal — subscription row is already written; profile patch can be retried.
    }

    gaps.push({ stripeSubscriptionId, stripeCustomerId, customerEmail, customerName, userId });

    // Log to ventures_activity_events.
    await logActivity({
      summary: `Reconcile gap fixed: ${customerEmail} (sub ${stripeSubscriptionId})`,
      detail: { stripeSubscriptionId, stripeCustomerId, customerEmail, userId },
    });
  }

  // ---------------------------------------------------------------------------
  // Phase 2 (NEW 2026-07-04): DB-side drift detection.
  // The reconciler's INSERT-only logic doesn't catch the case where a DB row
  // exists for a user but points to an OLD canceled stripe_subscription_id
  // while a NEWER active sub exists for the same customer (resubscribe pattern
  // that triggered the July 4 incident). Walk every DB row whose sub_id we did
  // NOT match in the active-Stripe list and flag it for Heath's attention.
  // We do NOT auto-heal here — Heath decides which sub_id to keep — but we
  // surface every drift row so it stops being invisible.
  const activeStripeSubIds = new Set(allStripeSubs.map((s) => s.id));
  let dbDrift = [];
  try {
    const dbRows = await supabaseFetch(
      `/rest/v1/subscriptions?status=eq.active&plan=eq.founding&select=user_id,stripe_subscription_id,stripe_customer_id,current_period_end,updated_at`,
    );
    if (dbRows.ok && Array.isArray(dbRows.data)) {
      for (const row of dbRows.data) {
        if (!row.stripe_subscription_id) continue;
        if (!activeStripeSubIds.has(row.stripe_subscription_id)) {
          // DB says active but this sub isn't in Stripe's active list.
          // Enrich with email for the digest.
          let email = null;
          try {
            const encoded = encodeURIComponent(row.user_id);
            const p = await supabaseFetch(`/rest/v1/profiles?id=eq.${encoded}&select=email&limit=1`);
            if (p.ok && Array.isArray(p.data) && p.data.length > 0) email = p.data[0].email;
          } catch (_) { /* email is nice-to-have */ }
          dbDrift.push({
            email,
            user_id: row.user_id,
            stale_sub_id: row.stripe_subscription_id,
            stripe_customer_id: row.stripe_customer_id,
            db_current_period_end: row.current_period_end,
          });
        }
      }
    }
  } catch (err) {
    console.warn('[cron-stripe-reconcile] Phase 2 drift check failed:', err && err.message);
  }

  // ---------------------------------------------------------------------------
  // Phase 3 (NEW 2026-08-22, Atlas): Email Integration add-on reconciliation.
  // Flagged by Quinn's 2026-08-22 QA pass — the addon's webhook
  // (handleAddonCheckoutCompleted in stripe-webhook.js) had no self-healer if
  // it silently failed, unlike the base plan handled above. The addon is a
  // SECOND Stripe subscription on an existing customer (never a new auth
  // user/profile), so healing means flipping
  // subscriptions.email_integration_enabled + email_integration_stripe_sub_id
  // on the row that already exists, matched via the subscription's
  // metadata.user_id (set at checkout by create-addon-checkout-session.js) or,
  // failing that, stripe_customer_id.
  //
  // Mirrors Phase 1/2's split: auto-heal the "paid but not enabled" gap
  // (same failure mode as the base plan). The reverse case — DB shows
  // enabled=true but the recorded Stripe sub is no longer active — is
  // flagged only, not auto-disabled, same conservative policy as Phase 2's
  // base-plan drift (Heath reviews before anything gets revoked).
  // ---------------------------------------------------------------------------
  const addonGaps = [];
  const addonErrors = [];
  let addonAlreadyProvisioned = 0;
  let addonDrift = [];

  if (!ADDON_EMAIL_INTEGRATION_PRICE_ID) {
    console.log('[cron-stripe-reconcile] ADDON_EMAIL_INTEGRATION_PRICE_ID not configured — skipping addon reconciliation (Phase 3)');
  } else {
    const allAddonSubs = [];
    try {
      let addonStartingAfter;
      while (true) {
        const params = { price: ADDON_EMAIL_INTEGRATION_PRICE_ID, status: 'active', limit: 100 };
        if (addonStartingAfter) params.starting_after = addonStartingAfter;
        const list = await stripe.subscriptions.list(params);
        allAddonSubs.push(...list.data);
        if (!list.has_more) break;
        addonStartingAfter = list.data[list.data.length - 1].id;
      }
    } catch (err) {
      console.error('[cron-stripe-reconcile] addon subscriptions.list failed:', err && err.message);
      addonErrors.push({ error: 'Failed to fetch addon subscriptions: ' + String(err && err.message || err) });
    }

    console.log(`[cron-stripe-reconcile] total active addon subscriptions in Stripe: ${allAddonSubs.length}`);

    for (const sub of allAddonSubs) {
      const stripeSubscriptionId = sub.id;
      const stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id) || null;
      const metaUserId = (sub.metadata && sub.metadata.user_id) || null;

      let row = null;
      try {
        if (metaUserId) {
          const r = await supabaseFetch(`/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(metaUserId)}&select=user_id,email_integration_enabled,email_integration_stripe_sub_id&limit=1`);
          if (r.ok && Array.isArray(r.data) && r.data.length > 0) row = r.data[0];
        }
        if (!row && stripeCustomerId) {
          const r = await supabaseFetch(`/rest/v1/subscriptions?stripe_customer_id=eq.${encodeURIComponent(stripeCustomerId)}&select=user_id,email_integration_enabled,email_integration_stripe_sub_id&limit=1`);
          if (r.ok && Array.isArray(r.data) && r.data.length > 0) row = r.data[0];
        }
      } catch (err) {
        console.warn('[cron-stripe-reconcile] addon row lookup failed for', stripeSubscriptionId, ':', err && err.message);
      }

      if (!row) {
        const errMsg = `Active addon sub ${stripeSubscriptionId} (customer ${stripeCustomerId}) matches no subscriptions row — cannot self-heal without a user_id`;
        console.error('[cron-stripe-reconcile]', errMsg);
        addonErrors.push({ stripeSubscriptionId, stripeCustomerId, error: errMsg });
        continue;
      }

      if (row.email_integration_enabled && row.email_integration_stripe_sub_id === stripeSubscriptionId) {
        addonAlreadyProvisioned += 1;
        continue;
      }

      try {
        const patch = await supabaseFetch(`/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(row.user_id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ email_integration_enabled: true, email_integration_stripe_sub_id: stripeSubscriptionId }),
        });
        if (!patch.ok) {
          const errMsg = `Addon patch failed status=${patch.status} body=${JSON.stringify(patch.data).slice(0, 200)}`;
          console.error('[cron-stripe-reconcile]', errMsg, 'for user', row.user_id);
          addonErrors.push({ stripeSubscriptionId, userId: row.user_id, error: errMsg });
          continue;
        }
        console.log('[cron-stripe-reconcile] addon GAP fixed: enabled email_integration for user_id=', row.user_id, 'sub=', stripeSubscriptionId);
        addonGaps.push({ stripeSubscriptionId, stripeCustomerId, userId: row.user_id });
        await logActivity({
          summary: `Addon reconcile gap fixed: email_integration for user ${row.user_id} (sub ${stripeSubscriptionId})`,
          detail: { stripeSubscriptionId, stripeCustomerId, userId: row.user_id },
        });
      } catch (err) {
        const errMsg = `Addon patch threw: ${err && err.message}`;
        console.error('[cron-stripe-reconcile]', errMsg, 'for user', row.user_id);
        addonErrors.push({ stripeSubscriptionId, userId: row.user_id, error: errMsg });
      }
    }

    // Reverse drift: DB says enabled, but the recorded sub_id isn't active in Stripe.
    try {
      const activeAddonSubIds = new Set(allAddonSubs.map((s) => s.id));
      const enabledRows = await supabaseFetch(
        `/rest/v1/subscriptions?email_integration_enabled=eq.true&select=user_id,email_integration_stripe_sub_id`,
      );
      if (enabledRows.ok && Array.isArray(enabledRows.data)) {
        for (const row of enabledRows.data) {
          if (!row.email_integration_stripe_sub_id) continue; // enabled by hand, not Stripe-tracked
          if (!activeAddonSubIds.has(row.email_integration_stripe_sub_id)) {
            addonDrift.push({ userId: row.user_id, stale_sub_id: row.email_integration_stripe_sub_id });
          }
        }
      }
    } catch (err) {
      console.warn('[cron-stripe-reconcile] addon drift check failed:', err && err.message);
    }

    console.log(`[cron-stripe-reconcile] addon done — ${addonAlreadyProvisioned} already provisioned, ${addonGaps.length} gaps fixed, ${addonErrors.length} errors, ${addonDrift.length} drift rows`);
  }

  console.log(`[cron-stripe-reconcile] done — ${alreadyProvisioned} already provisioned, ${gaps.length} gaps fixed, ${skippedDemoAccounts} demo/test accounts skipped, ${errors.length} real errors, ${dbDrift.length} drift rows`);

  // Send Telegram alert.
  // Digest shape (clean — no INSERT-and-catch-409 noise):
  //   Stripe reconcile YYYY-MM-DD
  //   ✅ <N> verified provisioned (<gaps> newly provisioned, <already> already on file)
  //   ⏭ <skipped> demo/test skipped
  //   🛠 <gaps> new provisioning required
  //   ⚠ <errors> real errors
  const dateStr = new Date().toISOString().slice(0, 10);
  const verifiedTotal = alreadyProvisioned + gaps.length;
  const lines = [
    `<b>Stripe reconcile ${dateStr}</b>`,
    `✅ ${verifiedTotal} verified provisioned (${gaps.length} newly provisioned, ${alreadyProvisioned} already on file)`,
    `⏭ ${skippedDemoAccounts} demo/test skipped`,
    `🛠 ${gaps.length} new provisioning required`,
    `⚠ ${errors.length} real errors`,
  ];

  if (gaps.length > 0) {
    const gapLines = gaps.map((g) => `  - ${g.customerEmail} (sub ${g.stripeSubscriptionId})`).join('\n');
    lines.push('', `Newly provisioned:`, gapLines);
  }

  if (errors.length > 0) {
    const errLines = errors.map((e) => `  - ${e.customerEmail || e.stripeSubscriptionId}: ${e.error}`).join('\n');
    lines.push('', `Real errors (need investigation):`, errLines);
  }

  if (dbDrift.length > 0) {
    const driftLines = dbDrift.map((d) => `  - ${d.email || d.user_id}: DB sub=${d.stale_sub_id} (not active in Stripe), cust=${d.stripe_customer_id}`).join('\n');
    lines.push('', `🚨 DB DRIFT (${dbDrift.length}) — DB shows active but Stripe sub is not active. Manual review:`, driftLines);
  }

  if (ADDON_EMAIL_INTEGRATION_PRICE_ID) {
    const addonVerifiedTotal = addonAlreadyProvisioned + addonGaps.length;
    lines.push(
      '',
      `<b>Email Integration add-on</b>`,
      `✅ ${addonVerifiedTotal} verified enabled (${addonGaps.length} newly fixed, ${addonAlreadyProvisioned} already on file)`,
      `⚠ ${addonErrors.length} real errors`,
    );
    if (addonGaps.length > 0) {
      const addonGapLines = addonGaps.map((g) => `  - user ${g.userId} (sub ${g.stripeSubscriptionId})`).join('\n');
      lines.push('', 'Addon gaps fixed:', addonGapLines);
    }
    if (addonErrors.length > 0) {
      const addonErrLines = addonErrors.map((e) => `  - ${e.userId || e.stripeCustomerId || e.stripeSubscriptionId || 'unknown'}: ${e.error}`).join('\n');
      lines.push('', 'Addon errors (need investigation):', addonErrLines);
    }
    if (addonDrift.length > 0) {
      const addonDriftLines = addonDrift.map((d) => `  - user ${d.userId}: DB enabled=true but sub=${d.stale_sub_id} not active in Stripe`).join('\n');
      lines.push('', `🚨 ADDON DRIFT (${addonDrift.length}) — enabled in DB but Stripe sub inactive. Manual review:`, addonDriftLines);
    }
  }

  const telegramText = lines.join('\n');

  await sendTelegramAlert(telegramText);

  return res.status(200).json({
    ok: true,
    ran_at: new Date().toISOString(),
    total_stripe_subs: allStripeSubs.length,
    verified_provisioned: alreadyProvisioned + gaps.length,
    already_provisioned: alreadyProvisioned,
    gaps_fixed: gaps.length,
    demo_accounts_skipped: skippedDemoAccounts,
    real_errors: errors.length,
    gaps,
    error_details: errors,
    db_drift_count: dbDrift.length,
    db_drift: dbDrift,
    addon_configured: Boolean(ADDON_EMAIL_INTEGRATION_PRICE_ID),
    addon_total_stripe_subs: addonGaps.length + addonAlreadyProvisioned,
    addon_already_enabled: addonAlreadyProvisioned,
    addon_gaps_fixed: addonGaps.length,
    addon_real_errors: addonErrors.length,
    addon_gaps: addonGaps,
    addon_error_details: addonErrors,
    addon_drift_count: addonDrift.length,
    addon_drift: addonDrift,
  });
});
