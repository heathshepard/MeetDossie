# Citation trail — new /answers/ pages, batch 1 (2026-08-06)

This is a recombination pass, not new research. Every claim in the 10 new answer JSON files
traces back to the `body_html` of an existing guide JSON in `marketing/guides-data/`, which in
turn traces to a TREC source per `new-trec-guides-citations.md` (batch 1) or
`new-trec-guides-citations-batch2.md` (batch 2). No new TREC pages or PDFs were fetched for this
pass. Where a claim chains through to an original TREC citation, that chain is noted.

---

## 1. what-happens-if-buyer-misses-option-period-deadline-texas.json

| Claim | Source |
|---|---|
| Option period ends at 5:00 PM local time, doesn't roll for weekends/holidays | `texas-option-period-rules.json` body_html ("Ends at 5:00 PM local time... Does NOT roll over") + `how-to-count-days-trec-contract.json` body_html (Rule 3 callout) — both trace to TREC 20-17 ¶ 5B per `new-trec-guides-citations.md` is not the source here (this predates batch 1/2; texas-option-period-rules is one of the original 5 guides, sourced independently, not re-verified this session) |
| Once 5:00 PM passes, unrestricted right is extinguished; buyer can still terminate only via cause-based rights (financing, ¶6D title) | `texas-option-period-rules.json` body_html, "What ends with the option period" section |
| Repair amendments must be executed (signed by both parties) before option expires; signed-buyer/unsigned-seller at 4:55 PM doesn't count | `texas-option-period-rules.json` body_html, same section, verbatim example |
| Common miscounting errors (business days, rollover misapplication, verbal extensions, late notice, wrong time zone) | `texas-option-period-rules.json` body_html, "The most common ways agents lose the option right" |
| Extension only via written amendment executed by both parties before original expiry | `texas-option-period-rules.json` FAQ ("Can the option period be extended?") |
| Letting the option period expire then trying to terminate without cause puts earnest money at risk ("cold feet" isn't a contractual reason) | `texas-earnest-money-rules.json` body_html, "Common ways buyers forfeit earnest money," item 1 |
| Seller's standard remedy on buyer default is to retain earnest money as liquidated damages | `texas-earnest-money-rules.json` body_html, "When earnest money is at risk" |

No unverifiable claims. Note: `texas-option-period-rules.json` and `texas-earnest-money-rules.json`
are among the original 5 pre-existing guides (updated_at 2026-05-05), not part of batch 1/2 — this
answer page draws only from their already-published body_html, per task instructions.

---

## 2. can-seller-back-out-during-option-period-texas.json

| Claim | Source |
|---|---|
| Option period consistently framed as buyer's right ("buyer pays an option fee for the right to terminate... for any reason") | `texas-option-period-rules.json` body_html, opening paragraph |
| TREC 50-0 gives seller exactly two grounds: earnest money not delivered timely, or "Other" w/ paragraph ID | `texas-notice-of-sellers-termination-guide.json` body_html, "Only two grounds, not eight" — traces to TREC 50-0 PDF, checkbox list, per `new-trec-guides-citations-batch2.md` item 7 |
| Comparison to buyer's 8-ground TREC 38-8, including the option-period ground | `texas-notice-of-sellers-termination-guide.json` body_html, same section — traces to TREC 38-8 PDF checkbox list per `new-trec-guides-citations.md` item 6 (batch 1) |
| Structural asymmetry: contract gives buyers more built-in cause-based (and one no-cause) rights than sellers | `texas-notice-of-sellers-termination-guide.json` body_html, same section, explicit statement |

Flagged in the answer's own callout box (not stated as fact): whether a seller could negotiate a
separate mutual no-cause right via the Amendment form, or what remedies exist outside the two TREC
termination-notice forms — not addressed in any source file, explicitly called out as outside scope
in the answer body itself rather than guessed.

---

## 3. is-earnest-money-due-on-weekends-texas.json

| Claim | Source |
|---|---|
| ¶ 5A default 3-day earnest money deadline | `texas-earnest-money-rules.json` body_html, "When earnest money is due" |
| Deadline rolls per ¶ 23 if it lands on Saturday/Sunday/federal holiday | `texas-earnest-money-rules.json` body_html, same section + `how-to-count-days-trec-contract.json` body_html, Rule 3 |
| Option period is the exception — does not roll | `how-to-count-days-trec-contract.json` body_html, Rule 3 callout ("The option-period exception") |
| ¶ 23 references federal holidays, not Texas state holidays (Confederate Heroes Day, TX Independence Day) | `how-to-count-days-trec-contract.json` FAQ, "Are Texas state holidays counted as rollover days?" |
| Underlying day-count is calendar days, not business days | `how-to-count-days-trec-contract.json` body_html, Rule 2 |
| Confirm escrow receipt in writing, not just buyer's claim of delivery | `texas-earnest-money-rules.json` body_html, "Operational reality" callout |

No unverifiable claims.

---

## 4. what-is-trec-form-38-8-used-for.json

| Claim | Source |
|---|---|
| All content (form name, date 02-10-2025, replaces 38-7, eight grounds, "not an election of remedies" language, attorney warning) | `texas-notice-of-buyers-termination.json` body_html and FAQ, in full — this guide itself traces to TREC 38-8 PDF, checkbox list, header/footer, and note above signature block per `new-trec-guides-citations.md` item 6 (batch 1) |

Direct restatement of a single existing guide, narrowed to the "what is it used for" framing. No
new claims added beyond what's already in the guide.

---

## 5. does-amendment-need-both-signatures-texas.json

| Claim | Source |
|---|---|
| Amendment form framed as two-party agreement ("Seller and Buyer amend the contract as follows") | `trec-amendment-to-contract-guide.json` body_html, opening paragraph — traces to TREC 39-11 PDF per `new-trec-guides-citations.md` item 7 (batch 1) |
| Execution line: "EXECUTED the ___ day..." + broker fills in date of final acceptance, distinct from Effective Date | `trec-amendment-to-contract-guide.json` body_html, "Execution line" section |
| Explicit statement that repair amendments must be executed (signed by both parties) before option expires; signed-buyer/unsigned-seller at 4:55 PM is not executed | `texas-option-period-rules.json` body_html, "What ends with the option period" — this is the load-bearing citation for the core "yes, both signatures" claim, since it's the only source file that states the two-signature requirement in those explicit terms |
| Ten types of changes on the Amendment form all require the same execution mechanics | `trec-amendment-to-contract-guide.json` body_html, "The ten things you can check" list (existence of the ten items) — the claim that ALL ten require both signatures is a direct inference from the single execution/signature block governing the whole form, not a separate per-item statement in the source |

No unverifiable claims. The central "both signatures required" fact comes from
`texas-option-period-rules.json`'s repair-amendment example, applied here to amendments generally
since the Amendment form has only one execution mechanism for the whole document.

---

## 6. difference-option-fee-earnest-money-texas.json

| Claim | Source |
|---|---|
| Full comparison table (purpose, refundability, held-by, credit-to-sales-price) | `texas-earnest-money-rules.json` body_html, "The option fee versus earnest money" table, verbatim — original guide, not part of batch 1/2 |
| Option fee non-refundable, seller keeps it, only refundable-to-credit if ¶5A box checked and deal closes | `texas-option-period-rules.json` body_html, "Can the buyer recover the option fee?" FAQ-style section |
| Earnest money refundable when buyer terminates under an actual contract right (option period, title, financing, casualty) | `texas-earnest-money-rules.json` body_html, "When earnest money is refundable" list |

No unverifiable claims.

---

## 7. hoa-addendum-information-not-delivered-on-time-texas.json

| Claim | Source |
|---|---|
| Four delivery options in Paragraph A | `texas-hoa-addendum-guide.json` body_html, "Paragraph A — four ways to handle delivery" — traces to TREC 36-11 PDF ¶ A(1)–(4) per `new-trec-guides-citations.md` item 3 (batch 1) |
| Option 1 (seller delivers): if never delivered, buyer's sole remedy is termination before closing, earnest money refunded | `texas-hoa-addendum-guide.json` body_html, option 1 description |
| Option 2 (buyer obtains): deemed-receipt mechanic, same 3-day/before-closing window | `texas-hoa-addendum-guide.json` body_html, option 2 description |
| Option 3 (buyer already has it, updated resale cert): 10-day delivery window after payment; missed window lets buyer terminate + refund | `texas-hoa-addendum-guide.json` body_html, option 3 description |
| Option 4 (buyer waives): no delivery obligation | `texas-hoa-addendum-guide.json` body_html, option 4 description |
| Fixed 3-day (or before-closing) post-receipt termination window regardless of which option is checked | `texas-hoa-addendum-guide.json` body_html, "The number to track" callout |
| Material change duty (Paragraph B): seller must notify; buyer may terminate if info "was not true" or materially adversely changed | `texas-hoa-addendum-guide.json` body_html, "Paragraph B — material changes" |

No unverifiable claims.

---

## 8. can-buyer-terminate-low-appraisal-texas.json

| Claim | Source |
|---|---|
| Property Approval (¶2B) baseline mechanics: 3rd-day-before-closing deadline, notice + lender statement, earnest money refund | `texas-third-party-financing-addendum.json` body_html, Paragraph 2 table — traces to TREC 40-11 PDF ¶ 2B per `new-trec-guides-citations.md` item 1 (batch 1) |
| TREC 49-1 applies only when 40-11 is attached and financing isn't FHA/VA | `trec-49-1-appraisal-addendum-guide.json` body_html, opening paragraph — traces to TREC 49-1 PDF header per `new-trec-guides-citations-batch2.md` item 1 (batch 2) |
| Three boxes: Waiver, Partial Waiver, Additional Right to Terminate, incl. dollar-threshold + appraisal-delivery + day-count mechanics | `trec-49-1-appraisal-addendum-guide.json` body_html, "Check one box only" list |
| If 49-1 not attached, falls back to standard ¶2B mechanics | `trec-49-1-appraisal-addendum-guide.json` body_html, "What this doesn't cover" |
| FHA/VA uses Paragraph 4 of 40-11 instead of 49-1; ¶2B's 3-day notice requirement doesn't apply to Paragraph 4 | `texas-third-party-financing-addendum.json` body_html, "Paragraph 4 — FHA/VA required provision" — traces to TREC 40-11 PDF ¶ 4 per `new-trec-guides-citations.md` item 1 |
| TREC 38-8 ground 6 requires appraisal copy delivered to seller, matching 49-1 ¶(3)'s condition | `texas-notice-of-buyers-termination.json` body_html, ground 6 + `trec-49-1-appraisal-addendum-guide.json` body_html, "How this connects to the Notice of Buyer's Termination" — this cross-reference is itself flagged in `new-trec-guides-citations-batch2.md` item 1 as the gap batch 1 flagged and batch 2 closed by independently fetching 49-1's own PDF text |

No unverifiable claims.

---

## 9. what-is-notice-of-sellers-termination-texas.json

| Claim | Source |
|---|---|
| All content (form name, date 8-13-18, two grounds, timing requirement for ground 1, "not an election of remedies," attorney warning, comparison to 38-8) | `texas-notice-of-sellers-termination-guide.json` body_html and FAQ, in full — traces to TREC 50-0 PDF per `new-trec-guides-citations-batch2.md` item 7 (batch 2) |

Direct restatement of a single existing guide, narrowed to the "what is it" framing. No new claims
added beyond what's already in the guide.

---

## 10. attorney-needed-for-real-estate-amendment-texas.json

| Claim | Source |
|---|---|
| Bolded attorney-consult warning above signature block | `trec-amendment-to-contract-guide.json` body_html, "Consult an attorney before signing" callout — traces to TREC 39-11 PDF, above signature block, per `new-trec-guides-citations.md` item 7 (batch 1) |
| Ten pre-written checkboxes cover sales price, repairs, closing date, financing amounts, option fee extension, waiver, financing-notice date | `trec-amendment-to-contract-guide.json` body_html, "The ten things you can check" list |
| "Other Modifications" checkbox caution: agents "prohibited from practicing law" | `trec-amendment-to-contract-guide.json` body_html, item 10 in the same list, and FAQ ("Can an agent draft custom language...") |

No unverifiable claims.

---

## Cross-cutting notes

1. **This batch draws from both the original 5 pre-existing guides** (`texas-option-period-rules`,
   `texas-earnest-money-rules`, `how-to-count-days-trec-contract`, plus two others not used here)
   **and the 14 new guides from batches 1–2** (`texas-notice-of-buyers-termination`,
   `trec-amendment-to-contract-guide`, `texas-hoa-addendum-guide`, `texas-third-party-financing-addendum`,
   `trec-49-1-appraisal-addendum-guide`, `texas-notice-of-sellers-termination-guide`). Every guide
   drawn from is named explicitly per claim above.
2. **No TREC PDFs or landing pages were fetched for this pass.** Every fact traces to an existing
   guide's `body_html`, which itself already carries a citation in one of the two guides-citation
   files (for the 14 new guides) or was published independently in the original 5 (not re-verified
   this session, per task instructions to treat already-published guide content as source material).
3. **One answer (`can-seller-back-out-during-option-period-texas`) required an explicit scope flag**
   rather than a fabricated claim — see item 2 above. That's the only page in this batch where the
   question, as asked, has a partial answer in the source material and a piece that isn't covered.
4. **One answer (`does-amendment-need-both-signatures-texas`) makes a bounded inference**: the
   two-signature requirement is stated explicitly only in the context of repair amendments during
   the option period (`texas-option-period-rules.json`), not restated separately for every one of
   the Amendment form's ten checkbox types. The inference that the same execution mechanic governs
   all ten is reasonable — the form has one signature block for the whole document — but it's an
   inference from a single documented example, not ten independently-verified statements. Flagged
   here for Hadley's review rather than presented as ten separately-sourced facts.

## Good questions NOT answered in this batch — need new primary research

- **What are the statutory exemptions to the Seller's Disclosure Notice requirement in Texas?**
  Flagged as unsourceable in `new-trec-guides-citations.md` item 2 — lives in Texas Property Code
  § 5.008(e), not on trec.texas.gov's form pages already fetched. Would make a strong answer page
  ("Who is exempt from the Seller's Disclosure Notice in Texas?") but needs a statute pull first.
- **Why doesn't the Unimproved Property Contract (9-18) require a standalone § 5.008 Seller's
  Disclosure Notice paragraph the way the Farm and Ranch Contract (25-17) does?** Flagged as
  unresolved in `new-trec-guides-citations-batch2.md` item 2 / cross-cutting note 4 — same statute
  gap.
- **Can a seller negotiate a mutual no-cause termination right into a Texas contract?** Raised
  directly by `can-seller-back-out-during-option-period-texas.json` in this batch and explicitly
  left open there — would need either a TREC forms review of what a custom Amendment could
  legally accomplish, or attorney-sourced guidance, neither of which exists in current source
  material.
- **What happens if a buyer's financing falls through after the Buyer Approval deadline but before
  closing?** Touched on tangentially in `texas-earnest-money-rules.json`'s forfeiture list, but a
  dedicated answer would benefit from a closer read of 40-11 ¶2A's "deemed obtained" mechanics
  paired with the contract's default-and-remedies paragraph (¶15), which wasn't independently
  fetched in either citation batch.
