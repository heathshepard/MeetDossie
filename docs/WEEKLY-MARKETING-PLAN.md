# Dossie Weekly Marketing Plan — SET IN STONE

**Owner:** Pierce (funnel/lifecycle/CS). **Do not restructure without Heath's sign-off** — this is the fixed
weekly operating rhythm, not a suggestion list. Sage's daily content-posting pipeline (docs/PIPELINE.md) runs
independently and is not duplicated here.

**Verified against `docs/CUSTOMERS.md` 2026-08-25:** 8 active customers, $204 MRR (7 founding @ $29 + Suzanne
@ $1). Founding closed permanently 2026-08-04 at 8 members (never reached the 50-spot cohort the URL-phase
plan in `DISTRIBUTION-STRATEGY.md` assumes). 4 real cancellations logged (Zelda, Jennifer, Miki, Amanda).

## Reality check driving this plan

- **We're not in acquisition-at-scale mode — we're in stabilize-and-prove mode.** 8 customers, 4 cancellations
  on the books. Before any paid or scaled acquisition push, retention on the current base is the higher-ROI
  lever: losing 1 more of 8 is a bigger swing than gaining 1 more of 8.
- **`/founding` is a dead acquisition doorway.** It's closed to new signups — CTAs still pointing there in old
  posts/pages are converting into a wall. Flagging for Cole/Carter: new acquisition copy needs to route to
  Solo ($79, rising to $149) / Team ($199, rising to $349) checkout, not `/founding`. I own the copy fix once
  I know the live signup URL for paid tiers — that's a Carter question, not guessed here.
- **No dunning process caused at least one churn (Zelda)** per `docs/CUSTOMERS.md`. That's a product/ops gap
  wearing a retention costume — flagging to Cole/Carter, not solving with a win-back email.

---

## Weekly cadence (fixed)

### Monday — Retention pulse + week setup
- Pull `subscriptions` status changes since last Monday (new, past_due, cancelled). Any `past_due` gets a
  same-day check-in email (not a script — a human note referencing their account).
- Review Sage's prior-week `post_analytics` top/bottom performer (read-only, informs Wednesday test — not my
  pipeline to edit).
- Confirm this week's founding-application queue (if any pending) is at 0 open >48h.

### Tuesday — Activation triage
- Check every customer inside first 14 days of signup: logged in? uploaded a document? drafted first email?
  Zero-activity accounts at day 3/7/14 get the activation drip nudge (see templates below — send manually
  today, cron-ify only after the copy is proven).
- Update `docs/CUSTOMERS.md` notes field for anyone who moved activation stage this week.

### Wednesday — One funnel test, live
- Ship exactly one A/B test this week — landing headline, CTA copy, or email subject. Not three. One,
  measured, decided next Wednesday.
- Log the test (what changed, hypothesis, which pillar — Control/Cost/Visibility/Speed) in
  `docs/CUSTOMERS.md`-adjacent test log (create `docs/FUNNEL-TESTS.md` on first test if it doesn't exist).

### Thursday — Lifecycle email review
- Audit one stage of the lifecycle (rotate: welcome drip -> 30-day check-in -> 60-90d upsell -> win-back) each
  week, 4-week rotation. Confirm the email that's supposed to fire actually fired for anyone who hit that
  trigger this week.
- Any customer crossing the 30-day mark this week gets the testimonial ask (Brittney's pattern — see
  `docs/CUSTOMERS.md` BRITTNEY CONTEXT).

### Friday — Expansion + referral
- Scan active accounts for Team-tier signals (multi-agent brokerage, high transaction volume, "team lead" in
  their notes — e.g., Natalie Megerson's flagged San Marcos team lead). One outbound expansion touch per week,
  minimum.
- One referral ask to a customer at 60+ days with no negative flags. Zelda (churned) came in via Terry's
  word-of-mouth — that channel works, it just isn't asked for systematically. Fix: ask every time, not just
  when it happens organically.

### Weekly, no fixed day — CS escalation sweep
- Any support/complaint signal (Telegram, email, in-app) gets triaged same-day: activation problem, billing
  problem, or genuine product gap. Product gaps get flagged to Carter/Cole, not smoothed over with copy.

---

## Monthly (first week of month)
- Recompute MRR/churn against `docs/CUSTOMERS.md`, reconcile with Stripe. Report the real number — never the
  remembered one.
- Review the 4-week lifecycle-email rotation for gaps (any stage that got skipped).
- One retention-focused piece of customer proof (verified quote/stat only — no fabrication) fed to Sage's
  content pipeline if one exists that month.

## Quarterly
- Full activation-funnel audit: signup -> first login -> first upload -> first drafted email -> first closed
  deal. Find the biggest drop-off, fix that stage before touching anything upstream of it.
- Reprice/upsell path review against the 2026-07-31 price changes (Solo $149, Team $349 for new signups) —
  confirm existing subs are still correctly grandfathered.

---

## What "set in stone" means here
The cadence (which day owns which motion) doesn't move. The *content* of each day's task does — driven by
whatever `docs/CUSTOMERS.md` and `subscriptions` say that week. If a week has zero activations to triage
Tuesday, Tuesday becomes "confirm zero, note it" — not skipped.

## Explicitly out of scope for this plan
- Daily social post generation/scheduling — Sage, `docs/PIPELINE.md`.
- Final brand-voice wording — Heath's call.
- Legal review — Hadley.
- Product fixes surfaced during CS triage — Carter, flagged not solved here.
