# Citation trail — texas-pid-disclosure-guide

## Task premise check: is "HB 2468" real and about PID disclosure?

Ambiguous on its face — "HB 2468" alone is not session-specific, and the Texas
Legislature reuses bill numbers every session. Confirmed by direct search:

- **80th Legislature (2007) HB 2468** — unrelated bill, different subject.
- **88th Legislature (2023) HB 2468** — relates to lifetime income benefits
  under the workers' compensation system. Passed House 146-0-1(Present, not
  voting). **Not about PIDs at all.**
- **89th Legislature (2025) HB 2468** — **this is the real one.** Bill
  caption, pulled directly from Texas Legislature Online bill-history page
  (https://capitol.texas.gov/BillLookup/History.aspx?LegSess=89R&Bill=HB2468):
  "Relating to the right of a purchaser to terminate a contract of purchase
  and sale of real property for failure to provide notice that the property
  is located in a public improvement district."

**Conclusion: HB 2468 is real, but only in the 89th Legislature, Regular
Session (2025) — not the 88th, which is a different, unrelated bill that
happens to share the same number.** Any reference to "HB 2468" in this guide
means 89(R) HB 2468 specifically; that qualifier is kept in the guide copy so
it isn't confused with the 88R workers'-comp bill of the same number.

### 89(R) HB 2468 — legislative history (pulled directly)

Source: https://capitol.texas.gov/BillLookup/History.aspx?LegSess=89R&Bill=HB2468

- Filed: 2025-02-05 (author: Harris; Senate sponsor: Parker)
- House committee vote: 10-0
- House floor passage: 2025-04-23
- Senate committee vote: 11-0
- Senate floor passage: 2025-05-22
- Signed by the Governor: 2025-06-20
- Effective: immediately upon signature (2025-06-20), per the bill's own
  Section 2 effective-date clause
- Applies only to contracts executed **on or after** 2025-06-20 — pre-existing
  contracts stay under the prior version of the statute. Confirmed directly
  from the enrolled bill text
  (https://capitol.texas.gov/tlodocs/89R/billtext/html/HB02468F.htm), Section
  2 applicability clause: "applies only to a sale or conveyance of property
  for which a binding contract is executed on or after the effective date of
  this Act."

Passed both chambers without recorded opposition in committee — not a
controversial or contested bill.

## What HB 2468 actually does

It amends **Property Code §5.0141(b)** — a section that already existed
(added 2021, effective 2021-09-01, well before this bill). Confirmed via
https://texas.public.law/statutes/tex._prop._code_section_5.0141 and
https://codes.findlaw.com/tx/property-code/prop-sect-5-0141/ (both pulled
directly, cross-checked against each other and against the enrolled bill
text).

**Before HB 2468:** §5.0141(b) gave a purchaser the right to terminate a
contract "for any reason" if the seller failed to give the required PID
notice before contract execution — with **no stated time limit** on when
that right had to be exercised. Practically, this left the termination right
open indefinitely if the seller never cured by giving late notice.

**After HB 2468 (current law, effective 2025-06-20):** §5.0141(b) reads (pulled
verbatim from the enrolled bill text and cross-confirmed against FindLaw's
current codification):

> "In the event a contract of purchase and sale is entered into without the
> seller providing the notice, the purchaser is entitled to terminate the
> contract for any reason, not later than the seventh day after the date the
> purchaser receives the notice."

So the bill didn't remove the termination right — it put a **7-day clock** on
it, running from the date the purchaser actually receives the late notice
(mirroring the shape of the existing §5.008(f) 7-day termination-right pattern
already used elsewhere in this repo's guides, though it's a textually
separate statute).

### Flagged ambiguity — do not treat as fully resolved

One WebFetch summarization of the enrolled bill text asserted that this 7-day
termination right applies "only if the municipality or county filed a copy of
the service plan with the county clerk under LGC §372.013 before the contract
was entered into" — implying a second, unlimited-time right might still exist
if the service plan was never filed. A second, independent fetch of the
current statute (FindLaw's codification of §5.0141(a)-(d)) does **not**
surface that conditional clause anywhere in subsection (b) itself — instead,
FindLaw's subsection (d) ties the "service plan not filed" scenario to a
**liability shield for sellers/brokers/title companies/examining attorneys**
(they aren't liable for damages if the plan was never filed), not to a second
termination-right track for the buyer.

These two summaries don't fully reconcile from AI-summarized web fetches
alone. The guide below states the confirmed core facts (7-day window, "for
any reason," runs from receipt of notice) and does **not** assert a specific
answer on whether an unlimited-time termination right survives in the
narrow case where the service plan was never filed with the county clerk at
all — that distinction is real practitioner value but needs a direct read of
the current Property Code text (not a summarized fetch) before being stated
as fact in client-facing copy. Recommend Heath or an attorney spot-check
current §5.0141 in full before this nuance is asserted definitively in any
higher-stakes context than a general educational guide.

## Property Code §5.014 — the notice content itself

Source: https://codes.findlaw.com/tx/property-code/prop-sect-5-014.html and
https://texas.public.law/statutes/tex._prop._code_section_5.014 (pulled and
cross-checked against each other; independently corroborated by the verbatim
notice language already quoted in this repo's
`texas-utility-special-district-notices-guide.json`, which quotes the same
"AN ASSESSMENT HAS BEEN LEVIED AGAINST YOUR PROPERTY..." language as coming
from TREC Form 53-0 — TREC 53-0 is the promulgated form that implements this
exact statute).

- Applies to property in a public improvement district under Local Government
  Code Chapter 372, Subchapter A, or Chapter 382.
- Standard notice, §5.014(a-1), must state the assessment has been levied and
  may be paid in full at any time; that if not paid in full it becomes annual
  installments varying by interest/collection/administrative/delinquency
  costs; and that nonpayment may result in penalties, interest, a lien, and
  foreclosure.
- A separate hotel-district notice form, §5.014(a-2), applies only to
  §372.0035 hotel-occupancy-tax-funded districts — not relevant to a typical
  residential resale and not covered further in the new guide.
- Purchaser must sign acknowledging receipt before the binding contract's
  effective date.
- §5.014(c) exempts: foreclosure/court-ordered sales, bankruptcy-trustee
  transfers, mortgagee/beneficiary acquisitions under a deed of trust,
  fiduciary estate/trust transfers, transfers between co-owners, transfers to
  a spouse or a person within the second degree of consanguinity, transfers to
  or from a governmental entity, and transfers of only a mineral, royalty,
  leasehold, or security interest.

This is the same statutory text TREC Form 53-0 exists to satisfy — already
covered from the forms-comparison angle in
`texas-utility-special-district-notices-guide.json`. The new guide does not
re-explain the form-selection question (53-0 vs. 59-0 vs. 58-0); it exists
one layer down, on the delivery-timing / termination-consequence mechanics of
§5.0141 and the 2025 change made by HB 2468, which the existing guide does not
mention at all.

## Local Government Code §372.013 — service plan filing

Source: search results quoting
https://law.justia.com/codes/texas/2021/local-government-code/title-12/subtitle-a/chapter-372/subchapter-a/section-372-013/
(Justia), cross-checked against general search results summarizing the same
section.

- The advisory body prepares an ongoing service plan; the governing body
  (municipality or county) approves it by ordinance or order.
- The plan must cover a period of at least five years and defines annual
  indebtedness and projected improvement costs.
- Reviewed and updated annually.
- Not later than the 7th day after the governing body approves the plan, the
  municipality or county must file a copy with the county clerk of each
  county where the district sits.
- Search results note (secondary, not independently verified against the
  statute's enforcement provisions) that there's no hard enforcement
  mechanism forcing this filing, and that in practice PID service plans are
  not always filed — relevant context for why §5.0141(d)'s liability shield
  for a seller/broker exists, but not asserted as an independently-confirmed
  statutory fact in the guide body.

## What "not covered anywhere in the repo" actually means here

`marketing/guides-data/texas-utility-special-district-notices-guide.json` was
read in full before writing anything. It already covers, thoroughly: TREC
53-0's exact notice text (same as §5.014(a-1)), TREC 59-0 (MUD/Water Code
Ch. 49 districts — explicitly NOT for PIDs), and TREC 58-0 (non-TREC-contract
notice, references §5.014 in passing). It does **not** mention §5.0141 at
all — no delivery-before-contract-execution rule, no termination right, no
waiver-on-closing-anyway rule, no liability shield, no HB 2468, no 2025
amendment. The existing guide is a "which form" guide; this is a "what the
missed-disclosure legal consequence actually is" guide, one statutory section
over from the one it already covers, and genuinely new information — not a
duplicate.

## PID vs. HOA vs. MUD — brief distinction sourced from primary statutes

- **PID (Public Improvement District):** created by a municipality or county
  under Local Government Code Ch. 372 or 382; funds public improvements
  (streets, landscaping, parks, etc.) via an **assessment** that attaches to
  the property (a lien), collected similarly to property taxes, governed by
  §5.014/§5.0141, Property Code, for disclosure purposes.
- **MUD (Municipal Utility District):** a separate taxing entity created
  under the Water Code (Ch. 49 and related chapters) that issues bonds for
  water/sewer/drainage infrastructure, repaid via **ad valorem property tax**
  levied by the district itself — disclosed under a different statute
  (Water Code §49.452/453) and a different TREC form (59-0), per the existing
  utility-district guide already in this repo.
- **HOA:** a private, non-governmental association created by restrictive
  covenant, not a taxing entity — dues are a **contractual** obligation, not
  a government assessment or tax, and disclosure runs through the HOA
  addendum (TREC 36-*) rather than Property Code §5.014/§5.0141 at all.

This three-way distinction is drawn directly from each entity's own enabling
statute (Local Government Code Ch. 372/382 for PIDs, Water Code Ch. 49 for
MUDs) rather than from a secondary explainer, though the framing/comparison
itself is original synthesis for the guide.

---

## Hadley legal-review correction (2026-08-09)

The "Flagged ambiguity — do not treat as fully resolved" section above (lines
78-101) turned out not to be an open question — it was the actual conditional
rule, and the shipped guide had it backwards. Hadley independently re-pulled
the enrolled HB 2468 bill text directly from
`https://capitol.texas.gov/tlodocs/89R/billtext/html/HB02468F.htm` and
confirmed the complete, current §5.0141(b) reads as two sentences, not one:

> "In the event a contract of purchase and sale is entered into without the
> seller providing the notice, the purchaser is entitled to terminate the
> contract for any reason, not later than the seventh day after the date the
> purchaser receives the notice. A purchaser may terminate the contract under
> this subsection only if the municipality or county filed a copy of the
> service plan with the county clerk in accordance with Section 372.013,
> Local Government Code, before the date the contract was entered into."

**What this resolves:** the WebFetch summary quoted at line 80-83 above (the
one asserting a filing condition) was correct. The second, independent
FindLaw-based fetch that appeared to contradict it (lines 84-90) was reading
an *incomplete* quote of (b) — the filing condition is the second sentence of
subsection (b) itself, not something FindLaw's codification omitted. There is
no unreconciled ambiguity and no second, unlimited-time termination track for
the case where the service plan was never filed. The correct rule: **the
7-day termination right under (b) exists only if the district's service plan
was filed with the county clerk (LGC §372.013) before the contract was
signed.** If it wasn't filed by then, subsection (b) gives the buyer no
termination right at all — subsection (d)'s liability shield (sellers,
title companies, brokers, and examining attorneys aren't liable for damages
in that scenario) is a separate, different protection and does not create a
termination right of its own.

**Guide fixes made as a result (`texas-pid-disclosure-guide.json`):**
1. The verbatim §5.0141(b) quote in `body_html` now includes both sentences
   instead of presenting the first sentence alone as the complete subsection.
2. The callout box, which previously framed the filing-timing question as
   unresolved, now states the actual conditional rule (filed before contract
   signing → 7-day right exists; not filed → no (b) termination right, only
   the separate (d) liability shield applies).
3. FAQ #3 ("What happens if a seller doesn't give the PID notice before the
   contract is signed?") now states the same filing condition instead of the
   termination right unconditionally. Checked for a duplicate FAQPage
   JSON-LD block in the generated HTML — there is only one, generated from
   the same `faq` array, so no separate fix was needed there.

**Non-blocking fix made in the same pass:** the guide's "passed the House
146-0" claim was also dropped. Repeated fetches of the House floor vote gave
inconsistent counts (one showed 142-4 with 2 present not voting) and neither
could be confirmed against a primary source. Replaced with "passed both
chambers with no recorded committee opposition" — this matches what's
actually confirmed in this file's own legislative-history table above (House
committee vote 10-0, Senate committee vote 11-0), not a floor-vote tally that
couldn't be verified.
