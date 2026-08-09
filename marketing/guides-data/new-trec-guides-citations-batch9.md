# Citation trail — new TREC guide page, batch 9 (2026-08-08)

One new guide: `texas-property-inspection-report-guide.json`, covering **TREC/TREC-inspector form
REI 7-6 (Property Inspection Report)** from the listing/buyer's agent or TC's side — what the
I/NI/NP/D rating system means for option-period decisions and repair negotiation, not an
inspector's how-to-fill-it-out doc.

## Prior attempt (batch 3) and what changed this session

Batch 3's citation file (`new-trec-guides-citations-batch3.md`, "Cross-cutting notes" item 3)
documents that this exact topic was investigated and explicitly left out: "Multiple WebFetch
attempts at the form's landing page (`/forms/inspection-report-form`) and a guessed PDF path
returned only tangential FAQ content... Rather than guess at a PDF filename pattern... this form
was left out of the batch entirely."

This session re-attempted with two changes to method:
1. **WebSearch first, not a guessed PDF filename.** Searching `"REI 7-6" trec.texas.gov property
   inspection report form pdf` and `site:trec.texas.gov REI 7-6` (both run this session) surfaced
   the actual working PDF path directly — `REI 7-6_0.pdf` — which is not a filename anyone could
   have reasonably guessed from the pattern used on contract forms (those follow `NN-NN.pdf`;
   inspector forms use the `REI N-N` prefix with URL-encoded spaces).
2. **The landing page fetch still dead-ends, confirming batch 3's finding was correct at the
   time and is still correct today** — `https://www.trec.texas.gov/forms/inspection-report-form`
   was fetched fresh this session and returns TREC's generic homepage/navigation content, not the
   form's own detail page. This is a live TREC site issue, not a research miss. The direct PDF URL
   is the only path that works.

Once the working PDF URL was found, this session followed the same two-step method batch 2/3
documented as reliable: WebFetch on the `.pdf` URL cannot parse the binary itself but saves it to
a local scratch path; the Read tool then opens that saved path directly and returns full,
accurate page-by-page text. That worked here without any failure, across all 6 pages of the form.

## Sources used

- **REI 7-6 form PDF, fetched directly and read via the Read tool (all 6 pages, full text and
  section layout):** https://www.trec.texas.gov/sites/default/files/pdf-forms/REI%207-6_0.pdf
  — this is the primary source for the entire guide: the preamble (purpose of inspection,
  inspector's required/not-required duties, client responsibility language, report limitations),
  the "Notice Concerning Hazardous Conditions, Deficiencies, and Contractual Agreements" section,
  the "Additional Information Provided by Inspector" disclaimer, and the six numbered sections of
  the report body (I. Structural Systems, II. Electrical Systems, III. Heating, Ventilation and
  Air Conditioning Systems, [mislabeled "VI" on the form itself, actually Plumbing] Plumbing
  Systems, V. Appliances, VI. Optional Systems), each with its own lettered subitems and the
  I/NI/NP/D checkbox row.
- **TREC article "Are You Using the Right Property Inspection Report Form?"**, fetched directly:
  https://www.trec.texas.gov/article/are-you-using-right-property-inspection-report-form —
  confirms REI 7-6 became mandatory for all real estate inspections in Texas effective February
  1, 2022, replacing the prior REI 7-5, and that the revision added the enhanced preamble
  clarifying inspector duties and client expectations.
- **TREC "Property Inspection Report Form Instruction Sheet" page**, fetched directly:
  https://www.trec.texas.gov/forms/property-inspection-report-form-instruction-sheet — confirms
  this is a TREC-published guidance document (effective 03/07/2023) aimed at inspectors on how to
  properly check the boxes on the form; used only to confirm the instruction sheet's existence and
  audience, not quoted for guide content since it's inspector-facing, not agent-facing.
- **TREC 20-19 One to Four Family Residential Contract (Resale) PDF, fetched directly and read via
  the Read tool (pages 1-2 and 4-5):** https://www.trec.texas.gov/sites/default/files/pdf-forms/20-19_4.pdf
  — used to source the base-contract mechanics this guide ties the inspection report to:
  - Page 2, Paragraph 5B (TERMINATION OPTION): full option-period mechanics, verbatim — "Seller
    grants Buyer the unrestricted right to terminate this contract by giving notice of termination
    to Seller within ___ days after the Effective Date of this contract (Option Period). Notices
    under this paragraph must be given by 5:00 p.m. (local time where the Property is located) by
    the date specified."
  - Page 4, Paragraph 7A (ACCESS, INSPECTIONS AND UTILITIES): "Buyer may have the Property
    inspected by inspectors selected by Buyer and licensed by TREC or otherwise permitted by law
    to make inspections."
  - Page 4, Paragraph 7D (ACCEPTANCE OF PROPERTY CONDITION): the "As Is" checkbox language and,
    critically, the sentence this guide leans on for the option-period tie-in: "Buyer's agreement
    to accept the Property As Is under Paragraph 7D (1) or (2) does not preclude Buyer from
    inspecting the Property under Paragraph 7A, from negotiating repairs or treatments in a
    subsequent amendment, or from terminating this contract during the Option Period, if any."
  - Page 5, Paragraph 7D(1)/(2): the two "As Is" checkbox options, verbatim, including the
    parenthetical instruction "(Do not insert general phrases, such as 'subject to inspections'
    that do not identify specific repairs and treatments.)"
  - Page 5, Paragraph 7E (LENDER REQUIRED REPAIRS AND TREATMENTS) and 7F (COMPLETION OF REPAIRS
    AND TREATMENTS): used to describe what happens after a repair amendment is signed — neither
    party obligated absent written agreement, 5%-of-sales-price lender-repair cap with a Buyer
    termination right if exceeded, and the Seller's up-to-5-day extension right under 7F if repairs
    aren't complete by Closing.
- **WebSearch results (two queries, both run this session)** confirming (a) REI 7-6 is the
  current, active TREC-prescribed form for Texas home inspections and REI 7-5 is retired, and (b)
  the working PDF filename pattern for TREC inspector forms differs from contract-forms
  filenames — used only to locate the correct URL, not quoted as guide content.

## Facts confirmed directly on the form itself (not assumed or estimated)

- The four rating categories and their exact labels: I=Inspected, NI=Not Inspected, NP=Not
  Present, D=Deficient — printed as a legend at the top of every report page (form pages 3-6).
- The form's own definition of "Deficient": "a condition exists that adversely and materially
  affects the performance of a system or component OR constitutes a hazard to life, limb or
  property as specified by the SOPs."
- The explicit statement, printed twice on the form (once in the preamble, once in the hazardous-
  conditions notice on page 2): "items identified as Deficient (D) in an inspection report DO NOT
  obligate any party to make repairs or take other actions."
- The inspector is NOT required to (per the form's own preamble): identify all potential hazards;
  turn on decommissioned equipment/utilities or light a pilot; climb over obstacles or move
  furnishings; prioritize one deficiency over another; provide follow-up verification of repairs;
  or inspect optional-section systems (with the form's own citation: 22 TAC 535.233).
- The six report sections and their full lettered subitem lists, verbatim from the form (see PDF
  citation above for the complete breakdown) — this guide's "what's actually inspected" section is
  a direct transcription of the form's table of contents, not a paraphrase or industry-standard
  guess.
- The "ADDITIONAL INFORMATION PROVIDED BY INSPECTOR" section's own disclaimer, verbatim: this
  content "IS NOT REQUIRED BY THE COMMISSION AND MAY CONTAIN CONTRACTUAL TERMS BETWEEN THE
  INSPECTOR AND YOU, AS THE CLIENT... IF YOU DO NOT UNDERSTAND THE EFFECT OF ANY CONTRACTUAL TERM
  CONTAINED IN THIS SECTION OR ANY ATTACHMENTS, CONSULT AN ATTORNEY."
- Form revision date printed on every page footer: "REI 7-6 (8/9/21)."

## What was deliberately NOT invented

No day-counts, dollar caps, or option-period lengths are asserted as fixed numbers anywhere in
this guide except where they're printed directly on the TREC 20-19 contract text itself (the 5:00
p.m. Paragraph 5B deadline mechanic, and the 5%-of-sales-price / up-to-5-day figures in 7E/7F,
both read directly off the contract PDF). Every other blank (the option period's actual day count,
the specific repairs negotiated, dollar caps on a residential service contract) is described as
negotiated/filled-in by the parties, consistent with the standing rule documented across batches
1-8. This guide does not cite the TREC Standards of Practice (22 TAC Chapter 535, Subchapter R) in
detail beyond the one section number (535.233) that appears printed on the form itself — a deeper
SOP citation trail was out of scope for an agent-facing guide about reading the report, not
performing the inspection.
