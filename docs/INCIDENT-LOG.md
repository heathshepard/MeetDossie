# Incident Log

## 2026-07-12 — content engine emergency shutdown (reconstructed 2026-07-28)

**Reconstructed after the fact. No contemporaneous record was written — see
"Why this had to be reconstructed" below, which is the more important half of
this entry.**

**What is verifiable from the data:**
- Nine already-published posts (5 LinkedIn, 4 Facebook, originally published
  2026-06-24 through 2026-07-09) were unpublished from Zernio on 2026-07-12.
  Each carries the identical stamped reason: *"REMOVED 2026-07-12 emergency —
  caption leak (competitor briefing or stale founding count)."*
- The same day, the entire content engine was switched off:
  - all 42 `posting_schedule` rows set `is_active = false`
  - `cron-generate-posts` rescheduled to `0 0 1 1 *` (once a year, Jan 1)
- Nothing has been published since **2026-07-09**. As of 2026-07-28 that is
  19 days of zero distribution, during which inbound was 1 waitlist signup,
  0 calculator signups, 0 genuine founding applications.

**What could NOT be substantiated:**
- The removed posts contain ordinary industry commentary — TREC form updates,
  broker compensation changes, a Pennsylvania broker suing over an office
  mandate. Nothing confidential appears in any of them.
- `sage_trend_briefs` for that window are empty placeholders ("No trend data
  available today"), so there was no competitor briefing available to leak.
- The reason string is boilerplate applied identically to all nine rows. It
  reads as a hedge covering two suspicions, not a diagnosis.

**The half that is real and still unfixed:** captions bake the founding-spot
count in at generation time. Three currently-approved posts say "13 spots left"
when the true figure is 14. A wrong public scarcity number is a plausible
trigger for an emergency unpublish, and it will recur on every future post
until spot counts are resolved at publish time instead of at generation time.

**Prevention:**
- Never hardcode a live count (founding spots, customer numbers, MRR) into
  generated caption text. Resolve it when the post publishes.
- An emergency shutdown must be written down the same day, with the trigger,
  the scope, and what has to be true to turn it back on. A pipeline switched
  off with no note stays off - this one cost 19 days.

**Why this had to be reconstructed:**
- `SESSION-DIARY.md` has entries for 2026-07-11, 07-13 and 07-14, and none for
  07-12. The diary skipped the one day that mattered.
- `daily_debriefs` for 2026-07-12 reads in full: "Shipped 0 TODOs. MRR flat.
  4 incidents in last 24h." It counted four incidents and described none of
  them. A debrief that stores a number instead of a description looks like
  coverage while retaining nothing.
- Heath relies on agents for recall rather than his own memory. That makes an
  undescribed incident count a silent failure of the whole arrangement.

---

## 2026-05-08 — Brittney onboarding

Ref: `INCIDENT-2026-05-08.md` (root of repo).

**What happened:**
- Brittney upload bugs during onboarding
- Opus model ID wrong (causing API errors)
- Media/ folder with binary files accidentally committed to repo

**Prevention:**
- Never commit binary files (images, videos, audio) to git — use Supabase Storage or external CDN
- Always verify model strings against current Anthropic API docs before deployment
- Always test with real file sizes before customer onboarding (don't assume small test files = production)

---

## Stripe webhook gap (recurring — 3 incidents)

Ref: `project_stripe_webhook_gap.md` in `.claude/projects/`.

**Pattern:** `api/stripe-webhook.js` only handles `checkout.session.completed`. Direct invoice / Payment Link payments leave customers entirely unprovisioned.

**Incidents:**
1. Terry Katz (2026-05-20) — direct Stripe invoice. Manual recovery.
2. Jennifer Beltrán (2026-05-22) — webhook never fired. Manual recovery 2026-05-24 after she messaged Heath.
3. Lisa Nilsson (2026-05-28) — same root cause. Manual recovery.

**Fix status:** Webhook handler expanded 2026-05-28 to cover invoice.paid + payment_link events. Root cause documented. Monitor next 5 signups for recurrence.
