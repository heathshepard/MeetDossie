# Citation trail — new TREC guide pages, batch 18 (2026-08-09)

One new guide: Texas HOA assessment liens and foreclosure — Property Code Chapter 209 (the
Texas Residential Property Owners Protection Act). Flagged as a top-confirmed content gap by
search volume. The existing repo guide `marketing/guides-data/texas-hoa-addendum-guide.json`
covers only TREC Form 36-11 (the contract addendum disclosing mandatory HOA membership at time
of sale, tied to Property Code § 207.003 "Subdivision Information"). It explicitly does not
cover the underlying statute governing what an HOA can do once assessments go unpaid — lien
rights, foreclosure procedure, and homeowner protections. This guide is the direct follow-up,
covering a materially different chapter of the Property Code (209, not 207).

**Primary source, method:** same wall and same workaround documented in
`new-trec-guides-citations-batch5.md` — `statutes.capitol.texas.gov` serves only the Angular SPA
shell on direct fetch. Used the Texas Legislative Council's own backing API directly:

```
GET https://tcss.legis.texas.gov/api/GetStatute/GetStatute/PR/209/209/null/null/null/null/null/null/null/htm
```

which returned the resolved document URL
`https://tcss.legis.texas.gov/resources/PR/htm/PR.209.htm#209`. Fetched that `resources` path
directly with `curl` — full chapter, plain HTML, one file for the whole chapter (all sections
209.001–209.017 in one document, anchored by `<a name="209.XXX">`). No API key or auth required;
this is Texas Legislative Council infrastructure, not a third-party mirror. Stripped HTML tags
to plain text locally for direct quoting and section-by-section verification (script-assisted,
not manual eyeballing of raw markup — reduces transcription error on this long a chapter).

Chapter runs to Sec. 209.017 (last section, "Justice Court Jurisdiction," added by Acts 2021,
87th Leg., ch. 951, eff. Sept. 1, 2021). Newest amendment found anywhere in the chapter: Sec.
209.0056 and 209.00592, amended by Acts 2025, 89th Leg., R.S., Ch. 79 (S.B. 2629), eff. September
1, 2025 (notice-of-election and quorum voting-method provisions, not touched by this guide) —
confirms the chapter is current through the 89th Legislature and no later session has amended it.

---

## texas-hoa-foreclosure-lien-guide.json — Property Code Chapter 209

| Claim | Source |
|---|---|
| Chapter cited as the "Texas Residential Property Owners Protection Act" | § 209.001, statute text |
| Chapter applies only to a residential subdivision whose restrictions/declaration authorize the HOA to collect regular or special assessments, and only to an association with mandatory membership for all/a majority of owners | § 209.003(a)–(b), statute text |
| Chapter does not apply to a condominium as defined by § 81.002 or § 82.003 | § 209.003(d), statute text |
| "Assessment lien" defined as a lien, lien affidavit, or other lien instrument evidencing nonpayment of assessments or other charges owed to the association | § 209.0094(a), statute text |
| Before filing an assessment lien: two delinquency notices required — first by first-class mail or e-mail; second by certified mail, return receipt requested, not earlier than 30 days after the first; association may not file the lien until the 90th day after the second notice | § 209.0094(c)–(f), statute text, verbatim mechanics |
| Servicemembers Civil Relief Act carve-out from the two-notice sequence | § 209.0094(g), statute text |
| Alternative payment plan mandatory for HOAs of more than 14 lots — minimum 3-month term, association not required to extend past 18 months, not required to re-offer within 12 months of a prior plan, not required if owner defaulted a prior plan within the last 2 years, not required after the cure period under § 209.0064(b)(3) has expired | § 209.0062(a)–(c), statute text |
| Association must record its payment-plan guidelines in the real property records of each county; failure to record does not defeat an owner's right to request the plan | § 209.0062(d)–(e), statute text |
| Priority-of-payments waterfall (delinquent assessment → current assessment → attorney's fees/collection costs tied to a foreclosure-eligible charge → other attorney's fees → fines → other amounts) | § 209.0063(a), statute text, verbatim order |
| Waterfall does not apply, and fines may not be prioritized over other debt, if the owner is in default under a payment plan | § 209.0063(b), statute text |
| Third-party collection agent: 45-day cure notice required before referral; owner not liable for contingency-fee collection arrangements or collection-agent fees the association isn't itself obligated to pay in full | § 209.0064(b)(3), (c), statute text |
| Attorney's-fee reimbursement requires advance written notice naming a date-certain before fees may be charged | § 209.008(a), statute text |
| **Attorney's-fee cap specific to nonjudicial foreclosure sales**: greater of (1) one-third of actual costs and assessments (excluding attorney's fees) plus interest and court costs, or (2) $2,500 — this cap does not limit fee recovery through other means (e.g., a judicial fee award) | § 209.008(f)–(g), statute text, verbatim |
| Foreclosure prohibited outright if the underlying debt consists solely of fines, attorney's fees tied solely to fines, or amounts added to the account as an assessment under §§ 209.005(i)/209.0057(b-4) (records-request or recount cost overruns) | § 209.009(1)–(3), statute text, verbatim |
| Before filing for expedited or judicial foreclosure, the association must give written notice of the delinquency amount to any inferior/subordinate lienholder of record (deed of trust holder) and a 60-day cure window (may not file before the 61st day after mailing) | § 209.0091(a)–(b), statute text |
| **The judicial-process requirement (the real limit vs. a mortgage lien):** § 209.0092(a) — an HOA may NOT foreclose an assessment lien unless it first obtains a court order via the expedited-foreclosure application process (modeled on the home-equity Rule 50(r) procedure the Texas Supreme Court adopted under Gov't Code § 74.024), UNLESS Subsection (c) or (d) applies | § 209.0092(a)–(b), statute text |
| Exception (c): expedited foreclosure is not required only if the specific owner "agrees in writing at the time the foreclosure is sought" to waive it — and that waiver may not be required as a condition of a title transfer (i.e., it can't be baked into the original declaration/deed as boilerplate; it has to be a case-specific waiver at the point foreclosure is actually pursued) | § 209.0092(c), statute text, verbatim on the "at the time" and "may not be required as a condition of transfer" language |
| Exception (d): even without a waiver, the association may choose full judicial foreclosure — a lawsuit resulting in a court judgment foreclosing the lien and ordering sale under TRCP Rules 309 and 646a — instead of the expedited-order process | § 209.0092(d), statute text |
| An association's foreclosure authority itself is not automatic — a declaration provision granting or removing the right to foreclose a lien for unpaid HOA amounts requires a 67% vote of total allocated votes to add or remove | § 209.0093, statute text |
| Post-sale notice: association must notify the lot owner and each lienholder of record within 30 days of the sale, stating the date/time of sale and the right of redemption, by certified mail return receipt requested; must record an affidavit of that notice within 30 days of sending it | § 209.010(a)–(c), statute text |
| **Right of redemption:** owner (or a lienholder of record, after 90 days if the owner hasn't already redeemed) may redeem within 180 days of the association's mailed notice of sale under § 209.010 | § 209.011(b), statute text, verbatim day counts |
| Purchaser at foreclosure of occupied property must bring a forcible entry and detainer action under Property Code Ch. 24 to obtain possession — cannot self-help evict | § 209.011(a), statute text |
| Redemption price if the association itself was the purchaser: all amounts due at time of sale + interest (declaration rate or 10%/yr default) + the association's foreclosure/conveyance costs including reasonable attorney's fees + post-sale assessments + reasonable holding costs (mortgage payments, repair, maintenance, leasing) − purchase price already applied | § 209.011(d), statute text |
| Redemption price if a third party purchased at the sale is a different, longer list (amounts owed the association net of sale proceeds actually received, interest, costs, post-sale assessments — PLUS separately to the purchaser: post-sale assessments the purchaser paid, the purchase price, deed recording fee, ad valorem taxes/penalties/interest the purchaser paid, taxable FED costs) | § 209.011(e)(1)–(2), statute text |
| Redeemed property remains subject to all pre-foreclosure liens and encumbrances | § 209.011(k), statute text |
| Restrictive-covenant amendment provisions (§ 209.0041, 67% vote threshold for declaration amendments generally) are a separate mechanism from the 67% vote required specifically to add/remove foreclosure authority under § 209.0093 — kept distinct in the guide, not conflated | § 209.0041(h) vs. § 209.0093, both read in full; different subject matter (general declaration amendment vs. foreclosure-authority-specific) |
| Homestead status does not shield a property from HOA assessment-lien foreclosure when the declaration creating the lien was recorded before the property became the owner's homestead — the lien is treated as a pre-existing contractual lien running with the land, not a forced sale for "debt" barred by the homestead article | *Not in Chapter 209 itself* — Texas Supreme Court, *Inwood North Homeowners' Ass'n v. Harris*, 736 S.W.2d 632 (Tex. 1987), confirmed via WebSearch (case holding summarized consistently across Justia, Leagle, and case-brief sources returned) |

**Interpretive/plain-reading note added in the guide itself, not left implicit:** the guide is
explicit that Chapter 209 is unusual next to a typical purchase-money mortgage lien because an
HOA generally cannot go straight to a non-judicial trustee sale the way a mortgage lender can
under Property Code Ch. 51 — the default under § 209.0092 requires court involvement (either
the expedited-order process or a full judicial foreclosure lawsuit), and a true non-judicial sale
is available only when the individual owner signs a case-specific waiver "at the time foreclosure
is sought," which by the statute's own text cannot be extracted as a standing condition of the
original purchase. This is framed as a direct reading of § 209.0092(a)–(d), not as legal opinion.

**Flagged as ambiguous/fact-specific, intentionally left undecided in the guide:**
- § 209.0092(c)'s waiver mechanic doesn't specify a required form, notarization, or delivery
  method for the owner's written waiver of expedited foreclosure — the statute says only "agrees
  in writing at the time the foreclosure is sought." Whether a given waiver a homeowner is asked
  to sign is valid/enforceable in a specific case is a fact-specific legal question the guide does
  not resolve.
- Whether a specific HOA's dedicatory instrument actually grants foreclosure authority at all, and
  whether that authority was validly adopted (or removed) under the § 209.0093 67% vote, is a
  title/instrument-specific question. The guide states the statutory floor but does not tell a
  reader whether their own HOA has this power — that requires reading the actual declaration.
- The homestead point (Inwood North) is case law layered on top of the statute, not Chapter 209
  text itself, and the guide says so explicitly rather than presenting it as if it were a
  Property Code provision. Whether a particular declaration was recorded before or after a given
  owner's homestead was established — which is the fact the Inwood North holding turns on — is
  case-specific and the guide does not assume an answer.
- § 209.008(f)'s attorney's-fee cap applies "if the dedicatory instrument or restrictions of an
  association allow for nonjudicial foreclosure" — since § 209.0092 makes true nonjudicial
  foreclosure the exception (available only after a case-specific waiver), the guide notes the cap
  is the operative limit in that narrower scenario, and that judicial and expedited-order
  foreclosures are not bound by this specific dollar/fraction cap per § 209.008(g) (though
  attorney's fees recovered that way are still subject to ordinary fee-reasonableness rules under
  other law — not itself sourced to Chapter 209, so the guide doesn't elaborate on it as a
  Chapter 209 rule).
- Interest rate on redemption: "the rate stated in the dedicatory instruments for delinquent
  assessments, or if no rate is stated, 10% annually" — which rate applies to a specific property
  depends on the declaration's own text, not something Chapter 209 fixes uniformly.

**Not flagged as ambiguous — confirmed clean:** the two-step delinquency-notice sequence before a
lien may be filed (§ 209.0094), the pre-foreclosure junior-lienholder notice (§ 209.0091), and the
post-sale notice/redemption mechanics (§§ 209.010–209.011) map to distinct, sequential stages
(lien filing → foreclosure filing → sale → redemption) and are kept in that order in the guide's
body copy rather than merged into a single generic "notice" bullet, since the statute treats them
as separate procedural gates with separate deadlines.

**Cross-link point:** the new guide cross-links to `texas-hoa-addendum-guide` (TREC 36-11) as the
"at time of sale" companion — that guide covers what a buyer is told about HOA membership and
fees before closing (§ 207.003 Subdivision Information); this guide covers what happens after
closing if an owner falls behind on those same assessments (Chapter 209). The addendum guide's
own `related_guides` array was not touched (isolation rule — only new files were edited); the
cross-link runs one direction, from the new guide back to the existing one, via `related_guides`
in the new guide's JSON.
