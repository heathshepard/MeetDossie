# SA REALTOR Cold Email — v2 (two-hook A/B)

**Owner:** Pierce
**Updated:** 2026-06-30 by Pierce (v2)
**Supersedes:** v1 sequence at `Shepard-Ventures/Marketing/drafts/2026-06-24-tx-agents-cold-email-sequence.md` (founder-origin-only hook). v2 adds a parallel hook centered on TX-specific weekday-evening pain points Heath named: option-period repair negotiations, lender-required repairs, low appraisals, second-appraisal orders.
**Test design:** Same 4-touch cadence as v1. Hook 1 (founder origin) vs Hook 2 (brutal-Tuesday-evening) = two test cells running parallel. Subject A/B inside each cell unchanged.

---

## VERIFIED FACTS — REUSED FROM V1 (do not deviate)

- Brittney YBarbo — broker, SE TX, 49 transactions tracked in Dossie (Supabase verified 2026-06-23)
- Miki McCarthy — RGV/McAllen, 9 documents uploaded (Supabase verified 2026-06-23)
- Founding price $29/mo locked vs $79 retail (CLAUDE.md §5)
- 37 of 50 founding spots remaining (per active brief)
- Heath's story — TC quit while he was in Italy with deals in escrow (verified)
- $400/file × 12–30 deals = $4.8k–$12k/yr (verified industry rate)

**NEW pain categories used in Hook 2 — universal TX REALTOR experience, NOT customer-specific fabrications:**
- Option-period repair negotiation
- Lender-required repair lists
- Low appraisal value
- Second appraisal orders

No invented stats, no fake customer names, no specific dollar amounts beyond the verified $400/file math.

---

## HOOK 1 — Founder Origin (unchanged from v1)

**Subject candidates (lowercase, 2-4 words):**
1. did your tc quit?
2. quick question, {{first_name}}
3. $400/file getting old?
4. tc trouble?

**From:** Heath Shepard `<heath@meetdossie.com>`

---

{{first_name}} — last year my TC quit on me while I was in Italy with three deals in escrow.

I'm a working REALTOR at KW in {San Antonio|Boerne}, so I rebuilt the back office myself and ended up turning it into software. It's called Dossie. She drafts your TREC forms, watches every deadline, and writes the client updates so you don't have to.

If you're paying $400 a file to a TC right now — that's $4.8k to $12k a year for most of us.

Worth a quick reply if that math sounds familiar?

— Heath
KW City View / KW Boerne

P.S. We're holding the founding rate at $29/mo for the first 50 agents — locked for the lifetime of your subscription. Fewer than 40 spots remaining.

*Unsubscribe: meetdossie.com/unsubscribe?email={{email}}. Dossie LLC, 5900 Balcones Drive STE 100, Austin, TX 78731.*

**Word count:** 99 | **Links:** 1 (unsubscribe footer)

---

## HOOK 2 — Brutal Tuesday Evening (NEW v2 — TX REALTOR pain layer)

**Subject candidates (lowercase, 2-4 words):**
1. 6:47pm again?
2. option period repairs
3. lender kicked back?
4. second appraisal pending?

**From:** Heath Shepard `<heath@meetdossie.com>`

---

{{first_name}} — it's 6:47pm Tuesday in {{city}}.

You're in the car. The buyer's lender just kicked back another required-repair list. Your seller is fired up about the option-period repair amendment that needs to go out tonight. The second appraisal you ordered Tuesday morning is still "pending review." And the offer you owe back on a different file hasn't been touched.

I'm a working KW agent — I've sat in that exact parking lot. So I built Dossie to handle the tracking, drafting, and reminder layer of those moments. She queues the amendment, watches the appraisal clock, drafts the repair-response email — you stay on the negotiation.

Worth a reply if any of that lands?

— Heath
KW City View / KW Boerne

P.S. Founding rate is $29/mo, locked for the lifetime of your subscription. Fewer than 40 of 50 spots left.

*Unsubscribe: meetdossie.com/unsubscribe?email={{email}}. Dossie LLC, 5900 Balcones Drive STE 100, Austin, TX 78731.*

**Word count:** 137 — RUNS LONG. Trim options below if Heath wants ≤100.

### Hook 2 — tightened to 99 words (recommended for send)

{{first_name}} — it's 6:47pm Tuesday in {{city}}.

You're in the car. The lender just kicked back another required-repair list. The seller's fired up about an option-period amendment that has to go out tonight. The second appraisal you ordered Tuesday is still pending.

I'm a working KW agent. I built Dossie to handle the tracking, drafting, and reminder layer of those exact moments — she queues the amendment, watches the appraisal clock, drafts the repair-response email. You stay on the negotiation.

Worth a reply if that sounds like a normal week?

— Heath
KW City View / KW Boerne

P.S. Founding rate $29/mo, locked. Fewer than 40 of 50 spots left.

*Unsubscribe: meetdossie.com/unsubscribe?email={{email}}. Dossie LLC, 5900 Balcones Drive STE 100, Austin, TX 78731.*

**Word count:** 99 | **Links:** 1 (unsubscribe footer)

---

## EMAILS 2, 3, 4 — UNCHANGED FROM V1

Hook 2 only swaps Email 1. Touches 2 (Brittney social proof), 3 (TREC workflow), and 4 (breakup) stay identical for both cells. See v1 source at `Shepard-Ventures/Marketing/drafts/2026-06-24-tx-agents-cold-email-sequence.md` lines 77–171.

Rationale: hook is the open-rate lever. Once a prospect replies or clicks through, the downstream story (real customer doing 49 deals → TREC workflow → soft breakup) doesn't need to vary.

---

## A/B TEST PLAN (v2)

Same Wave 1 / Wave 2 / Wave 3 structure as v1. Add Hook test as Wave 0:

- **Wave 0 (Week 1, before subject A/B):** Hook 1 (founder origin) vs Hook 2 (Tuesday evening). 500 sends per hook minimum. Lock the winning hook on reply rate. Then run the subject A/B inside the winning hook.
- **Waves 1–3:** As specified in v1.

**Primary metric:** positive reply rate (not open rate — open inflated by Apple MPP). Secondary: cold → founding signup over 14 days.

---

## NORTHWEST ADDRESS — POPULATED 2026-07-01 BY PIERCE

All three hook footers now contain the canonical Northwest Registered Agent service address on file for Dossie LLC per `project_dossie_llc_formation.md`:

> Dossie LLC, 5900 Balcones Drive STE 100, Austin, TX 78731

Source of truth: `project_dossie_llc_formation.md` (RA address, listed publicly on TX SOS filing).
Rule: `feedback_use_northwest_address.md` — Northwest address ONLY for any Dossie LLC public/bulk-mail context.

Hadley still owns final CAN-SPAM footer sign-off at send time.

---

## CHANGES PENDING BEFORE LIVE SEND (carry-over from v1)

1. Northwest address paste (above)
2. `meetdossie.com/unsubscribe` page must be live (Carter task)
3. Demo password handling for Email 3
4. Apollo enrichment `{{first_name}}`, `{{city}}`, `{{brokerage}}` >90% populated
5. Hadley CAN-SPAM sign-off on final HTML (or plain text) before Instantly send
