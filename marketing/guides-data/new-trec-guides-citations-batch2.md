# Citation trail — new TREC guide pages, batch 2 (2026-08-06)

Every factual claim in the 7 new guide JSON files, mapped to the exact TREC source it came from.
Same methodology as batch 1 (`new-trec-guides-citations.md`): (1) trec.texas.gov form landing
pages, (2) the actual current promulgated PDF form text, fetched directly and read via the Read
tool (WebFetch can't parse PDF binaries — it saves the binary, then Read extracts the text/pages).
No fact in these guides comes from general knowledge, prior training data, or the existing 17
guides (10 original + 7 from batch 1).

Master list source: https://www.trec.texas.gov/agency-information/contracts (full current forms +
addenda index, re-fetched 2026-08-06 — confirms all form numbers below are current as of that
date; TREC renumbers forms without warning, so don't reuse these numbers in a future pass without
re-checking).

---

## 1. trec-49-1-appraisal-addendum-guide.json — TREC No. 49-1

Sources:
- Landing page: https://www.trec.texas.gov/forms/addendum-concerning-right-terminate-due-lenders-appraisal-0
- PDF: https://www.trec.texas.gov/sites/default/files/pdf-forms/49-1.pdf

| Claim | Source |
|---|---|
| Form number 49-1 | PDF footer |
| Revision date printed on form: 11-15-18; landing page lists Effective Date 03/01/2019 | PDF header / landing page |
| Applies only if Third Party Financing Addendum is attached AND transaction does not involve FHA/VA financing | PDF header + intro sentence |
| Three checkbox options — (1) Waiver, (2) Partial Waiver, (3) Additional Right to Terminate — and the exact mechanics of each (cash-portion-increase language, opinion-of-value threshold, appraised-value threshold, day-count, appraisal-copy-to-seller requirement, earnest money refund) | PDF body, verbatim |
| Cross-reference to 38-8's Paragraph (3) ground, including the appraisal-copy-to-seller requirement | Confirmed against 38-8's own PDF text, already sourced in batch 1's citation file (item 6) — this batch independently fetched 49-1's own text to close the gap batch 1 explicitly flagged as unverified |

No unverifiable claims in this guide. **This closes the exact gap batch 1 flagged**: batch 1's
38-8 guide cited only what 38-8 itself said about 49-1 ("Paragraph (3)... copy of the Appraisal")
without independently fetching 49-1's own text. This batch fetched 49-1's PDF directly and
confirms the cross-reference is accurate — 49-1's own Paragraph (3) does require the buyer to
deliver a copy of the appraisal to the seller as a condition of terminating under it.

---

## 2. texas-unimproved-property-contract-guide.json — TREC No. 9-18

Sources:
- Landing page: https://www.trec.texas.gov/forms/unimproved-property-contract-0
- PDF: https://www.trec.texas.gov/sites/default/files/pdf-forms/9-18_1.pdf

| Claim | Source |
|---|---|
| Form number 9-18, replaces 9-17 | PDF footer |
| Revision date printed on form: 05-04-2026; landing page lists Effective Date 07/01/2026 | PDF header / landing page |
| "NOTICE: Not For Use For Condominium Transactions" | PDF header |
| Landing page purpose text ("property that does not have physical buildings...generally used for property that has been platted") | Landing page |
| Property description by Lot/Block/Addition; reservations via attached addendum | PDF ¶2 |
| ¶4B Natural Resource Lease definition + delivery/termination mechanics | PDF ¶4B |
| ¶7 Property Condition structure — no standalone §5.008 Seller's Disclosure Notice paragraph; ¶7E Seller's Disclosure checklist items (flooding, litigation, environmental hazards, dumpsite/tanks, wetlands, threatened species, floodplain, oak wilt); ¶7F Seller's Water Disclosure | PDF ¶7A–F, confirmed by direct comparison against 25-17's ¶7B which 9-18 lacks |
| ¶6 Title/Survey structure (three survey options, Commitment/Exception Document timelines, objection process) mirrors other current contracts | PDF ¶6 |
| ¶6E(2) cross-reference to the HOA addendum (36-11) | PDF ¶6E(2) |
| ¶¶9–21 (Closing through Notices) track the same structure as TREC's other current contracts | PDF ¶¶9–21, confirmed by direct comparison against 24-20/23-20/25-17 |

**Flagged — explicitly called out in the guide body rather than guessed:** whether unimproved/
vacant land sales are statutorily exempt from the Texas Property Code §5.008 Seller's Disclosure
Notice requirement. The 9-18 form itself doesn't state a reason for lacking the dedicated §5.008
paragraph that 25-17 has — I only confirmed the form's structure differs, not the underlying
statutory reason. That answer lives in Texas Property Code §5.008(e) directly, which was not
pulled for this pass. Flagged in the guide's own callout box, not silently resolved.

---

## 3. texas-new-home-contract-guide.json — TREC No. 24-20 (Completed Construction) & TREC No. 23-20 (Incomplete Construction)

Sources:
- Landing pages: https://www.trec.texas.gov/forms/new-home-contract-completed-construction-0 ,
  https://www.trec.texas.gov/forms/new-home-contract-incomplete-construction-0
- PDFs: https://www.trec.texas.gov/sites/default/files/pdf-forms/24-20_0.pdf ,
  https://www.trec.texas.gov/sites/default/files/pdf-forms/23-20_3.pdf

| Claim | Source |
|---|---|
| Form numbers 24-20 (replaces 24-19) and 23-20 (replaces 23-19) | PDF footers, both forms |
| Revision date printed on both forms: 05-04-2026; landing pages list Effective Date 07/01/2026 for both | PDF headers / landing pages |
| "Not For Use For Condominium Transactions or Closings Prior to Completion of Construction" (24-20 header); same notice language on 23-20 | PDF header, both forms |
| Landing page purpose text for each ("construction has been completed...no one has previously lived in the home" / "construction has not yet been completed") | Landing pages |
| 23-20-only ¶7B Construction Documents, ¶7C Cost Adjustments, ¶7D Buyer's Selections, ¶7E Completion (incl. Substantial Completion Date definition, force-majeure clause) | PDF 23-20, ¶7B–E |
| 23-20 survey tied to "after the Substantial Completion Date" vs. 24-20's Effective-Date-based survey timing | PDF 23-20 ¶6C vs. PDF 24-20 ¶6C — direct textual comparison |
| Casualty loss extension cap: 24-20 = 15 days, 23-20 = 45 days | PDF 24-20 ¶14 ("up to 15 days") vs. PDF 23-20 ¶14 ("up to 45 days") — verbatim, direct comparison |
| Insulation disclosure (FTC regs, R-value itemization) — present on both forms | PDF 24-20 ¶6D, PDF 23-20 ¶7G |
| Lender-required repairs/treatments (5%-of-Sales-Price termination trigger) — present on both | PDF 24-20 ¶6E, PDF 23-20 ¶7E (Lender Required Repairs and Treatments) |
| Residential service contracts reimbursement cap — present on both | PDF 24-20 ¶6I, PDF 23-20 ¶7J |
| Certificate of mold remediation (§1958.154, Occupations Code, 5-year lookback) — present on both forms, verbatim, as item (11) in the Title Notices list under Paragraph 6 (not a separately lettered paragraph on either form) | PDF 24-20 ¶6, Title Notices item (11), page 4; PDF 23-20 ¶6, Title Notices item (11), page 3 — both independently read and confirmed word-for-word this session |
| Chapter 27 Texas Property Code construction-defect notice (60-day pre-suit certified-mail notice, Section 27.004 cure opportunity) — present on both, near signature block | PDF 24-20 page 9, PDF 23-20 page 9 |

No unverifiable claims in this guide. (An earlier draft of this file flagged the mold-remediation
line as unconfirmed on 23-20 because the first extraction pass didn't reach that page; a full
re-read of 23-20's pages confirmed it's present verbatim, so that flag has been resolved and
removed.)

---

## 4. texas-farm-and-ranch-contract-guide.json — TREC No. 25-17

Sources:
- Landing page: https://www.trec.texas.gov/forms/farm-and-ranch-contract-0
- PDF: https://www.trec.texas.gov/sites/default/files/pdf-forms/25-17_4.pdf

| Claim | Source |
|---|---|
| Form number 25-17, replaces 25-16 | PDF footer |
| Revision date printed on form: 05-04-2026; landing page lists Effective Date 07/01/2026 | PDF header / landing page |
| "Designed For Use In Sales Of Existing Farms Or Ranches Of Any Size. Not For Use In Complex Transactions." | PDF header |
| ¶2 Property definition (Land/Improvements/Accessories/Crops), incl. Farm and Ranch Improvements list, Farm and Ranch Accessories checkbox list, Residential Accessories list, Crops harvest-right default, Exclusions | PDF ¶2A–E |
| ¶4D Surface Lease definition + three delivery/notice/termination options | PDF ¶4D |
| ¶6E Exception Documents table (Document/Date/Recording Reference), treated as permitted exceptions | PDF ¶6E |
| ¶6C four survey options incl. "(4) No survey is required" | PDF ¶6C — confirmed this fourth option is absent from 9-18/24-20/23-20's ¶6C, which only list three | Direct comparison across all four PDFs read this session |
| ¶7B Seller's Disclosure Notice Pursuant to §5.008 paragraph w/ 3 checkbox options incl. "Property Code does not require this Seller to furnish" | PDF ¶7B |
| ¶13A proration sentence re: unknown rentals prorated when known | PDF ¶13A |
| ¶20C AFIDA (Agriculture Foreign Investment Disclosure Act of 1978), FSA-153 filing, 90-day window, 25%-of-FMV penalty | PDF ¶20C |
| Page 11 standalone "Ratification of Fee" section + separate broker-fee agreement block | PDF page 11 — confirmed absent from the pages read on 9-18, 24-20, and 23-20 |

No unverifiable claims in this guide. All comparative statements ("doesn't appear on the other
contracts") are based on direct side-by-side reading of the other three forms' PDF text in this
same session, not assumption.

---

## 5. texas-sale-of-other-property-addendum-guide.json — TREC No. 10-6

Sources:
- Landing page: https://www.trec.texas.gov/forms/addendum-sale-other-property-buyer
- PDF: https://www.trec.texas.gov/sites/default/files/pdf-forms/10-6.pdf

| Claim | Source |
|---|---|
| Form number 10-6, replaces 10-5 | PDF footer |
| Revision date printed on form: 12-05-11; landing page lists the same date, 12/05/2011, as Effective Date (no gap on this form, unlike most others) | PDF header / landing page |
| Landing page purpose text ("used if the Buyers will be unable to buy the new property unless their existing property is sold and closed") | Landing page |
| ¶A contingency mechanics + the form's own NOTICE about the date matching Paragraph 9's Closing Date | PDF ¶A |
| ¶B seller's kick-out notice mechanics (dual notice requirement, buyer's response window, automatic termination + EM refund) | PDF ¶B |
| ¶C waiver requires both notice AND additional earnest money deposit | PDF ¶C |
| ¶D default consequence if buyer waives and then can't close solely due to non-receipt of proceeds | PDF ¶D |
| ¶E time-is-of-the-essence clause, verbatim | PDF ¶E |

No unverifiable claims in this guide.

---

## 6. texas-temporary-residential-lease-guide.json — TREC No. 16-7 (Buyer's) & TREC No. 15-7 (Seller's)

Sources:
- Landing pages: https://www.trec.texas.gov/forms/buyers-temporary-residential-lease ,
  https://www.trec.texas.gov/forms/sellers-temporary-residential-lease
- PDFs: https://www.trec.texas.gov/sites/default/files/pdf-forms/16-7.pdf ,
  https://www.trec.texas.gov/sites/default/files/pdf-forms/15-7.pdf

| Claim | Source |
|---|---|
| Form numbers 16-7 (replaces 16-6) and 15-7 (replaces 15-6) | PDF footers, both forms |
| Revision date printed on both forms: 11-03-2025; landing pages list Effective Date 01/05/2026 for both | PDF headers / landing pages |
| 90-day cap notice language, both forms, incl. exact "BUYER...PRIOR to the closing" / "SELLER...AFTER the closing" wording | PDF headers, both forms |
| Landlord/Tenant role assignment (16-7: Seller=Landlord, Buyer=Tenant; 15-7: Buyer=Landlord, Seller=Tenant) | PDF ¶2, both forms |
| 16-7 ¶4 Rental — full anticipated-term rent paid upfront at commencement, true-up at closing, "no portion...applied to payment of any items covered by the Contract" | PDF 16-7 ¶4 |
| 15-7 ¶4 Rental — paid at time of funding, day of closing excluded, no refund on early termination due to default/voluntary surrender | PDF 15-7 ¶4 |
| 16-7 ¶5 Deposit mechanics (must be in addition to earnest money; 30-day refund window; refund-at-closing if lease runs to closing) | PDF 16-7 ¶5 |
| 16-7 ¶18 Termination (four triggers, whichever first) vs. 15-7 ¶18 Termination (two triggers: term expiration or tenant default) | PDF 16-7 ¶18, PDF 15-7 ¶18 — direct comparison |
| Shared provisions: ¶17 Default (24-hour cure notice), ¶19 Holding Over (tenancy at sufferance + daily damages), ¶21 Smoke Alarms (tenant waiver language, verbatim), ¶22 Security Devices (90-day exemption from Property Code requirements), ¶16 Insurance warning (verbatim, both forms), ¶23 Consult Your Attorney | PDF ¶¶16–23, both forms — confirmed identical or near-identical wording across both |

No unverifiable claims in this guide.

---

## 7. texas-notice-of-sellers-termination-guide.json — TREC No. 50-0

Sources:
- Landing page: https://www.trec.texas.gov/forms/notice-sellers-termination-contract
- PDF: https://www.trec.texas.gov/sites/default/files/pdf-forms/50-0.pdf

| Claim | Source |
|---|---|
| Form number 50-0 | PDF footer |
| Revision date printed on form: 8-13-18; landing page lists the same date, 08/13/2018, as Effective Date (no gap on this form) | PDF header / landing page |
| Two grounds: (1) earnest money not delivered per ¶5, before notice given; (2) Other, w/ paragraph identification | PDF checkbox list, verbatim |
| "This notice is not an election of remedies. Release of the earnest money is governed by the contract." | PDF, note above signature block, verbatim |
| "CONSULT AN ATTORNEY BEFORE SIGNING: TREC rules prohibit real estate license holders from giving legal advice. READ THIS FORM CAREFULLY." | PDF, bold text, verbatim |
| Comparison to 38-8's eight grounds (option period, financing, HOA addendum, Seller's Disclosure Notice paragraph, appraisal addendum, uncured title objections, Other) | Sourced from batch 1's independently-verified 38-8 citation entry (item 6 in `new-trec-guides-citations.md`) — not re-fetched this session since batch 1 already sourced 38-8's full text directly from its own PDF |

No unverifiable claims in this guide.

---

## Cross-cutting notes for review

1. **The 49-1 gap from batch 1 is now closed.** Batch 1 explicitly flagged that its 38-8 guide
   only quoted what 38-8 itself said about the appraisal addendum, without independently sourcing
   49-1. This batch fetched 49-1's own PDF text directly and confirmed the cross-reference holds
   up — 49-1 ¶(3) does require the buyer to deliver a copy of the appraisal to the seller.
2. **Comparative claims across contracts (survey options, Seller's Disclosure Notice structure,
   casualty-loss windows, the mold-remediation clause, the Ratification of Fee page) are based on
   direct side-by-side reading of all four contract PDFs — 9-18, 24-20, 23-20, 25-17 — fetched and
   read in full in this same session, not carried over from memory or assumption.**
3. **No dollar figures, percentages, or day-counts were invented.** Every blank on every one of
   these forms (contingency dates, appraisal thresholds, lease rental amounts, deposit amounts) is
   described as negotiated/filled-in by the parties. AFIDA's 90-day filing window and 25%-of-FMV
   penalty are fixed statutory figures printed directly on the form, not blanks — cited as such.
4. **One genuinely unresolved question, flagged rather than guessed:** why the Unimproved Property
   Contract (9-18) doesn't carry the same standalone §5.008 Seller's Disclosure Notice paragraph
   that the Farm and Ranch Contract (25-17) has. The form text confirms the structural difference
   but not the statutory reason — that requires pulling Texas Property Code §5.008(e) directly,
   which was out of scope for a TREC-forms-only pass. Flagged in the guide's own callout box.
5. **Topics considered and deliberately excluded from this batch:** Condominium Resale Certificate
   (32-5), Environmental Assessment/Threatened or Endangered Species/Wetlands Addendum (28-2), and
   Addendum for Coastal Area Property (33-2) were all confirmed as current, live forms on TREC's
   index but skipped per the task's own guidance to prioritize topics a general residential agent
   would plausibly search for over narrower/regional ones. Landing pages for these were not
   fetched this session — if a future batch wants them, they'd need their own citation pass.
