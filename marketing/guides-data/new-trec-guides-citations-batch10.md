# Citation trail — new TREC guide pages, batch 10 (2026-08-08)

One new guide: Texas Property Code Chapter 5, Subchapter D — Executory Contracts for
Conveyance (contract for deed / seller-financed deals where the seller does not deed the
property to the buyer at closing). This is the governing statute the existing repo guide
`marketing/guides-data/texas-seller-financing-addendum-guide.json` (TREC 26-8) only
touches as a side reference — that guide covers the TREC form used when a seller
finances a deal that *does* transfer title at closing via a deed of trust. Subchapter D
governs the opposite structure: a contract where the deed doesn't pass until later (or
never, if the buyer defaults), which is the "contract for deed" pattern the addendum
guide explicitly does not cover.

**Primary source and method — same as batch 5:** `statutes.capitol.texas.gov` is an
Angular SPA; WebFetch/curl against its public `/Docs/PR/htm/PR.5.htm` URL returns only
the JS shell. Used the documented workaround: `GET
https://tcss.legis.texas.gov/api/GetStatute/GetStatute/PR/5/5/null/null/null/null/null/null/null/htm`
resolves to `https://tcss.legis.texas.gov/resources/PR/htm/PR.5.htm` — the same file used
for the § 5.008(e) guide, since Chapter 5 is a single HTML file covering all subchapters
(A through H). Fetched the full chapter (`curl -s -D -`), confirmed `Last-Modified: Fri,
10 Apr 2026` header (same as batch 5 — current, not stale), then isolated Subchapter D by
its `<a name="D">...SUBCHAPTER D. EXECUTORY CONTRACT FOR CONVEYANCE` header through to the
`<a name="F">...SUBCHAPTER F` header (there is no Subchapter E in Chapter 5 — the file
jumps D → F; confirmed by grepping every `SUBCHAPTER [A-Z]\.` header in the file, only
A/B/C/D/F/G/H exist). HTML tags stripped to plain text for direct quoting; every section
anchor (`5.061` through `5.087`) captured in order.

**Second source pulled for this batch, not part of the § 5.008(e) precedent:** Property
Code § 5.062(a) and § 5.062(d)(1) both define family/related-party status by reference to
"the second degree by consanguinity or affinity, as determined under Chapter 573,
Government Code" rather than defining it inline. Rather than describe that cross-reference
vaguely, fetched Government Code Chapter 573 the same way: `GET
.../api/GetStatute/GetStatute/GV/573/573/.../htm` → `tcss.legis.texas.gov/resources/GV/htm/GV.573.htm`.
Read in full. Relevant sections: § 573.021 (degree computed by "civil law method"), §
573.022 (consanguinity = descendant of the other, or share a common ancestor), § 573.023
(computation — parent/child = 1st degree, sibling/grandparent/grandchild = 2nd degree,
etc.), § 573.024 (affinity = married to each other, or one's spouse is related by
consanguinity to the other), § 573.025 (husband and wife = 1st degree affinity; for other
affinity relationships, degree matches the underlying consanguinity degree — e.g. a
sibling's spouse is 2nd-degree affinity because the sibling is 2nd-degree consanguinity).

---

## texas-executory-contract-for-deed-guide.json — Property Code Chapter 5, Subchapter D (§§ 5.061–5.087)

| Claim | Source |
|---|---|
| § 5.061 — "default" means failure to make a timely payment or comply with a contract term, verbatim | Statute text, § 5.061 |
| § 5.062(a) — subchapter applies only to an executory contract for property "used or to be used as the purchaser's residence" or the residence of a person related within the second degree by consanguinity/affinity under Gov't Code Ch. 573 | Statute text, § 5.062(a) |
| § 5.062(a)(1) — a lot of one acre or less is presumed residential, for this subchapter only | Statute text, § 5.062(a)(1) |
| § 5.062(a)(2) — a lease-option combined with or concurrent with a residential lease is treated as an executory contract | Statute text, § 5.062(a)(2) |
| § 5.062(b) — subchapter does not apply to sale of state land, or land sold by the Veterans' Land Board, the state/a political subdivision, or an entity created to act on their behalf | Statute text, § 5.062(b)(1)-(2) |
| § 5.062(c) — subchapter does not apply to an executory contract that delivers a deed within 180 days of the contract's final execution | Statute text, § 5.062(c) |
| § 5.062(d) — §5.066 and §§5.068–5.080 don't apply if buyer is related to seller within the second degree (Ch. 573) AND has waived those sections in a written agreement — both conditions required | Statute text, § 5.062(d)(1)-(2) |
| § 5.062(e) — §§5.066, 5.067, 5.071, 5.075, 5.079, 5.081, 5.082 don't apply to a lease-purchase executory contract described in (a)(2) | Statute text, § 5.062(e) |
| § 5.062(f)-(g) — a narrower list of sections (5.063-5.065, 5.073 except (a)(2), 5.083, 5.085) applies instead to a lease-purchase contract of 3 years or less where the same parties/assignees haven't had a longer-than-3-year executory contract on the same property before; (f) overrides conflicting provisions except (b) | Statute text, § 5.062(f)-(g) |
| § 5.0621 — this subchapter and Property Code Ch. 92 (landlord-tenant) both apply to the lease portion of a lease-purchase contract, until the tenant exercises the purchase option, at which point Ch. 92 stops applying | Statute text, § 5.0621(a)-(b) |
| § 5.0622 — a county (population <100,000, in a specific MSA-size/adjacency bracket) may by commissioners-court order extend this subchapter to residential executory contracts in that county, with carve-outs for §5.062(b)/(c)/(d) contracts and most agricultural-use land | Statute text, § 5.0622(a)-(d) |
| § 5.063(a) — notice under § 5.064 must be written, sent registered/certified mail return receipt requested, in 14-point boldface or uppercase type, with the statutory "NOTICE... UNLESS YOU TAKE THE ACTION SPECIFIED..." language on a separate page | Statute text, § 5.063(a), quoted verbatim |
| § 5.063(b) — notice must identify the remedy, and if payment default: itemize delinquent principal/interest, additional charges, and the period; if term-violation default: identify the term and cure action | Statute text, § 5.063(b)(1)-(3) |
| § 5.063(c) — notice by mail is given when mailed to purchaser's residence/business; affidavit is prima facie evidence for a subsequent bona fide purchaser | Statute text, § 5.063(c) |
| § 5.064 — seller may enforce rescission or forfeiture-and-acceleration only if: (1) seller gave the §5.063 notice of intent + cure right, (2) purchaser failed to cure within the 30-day §5.065 period, (3) §5.066 (equity protection) does not apply, and (4) the contract has not been recorded — all four conditions, not any one | Statute text, § 5.064(1)-(4) |
| § 5.065 — purchaser may cure by complying with the contract on or before the 30th day after the §5.064 notice is given, "notwithstanding an agreement to the contrary" | Statute text, § 5.065, quoted verbatim on the non-waivable phrase |
| § 5.066(a) — once a purchaser in default has paid 40%+ of the amount due, OR the equivalent of 48 monthly payments, OR (regardless of amount paid) the contract has been recorded, the seller's remedy shifts from forfeiture to a trustee power-of-sale; seller may not use rescission/forfeiture after the contract is recorded | Statute text, § 5.066(a) — read as three independent, disjunctive triggers ("or"), not cumulative |
| § 5.066(b)-(f) — 60-day cure notice (substituting the "TRUSTEE...SELL YOUR PROPERTY AT A PUBLIC AUCTION" language), sale posted/noticed/conducted per §51.002, seller must convey fee simple title free of encumbrance and warrant same, excess proceeds go to purchaser, deficiency subject to §§51.003-.005 | Statute text, § 5.066(b)-(f), quoted verbatim on the substitute notice language |
| § 5.066(g) — if a purchaser defaults *before* reaching the 40%/48-payment threshold, the seller may still use rescission/forfeiture per §§5.063-5.064 (i.e., equity protection is threshold-gated, not automatic from day one) | Statute text, § 5.066(g) |
| § 5.067 — a utility-service improvement lien placed on the property does not itself constitute a default under the executory contract | Statute text, § 5.067 |
| § 5.068 — if negotiations were conducted primarily in a non-English language, seller must provide a copy of all transaction documents (contract, disclosures, annual statements, default notices) in that language | Statute text, § 5.068 |
| § 5.069(a) — before the purchaser signs, seller must provide a survey/plat completed within the past year, copies of documents describing any encumbrance/restrictive covenant/easement, and the statutory box-check property-condition WARNING/disclosure form attached to the contract | Statute text, § 5.069(a)(1)-(3), form language quoted verbatim |
| § 5.069(a)(3) box-check items — subdivision status, potable water service, sewer service, septic-system approval, electric service, floodplain status, road maintenance responsibility, no adverse ownership/lien/interest claims, no restrictive covenants blocking construction — quoted verbatim in order | Statute text, § 5.069(a)(3) form text |
| § 5.069(b) — if the property is not in a recorded subdivision, seller must give a separate disclosure that utilities may be unavailable until the subdivision is recorded | Statute text, § 5.069(b) |
| § 5.069(c) — any advertisement of the property must disclose water/sewer/electric service availability | Statute text, § 5.069(c) |
| § 5.069(d)-(e) — failure to provide this info is a DTPA (Bus. & Com. Code § 17.46) violation and entitles the purchaser to cancel/rescind and get a full refund of payments made; doesn't limit other DTPA remedies | Statute text, § 5.069(d)-(e) |
| § 5.070(a) — before signing, seller must also provide a tax certificate (Tax Code § 31.08) from each taxing unit and a legible copy of the insurance policy/binder showing insurer, insured, property description, and coverage amount | Statute text, § 5.070(a)(1)-(2) |
| § 5.070(b)-(d) — same DTPA/cancel-and-refund consequence for failure to provide; if the contract is recorded, seller no longer has to keep insuring the property | Statute text, § 5.070(b)-(d) |
| § 5.071 — before signing, seller must give a written statement of purchase price, interest rate, total interest dollar amount (or estimate if variable), total principal+interest to be paid, any late charge, and that no prepayment penalty may be charged | Statute text, § 5.071(1)-(6) |
| § 5.072 — an executory contract is unenforceable unless written and signed; rights/obligations come solely from the written contract, prior oral agreements are superseded; contract may not be varied by oral agreements before/at signing; seller must include a 14-point bold "FINAL AGREEMENT...NO UNWRITTEN ORAL AGREEMENTS" merger-clause statement, with the same DTPA/cancel-and-refund consequence for omitting it | Statute text, § 5.072(a)-(f), merger clause quoted verbatim |
| § 5.073(a) — a seller may not include contract terms that: (1) impose a late fee exceeding the lesser of 8% of the monthly payment or actual processing cost, (2) prohibit the purchaser pledging their interest for an improvement loan, (3) impose a prepayment penalty, (4) forfeit an option fee for a late payment, or (5) penalize a lease-option purchaser for requesting repairs or exercising Ch. 92 rights | Statute text, § 5.073(a)(1)-(5) |
| § 5.073(b) — any contract provision purporting to waive a right or duty under this subchapter is void | Statute text, § 5.073(b) |
| § 5.074(a) — purchaser may cancel/rescind for any reason within 14 days of the contract date, by telegram/certified/registered mail or in-person delivery of signed written notice | Statute text, § 5.074(a) |
| § 5.074(b) — on cancellation, seller must, within 10 days, return the executed contract and any property/payments exchanged, and cancel any resulting security interest | Statute text, § 5.074(b) |
| § 5.074(c)-(e) — required 14-point bold notice next to the signature line, a required Notice of Cancellation form with statutory language, and a ban on asking the purchaser to waive receipt of that form | Statute text, § 5.074(c)-(e), quoted verbatim |
| § 5.075 — on contracts entered into *before* Sept. 1, 2001 only, a purchaser may pledge their § 5.066 equity interest, but only for a loan improving the property's safety (water/wastewater/septic connection, structural improvements, fire protection) | Statute text, § 5.075(a)-(b) — flagged in guide as a narrow, dated provision, not current-contract-relevant except for legacy deals |
| § 5.076(a) — seller must record the executory contract (with the attached §5.069 disclosure) within 30 days of execution | Statute text, § 5.076(a) |
| § 5.076(e) — a seller who violates the recording requirement is liable to the purchaser the same way as a §5.079 violation, capped at $500 per calendar year of noncompliance | Statute text, § 5.076(e) |
| § 5.077(a)-(b) — seller must give an annual accounting statement each January (postmarked by Jan. 31 if mailed) showing amount paid, remaining balance, payments remaining, tax/insurance amounts paid on purchaser's behalf, insurance-proceeds accounting, and current policy copy if coverage changed | Statute text, § 5.077(a)-(b)(1)-(7) |
| § 5.077(c)-(d) — liquidated damages for missing the annual statement: $100/statement for a seller doing fewer than 2 transactions/year under this section, or $250/day (capped at the property's fair market value) for a seller doing 2+ | Statute text, § 5.077(c)-(d) |
| § 5.077(e) — the annual-statement duty continues even after the purchaser gets title by conversion or otherwise | Statute text, § 5.077(e) |
| § 5.078 — named insured must tell the insurer about the executory contract and the other party within 10 days; insurer must pay casualty proceeds jointly to purchaser and seller; proceeds must be used to repair/remedy/improve the property; failure is a DTPA violation | Statute text, § 5.078(a)-(e) |
| § 5.079(a) — a recorded executory contract functions as a deed with a vendor's lien (implied general warranty unless limited), enforceable by §5.066 foreclosure sale or judicial foreclosure; if the contract is unrecorded and not converted under §5.081, the seller must transfer recorded legal title within 30 days of receiving the purchaser's final payment | Statute text, § 5.079(a) |
| § 5.079(b) — liquidated damages for late title transfer: $250/day for days 31-90 after final payment, $500/day after day 90, plus attorney's fees | Statute text, § 5.079(b)(1)-(2) |
| § 5.079(c)-(d) — a court may waive those damages for an heir/successor pursuing a court order to establish title with reasonable diligence; "seller" includes successors/assignees/personal reps | Statute text, § 5.079(c)-(d) |
| § 5.080 — a disclosure made by the seller's agent counts as a disclosure made by the seller, for purposes of this subchapter | Statute text, § 5.080 |
| § 5.081(a)-(b) — purchaser may convert their interest into recorded legal title **at any time**, without penalty, regardless of whether the contract was recorded, by tendering the full remaining balance | Statute text, § 5.081(a)-(b) — this is the section explicitly checked against the task brief's assumption of an "automatic conversion after enough payments" provision; see ambiguity note below |
| § 5.081(c)-(d) — alternatively, purchaser may deliver a promissory note (same balance/rate/due dates/late fees as the contract) and simultaneously execute a deed of trust; seller must respond within 10 days either refusing (with legal justification) or scheduling the closing | Statute text, § 5.081(c)-(d) |
| § 5.081(e)-(h) — violation liability mirrors §5.079; contract is "considered completed" with "no further effect" once both conveyances execute; using TREC's published forms for this transaction satisfies the section; section doesn't limit other purchaser rights | Statute text, § 5.081(e)-(h), "considered completed"/"no further effect" quoted verbatim |
| § 5.082 — on written request, purchaser is entitled to a payoff-balance statement and (if applicable) the seller's proposed §5.081 trustee, within 10 days; if seller doesn't respond, purchaser may determine/pay the amount and pick their own trustee (must be in-county), subject to a 20-day seller objection window with documentation requirements | Statute text, § 5.082(a)-(e) |
| § 5.083 — purchaser may cancel/rescind at any time on learning the seller improperly subdivided/platted the property; seller then has 10 days to notice intent to properly plat (with a 90-day cure window) or must refund all payments plus reimburse taxes paid and improvement value; seller can't remove purchaser's possession until that payment is made | Statute text, § 5.083(a)-(d) |
| § 5.084 — a purchaser owed money by the seller under this subchapter may deduct it from amounts owed to the seller, without going to court | Statute text, § 5.084 |
| § 5.085(a)-(b) — seller may not execute a contract without owning the property in fee simple free of liens, and must maintain that fee-simple, lien-free title for the entire contract term, subject to narrow carve-outs | Statute text, § 5.085(a)-(b) |
| § 5.085(b)(1)-(3) — carve-outs: liens caused by the purchaser's own conduct, liens the purchaser agreed to for an improvement loan, and a specific pre-existing purchase-money lien the seller placed before signing — but only if the seller gives a detailed pre-contract written disclosure (lienholder contact, loan number/balance, payment schedule, 14-point foreclosure-risk warning), the lien is capped at the purchaser's outstanding contract balance and attaches only to this property, the lienholder allows the executory contract and will deal directly with the purchaser on default, and the contract itself contains specific seller-payment/notice/cure covenants (including a 150%-of-cure-payment credit against the purchaser's balance) | Statute text, § 5.085(b)(3)(A)-(D), quoted in part — flagged in guide as a compound, multi-condition carve-out, not a simple exception |
| § 5.085(c) — violation is a DTPA violation, entitling cancellation/rescission plus refund of payments and reimbursement of taxes paid and improvement value | Statute text, § 5.085(c) |
| § 5.085(d) — seller isn't liable if a third party (not the seller) placed the lien and the seller removes it within 30 days of notice | Statute text, § 5.085(d) |
| § 5.087 — a county that adopted a §5.0622 order can't otherwise modify this subchapter, except it may require the §5.081 conversion to happen within 3 years for residential-purpose contracts | Statute text, § 5.087(a)-(b) |
| No Section 5.086 exists in the current statute — the numbering jumps from § 5.085 directly to § 5.087 | Confirmed by grepping every `<a name="5.0` anchor in the fetched chapter file; no 5.086 anchor present |
| Second-degree consanguinity relatives (parent/child = 1st degree; sibling, grandparent, grandchild = 2nd degree) | Gov't Code § 573.023(a)-(c), fetched as above |
| Second-degree affinity (spouse = 1st degree; affinity degree matches the underlying consanguinity degree of the connecting relative, e.g. sibling's spouse or spouse's sibling = 2nd degree) | Gov't Code §§ 573.024-573.025 |
| Degree of relationship computed by "the civil law method" | Gov't Code § 573.021, quoted verbatim |
| Amendment history for each section confirmed by capturing the "Added by.../Amended by:..." block at the end of every section through § 5.087; most recent amendments found: § 5.062 (2015), § 5.0622 (2023), § 5.064 (2015), § 5.066 (2015), § 5.070 (2015), § 5.073 (2005), § 5.076 (2015), § 5.077 (2015), § 5.079 (2015) — no amendment dated later than Sept. 1, 2023, and no 89th-Legislature (2025) amendment found anywhere in Subchapter D | Statute text, each section's trailing amendment block |
| Cross-reference to TREC 26-8 / seller-financing-addendum content | Existing repo guide `texas-seller-financing-addendum-guide.json`, read for consistency and to avoid duplication, not re-verified (its own citation trail already covers TREC form text) |

**Interpretive note added in the guide itself, not left implicit — the "automatic
conversion" question:** the task brief that spawned this guide assumed a general
"automatic-conversion-to-warranty-deed provision after enough payments." The statute does
not contain that. What it actually contains is three separate, easy-to-conflate
mechanisms, and the guide keeps them as three distinct sections rather than blending them:

1. **§ 5.066 "equity protection"** — once the purchaser has paid 40%+ of the amount due,
   OR the equivalent of 48 monthly payments, OR the contract has simply been recorded
   (any one of the three, not all three), the seller loses the forfeiture/rescission
   remedy and must instead go through a trustee power-of-sale process similar to a
   mortgage foreclosure. This protects the purchaser's *equity on default* — it does not
   transfer title to the purchaser at all; it only changes how the seller can take the
   property back.
2. **§ 5.081 "right to convert"** — the purchaser can convert to recorded legal title **at
   any time**, not gated by any payment percentage or payment count, by either paying off
   the full remaining balance or delivering a qualifying promissory note plus executing a
   deed of trust. This is purchaser-initiated, not automatic.
3. **§ 5.079(a)** — once the purchaser makes the **final** payment under the contract
   (100%, not a threshold), the seller has an affirmative 30-day duty to transfer legal
   title if the contract hasn't already been recorded or converted under § 5.081.

None of these is "convert to a warranty deed automatically once X% has been paid." The
guide states this directly rather than implying a payment-percentage trigger exists,
because asserting one would misstate the statute.

**Flagged as ambiguous/fact-specific, intentionally left undecided in the guide:**
- **§ 5.062(a)'s "second degree by consanguinity or affinity" test** determines several
  things (whether the one-acre presumption/lease-option rule matters, whether the §5.062(d)
  waiver is available, whether the §5.062(e)/(f) reduced-statute lists apply). The guide
  gives the plain-language relatives this reaches (spouse, parents, children, siblings,
  grandparents, grandchildren, and their spouses/in-laws) sourced directly from Gov't Code
  § 573.023/.025, but does not attempt to resolve harder edge cases (half-siblings, step-
  relations, remarriage after a spouse's death per § 573.024(b)) — those are fact-specific
  civil-law computations a TC should not self-certify.
- **§ 5.062(f)'s "have not been parties to an executory contract...for longer than three
  years" test** requires counting the parties' (or their assignees'/agents'/affiliates')
  prior executory-contract history on the same property. The guide describes the rule but
  doesn't supply a counting method beyond what the statute itself states, since the
  statute doesn't define how far back that history search must go.
- **§ 5.0622's county-option statute** only applies if a qualifying county's commissioners
  court has actually adopted an order under that section — the guide describes the
  mechanism and the population/MSA-adjacency test but does not assert which, if any,
  specific Texas county currently has such an order in effect, since that's a standing
  fact question outside the statute text itself (the statute doesn't name counties; it
  states a population/MSA formula).
- **§ 5.085(b)(3)'s seller-placed-lien carve-out** is a compound, multi-part exception
  (advance written disclosure + lien-amount cap + lienholder cooperation + specific
  contract covenants, all required together). The guide describes each part but flags
  that confirming a specific deal satisfies *all* of them is a documentation-review task,
  not something to assume from the carve-out's existence.
- **§ 5.075's pre-2001 pledge right** is narrow and dated (contracts entered before Sept.
  1, 2001 only) — flagged in the guide as legacy-relevant only, not a current-contract
  planning point.

**Not flagged as ambiguous — confirmed clean:** the four numbered conditions in § 5.064
for when a seller may use rescission/forfeiture are conjunctive ("only if" followed by
four numbered clauses joined by "and" at 5.064(3)-(4)) — all four must be met, not any
one; the guide states this as "all four," verified against the statute's own "and" at the
end of clause (3).

---

## Method note (continuity with batch 5)

Same `tcss.legis.texas.gov` API approach worked without modification for both Property
Code Chapter 5 (already-fetched full-chapter file, subchapter isolated by section-anchor
grep) and Government Code Chapter 573 (fetched fresh via the same API pattern, swapping
the code prefix from `PR` to `GV`). Confirms the method generalizes across Texas codes,
not just Property Code — useful for any future guide that needs to resolve a
statute's own cross-reference into a different code.

---

## Hadley legal-review corrections (2026-08-08)

Two accuracy fixes made to the shipped guide after Hadley flagged them on review.
Re-fetched `https://tcss.legis.texas.gov/resources/PR/htm/PR.5.htm` fresh for this pass
to re-verify both against the live statute text rather than relying on the batch-10 table
above.

**Fix 1 — § 5.062(e) is an unconditional exclusion, not part of the (e)-(g) term-length
test.** The original guide draft bundled § 5.062(e) into the same "§ 5.062(e)-(g)" bullet
as the ≤3-year lease-purchase narrowing in (f)-(g), which reads as if (e) is also
conditioned on a three-year-or-less term. It isn't. The statute text of § 5.062(e) reads:
"Sections 5.066, 5.067, 5.071, 5.075, 5.079, 5.081, and 5.082 do not apply to an
executory contract described by Subsection (a)(2)" — no term-length condition anywhere in
that subsection. The term-length test lives entirely in (f): "only the following sections
apply to an executory contract described by Subsection (a)(2) if the term of the contract
is three years or less and the purchaser and seller...have not been parties to an
executory contract to purchase the property...for longer than three years." (e) and (f)
are sequential, independent rules — (e) strips six sections from every § 5.062(a)(2)
lease-option unconditionally, and (f)-(g) then narrows the remaining applicable sections
further, but only for the short-term/no-prior-history subset. Guide now states these as
two separate bullets instead of one bundled bullet, plus a callout on the § 5.066/§ 5.081
consequence for rent-to-own files specifically.

Note on scope: the task brief that flagged this (relayed from Hadley) listed six excluded
sections — §§ 5.066, 5.067, 5.071, 5.075, 5.079, 5.081 — omitting § 5.082. Re-checked the
statute text directly (quoted above): § 5.062(e) excludes **seven** sections, including §
5.082 (the purchaser's right to request a payoff balance). Guide corrected to list all
seven, not six, since that's what the statute actually says.

| Claim | Source |
|---|---|
| § 5.062(e) unconditionally excludes §§ 5.066, 5.067, 5.071, 5.075, 5.079, 5.081, and 5.082 for any § 5.062(a)(2) lease-option, regardless of term length — no duration or prior-history condition appears in subsection (e) itself | Statute text, § 5.062(e), quoted verbatim above; re-fetched and re-read in full for this correction |
| § 5.062(f)'s three-year/no-longer-prior-history test is a separate, additional condition that applies only to (f)'s own narrower list (§§ 5.063–5.065, § 5.073 except (a)(2), §§ 5.083 and 5.085) — it does not gate § 5.062(e) | Statute text, § 5.062(f), quoted verbatim above |

**Fix 2 — the "no § 5.086" note needed the relocation, not just the gap.** The batch-10
table above already noted "No Section 5.086 exists...the numbering jumps from § 5.085
directly to § 5.087," which is true but incomplete — it doesn't explain where § 5.086
went or that it's still live law. Re-fetched Subchapter A of the same chapter file and
found § 5.0205, "EQUITABLE INTEREST DISCLOSURE," with trailing history text reading:
"Added by Acts 2017, 85th Leg., R.S., Ch. 974 (S.B. 2212), Sec. 4, eff. September 1,
2017. Transferred, redesignated and amended from Property Code, Section 5.086 by Acts
2023, 88th Leg., R.S., Ch. 94 (S.B. 1577), Sec. 27, eff. January 1, 2024." The
relocated section requires written disclosure, before a contract, to (1) any potential
buyer that the discloser is only selling an option or assigning an interest and doesn't
hold legal title, and (2) the property's actual owner that the discloser intends to sell
that option or assign that interest — directly relevant to a TC handling an assignment or
flip of a contract-for-deed interest. Guide now names § 5.0205 and the relocation instead
of only noting the gap.

| Claim | Source |
|---|---|
| § 5.086 ("Equitable Interest Disclosure," added 2017) was transferred, redesignated, and amended to § 5.0205 (Subchapter A) by the 88th Legislature, Acts 2023, Ch. 94 (S.B. 1577), Sec. 27, effective January 1, 2024 | Statute text, § 5.0205 trailing history block, quoted verbatim above |
| § 5.0205 requires written disclosure before a contract to (1) a potential buyer that the person is selling only an option or assigning an interest and lacks legal title, and (2) the property owner that the person intends to sell that option or assign that interest | Statute text, § 5.0205(1)-(2), quoted in full above |
| § 5.086's original 2017 enactment (S.B. 2212, 85th Leg.) predates its 2024 relocation | Statute text, § 5.0205 trailing history block |
