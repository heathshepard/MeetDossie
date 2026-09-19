# Dossie auth email — diagnosis and setup

**Date:** 2026-09-19
**Trigger:** Heath screenshotted a password-reset email that arrives from "Supabase"
with no Dossie branding anywhere on it.
**Related:** `docs/ACTIVATION-FORENSICS-2026-09-18.md` (5 of 8 paying customers never
logged in), branch `fix/durable-account-invites-0918` (durable invites — separate scope,
see "Overlap" at the bottom).

---

## 1. What is actually happening

**Dossie's password-reset email is sent by Supabase's built-in shared mailer, on
Supabase's stock template, from a Supabase address.** No custom SMTP is configured.

Verified from this project's own auth logs, not inferred:

```json
{"event":"mail.send",
 "mail_from":"noreply@mail.app.supabase.io",
 "mail_to":"...",
 "mail_type":"recovery"}
```

That is the whole explanation for the screenshot. The sender is
`noreply@mail.app.supabase.io`, and every one of the five auth templates is still
Supabase's factory default, which is why the body reads "Follow this link to reset the
password for your user" and never says Dossie.

### How each kind of Dossie mail is sent today

| Email | Path today | Branded? |
|---|---|---|
| New paid signup / set password | `api/stripe-webhook.js`, `api/signup.js`, `api/complete-onboarding.js` → `admin/generate_link` then **Resend** | Yes |
| **Password reset (existing user)** | `forgot-password.html` → `supabase.auth.resetPasswordForEmail()` → **Supabase built-in mailer** | **No — this is the screenshot** |
| Email change | `supabase.auth.updateUser({ email })` → **Supabase built-in mailer** | **No** |
| Confirm signup | never sent — `mailer_autoconfirm = true` | n/a |
| Magic link | never sent — nothing calls `signInWithOtp` | n/a |

The provisioning path was already fixed at some point and routed through Resend. The
reset path never was. That is the entire gap.

### The part that is worse than cosmetic

Supabase's built-in mailer is explicitly documented as **not for production**, and it
**refuses to deliver to any address that is not a member of the project's Supabase org
team**. Everything else fails with *"Email address not authorized."*

Two recovery emails were sent from this project today — Heath's own at 19:05 UTC, and a
throwaway probe at 19:12 UTC. Both produced a `mail.send` log entry. **Neither arrived**
in the destination mailbox — confirmed against inbox, spam and trash. The only Supabase
mail landing in that mailbox is from the *Rust* project, to a different address.

So the reasonable reading is not "customers got an ugly email." It is that **customers
who asked for a password reset got nothing at all**, silently, while the logs said
`mail.send`. That belongs on the list of candidate causes for the non-activation
alongside the one-hour expiry.

Two further properties of the built-in mailer, both relevant:

- **Hard rate limit**, a handful of messages per hour, changeable by Supabase without
  notice. A burst is dropped.
- **No DKIM/SPF alignment with meetdossie.com**, and a shared IP reputation. Even when it
  does deliver, a brokerage spam filter has every reason to bin it.

Resend on `meetdossie.com` is already authenticated and already delivers to these same
customers today. Moving auth mail onto it fixes the branding, the deliverability and the
rate limit in one change.

---

## 2. What is in this branch

Nothing here sends email, and nothing here touches a customer account. These are
templates and a config tool; **they do not take effect until the config in §3 is
applied.**

| File | What it is |
|---|---|
| `supabase/templates/recovery.html` | Reset password — **the screenshot email** |
| `supabase/templates/invite.html` | Dashboard/admin-API invite |
| `supabase/templates/email_change.html` | Email change confirmation |
| `supabase/templates/confirmation.html` | Confirm signup (dormant — `mailer_autoconfirm` is on) |
| `supabase/templates/magic_link.html` | Magic link (dormant — unused feature) |
| `scripts/configure-auth-email.js` | Applies SMTP + templates + expiry via the Management API. Read-only unless `--apply`. |

The two dormant templates are filled in deliberately. A default left in place is exactly
how the reset email came to look like phishing; if confirmations ever get switched on,
nobody should have to remember this.

### The new reset copy, in full

> **DOSSIE**
> # Reset your password
>
> Somebody asked to reset the password on the Dossie account for
> **suzanne.page@example.com**. If that was you, here's the link.
>
> **[ Set a New Password ]**
>
> If you didn't ask for this, just delete it — your password stays exactly as it is
> until somebody uses that link.
>
> Reply to this email any time. I read every one.
>
> Heath
> heath@meetdossie.com
> Licensed Texas REALTOR | Founder, Dossie
>
> ---
> *You're getting this because a password reset was requested for your Dossie account at
> meetdossie.com. Dossie is the transaction assistant for Texas REALTORS that you signed
> up for.*
>
> *The link is good for 24 hours. If it's expired by the time you get to it, go to
> meetdossie.com/forgot-password and request a fresh one — it's instant, you don't have
> to wait on anybody.*

It names the product, names the address the request was for, says plainly why the
message arrived, signs off as a person, and gives a self-service route that does not
require waiting on Heath.

---

## 3. What Heath has to do — the dashboard part

**None of this can be done from code without a Supabase personal access token, which
does not exist in the repo or in Vercel.** Two routes; pick one.

### Route A — one command (fastest)

1. Make a token at <https://supabase.com/dashboard/account/tokens> ("Generate new token",
   any name). Copy it.
2. Get the Resend API key — from the Resend dashboard or Bitwarden. It is **not**
   readable from `.env.local`; that file holds the literal string `[SENSITIVE]` because
   the var is marked Sensitive in Vercel.
3. Run, from the repo root:

```bash
cd /mnt/c/Users/Heath/Projects/MeetDossie
SUPABASE_ACCESS_TOKEN=sbp_... RESEND_API_KEY=re_... \
  node scripts/configure-auth-email.js --apply
```

Without `--apply` it only prints the live config and changes nothing — worth running
first to see the current state.

### Route B — by hand, four screens

**1. Custom SMTP** → <https://supabase.com/dashboard/project/pgwoitbdiyubjugwufhk/auth/smtp>

Turn on **Enable Custom SMTP**, then:

| Field | Value |
|---|---|
| Sender email | `dossie@meetdossie.com` |
| Sender name | `Dossie` |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` ← the literal word |
| Password | the Resend API key (`re_...`) |

Resend's SMTP username really is the fixed string `resend`, and the password is the
ordinary API key. No new credential is created, and nothing new needs storing.

**2. Templates** → <https://supabase.com/dashboard/project/pgwoitbdiyubjugwufhk/auth/templates>

For each tab, set the subject and paste the file's contents into the message body. Strip
the leading `<!-- ... -->` comment; it is a note to the next developer, not for a
customer's inbox.

| Tab | Subject | File |
|---|---|---|
| Reset Password | `Reset your Dossie password` | `supabase/templates/recovery.html` |
| Invite user | `You're in - set your Dossie password` | `supabase/templates/invite.html` |
| Change Email Address | `Confirm your new Dossie email` | `supabase/templates/email_change.html` |
| Confirm signup | `Confirm your Dossie account` | `supabase/templates/confirmation.html` |
| Magic Link | `Your Dossie sign-in link` | `supabase/templates/magic_link.html` |

**3. Link expiry** → <https://supabase.com/dashboard/project/pgwoitbdiyubjugwufhk/auth/providers> → **Email**

Set **Email OTP Expiration** to `86400` (24 hours). It is currently at the 3600 default.

**4. Rate limit** → <https://supabase.com/dashboard/project/pgwoitbdiyubjugwufhk/auth/rate-limits>

Enabling custom SMTP drops the email rate limit to **30/hour** automatically. That is
comfortably above Dossie's real volume, so it only needs raising if a bulk re-invite ever
goes out. Worth knowing it exists.

### Then verify

Request one reset at <https://meetdossie.com/forgot-password.html> for an address you
control and confirm the sender reads **Dossie**, not Supabase — and, just as important,
that it *arrives*. Re-running `node scripts/configure-auth-email.js` (no `--apply`)
prints the live config and flags any template still sitting on a Supabase default.

---

## 4. On the expiry — why 24 hours

`mailer_otp_exp` is **global**: it governs every emailed link, and cannot be set per link.
It is currently 3600 (one hour) and the maximum GoTrue allows is 86400.

One hour is a defensible second factor on a reset the user requested thirty seconds ago.
It is indefensible as the life of a credential somebody receives unprompted, because
every ordinary thing that happens to email — a brokerage quarantine queue, a phone read
at dinner, opening it Monday — permanently bricks the account. That is what happened to
three paying customers.

24 hours is the right trade here. A recovery link is single-use, high-entropy, and only
minted on request. Supabase's caution about long expiries is aimed at 6-digit `{{ .Token
}}` OTP codes, which are brute-forceable and which Dossie does not use — our templates
carry `{{ .ConfirmationURL }}` only.

**This does not replace the durable-invite work.** 24 hours is still far too short for a
*first* credential. The right shape is the one on `fix/durable-account-invites-0918`: a
30-day token we own, exchanged for a fresh short-lived link at the moment the customer
clicks. This change makes the ordinary reset survive a night; that branch makes the
first-ever login survive a holiday.

---

## 5. Overlap with `fix/durable-account-invites-0918`

**No files collide.** Everything here is new: `supabase/templates/*` and
`scripts/configure-auth-email.js`. That branch touches `api/_lib/account-invites.js`,
`api/invite*.js`, `api/signup.js`, `api/stripe-webhook.js`, `api/complete-onboarding.js`,
`api/cron-*`, `forgot-password.html`, `set-password.html` and a migration. Not one of
those is modified here. The two branches merge in either order.

They are also complementary rather than redundant:

- That branch owns the **application-level** paths — anywhere our own code mints a link
  and hands it to Resend.
- This one owns the **Supabase-native** paths — the reset that `forgot-password.html`
  fires client-side, and the email-change confirmation, which has *no* server-side hook
  in this repo and therefore can only ever be fixed by the SMTP sender and the template.

Custom SMTP is the backstop underneath both. Any auth mail either branch fails to
intercept now goes out as Dossie instead of Supabase.

### Two follow-ups for after that branch merges

1. **`forgot-password.html` still calls `supabase.auth.resetPasswordForEmail()` directly.**
   The invites branch adds `POST /api/invite-resend`, which correctly issues a durable
   30-day token to a never-activated customer and an ordinary reset to an activated one —
   but nothing points the page at it, so the form keeps going straight to Supabase. Once
   the templates in §3 are live that path is at least branded and deliverable, so this is
   no longer urgent; it is the difference between a locked-out customer getting one hour
   and getting thirty days. One fetch call.

2. **`invite-resend.js` sends the wrong body for a reset.** For an already-activated
   customer it calls `sendInviteEmail(...)` with the subject `Reset your Dossie password`
   but the body is `inviteEmailHtml`, which opens *"you're in"* / *"Your Dossie account is
   ready. Pick a password…"*. Someone who has used Dossie for months and just forgot their
   password gets a welcome email. `supabase/templates/recovery.html` is the copy it should
   be using.

Neither is touched here, on purpose — both live in files that branch owns.

---

## 6. Not done

- **Nothing was sent to any customer.** The only sends were two recovery mails: one to a
  throwaway `@meetdossie.com` user and one to a throwaway `heath.shepard+...@kw.com`
  user, both created and deleted inside the probe. No customer account was read for
  content, modified, or contacted.
- **The config is not applied.** Everything in §3 is still waiting on a token.
- **Link prefetching is unexamined and worth a look.** Brokerage mail security scanners
  routinely "click" links to vet them, which consumes a single-use recovery token before
  the human ever sees it — the customer then gets *"invalid or expired"* on their first
  try. Dossie's customers are real-estate agents on exactly that kind of filtered
  brokerage email. If resets keep failing after this change, that is the next thing to
  look at; the fix is a landing page that makes the user click once more rather than
  consuming the token on load.
