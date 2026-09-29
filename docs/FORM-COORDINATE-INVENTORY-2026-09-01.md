# Form Coordinate Inventory — 2026-09-01

Measurement pass only. Ran the existing extractor (`pdf-lib` `getForm().getFields()` +
`getRectangle()` per widget, same method as `scripts/extract-trec-field-coords.js`) against
every form in `api/fill-form.js` `FORM_CONFIGS` (31 total). Nothing wired in, nothing rebuilt.
Extracted files and overlay renders live in scratchpad, not `api/_assets/`.

## Method

1. Decoded each form's live base64 PDF asset (the actual file `fill-form.js` sends today).
2. Loaded with pdf-lib, counted AcroForm fields by type (text/checkbox/signature/radio).
3. For 4 forms, drew a colored box directly on every widget's real rect (red=checkbox,
   blue=signature, green=text) and rendered to PNG via `pdftoppm` to visually confirm
   placement against the printed form — not just trusting the count.

## Per-form table (31 forms)

| Form (FORM_CONFIGS key) | TREC/TAR # | Pages | AcroForm? | Total fields | text | checkbox | signature |
|---|---|---|---|---|---|---|---|
| resale-contract | 20-19 | 12 | yes | 280 | 215 | 61 | 4 |
| financing-addendum | 40-11 | 2 | yes | 64 | 45 | 15 | 4 |
| **sellers-disclosure** | **55-1** | **4** | **yes** | **186** | **158** | **24** | **4** |
| amendment | 39-11 | 1 | yes | 51 | 29 | 18 | 4 |
| unimproved-property | 9-17 | 10 | yes | 270 | 196 | 70 | 4 |
| seller-financing | 26-8 | 2 | yes | 48 | 19 | 25 | 4 |
| loan-assumption | 41-3 | 2 | yes | 35 | 22 | 9 | 4 |
| sellers-temp-lease | 15-7 | 2 | yes | 45 | 41 | 0 | 4 |
| buyers-temp-lease | 16-7 | 2 | yes | 43 | 39 | 0 | 4 |
| lead-paint-addendum | OP-L | 1 | yes | 25 | 11 | 8 | 6 |
| fixture-leases | 52-1 | 1 | yes | 24 | 6 | 14 | 4 |
| hoa-addendum | 36-11 | 1 | yes | 17 | 5 | 8 | 4 |
| backup-contract | 11-8 | 2 | yes | 17 | 13 | 0 | 4 |
| residential-leases | 51-1 | 1 | yes | 16 | 7 | 5 | 4 |
| appraisal-termination | 49-1 | 1 | yes | 11 | 4 | 3 | 4 |
| oil-gas-minerals | 44-3 | 1 | yes | 10 | 2 | 4 | 4 |
| sale-other-property | 10-6 | 1 | yes | 10 | 6 | 0 | 4 |
| propane-gas | 47-0 | 1 | yes | 9 | 5 | 0 | 4 |
| hydrostatic-testing | 48-1 | 1 | yes | 9 | 2 | 3 | 4 |
| environmental | 28-2 | 1 | yes | 9 | 2 | 3 | 4 |
| coastal-area | 33-2 | 1 | yes | 8 | 4 | 0 | 4 |
| improvement-district | IDN | 1 | yes | 8 | 4 | 0 | 4 |
| short-sale | 45-2 | 1 | yes | 6 | 2 | 0 | 4 |
| gulf-waterway | 34-4 | 1 | yes | 5 | 1 | 0 | 4 |
| termination-notice | 38-7 | 1 | **flat** | — | (anchor map done today) |
| new-home-incomplete | 23-20 | ? | **flat** | — | (anchor map done today) |
| new-home-complete | 24-20 | ? | **flat** | — | (anchor map done today) |
| farm-ranch | 25-17 | ? | **flat** | — | (anchor map done today) |
| wire-fraud-warning | TAR 2517 | 1 | **flat** | 0 | — | — | — |
| buyer-rep-agreement | TAR 1501 | 1 | **flat** | 0 | — | — | — |
| t47-affidavit | T-47 | 2 | **flat** | 0 | — | — | — |

24 forms carry real AcroForm widgets. 4 flat forms already have anchor-text field maps
(merged today, not re-verified in this pass — out of scope per task). 3 flat forms have
**no field map at all yet**.

## Spot-check renders (visual, not count-based)

Rendered overlays for 4 forms — boxes drawn at the exact extracted widget rects, on top of
the real page image:

- **Seller's Disclosure Notice (55-1), all 4 pages** — the priority form. Every one of the
  186 widgets lands exactly on its printed line/box: the per-item Y/N/U entry boxes (pages
  1, 2, 4), the true tri-state checkboxes for smoke detectors/repairs/floodplain/insurance
  claims (pages 2-3), and all 4 signature blocks (2 Seller, 2 Purchaser) on page 4 sit dead
  center on the printed signature lines. This is genuinely clean — no misalignment anywhere.
  **Important finding:** most of the 186 fields are single-character **text** fields (Y/N/U),
  not checkboxes — only 24 are true `PDFCheckBox` widgets (smoke detector, repairs, floodplain,
  insurance-claim, FEMA questions). Don't build a checkbox-only UI for this form.
- **HOA Addendum (36-11)** — all 17 widgets (5 text, 8 checkbox radio-style "check one box"
  selectors, 4 signature) land correctly, including the small inline checkboxes in
  paragraphs A/D.
- **Seller Financing Addendum (26-8), page 1** — all widgets including the dense inline
  checkbox row in paragraph A (credit report / employment / funds / financial statement)
  and paragraphs C's "check one box only" groups land precisely.
- **Amendment (39-11)** — all 51 widgets including all 18 checkboxes (10 numbered items +
  nested sub-checkboxes) and both Buyer/Seller signature pairs land correctly.

No form checked showed a page-assignment bug or misplaced widget. Sample spans the
highest-field-count form (SDN) down to a 17-field addendum, across 1-, 2-, and 4-page
layouts — consistent result across all of them.

## Judgment call: "signature" field type undercounts real initial requirements

Only forms that are full TREC **contracts** (not addenda) require per-page Buyer/Seller
initials: `resale-contract` (20-19, done today), `unimproved-property` (9-17, not done),
and the 3 already-flat contract forms (new-home x2, farm-ranch, done today). In the raw
AcroForm, those per-page initial boxes are typed as plain **text** widgets, not
`PDFSignature` — pdf-lib's field-type count doesn't surface them for free. Identifying
which of a contract's ~200 text widgets are the per-page initial footer (vs. a data field)
requires the same footer-band/visual heuristic that `trec-20-19-esign-coords.json` used.
**All 24 single/two-page addenda only need ONE signature block at the end** (no per-page
initials) — their `signature: 4` count already covers everything needed. This heuristic
work is real for exactly one remaining form: **unimproved-property (9-17)**.

## Gap list, ordered

**Group 1 — Ready to wire as-is (widget geometry clean, no per-page-initial complexity).**
21 single/two-page addenda: financing-addendum, hoa-addendum, lead-paint-addendum,
amendment, appraisal-termination, seller-financing, buyers-temp-lease, sellers-temp-lease,
sale-other-property, oil-gas-minerals, backup-contract, coastal-area, hydrostatic-testing,
environmental, short-sale, gulf-waterway, propane-gas, residential-leases, fixture-leases,
loan-assumption, improvement-district. Extraction is already clean per the spot checks above
(3 of these 4 spot-checked forms are in this group). Work left is just running the extractor
per form + writing each JSON in the `trec-20-19-esign-coords.json` shape + one quick render
check per form to confirm, no coordinate correction expected.
**Estimate: 1 focused session for all 21** (batchable — mechanical, not investigative).

**Group 2 — Seller's Disclosure Notice (55-1).** Widget geometry is clean and verified by
render (above), so the coordinate math is *not* the remaining work. What's left is the
semantic layer: mapping each of the 158 text + 24 checkbox fields to a friendly key/label
(Range, Termite Damage, Floodplain-wholly/partly, etc.) the way `trec-20-18-pdflib-fieldmap.js`
does for the resale contract — needed so answers can be programmatically routed, not just
geometrically placed. Highest-value form, most fields to label by hand.
**Estimate: 1 focused session** (comparable to today's 20-19 session — same shape of work,
more fields but simpler per-field logic since most are single Y/N/U text fields).

**Group 3 — unimproved-property (9-17).** Widget geometry extracts fine (270 fields), not
render-checked in this pass, but it's a 10-page full contract needing the same per-page
Buyer/Seller initial-footer identification work 20-19 got (see judgment-call note above).
**Estimate: 1 focused session**, same scope as the 20-19 build.

**Group 4 — Genuinely hard: flat PDFs, no field map yet.** wire-fraud-warning (TAR 2517,
1pg), buyer-rep-agreement (TAR 1501, 1pg), t47-affidavit (T-47, 2pg). Zero AcroForm widgets
— confirmed, not an extraction bug (checked directly, no XFA trick either). These need the
same anchor-text approach used today for the 4 now-fixed flat forms (23-20/24-20/25-17/38-7).
**Estimate: comparable to today's flat-form batch — roughly half a session per form**, so
~1.5 sessions for all 3, doable in one sitting since they're short forms.

## Bottom line

Good news: the extractor is not the bottleneck. Every widget-based form checked — including
the highest-priority Seller's Disclosure Notice — extracts geometrically clean with zero
hand-correction needed. 21 of 24 widget forms are close to a copy-paste of today's process.
The real remaining distance is 3 sessions of semantic/labeling work (SDN field-key mapping,
unimproved-property per-page initials, batch-wiring the 21 addenda) plus ~1.5 sessions of
anchor-text work for the 3 forms that are flat with nothing built yet.
