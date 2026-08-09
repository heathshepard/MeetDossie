# Citation trail — new TREC guide pages, batch 21 (2026-08-09)

One new guide: the Residential Construction Liability Act (RCLA), Texas Property Code Chapter 27,
and specifically the 60-day pre-suit notice a homeowner must give a builder/contractor before
suing over a construction defect. The existing repo guide
`marketing/guides-data/texas-new-home-contract-guide.json` (TREC 24-20/23-20) cites this notice
requirement as a single callout — "the contract is subject to Chapter 27... buyer must give the
contractor written notice by certified mail... no later than the 60th day before filing suit" —
but never explains the statute behind it. This is the direct follow-up, same pattern as
`texas-sellers-disclosure-notice-exemptions.json` was to `texas-sellers-disclosure-notice-guide.json`
in batch 5.

**Primary source, method (same wall/workaround as batch 5, re-confirmed working today):**
`statutes.capitol.texas.gov` is still an Angular SPA shell over `curl`/plain fetch — no raw HTML.
Used the same backing API: `GET https://tcss.legis.texas.gov/api/GetStatute/GetStatute/PR/27/27/null/null/null/null/null/null/null/htm`
returned the resolved document URL `https://tcss.legis.texas.gov/resources/PR/htm/PR.27.htm#27`.
Fetched that `resources` path directly with `curl` — 200 OK, `Content-Type: text/html`,
`Last-Modified: Fri, 10 Apr 2026`, served off `tcss.legis.texas.gov` (Texas Legislative Council
infrastructure, not a third-party mirror). Full chapter (Sections 27.001–27.009) received in one
file, tags stripped to plain text, verbatim text quoted directly from that output — not from any
secondary summary site.

**Amendment-history check (same discipline as batch 5):** every section's trailing "Amended by:"
block was read. The latest amendments across the whole chapter are all **Acts 2023, 88th Leg.,
R.S.** — Ch. 291 (S.B. 1768) and Ch. 441 (H.B. 2022), both effective either May 29, 2023 or
September 1, 2023. No entry from the 89th Legislature (2025) appears anywhere in Chapter 27.
Confirmed current as of the April 2026 `Last-Modified` header with no subsequent session having
touched it.

---

## texas-rcla-construction-defect-notice-guide.json — Property Code Chapter 27

| Claim | Source |
|---|---|
| "Construction defect" definition — deficiency in design, construction, or repair of a new residence, alteration/repair/addition to an existing residence, or an appurtenance, "on which a person has a complaint against a contractor," verbatim | § 27.001(3) |
| "Contractor" definition — builder, any person contracting for sale/construction of a new residence built by/on behalf of that person, or a person contracting with an owner or condo/housing-project developer; includes an owner, officer, director, shareholder, partner, or employee of the contractor, and certain risk-retention-group insurers | § 27.001(4) |
| "Residence" definition — detached one/two-family dwelling, townhouse ≤3 stories with separate egress, accessory structure ≤3 stories, duplex/triplex/quadruplex, or condo/co-op unit | § 27.001(6), (9) |
| Chapter applies to any action to recover damages/relief arising from a construction defect (except personal injury, survival, wrongful death, or damage-to-goods claims), and to subsequent purchasers who file a claim | § 27.002(a) |
| Chapter prevails over conflicting law, including the DTPA (Subchapter E, Ch. 17, Bus. & Com. Code) or a common-law cause of action | § 27.002(b) |
| Chapter does NOT apply to: a violation of § 27.01, Business & Commerce Code (a *different* statute with the same "27" number — real-estate fraud in a business transaction); a contractor's wrongful abandonment before completion; or a violation of Chapter 162 (construction trust fund) | § 27.002(d) |
| Contractor liable only to the extent a defect proximately causes actual physical damage, an actual failure of a building component to perform its function, or a verifiable danger to occupant safety | § 27.003(a)(1) |
| Contractor not liable for others' negligence, others' failure to mitigate/maintain/timely notify, normal wear/tear, normal cracking/shrinkage within building-standard tolerance, or reliance on inaccurate government records the contractor couldn't reasonably have known were wrong | § 27.003(a)(2) |
| 60-day notice: claimant must give written notice by certified mail, return receipt requested, to the contractor's last known address, specifying in reasonable detail the construction defects, before the 60th day preceding the date the claimant initiates an action | § 27.004(a), first sentence |
| Claimant must also provide evidence depicting nature/cause of the defect and extent of repairs needed (expert reports, photos, video/audio) if discoverable under Rule 192, Tex. R. Civ. P. | § 27.004(a), second sentence |
| Contractor's inspection right: during the 35-day period after receiving notice, on written request, contractor gets a reasonable opportunity to inspect — up to 3 inspections during that period (or any agreed/legal extension) | § 27.004(a), remainder |
| Contractor's settlement-offer window: not later than the 60th day after receiving notice, contractor MAY make a written offer of settlement (certified mail, return receipt requested) — to repair (fully/partially, at contractor's expense or reduced rate), describing repairs and completion timeline; repairs due within 60 days of claimant's written acceptance | § 27.004(b), first four sentences |
| If claimant considers the offer unreasonable: claimant has until the 25th day after receiving it to advise contractor in writing why; contractor then has 10 days after receiving that objection to make a supplemental offer | § 27.004(b)(1)-(2) |
| Notice not required if impracticable due to limitations expiration or if the complaint is a counterclaim — but the pleading must still specify the defects in reasonable detail; inspection then runs to the 75th day after service, offer to the 60th day after service; if a limitations problem exists and (a) wasn't followed, the action "shall be abated to allow compliance" | § 27.004(c) |
| **Consequence of skipping notice: ABATEMENT, not dismissal.** "The court or arbitration tribunal shall abate an action governed by this chapter" if the claimant failed to give notice, failed to give a reasonable inspection opportunity, or failed to follow the offer procedures — verbatim | § 27.004(d), first sentence |
| Abatement is self-executing: automatic beginning the 11th day after a verified motion to abate is filed (alleging no notice/no inspection opportunity/procedure not followed) unless the claimant controverts it by affidavit before that 11th day | § 27.004(d), second sentence |
| If claimant rejects a reasonable offer, or doesn't allow inspection/repair under an accepted offer: damages capped at the fair market value of the contractor's last offer (or a reasonable monetary/purchase offer under (n)), and attorney's fees limited to those incurred before the offer was rejected | § 27.004(e) |
| If the contractor fails to make a reasonable offer, the damage/fee caps in (e) do not apply | § 27.004(f) |
| Recoverable economic damages (absent the (e) cap): reasonable repair cost, replacement/repair of damaged goods, engineering/consulting fees, temporary housing during repairs, reduction in market value if the defect is a "structural failure," attorney's fees, and arbitration filing/arbitrator-share fees | § 27.004(g) |
| "Reasonableness" of a final settlement offer is decided by the trier of fact — statute does not itself define "reasonable" | § 27.004(j) |
| Imminent health/safety exception: a contractor who receives notice of a defect creating an imminent threat to occupant health/safety must take reasonable steps to cure it as soon as practicable, regardless of the standard notice timeline; if the contractor fails to cure in a reasonable time, the owner may have it cured and recover the reasonable repair cost plus attorney's fees/costs | § 27.004(m) |
| Chapter does not create a cause of action, derivative liability, or extend a limitations period — it modifies/limits an existing claim (contract, warranty, DTPA, negligence, etc.), it is not itself a standalone claim | § 27.005, verbatim |
| Causation: claimant must prove the defect existed at the time construction/alteration/repair was completed AND that damages were proximately caused by it | § 27.006 |
| Disclosure-statement requirement: written contracts subject to the chapter (except condo-developer-to-contractor contracts) must contain the prescribed 10-point boldface notice; the exact boilerplate quoted in TREC 24-20/23-20 (already covered in the existing repo guide) tracks this statutory text verbatim | § 27.007(a) |
| Civil penalty of $500 (in addition to other remedies) if a covered contract omits the required disclosure notice | § 27.007(b) |
| Arbitration submission has the same effect on a limitations period as a court filing | § 27.008 |
| Any attempted contractual waiver of Chapter 27 is void | § 27.009 |
| Frivolous-suit fee-shifting: a party who files an RCLA suit that is groundless and in bad faith or for harassment is liable for the defendant's reasonable attorney's fees and court costs | § 27.0031 |
| Existing guide's own § 27.004 citation ("60th day before filing suit," "reference Chapter 27 and Section 27.004," certified mail) re-checked against the statute text pulled here — consistent, not re-verified independently beyond this cross-check | `texas-new-home-contract-guide.json`, read for consistency |

**Interpretive framing added in the guide itself (not left implicit):** the guide states plainly
that Chapter 27 is a *procedural, damages-limiting layer* on top of an existing claim (breach of
contract, breach of implied warranty, DTPA, negligence) — not its own cause of action — because
§ 27.005 says so directly and this is a common point of confusion worth stating up front rather
than leaving a reader to infer it.

**Flagged as ambiguous/needing attorney judgment, intentionally left undecided in the guide:**
- **Notice trigger vs. liability standard aren't the same test.** § 27.002(a) triggers the whole
  chapter (and its notice requirement) for "any action to recover damages... arising from a
  construction defect" — a broad complaint-level trigger. § 27.003(a) then narrows what the
  contractor is actually *liable* for (physical damage, component failure, or safety danger). A
  homeowner's complaint can be broad enough to trigger the notice obligation without necessarily
  being broad enough to win under the narrower liability standard. The guide keeps these as two
  separate sections rather than collapsing them, and does not tell a reader whether a specific
  complaint clears the liability bar — that's a legal judgment call.
- **"Contractor" reaches further than "the builder."** § 27.001(4)(B) folds in "an owner, officer,
  director, shareholder, partner, or employee of the contractor" and certain risk-retention-group
  insurers. The guide states this because it's easy to assume RCLA only reaches the entity that
  signed the build contract; whether a specific individual (e.g., a superintendent employee) is a
  proper notice recipient in a given case is not something the guide resolves.
- **What makes a settlement offer "reasonable" is not defined in the statute.** § 27.004(j) leaves
  reasonableness to the trier of fact case-by-case. The guide explains the *consequence* of
  rejecting a reasonable offer (the damages/fee cap in (e)) without guessing at what dollar amount
  or scope of repair a court would consider reasonable on a given claim.
- **§ 27.01, Business & Commerce Code is a different, unrelated statute** that happens to share the
  number "27" with this Property Code chapter — it covers a specific real-estate-transaction fraud
  claim and is expressly excluded from RCLA's coverage by § 27.002(d)(1). The guide calls this out
  explicitly to prevent a reader from conflating "Chapter 27" (Property Code, RCLA) with "Section
  27.01" (Business & Commerce Code, fraud) — same number, different code, different subject.
- **Chapter 162 (construction trust fund) violations are also excluded** from RCLA by
  § 27.002(d)(3) — flagged in the guide as a carve-out worth knowing rather than assuming RCLA's
  notice-and-cure process governs every dollar-related builder dispute.

**Not flagged as ambiguous — confirmed clean:** the 60-day notice period, the 35-day/3-inspection
window, the 60-day settlement-offer window, the 25-day objection window, the 10-day supplemental-
offer window, and the 11-day self-executing-abatement window are all stated in the statute in
plain, unambiguous day counts with no discretionary language — quoted and cross-checked directly
against § 27.004(a)-(d) with no rounding or paraphrase risk.

---

## Method note (carried forward from batch 5, re-confirmed working)

`statutes.capitol.texas.gov`'s public `/Docs/<CODE>/htm/<CODE>.<chapter>.htm` URLs still resolve
only to the Angular SPA shell. The reliable path to primary-source text without a headless
browser remains: `GET https://tcss.legis.texas.gov/api/GetStatute/GetStatute/<CODE>/<chapter>/<chapter>/null/null/null/null/null/null/null/htm`,
which returns a short text response pointing at
`https://tcss.legis.texas.gov/resources/<CODE>/htm/<CODE>.<chapter>.htm#<section>` — that
`resources` path serves the actual chapter file as plain HTML (section anchors via
`<a name="X.XXX">`), fetchable directly with `curl`. No API key or auth required. Confirmed a
second time today on Property Code Chapter 27, same as Chapter 5 in batch 5 — this is a stable,
repeatable method for future statute-level guides.
