# Dossie System Audit — 2026-05-21

Read-only audit. 8 paying founding members, MRR roughly $204 (7 × $29 + $1 friend). Confirmed findings vs suspected items are marked.

---

## Critical gaps (fix this week)

1. **`email_queue` is never populated for drafts — only for sent emails.** *Confirmed.*
   - `api/send-email.js:131-159` only inserts a row with `status='sent'` AFTER Resend accepts the send. No code path inserts a `draft` row. The Dossie React app builds drafts in memory from `transactions` (`dossie-app.jsx:3697 buildEmailQueue`).
   - Consequence: the customer-facing daily digest cron (`api/cron-email-digest.js`) reads `email_queue.status != 'sent'` — it will **never fire** for any paying customer. Likewise the sidebar pulsing red badge (`dossie-app.jsx:1552-1584`) is always 0.
   - DB confirms: only 3 rows in `email_queue`, all `status='sent'`, all owned by either demo or Heath's `0cd05e2f-…` account.
   - Fix: when the React app generates a draft, persist a row with `status='draft'`. Or fold draft generation into a server-side endpoint that writes the row.

2. **Stripe `invoice.paid` recurring renewal will fail silently for any customer with a missing `stripe_subscription_id` row.** *Confirmed.*
   - `api/stripe-webhook.js:471-499` recovers existing customers by email lookup, then attempts `upsertSubscription({stripe_subscription_id, …})`. If we know the email but the existing row has no `stripe_subscription_id` (or doesn't exist), the upsert may insert a duplicate orphan row.
   - Terry Katz (`michellesellshouston@gmail.com`, user `450f5da7-…`) currently has `stripe_customer_id = NULL` AND `stripe_subscription_id = NULL` in `subscriptions`. When her next monthly invoice fires (around 2026-06-20), the webhook will recognise the email-→-auth-user mapping but the period refresh path requires either `stripe_subscription_id` or `stripe_customer_id` to update — she has neither, so the row will never get period dates refreshed and she may appear stale on the morning brief.
   - Fix: backfill `stripe_customer_id`/`stripe_subscription_id` for Terry from Stripe Dashboard now. Add a defensive insert path in `handleInvoicePaid` that always upserts by user_id when we recover by email but the existing sub row is empty.

3. **Two paying customers have never logged in.** *Confirmed.*
   - DB: Kim Herrera (`kimberlyherrera@kw.com`, subscribed 2026-05-19) and Cecilia Whitley (`cecilia@sterlingassociatesre.com`, 2026-05-20) have `auth.users.last_sign_in_at = NULL`.
   - Both have paid. The "set your password" email is sent via `setPasswordEmailHtml` (`api/stripe-webhook.js:287-295` / `complete-onboarding.js:208-216`) — link expires in 24 hours. After 24h they have no in-app path to set a password.
   - The forgot-password page works, but the sign-in screen in the React app (`dossie-app.jsx:3770-3794`) has **no "Forgot Password?" link**. A user who lost their welcome email has no obvious recovery path.
   - Fix: (a) re-send recovery links to Kim and Cecilia tomorrow morning; (b) add a "Forgot Password?" link below the Sign In button in the auth card.

4. **`/signin` rewrite in `vercel.json:25-28` points to `/signin.html` which does not exist.** *Confirmed.*
   - File `C:\Users\Heath Shepard\Desktop\MeetDossie\signin.html` is missing. Hitting `meetdossie.com/signin` returns a 404 (or Vercel default).
   - If any email/welcome flow links to `/signin` the user lands on an error page.
   - Fix: either delete the rewrite or create a `signin.html` that mirrors `app.html` or redirects to `/app`.

5. **`alert-health` cron burns ElevenLabs credits every 5 minutes.** *Confirmed.*
   - `api/health.js:27-34` sends a `'test'` text-to-speech request to ElevenLabs on every health-check. `alert-health` runs `*/5 * * * *` (`vercel.json:75-78`) — ~8,640 calls/month. Even at 4 chars/call, that's ~34,560 characters/month — credits wasted on noise. Creator plan is 30k credits/month total.
   - Fix: replace the TTS hit with a cheaper read (e.g. `GET /v1/voices` or `/v1/user`). Same shape, zero credits.

---

## Important gaps (fix this month)

6. **No "Forgot Password" link from the in-app sign-in screen** — already called out above but worth repeating. `dossie-app.jsx:3784-3791`.

7. **Self-serve cancellation API exists but is not exposed in the UI.** *Confirmed.*
   - `api/cancel-subscription.js` is fully built (Stripe `cancel_at_period_end=true`, confirmation email, Telegram alert).
   - Grep `cancel-subscription` in `dossie-app.jsx` returns no matches. Customers cannot cancel themselves — they must email Heath. Combined with the cancellation email mentioning "reactivate by emailing heath@meetdossie.com," the experience is OK but creates work for Heath.
   - Fix: wire a "Cancel subscription" button into Settings.

8. **No account-deletion path.** *Suspected (needs UI verification).*
   - No grep hits for `delete.*account` or GDPR data export in the React source. Texas REALTORS aren't GDPR-covered, but CCPA-style requests will arrive eventually.
   - Fix: document a manual deletion runbook for now; build a button when count > 50.

9. **`founding-count` may include the $1 friend AND demo accounts.** *Confirmed.*
   - `api/founding-count.js:38` reads `subscriptions where plan='founding' AND status='active'` — no `is_demo` filter, no friend filter. Currently both demo profiles have an active founding subscription row (DB confirms `demo@meetdossie.com` and `demo2@meetdossie.com` both have `plan='founding', status='active'`). So `taken` is inflated by 2 demo + 1 friend + 1 Heath test = the "X of 50 spots taken" number on the homepage is wrong by ~4.
   - Fix: filter out `is_demo=true` profiles and exclude `FOUNDING_FRIEND_EMAILS` (Suzanne) the same way `cron-morning-brief.js:35` does.

10. **`admin-dashboard.js` queries `auth.users` via PostgREST.** *Confirmed.*
    - `api/admin-dashboard.js:104-141` does `supabase.from('auth.users').select(...)`. PostgREST does not expose the `auth` schema by default — these queries silently return zero. The dashboard probably shows 0 active7d / active30d / neverLoggedIn even when the data is fine.
    - Fix: hit the auth admin REST endpoint the same way `cron-morning-brief.js:207-214` does (`/auth/v1/admin/users/<id>`).

11. **`dossier_milestones.canvas_data_url` already at 21 MB across 14 rows (~1.5 MB each).** *Confirmed via SQL.*
    - At current rate, the 500 MB Supabase free-tier DB limit (the table is in Postgres, not Storage) is hit at ~330 milestones. With 8 customers × ~6 closings/year = ~50 cards/year — fine for ~6 years but already 4% of quota for 14 cards. CLAUDE.md flags this as known tech debt.

12. **Recovery link generation is brittle in low-quota Supabase auth.** *Suspected, needs testing.*
    - `generateRecoveryLink` (`stripe-webhook.js:140-192`, `complete-onboarding.js:108-152`) calls `/auth/v1/admin/generate_link`. If Supabase rate-limits or returns 422, we log + skip the email. Customer would never receive the set-password link. No retry. Two confirmed never-logged-in customers may have been hit by this.

13. **`founding_applications` flow is now bypassed by direct checkout.** *Confirmed.*
    - DB shows only 3 founding_applications rows total (Heath, Brittney, a heathtest). All 8 actual paying customers came in through direct Stripe Checkout or invoice — the funnel logic in `_lib/founding-approval.js` is essentially dead.
    - Not broken, but the founding page sends to Telegram for Heath to manually approve — if a real applicant submits via that form, the email/checkout path uses `STRIPE_FOUNDING_PAYMENT_LINK` (env var). Confirm that env var is set; otherwise the approve button will silently fail.

14. **CORS policy on `complete-onboarding.js:18-22` is `meetdossie.com` only.** *Confirmed.*
    - Staging URL (`meet-dossie-nc8tcpjt5-heathshepard-6590s-projects.vercel.app`) is not in `ALLOWED_ORIGINS`. Cannot run end-to-end onboarding test from staging — must test only on prod.
    - `send-email.js:26` does accept `.vercel.app` origins, so that one's fine. Inconsistent though.

---

## Watch items (track, fix when relevant)

- **Supabase advisors (security):** RLS disabled on `mark_post_failed_logs`; `calculator_signups` and `leads` have RLS enabled but no policy (effectively zero rows readable for authenticated, fine if intentional); several SECURITY DEFINER functions exposed via `/rest/v1/rpc` to anon role (`handle_new_user`, `cleanup_rate_limits`, etc.) — low risk, but worth tightening.
- **Leaked-password protection disabled** on Supabase Auth — enable for HaveIBeenPwned check.
- **No automated backup of `documents` bucket** — Supabase free tier doesn't include PITR. A bucket-level rm by mistake would lose every contract.
- **Telegram `cron-morning-brief` uses `TELEGRAM_BOT_TOKEN` (Claudy)** — `cron-morning-brief.js:21`. If Claudy's webhook ever conflicts with getUpdates, brief delivery breaks.
- **No reconciliation between Stripe customers and Supabase `subscriptions`.** A monthly job that lists all `active` Stripe subs and reports mismatches would have caught Terry on day 1.
- **`scan_credits` table exists but `scan-contract.js` does not reference it** (grep miss) — paid scans beyond the free 5 may be uncapped. Needs verification when scan volume grows.
- **No structured error tracking** (Sentry/Logflare). All `console.error` lines vanish into Vercel logs.
- **`is_demo` filter in admin-dashboard.js:88-90** only filters `profiles`, but the auth.users query (broken anyway, see #10) uses email pattern matching only. Consistency drift if a non-demo email contains `demo`.
- **`audit_logs` table exists but no code path writes to it** (grep miss for `audit_logs`). Tech debt placeholder.
- **`onboarding_progress` row creation depends on a DB trigger** (`create_onboarding_for_new_user`, flagged by advisor). If trigger is dropped, new users get no checklist — defensive insert exists in `dossie-app.jsx:1613-1628`.
- **Vercel cron limit on Hobby is 12 — we have exactly 12** (`vercel.json:74-122`). Adding any new cron requires Pro plan ($20/mo).
- **TREC deadline reminders are date-based only** — no time-of-day awareness. A deadline set for "today at 5pm" will fire its T-0 reminder at 8am, not noon.
- **`scan-contract.js:18` uses `claude-sonnet-4-5` and `claude-opus-4-5-20251101` for large PDFs** — confirm both model IDs still resolve after the 2026-01 cutoff.

---

## What's working well

- Stripe webhook now handles three event types correctly (checkout.session.completed, invoice.paid, customer.subscription.deleted) with idempotency guards.
- Daily customer email digest + deadline reminder crons are well-structured with `deadline_reminders` uniqueness table preventing double-sends.
- `forgot-password.html:163-178` follows security best practice — always shows success message regardless of whether email is registered (no account enumeration).
- All cron endpoints require `Bearer ${CRON_SECRET}` or `x-vercel-cron: 1`. Defense-in-depth.
- All user-facing API endpoints use `verifySupabaseToken` middleware (`api/_middleware/auth.js`) — no raw service-role exposed to browsers.
- `api/health.js` + `alert-health.js` give 5-minute monitoring of Supabase / Telegram / ElevenLabs / Creatomate (modulo the credit-burn bug in #5).
- Suzanne's $1 friend pricing is correctly handled in `cron-morning-brief.js:35` and `priceForCustomer()` so MRR isn't inflated.
- Support tickets table + submission flow + admin viewer all wired (`api/support.js`, `dossie-app.jsx:4269-4299`).
- Customer name normalization (`toTitleCase`) prevents shouting/mid-cap names everywhere they appear.

---

## Recommended prioritization

1. **Fix email_queue draft persistence** (#1) — daily digest depends on it; current value of cron is 0.
2. **Recover Kim + Cecilia** (#3) — they're paying and locked out. Re-send recovery link manually today; add Forgot Password link to in-app sign in.
3. **Backfill Terry's `stripe_customer_id`** (#2) — before her June 20 renewal, otherwise recurring-invoice handling will not refresh her row.
4. **Fix `/signin` 404 and `founding-count` inflation** (#4 + #9) — homepage scarcity claim must be true; broken /signin damages trust.
5. **Replace ElevenLabs TTS in health check** (#5) — easy win, stops bleeding credits.
6. **Expose self-serve cancellation in Settings** (#7) — API is built; takes ~1 hour to wire.
7. **Fix `auth.users` query in admin-dashboard** (#10) — Heath is operating on misleading numbers.
8. **Add `is_demo` filter to founding-count + reconciliation cron** — prevents the 2026-05-20 incident class.
