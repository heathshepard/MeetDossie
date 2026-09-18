# Activation forensics — why 5 of 8 paying customers have never used Dossie

Run 2026-09-18. Read-only analysis against live Supabase (`pgwoitbdiyubjugwufhk`).
No customer was contacted. No record was modified.

**Prior theory refuted before this run:** the app was suspected of crashing on
Firefox/Safari. QA loaded production in Firefox, WebKit and Chromium — it renders
and functions in all three. That is not the cause, and this document does not
revisit it.

---

## The one-line answer

**Three of the five never authenticated once — not a single session in the
product's entire history — and a fourth had one 42-second session at
provisioning.** They were never given a working way in, and the activation
emails that were supposed to chase them were marked as sent in the database
without ever being sent. This is an engineering + onboarding failure, not five
people independently losing interest.

---

## 1. Roster verification

`docs/BACKLOG-BUSINESS.md`'s list of five is **correct**. Verified against
`onboarding_progress` — every flag false, `updated_at` identical to `created_at`
(row written at signup, never touched again):

Kimberly (Kim) Herrera · Cecilia Whitley · Terry Katz · Natalie Megerson · Lisa Nilsson

8 active paying accounts total (`subscriptions.status='active'`, excluding the
two `cancel_at_period_end=true` rows for Miki Mccarthy and Amanda Nuckles, and
excluding Heath's own internal/test rows).

---

## 2. Per customer — the exact stop

| Customer | Auth sessions, ever | Last sign-in | Stops at | Content created |
|---|---|---|---|---|
| **Kim Herrera** | **0** | never | **first login** | 0 txn / 0 doc / 0 action |
| **Cecilia Whitley** | **0** | never | **first login** | 0 / 0 / 0 |
| **Lisa Nilsson** | **0** | never | **first login** | 0 / 0 / 0 |
| **Terry Katz** | 2 (both 2026-05-20 19:55:35) | 2026-05-20, 42s after account creation | **first login → never returned** | 0 / 0 / 0 |
| **Natalie Megerson** | 2 (2026-06-18 → 2026-06-19) | 2026-06-18 | **first dossier** — got in once, created nothing, session died 6/19, 91 days ago | 0 txn / 0 doc / 1 action |

Sessions counted from `auth.sessions` and `auth.refresh_tokens`; sign-ins from
`auth.users.last_sign_in_at`. Kim, Cecilia and Lisa each have **0 sessions and 0
refresh tokens** — these are not stale-session artifacts, they have genuinely
never held an authenticated session.

**The drop-off is shared, not five different ones.** Four of the five stop at the
same step: *first login*. The fifth (Natalie) cleared login once and stopped at
*first dossier*.

---

## 3. Why they could not log in — the systemic cause

Every one of these accounts was provisioned server-side, not self-served. The
code path (`api/stripe-webhook.js` → `createAuthUser` → `generateRecoveryLink`,
mirrored in `api/signup.js`):

1. `POST /auth/v1/admin/users` with a **random 48-character scratch password**
   that is never shown to anyone.
2. `POST /auth/v1/admin/generate_link` `type=recovery`.
3. Resend emails that link, with the footer: *"This link expires in **1 hour**."*

**That one-time, 1-hour link is the only credential the customer ever receives.**
If it is missed, expired, filtered, or clicked on a phone that doesn't complete
the form, the account has no usable password and the customer has no way in
except noticing "Forgot password?" on the login screen and starting over.

Corroborating evidence, from `auth.users.updated_at`:

- **Kim, Cecilia, Lisa** — `updated_at` is *identical* to `recovery_sent_at`
  (Kim & Cecilia 2026-05-21 20:21:01, within 0.5s of each other — a batch
  script; Lisa 2026-05-28 00:59:11, 300ms after her account was created). No
  row mutation of any kind after that instant. A `updateUser({password})` from
  `/set-password.html` would have bumped it. **They never set a password.**
- **Terry** — `updated_at` is 2ms after `last_sign_in_at`. He clicked the invite
  link, got a session, and left without completing the set-password form.
  `invited_at` is set; he was the first of three manual "webhook gap" recoveries.
- **Natalie** — got a session 2026-06-18, last token refresh 2026-06-19 19:57,
  nothing since. She has **never requested a password reset** (`recovery_sent_at`
  is null), so if she also never completed set-password, her session dying on
  6/19 locked her out permanently.

`/forgot-password.html` and the "Forgot password?" link in `AuthGate.jsx` have
existed since 2026-05-01, so a self-service route technically exists. But
**zero `/recover` requests appear in the auth logs in the last 24 hours**, and
none of the five has a recovery request they initiated themselves. Nobody is
finding it, or nobody is trying.

---

## 4. Email delivery — cleared, and it makes the story worse

Delivery is **not** the problem. `email_events` (Resend webhook, live since
2026-07-09) for all eight active customers:

- **Zero bounces. Zero complaints. Zero suppression-list entries.**
- 72–80 `delivered` events per address.
- Four of the five *open* Dossie email regularly: Cecilia 6 opens, Lisa 12,
  Terry 5, Natalie 2 + 5 link clicks.
- **Kim Herrera is the exception: 96 delivered, 0 opens, 0 clicks, ever.** Her
  address is `@kw.com`, and memory `kw-email-blocking-incident-2026-09-10.md`
  documents kw.com silently mishandling inbound mail. Resend reports "delivered"
  (the MX accepted it) but nothing indicates a human ever saw one. Treat her as
  a *delivery-suspect* case distinct from the other four.

Caveat on Natalie: she has 5 `clicked` events on `https://meetdossie.com/app`
(most recently 2026-09-17, yesterday) against only 2 `opened` events. More clicks
than opens is the classic signature of an automated link scanner (Microsoft Safe
Links and similar), so this is **not** proof a human is trying to get in. It is
worth one manual check, not a conclusion.

### The activation drip was marked sent without being sent

This is the sharpest fixable defect found.

Ten profiles — including Kim, Cecilia, Terry and Natalie — carry the **identical
microsecond timestamp `2026-06-05 20:15:46.475638+00` in all three**
`activation_email_{1,2,3}_sent_at` columns.

`api/cron-activation-drip.js` writes those columns one at a time via
`new Date().toISOString()`, which yields millisecond precision (`.475000`) and
different values per call per user. A 6-digit microsecond value repeated
byte-identically across three columns and ten users can only come from a single
`UPDATE profiles SET ... = now()` statement. **It is a manual bulk backfill, not
a record of sends.**

Contrast: Suzanne Page's three stamps are `.835` / `.213` / `.15` — 3-digit, from
the real cron. Lisa Nilsson's emails 1 and 2 are backfilled (`.834038`) but her
email 3 is real (`.909`, 2026-06-11).

**Consequence:**

- Kim, Cecilia, Terry and Natalie received **zero** activation emails, ever.
- Lisa received exactly one — email 3, the day-14 message, out of sequence and
  with no email 1 or 2 before it.
- Because the drip gates on `activation_email_3_sent_at IS NULL`, the backfill
  **permanently suppresses the sequence** for all ten. It can never fire for them
  again, no matter how long they stay inactive.
- `referral_ask_sent_at` is null for all ten, and its window is "signed up 14–21
  days ago" — a 4-month-old cohort can never qualify. That half of the cron has
  never run for anyone.

Correction to `docs/CUSTOMERS.md`'s 2026-08-26 audit note: `cron-activation-drip`
**is** registered in `vercel.json` (`0 15 * * *`, one of 99 crons), contradicting
the file's own header comment claiming it is not. The cron works. It was the data
that was poisoned.

### What they *have* been receiving

All five have received **96–97 consecutive daily morning-brief emails** since
2026-06-13 (`morning_brief_email_log`), every single one with
`transaction_count = 0` and `deadline_count = 0`.

For roughly a hundred days, the only thing Dossie has said to these customers is
a daily briefing about nothing. That is the entire lifecycle touch they got.

---

## 5. Account validity — all five are structurally fine

Nothing is broken about their accounts specifically:

- Valid `profiles` row, correct `plan='founding'`, `subscription_status='active'`.
- `auth.users`: email confirmed, exactly 1 identity, not banned, not deleted,
  not SSO, not anonymous, password hash present (the scratch one).
- No org/tenant dependency — `organization_members` is empty for *all* eight
  customers including Brittney, who uses the product heavily. Orgs are not a gate.

The product would work for them. They cannot reach it.

---

## 6. The contrast — what the "3 who use it" did differently

The honest version is starker than "3 of 8 use it."

| Customer | Sessions | Last sign-in | Transactions | Real usage? |
|---|---|---|---|---|
| **Brittney YBarbo** | 8 (179 refresh tokens) | **2026-09-16** | **66** (63 docs, 8 actions) | **Yes — the only one** |
| Tiffany Gill-Teich | 3 | 2026-06-02 | 3 | Marginal; gone 3.5 months |
| Kay Suzanne Page | 3 | 2026-08-13 (session alive 9/17) | **0** | Logs in, has never created anything |

**Six of eight paying customers have produced zero transactions. Exactly one
customer uses this product.**

And Suzanne's and Brittney's `onboarding_progress` rows are *also* a backfill —
all five flags true with `completed_at`, `created_at` and `updated_at` identical
to the microsecond (`2026-05-07 17:06:51.460959`). Suzanne's "completed
onboarding" is fiction; she has never created a dossier. Any dashboard counting
completed onboarding is over-reporting by two.

### The one real differentiator

**Brittney is the only customer of the eight who filled out a founding
application.** `founding_applications` holds exactly five rows in its entire
history; hers is the only one matching a current customer. She applied
2026-05-06 02:15, wrote a "why," declared 80 transactions/year and both sides,
and Heath reviewed and approved her 11 hours later.

The other seven have **no application row at all**. They bought a $29 founding
spot off a Facebook post via a direct Stripe payment link — no qualification, no
stated reason, no conversation with Heath, no human moment. Three of them (Terry,
Jennifer, Lisa) had to be provisioned by hand afterwards because the Stripe
webhook never fired.

The one customer who was qualified and talked to is the one customer who uses it.
That is the whole contrast.

---

## 7. Last touch, per customer

| Customer | Last login | Last email opened | Last inbound signal of any kind |
|---|---|---|---|
| Kim Herrera | never | never (0 opens in 96 delivered) | none, ever |
| Cecilia Whitley | never | 2026-09-03 | email open, 2026-09-03 |
| Terry Katz | 2026-05-20 | 2026-08-31 | email open, 2026-08-31 |
| Natalie Megerson | 2026-06-18 | 2026-08-26 (click 2026-09-17, likely a scanner) | ambiguous, 2026-09-17 |
| Lisa Nilsson | never | 2026-09-05 | email open, 2026-09-05 |

Outbound to all five: a daily empty morning brief, every day, for ~97 days. No
activation email (except Lisa's single out-of-sequence #3). No personal outreach
on record since signup.

---

## 8. Is it one cause or five?

**One shared cause, with one variant.**

The shared cause: **these customers were never actually onboarded.** Access was
handed over as a single 1-hour email link with no follow-up, the drip meant to
catch the ones who didn't make it was neutered by a database backfill on
2026-06-05, and the only ongoing communication was an automated daily brief
about an empty account. Four of the five never got a working credential. They
did not churn out of the product — they never got into it.

The variant: **Kim Herrera** is also a plausible email-delivery casualty on
`@kw.com` (96 delivered, 0 opens ever). Same outcome, possibly a second
independent reason.

**Which problem does Heath have?** Both, in this order:

1. **Engineering (fixable, and it is the bigger half).** A one-time 1-hour link
   as the sole access mechanism is an activation funnel designed to leak. The
   activation drip is permanently disabled for this cohort by poisoned data. No
   alarm anywhere fires on "paying customer, zero sessions, 120 days" —
   `cron-pierce-activation.js`, the one job that would have caught this, is
   absent from `vercel.json`'s cron array (verified: 99 crons, not among them).
   Four months of $145/mo went by with nothing watching.
2. **Sales/onboarding (the deeper half).** Seven of eight customers bought a $29
   product off a Facebook post without ever speaking to Heath. The one who went
   through an application and a human approval is the one who uses it. A cheap
   frictionless payment link sold spots to people who had not decided anything.

---

## 9. Side finding — the MRR number is not verified

`subscriptions.current_period_end` is stale for the whole roster: Terry
2026-06-20, Kim 2026-07-19, Cecilia 2026-07-20, Natalie 2026-07-22, Lisa
**null**. Nothing has advanced these since summer.

This is the known Stripe webhook gap (`customer.subscription.updated` /
`invoice.payment_failed` not subscribed — item G2 in `docs/BACKLOG-BUSINESS.md`).
**The database cannot confirm that the $145/mo from these five is still being
collected.** That figure needs checking in the Stripe dashboard before it is
used in any decision.

---

## 10. Recommended order of work (analysis only — nothing here was executed)

1. **Verify in Stripe** that all five are actually still paying. Do this first;
   it may change the size of the problem.
2. **Clear the poisoned drip flags** for the ten backfilled profiles so the
   sequence can run — or better, write a distinct win-back sequence, since a
   "day 4" email to a 120-day-old account reads wrong.
3. **Replace the 1-hour link as sole access.** Options: longer-lived
   set-password token, a resend-link endpoint the customer can self-serve from
   the login screen, or magic-link sign-in that doesn't require a password at all.
4. **Add the missing alarm.** "Active subscription, zero auth sessions, >7 days"
   should page Heath. `cron-pierce-activation.js` exists and is not registered.
5. **Personal outreach from Heath** — his call, his voice, not an automated
   email. Four of these five open his email; they are reachable. Kim needs a
   non-email channel (phone).
6. **Stop sending empty morning briefs** to accounts with zero transactions. It
   is a daily reminder that the product is empty.
