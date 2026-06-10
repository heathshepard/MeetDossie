# Stripe Payment Link Rollout — Audit & Harden

**Author:** Pierce (Growth, Conversion & Customer Success — Shepard Ventures)
**For:** Carter (implementation)
**Filed:** 2026-06-08
**Status:** Ready for implementation
**Scope correction:** The original mandate ("create a permanent Payment Link, replace one-shot checkout sessions, handle invoice.paid") describes work that is **already shipped**. I verified by reading `api/stripe-webhook.js`, `api/_lib/founding-approval.js`, `api/create-checkout-session.js`, and `api/cron-stripe-reconcile.js`. This brief therefore audits what's there, fixes gaps Pierce found, and pushes the hardening one notch further.

**What's already live (do NOT rebuild):**
- ✅ Permanent Payment Link in env var `STRIPE_FOUNDING_PAYMENT_LINK`, consumed by `_lib/founding-approval.js`
- ✅ Approval email uses the Payment Link, prefilled with email via `?prefilled_email=`
- ✅ Webhook handles `checkout.session.completed`, `invoice.paid`, `customer.subscription.created` (safety net), `customer.subscription.deleted`
- ✅ Nightly reconciliation at `api/cron-stripe-reconcile.js` (Telegram alert + ventures activity log)
- ✅ Three webhook-gap incidents (Terry Katz, Jennifer Beltrán, Lisa Nilsson) — Lisa was the last (2026-05-28). The fix landed 2026-05-28 (per CLAUDE.md GOLD-2026-05-28-v1).

**Why this brief still ships:** I found four real gaps below. None are catastrophic, but each one risks a future incident.

---

## Gap 1 — `create-checkout-session.js` is still creating one-shot sessions for `/founding` page clicks

**The problem:** When a visitor clicks "Join as Founding Member" on `https://meetdossie.com/founding`, the JS POSTs to `/api/create-checkout-session` which **creates a one-shot Stripe Checkout Session** (24h expiry). That bypasses the Payment Link entirely. The Payment Link is only used for the *applied + approved* path through the Telegram approval flow.

This means:
1. Direct `/founding` traffic hits the old one-shot pattern.
2. If a visitor abandons checkout, comes back the next day, the session has expired and they can't resume — they'd hit the `cancel_url` and start over.
3. The two flows produce subscriptions tagged the same way in Stripe metadata (`source: 'founding_landing'`), so we can't tell them apart in reconciliation.

**The fix:**

Update `founding.html` Join button to redirect **directly to the Payment Link** instead of POST-ing to `/api/create-checkout-session`. The Payment Link supports email prefill via query string, but in this case the visitor hasn't given us an email yet — Stripe will collect it on the Payment Link page itself.

### Code change in `founding.html`

Replace the entire `async function () { ... button.addEventListener("click", ...) }` block (lines 408-442) with:

```js
// Join button → permanent Stripe Payment Link
(function () {
  var button = document.getElementById("join-button");
  if (!button) return;

  // The Payment Link URL is injected at build time / hardcoded.
  // Source: env var STRIPE_FOUNDING_PAYMENT_LINK (live in Vercel).
  // Carter: replace the placeholder below with the live Payment Link URL.
  // It's safe to expose — Payment Links are public-by-design URLs.
  var PAYMENT_LINK_URL = "REPLACE_WITH_LIVE_STRIPE_FOUNDING_PAYMENT_LINK";

  button.addEventListener("click", function () {
    // Pass UTM source through Stripe metadata via client_reference_id (the
    // Payment Link surfaces this on the checkout session and the subscription).
    var params = new URLSearchParams(window.location.search);
    var utmSource = params.get("utm_source") || sessionStorage.getItem("utm_source") || "";
    var separator = PAYMENT_LINK_URL.includes("?") ? "&" : "?";
    var url = PAYMENT_LINK_URL + (utmSource ? separator + "client_reference_id=" + encodeURIComponent(utmSource) : "");
    window.location.href = url;
  });
})();
```

**Then remove `/api/create-checkout-session.js`** — nothing should still call it. Carter: search the codebase for `/api/create-checkout-session` before deleting; if anything else calls it (admin tools, scripts), gate the deletion. Confirmed callers as of this brief: only `founding.html` (which this brief replaces) and `memory/project_create_checkout_session.md` (memory note about the approval-email-sends-this-URL pattern, now obsolete).

### Pre-implementation question for Heath (via Cole)

Heath needs to confirm the live Payment Link URL value. It's the value currently in Vercel env `STRIPE_FOUNDING_PAYMENT_LINK`. Carter: read the env value from `/api/admin-stripe-tools` or have Cole ask Heath to copy/paste it.

---

## Gap 2 — `checkout.session.completed` is the only webhook event setting `status='active'` on first paid customers

**The problem:** Re-read `api/stripe-webhook.js` `handleCheckoutSessionCompleted()` (lines 326-416). It sets `status='pending_onboarding'` — NOT `'active'`. The activation flip happens in `api/complete-onboarding.js` after the welcome form is submitted on `welcome.html`.

This creates a bug class: **a paid customer who abandons the welcome.html form is permanently stuck at `pending_onboarding`**, even though Stripe collected their money. They don't get the welcome email. They never set a password. They're stuck.

I cannot verify how many historical customers are in this state without running a Supabase query — Carter should run it as Step 1 of the rollout.

### Diagnostic query (Carter runs in Supabase SQL Editor)

```sql
-- Find paid customers stuck at pending_onboarding
SELECT
  s.id AS subscription_id,
  s.user_id,
  s.stripe_subscription_id,
  s.status,
  s.created_at,
  s.current_period_start,
  p.email,
  p.full_name,
  p.created_at AS profile_created_at,
  EXTRACT(EPOCH FROM (NOW() - s.created_at)) / 86400 AS days_stuck
FROM subscriptions s
LEFT JOIN profiles p ON p.id = s.user_id
WHERE s.status = 'pending_onboarding'
  AND s.created_at < NOW() - INTERVAL '2 hours'  -- give the onboarding flow 2h to complete
ORDER BY s.created_at DESC;
```

If this returns ANY rows, those are paid customers in limbo. Carter: surface the list to Cole; Pierce will write the rescue copy (Heath manually emails them).

### Hardening fix — auto-flip after 24 hours

Add a new branch to `cron-stripe-reconcile.js` (after the current "reconcile gaps" logic, before the Telegram alert is composed):

```js
// Step 2: Auto-flip stuck pending_onboarding subscriptions to active after 24h.
// If a customer paid but never completed onboarding, they should still be
// marked 'active' so they receive billing renewals and don't show up as a
// payment leak. Heath will personally email them the onboarding link.
console.log('[cron-stripe-reconcile] checking for stuck pending_onboarding subscriptions...');
const stuckQuery = `/rest/v1/subscriptions?status=eq.pending_onboarding&created_at=lt.${encodeURIComponent(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())}&select=id,user_id,stripe_subscription_id,created_at`;
const stuckR = await supabaseFetch(stuckQuery);
const stuckRows = (stuckR.ok && Array.isArray(stuckR.data)) ? stuckR.data : [];
const flippedToActive = [];
for (const row of stuckRows) {
  try {
    await supabaseFetch(`/rest/v1/subscriptions?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'active' }),
    });
    flippedToActive.push(row);
    await logActivity({
      summary: `Auto-flipped pending_onboarding → active (24h+ stale): sub_id=${row.id}`,
      detail: { subscription_id: row.id, stripe_subscription_id: row.stripe_subscription_id, age_hours: Math.round((Date.now() - new Date(row.created_at).getTime()) / 3600000) },
    });
  } catch (err) {
    console.error('[cron-stripe-reconcile] auto-flip failed for sub_id=', row.id, ':', err && err.message);
  }
}
console.log(`[cron-stripe-reconcile] flipped ${flippedToActive.length} pending_onboarding → active`);
```

And extend the Telegram alert text to include the flip count.

---

## Gap 3 — `cron-stripe-reconcile.js` is NOT scheduled

I checked `vercel.json` against this file. The function exists and has a route mapping (line 163) but it's NOT in the `crons` array — there is no schedule. The comment at the top of the file says "trigger via cron-job.org at 06:00 UTC daily" but external cron services are fragile.

### Fix

Add to `vercel.json`:

```json
{
  "crons": [
    // ...existing entries...
    {
      "path": "/api/cron-stripe-reconcile",
      "schedule": "0 6 * * *"
    }
  ]
}
```

Vercel cron uses UTC. `0 6 * * *` = 06:00 UTC = 1:00 AM CST = 12:00 AM CDT. This is the safety net we wrote and never armed.

Confirm: there's an `x-vercel-cron: 1` header check already in the handler (line 211), so Vercel cron auth works out of the box.

---

## Gap 4 — `cron-stripe-reconcile.js` doesn't send the welcome email when it fixes a gap

**The problem:** When the reconcile script finds a paid Stripe customer with no Supabase subscription row, it:
1. Creates an auth user
2. Inserts the subscription row
3. Patches the profile

But it does **NOT** send the welcome email + password-reset email. The customer paid, got nothing, and we never tell them they have an account.

Compare with `handleInvoicePaid()` lines 604-628 — that path DOES send both emails. Reconcile should match.

### Fix

In `cron-stripe-reconcile.js`, after the `insertSubscriptionRow` succeeds and the `patchProfileByUserId` succeeds, add:

```js
// Send the same welcome + password-set emails that handleInvoicePaid does.
// Reuse the helpers by extracting them from stripe-webhook.js into a shared
// module: api/_lib/welcome-emails.js.
const { sendWelcomeAndPasswordEmails } = require('./_lib/welcome-emails');
await sendWelcomeAndPasswordEmails({
  email: customerEmail,
  fullName: customerName,
  resendKey: process.env.RESEND_API_KEY,
  supabaseUrl: SUPABASE_URL,
  supabaseKey: SUPABASE_SERVICE_ROLE_KEY,
});
```

### Extraction step

Move these functions from `api/stripe-webhook.js` into a new `api/_lib/welcome-emails.js`:

- `welcomeEmailHtml(fullName)` (line 257)
- `setPasswordEmailHtml(actionLink)` (line 287)
- `generateRecoveryLink(email)` (line 140)
- `sendEmail({ to, subject, html })` (line 297)
- New wrapper: `sendWelcomeAndPasswordEmails({ email, fullName, resendKey, supabaseUrl, supabaseKey })` that calls both

Then have `stripe-webhook.js` import from the shared module so it doesn't duplicate. **Critical:** preserve the BCC to `heath@meetdossie.com` in `sendEmail` (per memory rule `feedback_bcc_heath_on_all_emails`).

---

## Gap 5 — No source attribution on reconcile-fixed subscriptions

When `cron-stripe-reconcile.js` inserts a missing subscription row, it has no idea where the customer came from (no `source`, no UTM data). Pair this with the PostHog spec's new `source` column on `subscriptions` (see `posthog-instrumentation-spec.md` §5).

### Fix

In `cron-stripe-reconcile.js` `insertSubscriptionRow()`, add a `source: 'reconcile_recovered'` to the body. This way, when Pierce queries source breakdown in PostHog or Supabase, she can see exactly how many customers came through the safety net vs. the happy path. If `reconcile_recovered` ever exceeds 5% of monthly signups, something is broken upstream and we need to investigate.

---

## Test plan (Quinn runs after Carter ships)

### Test 1 — `/founding` Join button uses the Payment Link

1. Visit `https://staging.meetdossie.com/founding`
2. Click "Join as Founding Member"
3. Confirm browser redirects to `buy.stripe.com/<payment-link-id>` (NOT to a `checkout.stripe.com/c/...` session URL)

### Test 2 — Webhook handles `invoice.paid` correctly with the Stripe CLI

```bash
stripe trigger invoice.paid \
  --override invoice:customer_email=test+webhook@meetdossie.com \
  --override invoice:lines.data[0].price.id=price_1TPxxNL920SKTEEiN7Gphq8T
```

Expected:
- Supabase `profiles` row created with `email='test+webhook@meetdossie.com'`
- Supabase `subscriptions` row inserted, `status='active'`
- Telegram alert fires to Heath
- TWO Resend emails sent (welcome + password-set), both BCC'd to `heath@meetdossie.com`

### Test 3 — `checkout.session.completed` flow ends at `pending_onboarding`, then completes via welcome.html

1. Run a Stripe TEST mode checkout via the Payment Link
2. Confirm `subscriptions` row inserted with `status='pending_onboarding'`
3. Fill out `welcome.html` form
4. Confirm `complete-onboarding.js` flips the row to `status='active'`

### Test 4 — Reconciliation cron runs and reports

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://staging.meetdossie.com/api/cron-stripe-reconcile
```

Expected:
- 200 OK with JSON `{ ok: true, total_stripe_subs: N, already_provisioned: N, gaps_fixed: 0, errors: 0 }`
- Telegram alert fires: "Stripe reconcile (date): all clear."

### Test 5 — Reconciliation auto-flips stale pending_onboarding

1. In Supabase: `UPDATE subscriptions SET created_at = NOW() - INTERVAL '48 hours', status = 'pending_onboarding' WHERE user_id = '<test_user_id>';`
2. Trigger reconcile (as in Test 4)
3. Confirm subscription row flipped to `status='active'`
4. Confirm `ventures_activity_events` has the audit row
5. Confirm Telegram alert mentions the flip

---

## Summary of files Carter will touch

| File | Change |
|---|---|
| `founding.html` | Replace Join button JS with direct Payment Link redirect (Gap 1) |
| `api/create-checkout-session.js` | **Delete** after confirming no other callers (Gap 1) |
| `api/stripe-webhook.js` | Refactor: extract email helpers into `api/_lib/welcome-emails.js` (Gap 4) |
| `api/_lib/welcome-emails.js` | **New** file — shared welcome + password-set email helpers (Gap 4) |
| `api/cron-stripe-reconcile.js` | Add stuck-pending-onboarding auto-flip (Gap 2); send welcome emails on gap fix (Gap 4); tag inserts with `source='reconcile_recovered'` (Gap 5) |
| `vercel.json` | Add `0 6 * * *` cron entry for `/api/cron-stripe-reconcile` (Gap 3) |

---

## Cost summary

- **$0.** No new services. No new Vercel functions. The Vercel cron schedule is free (Hobby plan allows daily crons).
- Implementation: ~3-4 hours Carter work end to end.
- Risk: low — every change is additive (auto-flip, schedule, source tag) or a clean refactor (extract email helpers).

---

## Open questions for Carter (flag to Cole before starting)

1. **Live Payment Link URL value** — Carter needs the actual `STRIPE_FOUNDING_PAYMENT_LINK` value to hardcode in `founding.html`. Cole asks Heath.
2. **Number of stuck `pending_onboarding` rows** — run the Gap 2 diagnostic query before doing anything else. If it returns >0 rows, Pierce drafts personal-touch recovery emails for Heath to send before the auto-flip runs.
3. **Confirm no other callers of `/api/create-checkout-session`** — Carter greps the full repo (including the Dossie React repo at `C:\Users\Heath Shepard\Desktop\Dossie\`) before deleting. The memory note `project_create_checkout_session.md` says it's load-bearing for the approval email path, but per `_lib/founding-approval.js` line 8-11, the email now uses the Payment Link, so the memory note is stale and Cole should update it.

---

## Sequencing

If Carter has to pick:

1. **Hour 1:** Gap 2 diagnostic query (Carter runs in Supabase, surfaces results to Cole). This is non-destructive and tells us if there's a customer-service fire to put out.
2. **Hour 2:** Gap 3 (add vercel.json cron entry). One-line change, zero risk, lights up the safety net immediately.
3. **Hour 2-3:** Gap 4 (extract welcome-emails helper, wire into reconcile). Most code volume.
4. **Hour 3:** Gap 5 (source tag on reconcile inserts). Trivial change.
5. **Hour 4:** Gap 1 (replace `/founding` Join button → Payment Link redirect, delete create-checkout-session.js). Touches the customer-facing landing page, ships last so Quinn can give it the most attention in QA.
6. **Hour 5:** Gap 2 (auto-flip stale pending_onboarding). Ship LAST and only after Pierce has emailed any actual stuck customers — we don't want the cron to silently flip them before Heath personally reaches out.

If Carter only has time for one: **Gap 3** (Vercel cron schedule). The reconcile script is the safety net for everything else, and it's currently disarmed.
