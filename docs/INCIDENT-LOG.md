# Incident Log

## 2026-09-30 — near-miss: real contract almost rendered into video background

**What happened:** while building a video, an agent reached for
`.tmp/quinn-downloaded-20-19.pdf` as the on-screen contract background. That
file was a FILLED contract — real property address (987 Magnolia Creek Dr,
San Antonio, TX 78230), a title company, and a $7,200 earnest money figure.
Caught on visual inspection before anything shipped; the agent rebuilt from
the correct blank specimen at `scripts/trec-forms/20-19.pdf`. Nothing was
published. This came within one step of rendering a real client's contract
into a public video on Heath's licensed-agent accounts.

**Root cause:** no structural separation between the video pipeline's
document source and the working directories where real client transaction
PDFs accumulate (`.tmp/`, deal-specific folders). `doc-scroll.js` and
`doc-snip.js` accepted any `--pdf` path with zero validation beyond
`fs.existsSync`. The near-miss filename (`quinn-downloaded-20-19.pdf`) closely
resembled a legitimate blessed-form filename (`20-19.pdf`), sitting one `ls`
away in the same working tree.

**Fix (same day):**
1. Quarantined every filled/executed document found at the top level of
   `.tmp/` (49 files — sellers' disclosures, surveys, T-47s, offer packets,
   executed contracts) plus 6 filled test fixtures that had been sitting in
   `scripts/trec-forms/` itself, into `.private-transaction-docs/` at the repo
   root — gitignored, outside every pipeline's reach. Files were moved, never
   deleted. Nested per-deal working folders inside `.tmp/` were left in place
   (active brokerage files; not globbed by any video script; the guard below
   makes their location irrelevant to video-pipeline safety).
2. Confirmed `scripts/trec-forms/` (the pre-existing forms directory) now
   contains only genuinely blank promulgated TREC forms — verified by
   `pdftotext` + regex scan against every file, zero false positives.
3. Added `scripts/video-engine/assert-blessed-pdf.js` — a path-allowlist +
   content-check guard, called from `doc-scroll.js`, `doc-snip.js`, and
   `capture-screen-recording-trec-clause.js` before any `pdftoppm` call.
   Rejects any path outside `scripts/trec-forms/`, and separately rejects a
   blessed-path file whose content looks filled (real address or completed
   dollar figure) even if the path check passes. Tested against the actual
   incident file (correctly rejected on the path check) and against a blessed
   blank form (renders successfully).

Full detail, the guard's two layers, and the "never point `--pdf` outside
`scripts/trec-forms/`" rule → `docs/VIDEO-RULES.md` "Document source of
truth."

---

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
