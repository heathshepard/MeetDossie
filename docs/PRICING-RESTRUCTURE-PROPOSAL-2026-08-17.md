# Pricing Restructure Proposal — Team + Brokerage (DRAFT)

**Status: DRAFT — pending Heath's sign-off on exact digits. Not live. Not in Stripe.
Not in CLAUDE.md Section 5 (which stays LOCKED at current pricing until Heath says
otherwise). This doc is the concrete proposal Heath asked for after confirming the
restructure direction 2026-08-17.**

Solo tier is NOT touched by this proposal — it's already healthy (see math below) and
stays at $149/mo ($79/mo annual).

---

## 1. Why this is happening — the value-capture problem

Value-capture = what Dossie charges ÷ the cost of the human TC work it replaces.
Healthy range for a tool that fully replaces a paid role: **15–30%** of cost replaced
(higher end justified when it also cuts E&O/compliance exposure — real value not
counted in these numbers at all).

**Current Team tier, worked for a 10-agent office:**

| | |
|---|---|
| Agents | 10 |
| Files/agent/mo | 2 |
| Human TC cost/file | $400 |
| **Value replaced/mo** | 10 × 2 × $400 = **$8,000** |
| Current Team cost (5 seats incl. + $35/seat overage) | $349 + (5 × $35) = **$524** |
| **Capture** | 524 / 8,000 = **6.5%** |

That's roughly a third of the floor of the healthy range. The "5 included seats, cheap
$35 overage" structure also makes the office's bill degenerate toward almost-free per
seat as it scales — the opposite of what a role-replacement tool should do.

**Solo, for comparison (unchanged, already healthy):**

$149/mo ÷ (1 agent × 2 files × $400) = 149/800 = **18.6%** capture. Solo stays as-is.

---

## 2. Proposed Team tier — flat per-agent, no included/overage split

**$129/agent/mo, 3-agent minimum (floor = $387/mo). Monthly billing.**

Every seat costs the same. No "5 included then $35 overage" — that tier-within-a-tier
was the actual confusion problem, not just the price level.

**Capture math (constant at any team size, because it's flat per-seat):**

$129 ÷ (2 files × $400) = 129/800 = **16.1%** capture — squarely mid-range of the
15–30% healthy band, roughly 2.5x today's 6.5%.

| Team size | Old cost (5 incl. + $35/seat) | Old capture | New cost (flat $129/seat) | New capture |
|---|---|---|---|---|
| 3 (new minimum) | n/a — below old model's assumption | — | $387 | 16.1% |
| 5 | $349 | 8.7% | $645 | 16.1% |
| 10 | $524 | 6.5% | $1,290 | 16.1% |
| 20 | $349 + 15×$35 = $874 | 5.5% | $2,580 | 16.1% |

The old model's capture % actually *fell* as the office grew (more seats hit the cheap
$35 overage). The new flat model holds a constant, healthy 16.1% regardless of size —
this is the real fix, not just a price increase.

### Annual rate: $80/agent/mo (billed annually)

CLAUDE.md's existing annual-discount pattern: Solo $79→$39 is ~50% off; old Team
$199→$119 is ~40% off. This proposal splits the difference, weighted toward the lower
end because Team's healthy-range capture (16.1%) has less room to give away than
Solo's (18.6%) before falling out of the 15–30% band:

- 38% off $129 = $129 × 0.62 = $79.98 → **round to $80/agent/mo**
- 3-agent minimum still applies → annual floor = 3 × $80 = **$240/mo ($2,880/yr)**
- Capture at annual rate: 80/800 = 10% — still inside 15–30%'s lower reach only if we're
  lenient; strictly it's below 15%. **Flagging this: the annual discount as proposed
  pushes capture under the healthy floor.** Options for Heath: (a) accept it as a
  volume/commitment trade (annual = cash upfront, lower churn risk, worth the discount),
  same logic used for Solo/old-Team already, or (b) tighten the annual discount to ~25-30%
  off (~$90-97/agent/mo) to stay inside 15%+. I did not resolve this — needs Heath's call.

---

## 3. Proposed Brokerage tier — real rate card instead of "custom" with nothing behind it

Brokerage currently has zero published numbers — "custom" with no anchor at all. This
proposes a banded per-agent rate (declining with volume, standard SaaS practice) plus a
flat base fee for brokerage-only features that aren't simple per-agent TC replacement.

### Bands

| Band | Rate | Minimum monthly commitment |
|---|---|---|
| 11–25 agents | **$89/agent/mo** | **$1,200/mo** |
| 26–75 agents | **$69/agent/mo** | (per-agent math clears the old band's minimum by definition — see below) |
| 76+ agents | **custom**, anchored at **~$45/agent/mo** | **$50,000/yr (~$4,167/mo)** real annual minimum, not open-ended |

Plus, on top of all three bands: **flat $300/mo base/admin fee** for brokerage-only
value that isn't per-agent TC replacement — consolidated compliance dashboard,
office-wide file-consistency reporting, dedicated onboarding. This is priced
separately on purpose; folding it into the per-agent rate would hide it and make the
per-agent number not comparable band-to-band.

### Capture math by band

| Band example | Per-agent price | Minimum bite? | Effective monthly cost | Value replaced/mo (agents × 2 × $400) | Capture |
|---|---|---|---|---|---|
| 11 agents | $89 × 11 = $979 | yes, $1,200 min > $979 | **$1,200** (+ $300 base = $1,500 all-in) | $8,800 | 13.6% (17.0% all-in w/ base) |
| 25 agents | $89 × 25 = $2,225 | no | **$2,225** (+ $300 = $2,525) | $20,000 | 11.1% (12.6% all-in) |
| 26 agents | $69 × 26 = $1,794 | no | **$1,794** (+ $300 = $2,094) | $20,800 | 8.6% (10.1% all-in) |
| 75 agents | $69 × 75 = $5,175 | no | **$5,175** (+ $300 = $5,475) | $60,000 | 8.6% (9.1% all-in) |
| 76 agents | $45 × 76 = $3,420 | yes, $4,167 min > $3,420 | **$4,167** (+ $300 = $4,467) | $60,800 | 6.9% (7.3% all-in) |
| 150 agents | $45 × 150 = $6,750 | no | **$6,750** (+ $300 = $7,050) | $120,000 | 5.6% (5.9% all-in) |

Capture % declines with scale by design (standard volume-discount economics for a
role-replacement SaaS at high seat counts), but every band still sits **above the
Team tier's absolute dollar-per-agent floor never goes below $45**, and every band adds
real revenue — the point of this proposal is that "custom" today effectively means
"$0 anchor," not that these bands are meant to match Team's 16.1% capture rate.
**Flagging: the 76+ band's capture (5.6–7.3%) is close to where the *current, broken*
Team tier sits (6.5%) — worth a gut check with Heath on whether $45/agent is too low
even as a starting anchor, or whether the E&O/compliance value (uncounted here, and
larger at enterprise scale) justifies it.**

### Annual Brokerage terms

**Not proposed here — open question for Heath (see below).** No annual Brokerage rate
exists in this draft.

---

## 4. Open questions for Heath (not resolved in this doc)

1. **Exact final digits.** Every number above is the anchor from Heath's approved
   direction, not a locked number — Team $129/$80, Brokerage $89/$69/~$45, base fee
   $300, minimums $1,200/$50k-yr. All are round-number starting points; sign off or
   adjust each one.
2. **Team annual discount rate.** As proposed (38% off → $80/agent/mo), capture drops
   to 10%, below the 15% floor. Decide whether that's an acceptable commitment trade
   (matches existing Solo/Team logic) or should be tightened to keep capture ≥15%.
3. **Does an annual Brokerage tier exist at all?** Not built into this draft. If yes,
   need a discount rate and whether it varies by band.
4. **3-agent Team minimum — enforcement mechanism at signup.** This requires new
   Stripe configuration (per-seat/quantity pricing with a quantity floor, or new Price
   objects) — not something the current flat Team Price object supports. Flagging as a
   build item, not touching Stripe now per instructions.
5. **CLAUDE.md Section 5 currently says Team = "3 seats" base; the pitch deck and this
   restructure's starting math (matching Heath's approved direction) use "5 seats
   included."** Those two source-of-truth numbers already disagree before this
   proposal touches anything — worth reconciling regardless of which pricing model
   ships.
6. **76+ Brokerage band** is the least fleshed out — still explicitly "custom" per
   Heath's original framing. The $45/agent + $50k/yr anchor is a starting point for
   negotiation, not a rate to quote unprompted.
7. **Existing pipeline impact:** no customer is currently on a paying Team or
   Brokerage subscription (`docs/CUSTOMERS.md` — all 11 active accounts are Founding).
   Natalie Megerson is flagged as a "HOT TEAM-tier LEAD" for a multi-agent San Marcos
   team — if this restructure ships before she converts, her pitch changes from
   "$349/mo flat" to "$129/agent/mo, 3-agent minimum." No grandfathering conflict
   exists yet, but timing matters for that one live lead.

---

## 5. What changed in this pass

- `marketing/brokerage-pitch-deck.html` — Slide 9 (Pricing) and Slide 8 (Sample ROI
  Math) updated to the new proposed numbers, both slides now internally consistent
  with each other and with this doc. Slide explicitly marked as proposed/pending, not
  live pricing.
- `CLAUDE.md` Section 5 — **not touched.** Stays the locked, live source of truth
  until Heath explicitly approves final digits.
- No Stripe objects touched. No `/agents` page touched.
