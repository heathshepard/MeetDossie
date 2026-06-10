# PostHog Instrumentation Spec

**Author:** Pierce (Growth, Conversion & Customer Success — Shepard Ventures)
**For:** Carter (implementation)
**Filed:** 2026-06-08
**Status:** Ready for implementation
**Why we're doing this:** As of today the Dossie funnel is uninstrumented. We have no idea what % of `/founding` visitors click "Join," what % of approved applicants pay, or how long Lisa took between paying and her first login. Every Pierce recommendation from now on is guesswork unless we fix that. The reference library (`shared/pierce-reference-library/ab-testing-and-experiments.md` §3) flags this as the must-have prerequisite for any conversion test.

---

## 1. Account creation (Heath does this — ~5 min)

1. Go to https://us.posthog.com/signup
2. Sign up with `heath@meetdossie.com`. Region: **US Cloud** (TX customer data residency is easier on US-Cloud than EU).
3. Organization name: `Shepard Ventures`. Project name: `MeetDossie`.
4. After signup, go to **Project Settings → Project API Key**. Copy the `phc_...` key.
5. Add to Vercel env vars (both `Production` and `Preview`):
   - `POSTHOG_KEY` = `phc_...` (the key from step 4)
   - `POSTHOG_HOST` = `https://us.i.posthog.com`
   - `NEXT_PUBLIC_POSTHOG_KEY` = same value as `POSTHOG_KEY` (browser-exposed)
   - `NEXT_PUBLIC_POSTHOG_HOST` = same value as `POSTHOG_HOST`
6. Confirm to Cole when done so Carter can ship.

**Cost confirmation:** PostHog free tier = 1M events/mo + 5K session recordings + 1-year data retention. At Dossie's current 12 customers + ~50-200 visitors/day, we are nowhere near the cap for at least 12 months. **$0 forever at current volume.** When we cross 100K events/mo (probably at ~300 paying customers) we revisit. No surprises.

---

## 2. Event taxonomy

### Acquisition events (fire from browser)

| Event name | Payload | Where it fires |
|---|---|---|
| `$pageview` | (auto-captured) | All pages, automatic via posthog-js |
| `founding_landing_viewed` | `{ utm_source, utm_medium, utm_campaign, referrer }` | `founding.html` on load |
| `founding_join_clicked` | `{ time_on_page_seconds }` | `founding.html` Join button click, BEFORE the `fetch` to create-checkout-session |
| `agents_page_viewed` | `{ utm_source }` | `agents/index.html` on load |
| `coordinators_page_viewed` | `{ utm_source }` | `coordinators/index.html` on load |
| `calculator_email_submitted` | `{ email_domain }` (NOT the email itself) | `calculator.html` form submit |
| `guide_viewed` | `{ guide_slug }` | All `guides/*/index.html` pages on load |
| `answer_viewed` | `{ answer_slug }` | All `answers/*/index.html` pages on load |

### Conversion events (server-side from API routes)

| Event name | Payload | Where it fires |
|---|---|---|
| `founding_application_submitted` | `{ application_id, heard_from, transactions_12mo, sides, brokerage, market }` | `api/notify-founding-application.js` after the DB lookup succeeds |
| `founding_application_approved` | `{ application_id, heard_from, time_since_submitted_minutes }` | `api/_lib/founding-approval.js` `approveFoundingApplication()` after the email send succeeds |
| `founding_application_rejected` | `{ application_id, heard_from }` | `api/_lib/founding-approval.js` `rejectFoundingApplication()` |
| `checkout_session_created` | `{ source: 'founding_landing', has_email_prefill }` | `api/create-checkout-session.js` after Stripe returns a session |
| `checkout_completed` | `{ stripe_subscription_id, stripe_customer_id, plan, amount_cents, source }` | `api/stripe-webhook.js` `handleCheckoutSessionCompleted()` after subscription upsert |
| `direct_invoice_provisioned` | `{ stripe_subscription_id, source: 'direct_invoice' }` | `api/stripe-webhook.js` `handleInvoicePaid()` after welcome email send |
| `subscription_cancelled` | `{ stripe_subscription_id, days_active }` | `api/stripe-webhook.js` `handleSubscriptionDeleted()` |
| `onboarding_completed` | `{ phone_collected, brokerage, market, heard_from }` | `api/complete-onboarding.js` after profile upsert succeeds |

### Activation events (fire from React workspace bundle — client-side)

These are the most important events for the activation crisis. Every one of them must fire from the React app on first occurrence per user. Use a `localStorage` key per event to dedupe (`posthog_fired_<event_name>`) — fire once per browser/session is fine; we'll see them via cohorts not raw counts.

| Event name | Payload | Where it fires (in `Dossie` React repo, not `MeetDossie`) |
|---|---|---|
| `app_first_login` | `{ user_id, time_since_payment_seconds }` | React app mount, when `session.user.id` first appears AND `localStorage.posthog_fired_first_login` is unset |
| `dossier_first_created` | `{ user_id, transaction_id, time_since_first_login_seconds }` | After Supabase `transactions.insert()` succeeds for the first time for this user |
| `document_first_uploaded` | `{ user_id, document_type, time_since_first_login_seconds }` | After Supabase Storage upload + `documents.insert()` succeeds for the first time |
| `talk_to_dossie_first_used` | `{ user_id, mode: 'voice' | 'text' }` | First message sent to Talk to Dossie |
| `morning_brief_first_played` | `{ user_id }` | First time the play button on the morning brief audio is clicked |
| `share_button_clicked` | `{ method: 'copy' | 'facebook' | 'sms', user_id }` | Share button click (already tracked in `share_events` table — fire to PostHog also) |
| `amendment_first_drafted` | `{ user_id, amendment_type }` | After `api/draft-amendment.js` returns success for the first time |
| `esign_first_sent` | `{ user_id }` | After DocuSeal submission completes for the first time |

**Why "first" events instead of every occurrence:** activation cohorts care about "did the user EVER do X by day N." Repeat-usage retention events come later (Phase 2) when we have enough customers for retention curves to mean something. At 12 customers, single-event cohort math is what wins.

---

## 3. Identification — when does anonymous → identified happen?

**Decision: identify on first login, NOT on checkout.**

Rationale: the Stripe checkout flow happens on `checkout.stripe.com`, not on `meetdossie.com`. PostHog can't capture that page. So:

- **Anonymous tracking:** all `$pageview`, `founding_landing_viewed`, `founding_join_clicked` events fire with the auto-generated `distinct_id` (anonymous PostHog cookie).
- **Server-side conversion events** (`checkout_completed`, etc.) use the customer's **email** as the `distinct_id` (PostHog supports any string).
- **Identification handoff:** when the React workspace bundle mounts and detects a valid Supabase session, it calls `posthog.identify(user.id, { email, plan })` AND `posthog.alias(anonymous_distinct_id, user.id)`. This stitches the anonymous browsing session to the identified user. The alias call requires the anonymous distinct_id to still be in the same browser — works for the standard `/founding → checkout → welcome.html → /app` flow, breaks for cross-device (user pays on desktop, logs in on phone). That's acceptable at this scale.

**Implementation:** the alias call goes in the React workspace mount, gated by `localStorage.posthog_aliased !== user.id`.

---

## 4. Where to instrument — file-by-file

### `MeetDossie` repo (this repo, server + landing pages)

**Step 1 — Add a shared helper module: `api/_lib/posthog.js`**

```js
// api/_lib/posthog.js
// Server-side PostHog capture helper. Fire-and-forget; never block a webhook
// on PostHog being slow.
const POSTHOG_KEY = process.env.POSTHOG_KEY;
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';

async function captureServerEvent({ distinctId, event, properties = {} }) {
  if (!POSTHOG_KEY) return; // graceful no-op when not configured
  if (!distinctId) return;
  try {
    await fetch(`${POSTHOG_HOST}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: POSTHOG_KEY,
        event,
        distinct_id: String(distinctId),
        properties: { ...properties, $lib: 'server', source: 'meetdossie-api' },
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.warn('[posthog] capture failed:', err && err.message);
  }
}

module.exports = { captureServerEvent };
```

**Step 2 — Wire server-side captures**

| File | Insertion point | Code |
|---|---|---|
| `api/notify-founding-application.js` | After the `buildMessage(app)` line, before sending Telegram | `await captureServerEvent({ distinctId: app.email, event: 'founding_application_submitted', properties: { application_id: app.id, heard_from: app.heard_from, transactions_12mo: app.transactions_12mo, sides: app.sides, brokerage: app.brokerage, market: app.market } });` |
| `api/_lib/founding-approval.js` `approveFoundingApplication()` | At the end, before the `return { ok: true, ... }` | `await captureServerEvent({ distinctId: app.email, event: 'founding_application_approved', properties: { application_id: app.id, heard_from: app.heard_from, time_since_submitted_minutes: Math.round((Date.now() - new Date(app.created_at).getTime()) / 60000) } });` |
| `api/_lib/founding-approval.js` `rejectFoundingApplication()` | At the end, before return | `await captureServerEvent({ distinctId: app.email, event: 'founding_application_rejected', properties: { application_id: app.id, heard_from: app.heard_from } });` |
| `api/create-checkout-session.js` | After `res.status(200).json({ ok: true, url: session.url });` (move that line below the capture) | `await captureServerEvent({ distinctId: customerEmail || `anon_${session.id}`, event: 'checkout_session_created', properties: { source: 'founding_landing', has_email_prefill: !!customerEmail } });` |
| `api/stripe-webhook.js` `handleCheckoutSessionCompleted()` | After `upsertSubscription(...)` succeeds | `await captureServerEvent({ distinctId: customerEmail, event: 'checkout_completed', properties: { stripe_subscription_id: stripeSubscriptionId, stripe_customer_id: stripeCustomerId, plan: tier, amount_cents: 2900, source: 'checkout_session' } });` |
| `api/stripe-webhook.js` `handleInvoicePaid()` | After the welcome + password-set emails are sent | `await captureServerEvent({ distinctId: customerEmail, event: 'direct_invoice_provisioned', properties: { stripe_subscription_id: stripeSubscriptionId, source: 'direct_invoice', invoice_id: invoice.id } });` |
| `api/stripe-webhook.js` `handleSubscriptionDeleted()` | After the profile patch | `await captureServerEvent({ distinctId: customerEmail || stripeCustomerId, event: 'subscription_cancelled', properties: { stripe_subscription_id: subscription.id } });` |
| `api/complete-onboarding.js` | After the profile upsert succeeds | `await captureServerEvent({ distinctId: email, event: 'onboarding_completed', properties: { phone_collected: !!phone, brokerage, market, heard_from } });` |

**Step 3 — Wire browser-side captures (landing pages)**

Add this snippet to `<head>` of `founding.html`, `agents/index.html`, `coordinators/index.html`, `calculator.html`, `index.html`, and every `guides/*/index.html` + `answers/*/index.html`:

```html
<!-- PostHog -->
<script>
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures getActiveMatchingSurveys getSurveys getNextSurveyStep onSessionId".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  posthog.init('REPLACE_WITH_POSTHOG_KEY_FROM_ENV', { api_host: 'https://us.i.posthog.com', autocapture: true });
</script>
```

For env injection: since these are static HTML files, hardcode the public PostHog key (it's safe to expose — it's write-only and PostHog's threat model expects browser exposure). Carter: hardcode the actual `phc_...` value Heath provides. Do NOT use the env var pattern here — static HTML can't read Vercel env.

**Step 4 — Page-specific event captures**

Add inside the existing `<script>` blocks on each page:

**`founding.html`** — after `posthog.init`:

```js
// Capture UTM params + referrer on landing
(function () {
  var params = new URLSearchParams(window.location.search);
  posthog.capture('founding_landing_viewed', {
    utm_source: params.get('utm_source') || null,
    utm_medium: params.get('utm_medium') || null,
    utm_campaign: params.get('utm_campaign') || null,
    referrer: document.referrer || null,
  });
  // Persist UTM params for the session — they'll flow into checkout_clicked
  if (params.get('utm_source')) {
    sessionStorage.setItem('utm_source', params.get('utm_source'));
    sessionStorage.setItem('utm_medium', params.get('utm_medium') || '');
    sessionStorage.setItem('utm_campaign', params.get('utm_campaign') || '');
  }
})();
```

Then inside the existing `button.addEventListener("click", ...)` handler, BEFORE the `fetch("/api/create-checkout-session", ...)` call:

```js
posthog.capture('founding_join_clicked', {
  time_on_page_seconds: Math.round((Date.now() - performance.timing.navigationStart) / 1000),
  utm_source: sessionStorage.getItem('utm_source') || null,
});
```

**`agents/index.html`, `coordinators/index.html`** — after `posthog.init`:

```js
var params = new URLSearchParams(window.location.search);
posthog.capture(window.location.pathname.includes('agents') ? 'agents_page_viewed' : 'coordinators_page_viewed', {
  utm_source: params.get('utm_source') || null,
  referrer: document.referrer || null,
});
```

**`calculator.html`** — inside the existing form submit handler, after the Supabase insert succeeds:

```js
posthog.capture('calculator_email_submitted', {
  email_domain: email.split('@')[1] || null,
});
```

**`guides/*/index.html` and `answers/*/index.html`** — after `posthog.init`:

```js
var slug = window.location.pathname.split('/').filter(Boolean).pop();
posthog.capture(window.location.pathname.includes('/guides/') ? 'guide_viewed' : 'answer_viewed', { slug: slug });
```

**`welcome.html`** — after the user lands post-payment, inside the script block:

```js
var params = new URLSearchParams(window.location.search);
var sessionId = params.get('session_id');
posthog.capture('welcome_page_viewed', { stripe_session_id: sessionId });
```

### `Dossie` repo (React workspace bundle — Carter coordinates with the React build)

**Step 1 — `npm install posthog-js` in `C:\Users\Heath Shepard\Desktop\Dossie`.**

**Step 2 — Initialize once in `src/main.jsx` (or wherever `<App />` mounts):**

```jsx
import posthog from 'posthog-js';

posthog.init(import.meta.env.VITE_POSTHOG_KEY, {
  api_host: 'https://us.i.posthog.com',
  autocapture: false, // app is logged-in; use explicit events
  capture_pageview: true,
});
```

Add `VITE_POSTHOG_KEY` to the Vite env in the Dossie repo (`.env`). For the build to pick it up in the MeetDossie Vercel build, also expose it as `VITE_POSTHOG_KEY` there.

**Step 3 — Identify on auth state:**

In the auth/session bootstrap (wherever `supabase.auth.onAuthStateChange` fires):

```jsx
if (session?.user) {
  posthog.identify(session.user.id, {
    email: session.user.email,
    plan: profile?.plan || 'founding',
  });
  // First-login dedupe
  if (!localStorage.getItem('posthog_fired_first_login')) {
    const paymentTimestamp = profile?.created_at ? new Date(profile.created_at).getTime() : null;
    posthog.capture('app_first_login', {
      time_since_payment_seconds: paymentTimestamp ? Math.round((Date.now() - paymentTimestamp) / 1000) : null,
    });
    localStorage.setItem('posthog_fired_first_login', '1');
  }
}
```

**Step 4 — Wire activation events** (after each Supabase mutation):

```jsx
// After successful transactions.insert (first dossier)
if (!localStorage.getItem('posthog_fired_dossier_first_created')) {
  posthog.capture('dossier_first_created', {
    transaction_id: newTx.id,
    time_since_first_login_seconds: Math.round((Date.now() - parseInt(localStorage.getItem('posthog_first_login_ts') || Date.now(), 10)) / 1000),
  });
  localStorage.setItem('posthog_fired_dossier_first_created', '1');
}

// After successful document upload (first document)
if (!localStorage.getItem('posthog_fired_document_first_uploaded')) {
  posthog.capture('document_first_uploaded', {
    document_type: file.type || 'unknown',
  });
  localStorage.setItem('posthog_fired_document_first_uploaded', '1');
}

// Same pattern for: talk_to_dossie_first_used, morning_brief_first_played,
// amendment_first_drafted, esign_first_sent
```

**Step 5 — Share button** (already exists in workspace bundle; just add a capture call alongside the existing `share_events` insert):

```jsx
posthog.capture('share_button_clicked', { method: shareMethod });
```

---

## 5. Source attribution — schema migration

Add a `source` column to both `founding_applications` AND `subscriptions` so every signup is attributable end-to-end.

### Migration SQL

```sql
-- File: supabase/migrations/2026_06_08_add_source_columns.sql
-- Adds source TEXT column to founding_applications and subscriptions.
-- Values: 'founding_landing' (paid /founding click-through),
--         'founding_form' (filled the 7-field application),
--         'direct_invoice' (Heath sent a manual Stripe invoice),
--         'facebook_group_<slug>', 'instagram', 'tiktok', 'twitter_x',
--         'linkedin', 'google_search', 'trec_calculator', 'word_of_mouth',
--         'other', or freeform UTM source string.
-- Existing rows default to 'unknown' (Carter: do NOT backfill — leave NULL
-- so Pierce can spot the historical gap in dashboards).

ALTER TABLE public.founding_applications
  ADD COLUMN IF NOT EXISTS source TEXT;

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS source TEXT;

CREATE INDEX IF NOT EXISTS founding_applications_source_idx
  ON public.founding_applications(source);

CREATE INDEX IF NOT EXISTS subscriptions_source_idx
  ON public.subscriptions(source);
```

### Wire the column in code

- `notify-founding-application.js`: when inserting the row, pull `source` from the form payload (UTM source captured in sessionStorage at landing, then included on form submit).
- `create-checkout-session.js`: `metadata: { source: 'founding_landing', utm_source: ... }` (already does `source: 'founding_landing'` — extend with the UTM data).
- `stripe-webhook.js`: when creating subscriptions row, copy `session.metadata.source` and `session.metadata.utm_source` into the row.
- `_lib/founding-approval.js`: copy `application.heard_from` into the subscription's `source` if no UTM is present.

---

## 6. Dashboards (Carter creates after instrumentation is live)

In PostHog → **Insights → New Insight**, create three saved dashboards:

### Dashboard 1: Acquisition Funnel

- Type: **Funnel**
- Steps:
  1. `founding_landing_viewed`
  2. `founding_join_clicked`
  3. `checkout_session_created`
  4. `checkout_completed`
  5. `onboarding_completed`
  6. `app_first_login`
  7. `dossier_first_created`
- Time window: last 30 days, rolling
- Breakdown: `utm_source` (when present) and `source` (server-side, when present)

### Dashboard 2: Source Attribution

- Type: **Trends**
- Event: `checkout_completed`
- Breakdown: `source` (the new column we're adding)
- Display: stacked bar, weekly
- Filter: `plan = 'founding'`
- This answers: "which channel drove paying customers this week."

### Dashboard 3: Activation Cohort

- Type: **Retention** (PostHog cohort retention view)
- Cohort definition: users who fired `checkout_completed` in the last 90 days
- Target events to measure retention against:
  - `app_first_login` (Day 1, 3, 7, 14, 30)
  - `dossier_first_created` (Day 1, 3, 7, 14, 30)
  - `document_first_uploaded` (Day 1, 3, 7, 14, 30)
- Display: cohort grid (week-of-signup × days-since-signup)
- This is the **activation crisis dashboard**. Pierce will reference it in every weekly check-in.

---

## 7. Verification (Quinn runs this after Carter ships)

1. Visit `https://meetdossie.com/founding` in an incognito browser. Confirm `founding_landing_viewed` appears in PostHog Live Events within 30 seconds.
2. Click "Join as Founding Member." Confirm `founding_join_clicked` and `checkout_session_created` fire.
3. (Test mode) Complete a Stripe test checkout. Confirm `checkout_completed` fires from the webhook.
4. Log into the React app at `/app`. Confirm `app_first_login` fires once. Refresh — confirm it does NOT fire again (dedupe working).
5. Create a test dossier. Confirm `dossier_first_created` fires.
6. Upload a test document. Confirm `document_first_uploaded` fires.
7. Check the Acquisition Funnel dashboard — confirm at least one user shows up in all 7 steps.

---

## 8. Open questions for Carter

1. **Where does the 7-field founding application form actually live?** It's not in `MeetDossie/founding.html`. It writes to `founding_applications` via anon-role Supabase INSERT (per `notify-founding-application.js` comments). It's probably in the `Dossie` React repo — Carter please locate and wire the `source` capture there. If it doesn't exist in either repo, flag to Cole — we may have a dead code path.
2. **Vite env injection for the React bundle**: confirm `VITE_POSTHOG_KEY` works through the existing MeetDossie deploy. If not, hardcode the value in `src/main.jsx` like the static HTML pages (the public key is safe to expose).

---

## 9. Cost summary

- PostHog: **$0** (free tier, 1M events/mo — we'll use <50K/mo at current volume).
- No new Vercel functions. No new Supabase tables (just two columns).
- Implementation: ~6-8 hours Carter work end to end. Detail breakdown in the recommended sequencing below.

---

## 10. Sequencing

If Carter has to pick what ships first:

1. **Day 1 (2 hr):** Create `api/_lib/posthog.js` helper. Wire ALL server-side captures (Section 4 Step 2). This alone gives Pierce the entire conversion funnel from form → paid customer.
2. **Day 1 (1 hr):** Schema migration (Section 5).
3. **Day 2 (2 hr):** Browser-side captures on static HTML pages (Section 4 Step 3 + 4). Adds the visit → click → checkout half of the funnel.
4. **Day 2 (2-3 hr):** React workspace activation events (Section 4 Dossie repo block). This is the activation crisis instrumentation — depends on locating the React form code first.
5. **Day 2:** Build the three PostHog dashboards (Section 6).
6. **Day 3:** Quinn verification (Section 7), then merge to main.

Steps 1-3 alone are shippable independently. Carter can land them in one PR, then do steps 4-5 in a second PR.
