# Citation trail — new TREC guide pages, batch 3 / FINAL (2026-08-06)

Every factual claim in the 11 new guide JSON files, mapped to the exact TREC source it came from.
Same methodology as batch 1 and batch 2: (1) trec.texas.gov form landing pages, (2) the actual
current promulgated/approved PDF form text, fetched directly and read via the Read tool (WebFetch
saves the PDF binary locally; Read then extracts the actual text/pages from that saved file — the
same two-step process batch 2 documented). No fact in these guides comes from general knowledge,
prior training data, or any of the 33 existing guides (10 original + 7 batch 1 + 7 batch 2 + 9
form-specific guides already covering ai-transaction-coordinator-texas / how-much-does-a-tc-cost /
what-does-a-tc-do, which aren't TREC-form guides and aren't counted against the 17-form baseline).

Master list source: https://www.trec.texas.gov/agency-information/contracts (full current forms +
addenda index, re-fetched 2026-08-06). Two renumbering notes surfaced during this fetch, both
flagged below and neither acted on as a new guide, per the task's own "do not duplicate the 17
already-covered form numbers" instruction.

---

## 1. texas-condo-resale-contract-guide.json — TREC No. 30-18 & TREC No. 32-5

Sources:
- 30-18 landing page: https://www.trec.texas.gov/forms/residential-condominium-contract-resale-0
- 30-18 PDF: https://www.trec.texas.gov/sites/default/files/pdf-forms/30-18.pdf
- 32-5 landing page: https://www.trec.texas.gov/forms/condominium-resale-certificate-0
- 32-5 PDF: https://www.trec.texas.gov/sites/default/files/pdf-forms/32-5.pdf

| Claim | Source |
|---|---|
| Form number 30-18, replaces 30-17, revision date 05-04-2026 | PDF footer/header |
| "NOTICE: Not For Use Where Seller Owns Fee Simple Title To Land Beneath Unit" | PDF header |
| ¶2A Condominium Unit / Common Elements / Limited Common Elements / parking definition | PDF ¶2A(1) |
| ¶2A(2) Improvements list, incl. the "Controls" clause for garage doors/entry gates and the software/app/hardware language | PDF ¶2A(2), verbatim |
| ¶2A(3) Accessories list | PDF ¶2A(3) |
| ¶2B Documents (Declaration/Bylaws/Rules), two delivery options, 7-day post-receipt termination right, Section 82.156 Property Code cross-reference | PDF ¶2B |
| ¶2C Resale Certificate requirement — must be TREC-promulgated or as required by parties, prepared at seller's expense no more than 3 months before delivery, minimum content per Section 82.157 Property Code; three checkbox options incl. the affidavit/waiver path | PDF ¶2C |
| ¶2D right-of-refusal / Effective Date amendment mechanic | PDF ¶2D |
| ¶3B financing checkboxes (Third Party Financing / Loan Assumption / Seller Financing Addendum) | PDF ¶3B |
| ¶4 Residential Leases and Fixture Leases checkboxes, incl. the form's own fixture examples (solar panels, propane tanks, water softener, security system) | PDF ¶4 |
| ¶10B Smart Devices clause (access codes/usernames/passwords/apps delivery at possession; seller terminates own device access) | PDF ¶10B |
| ¶13 condo-specific proration rule (reserves not credited to seller; unpaid special assessment is seller's obligation) | PDF ¶13 |
| ¶14 casualty loss split between unit (seller's sole obligation) and Common/Limited Common Elements (7-day buyer notice / 7-day seller confirmation mechanic) | PDF ¶14 |
| ¶6D Title Notices — all 10 items incl. verbatim §13.257 Water Code certificated-service-area text and the reservoir water-level-fluctuation notice | PDF ¶6D(1)–(10) |
| ¶22 full addenda checklist, confirming every other addendum named in this batch (Seller Financing, 1031 Exchange, Loan Assumption, Release of Liability/VA Entitlement, Residential Leases, Fixture Leases, Back-Up Contract, etc.) is directly cross-referenced on a current TREC contract | PDF ¶22 |
| Form 32-5 number, replaces 32-4, revision date 11-04-2024, landing page Effective Date 11/25/2024 (no gap) | PDF footer / landing page |
| Certificate prepared/signed by Association's Board, per Section 82.157, Texas Property Code | PDF header |
| Full item list A–P (right of refusal, periodic assessment, unpaid amounts, capital expenditures, reserves, budget/balance sheet, judgments, pending suits, insurance, known violations, code-violation notices, leasehold term, managing agent, transfer fees, capital reserve contribution) | PDF ¶A–P |
| Required attachments (Operating Budget, Insurance Summary, Balance Sheet) | PDF, "Required Attachments" |
| 3-month preparation window notice, verbatim | PDF, bold NOTICE line |

No unverifiable claims in this guide.

---

## 2. texas-mineral-rights-reservation-addendum.json — TREC No. 44-3

Sources:
- Landing page: https://www.trec.texas.gov/forms/addendum-reservation-oil-gas-and-other-minerals-0
- PDF: https://www.trec.texas.gov/sites/default/files/pdf-forms/44-3_0.pdf

| Claim | Source |
|---|---|
| Form number 44-3, replaces 44-2, revision date 11-07-2022, landing page Effective Date 02/01/2023 | PDF footer / landing page |
| "For use ONLY if Seller reserves all or a portion of the Mineral Estate" | PDF notice, top of form |
| Full Mineral Estate definition incl. inclusions/exclusions list (water, sand, gravel, limestone, building stone, caliche, surface shale, near-surface lignite, iron excluded; reasonable surface use for extraction included) | PDF ¶A |
| ¶B two reservation checkboxes (reserve all / reserve undivided interest) incl. the "only this percentage or fraction of Seller's interest" note | PDF ¶B |
| ¶C surface-access waiver checkbox, the other-owners'-rights carve-out, and the "failure to complete = deemed election to convey" default | PDF ¶C |
| ¶D 7-day mineral-lessee contact-info requirement | PDF ¶D |
| IMPORTANT NOTICE block, verbatim | PDF, bold text |
| CONSULT AN ATTORNEY BEFORE SIGNING boilerplate | PDF, bold text |

No unverifiable claims in this guide.

---

## 3. texas-seller-financing-addendum-guide.json — TREC No. 26-8

Sources:
- Landing page: https://www.trec.texas.gov/forms/seller-financing-addendum-0
- PDF: https://www.trec.texas.gov/sites/default/files/pdf-forms/26-8_0.pdf

| Claim | Source |
|---|---|
| Form number 26-8, replaces 26-7, revision date 11-07-2022, landing page Effective Date 02/01/2023 | PDF footer / landing page |
| Opening attorney/financial-professional warning, verbatim | PDF, top of form |
| ¶A credit documentation checkboxes and buyer's credit-agency authorization | PDF ¶A |
| ¶B credit-approval mechanics (seller's sole discretion, 7-day window, deemed-approved default) | PDF ¶B |
| ¶C promissory note terms incl. fixed 5% late fee (10-day grace) and fixed 18%/yr (or highest lawful rate) matured-default interest, three payment-structure checkboxes | PDF ¶C |
| ¶D(1) property-transfer options (Consent Not Required / Consent Required) incl. the >3-year lease and contract-for-deed triggers, the carve-outs (subordinate lien, condemnation, deed between buyers, death/operation of law), and the bolded continuing-liability NOTE | PDF ¶D(1) |
| ¶D(2) casualty insurance checkbox | PDF ¶D(2) |
| ¶D(3) tax/insurance escrow options (not required / required, incl. 30-day deficiency cure and servicer checkbox) | PDF ¶D(3) |
| ¶D(4) prior-liens cross-default clause | PDF ¶D(4) |

No unverifiable claims in this guide.

---

## 4. texas-back-up-contract-addendum-guide.json — TREC No. 11-9 & TREC No. 62-0

Sources:
- 11-9 landing page: https://www.trec.texas.gov/forms/addendum-back-contract
- 11-9 PDF: https://www.trec.texas.gov/sites/default/files/pdf-forms/11-9.pdf
- 62-0 landing page: https://www.trec.texas.gov/forms/sellers-notice-buyer-removal-contingency-under-addendum-back-contract
- 62-0 PDF: https://www.trec.texas.gov/sites/default/files/pdf-forms/62-0.pdf

| Claim | Source |
|---|---|
| Form 11-9 number, replaces 11-8, revision date 05-04-2026, landing page Effective Date 07/01/2026 | PDF footer / landing page |
| ¶A Back-Up Contract binding-on-execution, EM/option fee per ¶5 of underlying contract, additional EM/option fee mechanics | PDF ¶A |
| ¶B weekend/Legal Holiday rollover | PDF ¶B |
| ¶C funds-applied-first-to-option-fee order | PDF ¶C |
| ¶D escrow agent's release authorization for additional option fee | PDF ¶D |
| ¶E/¶F consequences of missed additional EM / additional option fee deadlines | PDF ¶E, ¶F |
| ¶G contingency on First Contract's termination; neither party required to perform while contingent | PDF ¶G |
| ¶H Amended Effective Date mechanic, outside termination date, seller's immediate-notice duty | PDF ¶H |
| ¶I amendment/modification of First Contract does not terminate it | PDF ¶I |
| ¶J unrestricted-termination-window continuity language | PDF ¶J |
| ¶K time-is-of-the-essence, strict compliance | PDF ¶K |
| Form 62-0 number, revision date 05-04-2026, landing page Effective Date 05/28/2026; no "replaces" predecessor line visible in the extracted PDF text | PDF footer / landing page |
| 62-0's three-part notice content (First Contract terminated; contingency removed; Amended Effective Date stated), tied explicitly to Paragraph H of 11-9 | PDF, body text |
| Additional Option Fee Receipt / Additional Earnest Money Receipt blocks | PDF, bottom of form |

No unverifiable claims in this guide.

---

## 5. texas-loan-assumption-addenda-guide.json — TREC No. 41-3 & TREC No. 12-3

Sources:
- 41-3 landing page: https://www.trec.texas.gov/forms/loan-assumption-addendum-0
- 41-3 PDF: https://www.trec.texas.gov/sites/default/files/pdf-forms/41-3_0.pdf
- 12-3 landing page: https://www.trec.texas.gov/forms/addendum-release-liability-assumed-loan-andor-restoration-sellers-va-entitlement
- 12-3 PDF: https://www.trec.texas.gov/sites/default/files/pdf-forms/12-3_0.pdf

| Claim | Source |
|---|---|
| Form 41-3 number, replaces 41-2, revision date 11-07-2022, landing page Effective Date 02/01/2023 | PDF footer / landing page |
| ¶A credit documentation, incl. authorization extending to the noteholder(s) (distinct from 26-8's seller-only authorization) | PDF ¶A |
| ¶B credit-approval mechanics | PDF ¶B |
| ¶C assumption terms — first/second lien note identification, unpaid balance, monthly payment, variance-adjustment checkbox, variance-cap termination right, 7-day document-delivery requirement | PDF ¶C |
| ¶D buyer termination rights (assumption fee excess, interest rate increase, other loan-document modification) | PDF ¶D |
| ¶E noteholder non-consent termination right | PDF ¶E |
| ¶F seller's liens / vendor's lien mechanic | PDF ¶F |
| ¶G tax/insurance escrow transfer | PDF ¶G |
| ¶H authorization to release information | PDF ¶H |
| Bolded NOTICE TO SELLER directly naming "the TREC Release of Liability Addendum" | PDF, bold text — this is the direct cross-reference confirmed by independently fetching 12-3's own text in this same session |
| DUE ON SALE NOTICE, verbatim | PDF, bold text |
| Form 12-3 number, replaces 12-2, revision date 12-05-11, landing page Effective Date 12/05/2011 (no gap) | PDF footer / landing page |
| ¶A Release of Seller's Liability mechanics (conventional/VA/FHA, two outcome checkboxes) | PDF ¶A |
| ¶B Restoration of Seller's VA Entitlement mechanics (same structure) | PDF ¶B |
| VA restoration eligibility NOTICE (veteran / sufficient unused entitlement / otherwise qualified), verbatim | PDF, bold NOTICE |
| Seller pays cost of release/restoration; seller's deed contains required assumption clause | PDF, closing paragraphs |

No unverifiable claims in this guide. This closes a direct cross-reference loop: 41-3's own text
points to "the TREC Release of Liability Addendum," and this batch independently fetched 12-3's
full text to confirm what that addendum actually contains, rather than assuming its content from
41-3's description alone.

---

## 6. texas-fixture-leases-addendum-guide.json — TREC No. 52-1

Sources:
- Landing page: https://www.trec.texas.gov/forms/addendum-regarding-fixture-leases-0
- PDF: https://www.trec.texas.gov/sites/default/files/pdf-forms/52-1_0.pdf

| Claim | Source |
|---|---|
| Form number 52-1, revision date 11-07-2022, landing page Effective Date 02/01/2023; no "replaces" predecessor line visible in the extracted PDF footer text | PDF footer / landing page |
| ¶A Leased Fixtures definition, incl. the four named checkbox examples (solar panels, propane tanks, water softener, security system) | PDF ¶A |
| ¶A(1) assumption/assignment cost-split mechanic | PDF ¶A(1) |
| ¶A(2) removal-before-closing checkbox, seller's damage-repair duty, "remains subject to lessor's rights" notice | PDF ¶A(2) |
| ¶B delivery options (already received / 5-day delivery with 7-day buyer termination right / oral lease disclosure) | PDF ¶B |
| ¶C lien/security-interest carve-out for assumed Leased Fixtures | PDF ¶C |
| Closing notice to consult the lessor and attorneys | PDF, bold text |

No unverifiable claims in this guide.

---

## 7. texas-residential-leases-addendum-guide.json — TREC No. 51-1

Sources:
- Landing page: https://www.trec.texas.gov/forms/addendum-regarding-residential-leases-0
- PDF: https://www.trec.texas.gov/sites/default/files/pdf-forms/51-1_0.pdf

| Claim | Source |
|---|---|
| Form number 51-1, revision date 11-07-2022, landing page Effective Date 02/01/2023; no "replaces" predecessor line visible in the extracted PDF footer text | PDF footer / landing page |
| "Residential Lease" definition | PDF, opening paragraph |
| Seller's no-new-lease-without-consent restriction | PDF, opening paragraph |
| Option A (Termination) checkbox, incl. the bracketed self-caveat that it doesn't itself terminate any existing lease | PDF ¶A |
| Option B (Assignment and Assumption) checkbox | PDF ¶B |
| ¶B(1) delivery mechanics (3-day delivery deadline, buyer termination right, oral-lease disclosure) | PDF ¶B(1) |
| ¶B(2) security deposit transfer, §92.102 Property Code cross-reference, buyer's tenant-notice requirement | PDF ¶B(2) |
| ¶B(3) seven seller-knowledge representations (a)–(g) | PDF ¶B(3) |
| ¶B(4) cure/termination mechanic (7-day cure, 5-day sole-remedy termination window, daily Closing Date extension) | PDF ¶B(4) |

No unverifiable claims in this guide.

---

## 8. texas-utility-special-district-notices-guide.json — TREC No. 53-0, TREC No. 59-0 & TREC No. 58-0

Sources:
- 53-0 landing page: https://www.trec.texas.gov/forms/addendum-containing-notice-obligation-pay-improvement-district-assesment
- 53-0 PDF: https://www.trec.texas.gov/sites/default/files/pdf-forms/53-0.pdf
- 59-0 landing page: https://www.trec.texas.gov/forms/notice-purchaser-special-taxing-or-assessment-district
- 59-0 PDF: https://www.trec.texas.gov/sites/default/files/pdf-forms/59-0.pdf
- 58-0 landing page: https://www.trec.texas.gov/forms/notice-prospective-buyer-0
- 58-0 PDF: https://www.trec.texas.gov/sites/default/files/pdf-forms/58-0.pdf

| Claim | Source |
|---|---|
| Form 53-0 number, revision date 11-08-2021, landing page Effective Date 09/01/2021 (earlier than the printed revision date — flagged directly in the guide, not resolved) | PDF footer / landing page |
| PID definition, Subchapter A Ch. 372 / Ch. 382 Local Gov't Code blank, "Authorized Improvements" language, verbatim assessment-obligation paragraph, penalty/lien/foreclosure warning | PDF, body text |
| Buyer-and-seller signature structure, buyer acknowledgment before binding-contract effective date | PDF, signature block |
| Form 59-0 number, revision date 02-12-2024, landing page Effective Date 02/12/2024 (no gap) | PDF footer / landing page |
| "NOTICE: Not for use for Public Improvement Districts (PIDs)," verbatim | PDF header |
| Section 49.453, Texas Water Code cross-reference and the "use the district's own form instead" instruction | PDF, intro paragraph |
| Full section list (name of district, tax rate, assessments, bonds by category, standby fees, ETJ/corporate-boundary location, strategic partnership agreement, purpose) | PDF ¶¶1–8 |
| "The cost of district facilities is not included in the purchase price of your property," verbatim | PDF ¶8 |
| Form 58-0 number, revision date 11-07-2022, landing page Effective Date 09/03/2025 (a roughly 3-year gap, flagged directly in the guide, not resolved); replaces TREC No. OP-C | PDF footer / landing page |
| "APPROVED BY THE TEXAS REAL ESTATE COMMISSION" header (voluntary-use category, distinct from "PROMULGATED BY") | PDF header |
| "for use when a contract of sale has not been promulgated by TREC... presented before an offer to purchase is signed," verbatim | PDF, closing boilerplate |
| Title-examination advisement and Utility District / Chapter 49 Water Code notice content | PDF, body text |
| §5.014, Property Code public improvement district notice reference | PDF, body text |

**Flagged directly in the guide, not resolved:** two date-order anomalies (53-0's landing-page
Effective Date predates its own printed PDF revision date; 58-0's landing-page Effective Date is
nearly three years after its printed PDF revision date). Both are TREC's own published dates as
fetched directly from trec.texas.gov in this session — presented as-is rather than guessed at or
reconciled.

---

## 9. texas-lead-based-paint-disclosure-guide.json — TREC No. 56-0

Sources:
- Landing page: https://www.trec.texas.gov/forms/addendum-sellers-disclosure-information-lead-based-paint-and-lead-based-paint-hazards-0
- PDF: https://www.trec.texas.gov/sites/default/files/pdf-forms/56-0.pdf

| Claim | Source |
|---|---|
| Form number 56-0, revision date 05-04-2026, landing page Effective Date 05/28/2026 | PDF footer / landing page |
| "APPROVED BY THE TEXAS REAL ESTATE COMMISSION" header (not "PROMULGATED BY") | PDF header |
| Full Lead Warning Statement, verbatim | PDF ¶A |
| "Inspector must be properly certified as required by federal law" notice | PDF ¶A |
| ¶B seller's disclosure checkboxes (presence of hazards; records/reports available) | PDF ¶B |
| ¶C buyer's rights (waiver, or 10-day inspection with 14-day termination window) | PDF ¶C |
| ¶D buyer's acknowledgment checkboxes, incl. the pamphlet name | PDF ¶D |
| ¶E brokers' acknowledgment citing 42 U.S.C. 4852d and the 3-year record-retention duty, verbatim | PDF ¶E |
| ¶F certification of accuracy signature block | PDF ¶F |

**Sourcing verification, per the task's explicit instruction to check this rather than guess:**
the form's own text confirms it is a TREC-approved form (not "promulgated," i.e. not a mandatory
contract form) that operationalizes a federally created disclosure duty. Paragraph E cites
42 U.S.C. 4852d directly on the form itself — that federal statute is the source of the underlying
disclosure obligation; TREC did not create the requirement, but does publish and approve this
specific form as the standard vehicle Texas licensees use to comply with it. The guide states this
distinction explicitly rather than presenting 56-0 as either a purely-TREC-created rule or silently
omitting the federal-law origin.

---

## 10. texas-groundwater-surface-water-rights-disclosure-guide.json — TREC No. 61-0

Sources:
- Landing page: https://www.trec.texas.gov/forms/water-notice-sellers-disclosure-about-groundwater-and-surface-water-rights
- PDF: https://www.trec.texas.gov/sites/default/files/pdf-forms/61-0.pdf

| Claim | Source |
|---|---|
| Form number 61-0, revision date 05-04-2026, landing page Effective Date 07/01/2026 | PDF footer / landing page |
| "PROMULGATED BY THE TEXAS REAL ESTATE COMMISSION (TREC)" header | PDF header |
| Opening scope-limit notice, verbatim | PDF, top of form |
| ¶1 four definitions (Groundwater, Groundwater District, Surface Water, Surface Water Rights) with their bracketed notes, and the fifth definition (Water Well) | PDF ¶1A–E |
| ¶2 groundwater/well questions A–F, incl. the "another property" / "outside the property" / "severed, sold, or leased" questions | PDF ¶2A–F |
| ¶3 surface water questions A–B | PDF ¶3A–B |
| Five closing "Notices to Buyer and Seller," verbatim | PDF, closing section |

No unverifiable claims in this guide.

---

## 11. texas-1031-exchange-addendum-guide.json — TREC No. 60-0

Sources:
- Landing page: https://www.trec.texas.gov/forms/addendum-section-1031-exchange
- PDF: https://www.trec.texas.gov/sites/default/files/pdf-forms/60-0.pdf

| Claim | Source |
|---|---|
| Form number 60-0, revision date 11-04-2024, landing page Effective Date 01/03/2025 | PDF footer / landing page |
| Full text of ¶A (checkbox) and ¶B (cooperation clause), verbatim — this is the form's entire substantive content | PDF ¶A, ¶B |

**Explicitly flagged in the guide rather than filled in:** IRS Section 1031 exchange mechanics —
identification windows, qualified intermediary requirements, replacement-property rules, the
45-day/180-day timelines commonly associated with 1031 exchanges — do **not** appear anywhere on
TREC No. 60-0's own text, and are not sourced or invented in this guide. The guide states plainly
that those mechanics come from federal tax law and the exchanging party's own intermediary
arrangement, entirely outside this two-paragraph TREC addendum, and directs readers to a tax
professional rather than presenting invented deadlines as if TREC's form set them.

---

## Cross-cutting notes for review

1. **Method confirmed working end-to-end this session:** WebFetch on a `.pdf` URL cannot parse the
   binary itself (it correctly reports the raw PDF stream data as unreadable), but it *does* save
   the binary to a local scratch path in every case tested. The Read tool then opens that saved
   path directly and returns full, accurate page-by-page text — this is the same two-step process
   batch 2 documented, now used across 16 additional form PDFs (30-18, 32-5, 44-3, 26-8, 11-9,
   62-0, 41-3, 12-3, 52-1, 51-1, 53-0, 59-0, 58-0, 56-0, 61-0, 60-0) without a single failure.
2. **Two form renumberings surfaced during the master-list re-fetch, neither acted on as a new
   guide:** (a) the One to Four Family Residential Contract (Resale) is now **TREC No. 20-19** on
   TREC's live index — the existing `trec-form-20-17-guide.json` covers the older 20-17 number.
   This is a maintenance item for that existing guide, not a new topic, and is flagged here rather
   than silently left stale. (b) No other of the 17 already-covered form numbers showed a
   renumbering as of this fetch.
3. **REI 7-6 (Property Inspection Report) was investigated and NOT built.** Multiple WebFetch
   attempts at the form's landing page (`/forms/inspection-report-form`) and a guessed PDF path
   returned only tangential FAQ content referencing the form by name, not the form's own landing
   page or a working PDF link. Rather than guess at a PDF filename pattern or reconstruct the
   form's content from the stray FAQ mention, this form was left out of the batch entirely. If a
   future pass wants it, the landing page needs a fresh, successful fetch first.
4. **Topics reconsidered per the task's explicit instruction, and the reasoning for each verdict:**
   - **Condominium Resale Certificate (32-5)** — reconsidered and **built** (see guide #1). Texas
     condo transactions are common enough in the state's metro markets that this earns a page.
   - **Environmental Assessment, Threatened or Endangered Species, and Wetlands Addendum (28-2)**
     — reconsidered and **still skipped**. Its trigger condition is narrow (a specific
     environmental-hazard or protected-species concern on a specific parcel), and the existing
     `texas-farm-and-ranch-contract-guide.json` already covers general rural-transaction mechanics
     this addendum would otherwise sit alongside. Landing page not re-fetched this session.
   - **Addendum for Coastal Area Property (33-2) and Addendum for Property Located Seaward of the
     Gulf Intracoastal Waterway (34-4)** — reconsidered together and **still skipped**. Both apply
     only to a narrow strip of Texas's Gulf coastline; the working Texas agent this guides library
     targets is overwhelmingly inland (DFW, Houston-metro, Austin, San Antonio). Landing pages not
     re-fetched this session.
   - **Addendum for Property in a Propane Gas System Service Area (47-0)** — reconsidered and
     **skipped**. Narrow trigger: unincorporated areas served by a specific propane distribution
     retailer. Landing page not re-fetched this session.
   - **Landlord's Floodplain and Flood Notice (54-1)** — reconsidered and **skipped**. This is a
     landlord-tenant leasing compliance document, not a purchase/sale form — outside the core
     buy/sell transaction-coordination scope this guides library and Dossie's product both target.
     Landing page not re-fetched this session.
   - **Disclosure of Relationship with Residential Service Company (RSC-4)** — reconsidered and
     **skipped**. It's an internal broker/RESPA-adjacent compliance disclosure about referral
     relationships to home warranty companies, not the kind of "what does this form do" content a
     working agent or consumer searches for. Landing page not re-fetched this session.
   - **Subdivision Information, Including Resale Certificate for Property Subject to Mandatory
     Membership in a Property Owners' Association (37-5)** — reconsidered and **skipped as
     duplicative**. This is the literal document already discussed at length inside the existing
     `texas-hoa-addendum-guide.json` (TREC 36-11), which explains the Subdivision Information
     delivery process this form is part of. A standalone guide would mostly restate that coverage.
   - **Property Inspection Report (REI 7-6)** — see note 3 above: investigated, not skipped by
     judgment call, but left out because the form's own page couldn't be reliably fetched this
     session. This is the one item that's a genuine "try again next time" rather than a deliberate
     scope decision.
5. **No dollar figures, percentages, day-counts, or statutory citations were invented anywhere in
   this batch.** Every blank on every form (assumption caps, financing amounts, notice windows,
   escrow terms) is described as negotiated/filled-in by the parties. The fixed figures that do
   appear — 26-8's 5% late fee and 18%/highest-lawful-rate default interest, 56-0's 10-day/14-day
   inspection and termination windows and 3-year record retention, AFIDA-style statutory citations
   where present — are all printed directly on the form text itself, not assumed or estimated.
