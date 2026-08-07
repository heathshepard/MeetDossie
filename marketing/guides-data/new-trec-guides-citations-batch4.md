# Citation trail — new TREC guide pages, batch 4 (2026-08-06)

Two new guide JSON files, both covering paragraphs on TREC Form 20-19 (the current One to Four
Family Residential Contract (Resale), effective 07/01/2026, replacing 20-18). Same methodology as
batches 1-3: primary source is the actual current form PDF, fetched directly and read via the
Read tool (WebFetch saves the PDF binary locally; Read then extracts the actual page images/text
from that saved file). Both guides also cross-verified against Texas REALTORS®' own May 2026
"Updates to TREC Forms" memo, fetched independently as a second source.

Sources used across both guides:
- TREC 20-19 PDF (direct fetch + Read, all 12 pages): https://www.trec.texas.gov/sites/default/files/pdf-forms/20-19_4.pdf
- Texas REALTORS® "Updates to TREC Forms" memo (May 11, 2026), fetched directly: https://www.texasrealestate.com/wp-content/uploads/2026-05-Forms-Updates.pdf
- TREC 20-19 effective-date confirmation: web search results citing TREC's own site and Texas REALTORS® coverage (see note 2 below)
- Existing repo guide, read for consistency and cross-link accuracy, not re-verified against a new source: `marketing/guides-data/texas-groundwater-surface-water-rights-disclosure-guide.json` (TREC 61-0)

---

## 1. texas-trec-brokerage-compensation-2026-guide.json — TREC No. 20-19, ¶12B/¶12C

| Claim | Source |
|---|---|
| Form number 20-19, replaces 20-18, revision date 05-04-2026 | 20-19 PDF, page 1 header + page 10 footer ("This form replaces TREC NO. 20-18") |
| Mandatory effective date 07/01/2026, voluntary use permitted before that, no grace period after | Texas REALTORS® memo, page 1: "Forms labeled as mandatory have an effective date of July 1, 2026"; corroborated by web search results citing TREC's own published effective date |
| ¶12B "BROKERAGE COMPENSATION" full text, verbatim, incl. both checkbox subparagraphs | 20-19 PDF, page 7 |
| ¶12B(2) — buyer's new option to contribute to seller's broker compensation — is the new element | Texas REALTORS® memo, page 3: "Brokerage Compensation has been moved to a new paragraph, Paragraph 12B, and adds a new option that allows the buyer to contribute to the seller's broker's compensation" |
| Old ¶8B brokers'-fees statement moved into ¶12B | Texas REALTORS® memo, page 3: "The statement regarding each party's obligation to pay their broker has been moved from Paragraph 8B to Paragraph 12B" |
| Current ¶8 retitled "BROKER OR SALES AGENT DISCLOSURE," now covers only a broker/agent's disclosure of being a party (or having a spouse/parent/child/business-entity/trust interest) in the transaction | 20-19 PDF, pages 5-6, ¶8 full text |
| ¶12C "EXPENSE LIMITATION" full text, verbatim | 20-19 PDF, page 7 |
| Old "lender expense limitation paragraph" moved to ¶12C and reworded | Texas REALTORS® memo, page 3: "The lender expense limitation paragraph has been moved to Paragraph 12C and reworded to align with the other changes made to Paragraph 12" |
| ¶12A retitled "EXPENSES," now excludes brokerage fees from its scope | Texas REALTORS® memo, page 3: "Paragraph 12A is now titled Expenses and clearly specifies that the expenses referenced in 12A do not include brokerage fees" |
| ¶12A(1)(b) seller-concession language, verbatim | 20-19 PDF, page 6, ¶12A(1)(b) |
| Broader context: 2024 NAR settlement, MLS cooperative-compensation removal, TXR 1101 dropping broker-to-broker compensation from its own Paragraph 5 | Texas REALTORS® memo, page 4: "A significant update to the listing agreement is the removal of broker-to-broker compensation from Paragraph 5. This change aligns with recent updates to the TREC contracts... and better aligns with the industry shift that began when cooperative compensation was removed from the MLSs..." |

**Flagged as unverifiable, stated directly in the guide rather than guessed at:** we do not have the
prior 20-18 form's PDF text on hand, so the exact word-for-word prior language of the
expense-limitation clause (what it said before being moved into ¶12C) could not be quoted or diffed.
The guide states only that TREC's and Texas REALTORS®' own change summaries confirm the clause was
relocated and reworded — it does not reconstruct or guess at the old wording. The task brief's
characterization of the old clause as a broader "any expense exceeds X, terminate" right was **not**
independently confirmed against 20-18 text and was intentionally left out of the guide for that
reason.

**Corrected 2026-08-07 (prior version of this note was wrong):** the task brief described a
terminology shift in "¶17" (ATTORNEY'S FEES) from "Listing Broker/Other Broker" to "Seller's
broker/Buyer's broker." This is a genuine, in-form change on 20-19 itself, confirmed by directly
reading both PDFs and diffing ¶17 across forms — it is not solely a TREC 56-0 (Lead-Based Paint
Addendum) matter, and the earlier conclusion in this file pinning it exclusively to 56-0 was wrong
because it diffed 20-19's ¶17 against itself instead of against the prior form's ¶17. Verbatim,
both sides:
- 20-17/20-18 ¶17: "A Buyer, Seller, Listing Broker, Other Broker, or Escrow Agent who prevails..."
- 20-19 ¶17: "A Buyer, Seller, Seller's broker, Buyer's broker, or Escrow Agent who prevails..."
This is part of the same broker-terminology overhaul that also touches ¶12/¶8 and the broker
signature page on 20-19. The Texas REALTORS® memo's TREC 56-0 note ("Changed Other Broker to
Buyer's Broker and Listing Broker to Seller's Broker") describes an additional, separate instance
of the same industry-wide relabeling on the Lead-Based Paint Addendum — it does not mean 20-19 ¶17
was left unchanged. The 20-19 guide should state plainly that ¶17 itself now uses "Seller's
broker"/"Buyer's broker" language.

---

## 2. texas-sellers-water-disclosure-guide.json — TREC No. 20-19, ¶7I

| Claim | Source |
|---|---|
| ¶7I "SELLER'S DISCLOSURE ABOUT GROUNDWATER AND SURFACE WATER RIGHTS (Seller's Water Disclosure)" — full text, all three checkbox options, verbatim | 20-19 PDF, page 5 |
| Five exemption conditions (a)-(e) under box (3), verbatim, incl. condition (b) ("Seller is not aware of a pond, lake, or water tank on the Property") | 20-19 PDF, page 5 |
| New requirement is directive-driven, doesn't apply to Residential Condominium Contract (TREC 30-18) | Texas REALTORS® memo, page 2-3: "To fulfill the directive from the Sunset Commission, the seller must indicate whether the buyer has already received the Seller's Water Disclosure... The new water disclosure requirement does not apply to the Residential Condominium Contract" |
| ¶7I references a separate TREC-published disclosure ("Seller's Water Disclosure published by TREC") — that document is TREC 61-0 | 20-19 PDF, page 5, ¶7I opening text; cross-referenced against the existing repo guide `texas-groundwater-surface-water-rights-disclosure-guide.json`, which independently sourced TREC 61-0's own text in an earlier session |
| Mandatory effective date 07/01/2026 (same as the contract itself) | Texas REALTORS® memo, page 1; web search corroboration of TREC's published effective date |

**Resolved (was flagged as an OCR/extraction caveat, confirmed as a real drafting gap
2026-08-07):** ¶7I(2)'s sentence reads "Seller deliver the Seller's Water Disclosure to Buyer,"
missing a verb (expected "shall") between "Seller" and "deliver." Three independent reads —
including a fresh pull directly from trec.texas.gov, separate from the original saved-PDF
read — all show the same missing word. This is not an OCR artifact from the original page-image
read; it appears to be a genuine drafting gap in TREC's printed form. The surrounding paragraph
(¶7B, same structure, page 4) does use "Seller shall deliver the Seller's Disclosure Notice to
Buyer," so the omission in ¶7I(2) looks like an oversight when that paragraph was drafted, not an
intentional variation. The guide (`texas-sellers-water-disclosure-guide.json`) no longer quotes the
sentence with a bracketed "[shall]" placeholder — it now paraphrases around that clause and notes
in prose that the form's own printed text appears to omit the verb, rather than presenting a
reconstructed word as if it were part of the verbatim quote.

---

## Cross-cutting notes

1. **PDF read method:** WebFetch on the 20-19 and Texas REALTORS® memo PDF URLs both correctly
   reported the raw binary as unparseable directly, but both saved the binary to a local scratch
   path. The Read tool then opened each saved path directly. For the 20-19 PDF (1.6MB, 12 pages),
   Read returned rendered page images (not a text layer) — verbatim quotes above were read directly
   off those images. For the Texas REALTORS® memo (102KB, 8 pages), Read returned a proper text
   layer. Same two-step process documented in batches 2 and 3, now confirmed working on a
   page-image PDF as well as a text-layer PDF.
2. **Effective date 07/01/2026 vs. form revision date 05-04-2026:** these are two different dates
   and both are used correctly in the guides — 05-04-2026 is the date printed on the form itself
   (when it was adopted/revised); 07/01/2026 is the date TREC set for mandatory use, confirmed via
   Texas REALTORS®' memo and corroborated by web search results referencing TREC's own published
   effective date. Neither guide conflates the two.
3. **No dollar figures, percentages, or day-counts were invented.** ¶12B(1)/(2)'s $ or % fields and
   ¶7I(2)'s blank day-count are described as blanks the parties fill in, not given assumed defaults.
4. **Nothing in either guide characterizes the legal effect, enforceability, or antitrust
   implications of any compensation arrangement.** Both guides are limited to describing what the
   form's printed language says, consistent with the task's instruction given the NAR-settlement
   sensitivity of this topic. Both carry "not legal advice, consult a Texas real estate attorney"
   framing in their opening paragraph, matching every other guide in this series.
