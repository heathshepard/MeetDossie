# Hadley_13 FULL-FORM PASS Report — TREC OP-L Lead-Based Paint Addendum

**Report date:** 2026-07-01
**Reviewer:** Hadley_13 (clone — full-form coverage audit)
**Form audited:** TREC OP-L *Addendum for Seller's Disclosure of Information on Lead-Based Paint and Lead-Based Paint Hazards as Required by Federal Law* (approved by TREC 05-04-2026, form number 56-0)
**Prior artifacts consulted:** `scripts/.op-l-validation-table.json`, `.tmp-labeler-pages/op-l/op-l-page-1.png`, `.tmp/hadley-audit-2026-07-01/lead-paint-addendum-1.png`
**Merge-gate rule applied:** `feedback_hadley_apv_is_fillform_merge_gate.md` (locked 2026-06-28)
**Heath rule applied:** *"The whole form has to be fully capable to get a green. For all forms."* (locked 2026-07-01)

---

## FINAL VERDICT: **PASS — 0 FAIL items across full form × full scenario matrix**

**Score:**
- **Total AcroForm fields on TREC OP-L:** 25 (11 text + 8 checkbox + 6 signature)
- **Fillable fields covered by fill pipeline:** 19 of 19 (100%)
- **Signature widgets reserved for DocuSeal:** 6 of 6 (correctly left blank at fill stage)
- **Scenarios rendered:** 10
- **Field × scenario checks:** 250 (25 fields × 10 scenarios)
- **PASS:** 250
- **FAIL:** 0
- **Confidence:** HIGH — ground truth verified by (a) reading every AcroForm `/V` slot via pdf-lib after passing each scenario through the production `fillLeadPaintAddendum` function copied VERBATIM from `api/fill-form.js`, and (b) flattened PDF renders of scenarios F1, F4, and F8 opened by Hadley to visually confirm checkbox states + property address text + signature-date values on the physical form.

---

## Federal-law context (why this form matters)

OP-L is TREC's Texas-formatted implementation of the federal Residential Lead-Based Paint Hazard Reduction Act of 1992 (42 U.S.C. §4852d) and 24 CFR Part 35 / 40 CFR Part 745, Subpart F disclosure requirements. **Federally required for any target housing built before 1978.** Failure to deliver the required disclosure exposes seller and each listing broker to civil penalties (up to $19,507 per violation as of 2024 EPA adjustment) and treble damages in a private right of action by the buyer.

Key downstream trigger inside the Dossie fill pipeline: this form auto-attaches when `year_built < 1978` on the underlying transaction. That trigger is out of scope for this OP-L-only audit but was confirmed present at `api/fill-form.js:3321` ("Year built for lead paint trigger").

---

## Full field inventory (all 25 AcroForm fields)

Enumerated via `pdf-lib` `PDFDocument.getForm().getFields()` against `api/_assets/trec-lead-paint-base64.js`.

| # | Type | AcroForm field name | Physical section | Fill-pipeline coverage |
|---|---|---|---|---|
| 0 | Text | `Street Address and City` | Header — CONCERNING THE PROPERTY AT | YES — `property_address` + `city_state_zip` |
| 1 | Text | `undefined` | §B.1(a) — explanation of known lead-based paint hazards | YES — `hazard_explanation` (only when `seller_aware_of_hazards === true`) |
| 2 | Text | `b Seller has no actual knowledge of leadbased paint andor leadbased paint hazards in the Property` | §B.1(b) — legacy overflow text widget on the "no knowledge" line | YES — explicitly cleared to `""` when B1(b) path is taken (prevents stale data) |
| 3 | Text | `undefined_2` | §B.2(a) — list of documents delivered to purchaser | YES — `documents_list` (only when `seller_has_records === true`) |
| 4 | Text | `b Seller has no reports or records pertaining to leadbased paint andor leadbased paint hazards in the` | §B.2(b) — legacy overflow text widget on the "no records" line | YES — explicitly cleared to `""` when B2(b) path is taken |
| 5 | Text | `Date` | §F Certification — Buyer row 1 date | YES — `lead_paint_date` (or today) via `formatDate()` |
| 6 | Text | `Date_2` | §F Certification — Buyer row 2 date | YES — same value |
| 7 | Text | `Date_3` | §F Certification — Seller row 1 date | YES — same value |
| 8 | Text | `Date_4` | §F Certification — Seller row 2 date | YES — same value |
| 9 | Text | `Date_5` | §F Certification — Buyer's Broker date | YES — same value |
| 10 | Text | `Date_6` | §F Certification — Seller's Broker date | YES — same value |
| 11 | Signature | `Signature1` | §F Buyer signature row 1 | RESERVED — DocuSeal collects at execution |
| 12 | Signature | `Signature2` | §F Buyer signature row 2 | RESERVED |
| 13 | Signature | `Signature3` | §F Buyer's Broker signature | RESERVED |
| 14 | Signature | `Signature4` | §F Seller signature row 1 | RESERVED |
| 15 | Signature | `Signature5` | §F Seller signature row 2 | RESERVED |
| 16 | Signature | `Signature6` | §F Seller's Broker signature | RESERVED |
| 17 | CheckBox | `Check Box7` | §B.1(a) — Known lead-based paint hazards | YES — `seller_aware_of_hazards === true` |
| 18 | CheckBox | `Check Box8` | §B.1(b) — Seller has no actual knowledge (default) | YES — auto-checked when `seller_aware_of_hazards !== true` |
| 19 | CheckBox | `Check Box9` | §B.2(a) — Seller has records/reports | YES — `seller_has_records === true` |
| 20 | CheckBox | `Check Box10` | §B.2(b) — Seller has no reports (default) | YES — auto-checked when `seller_has_records !== true` |
| 21 | CheckBox | `Check Box11` | §C.1 — Buyer waives 10-day inspection | YES — `buyer_waives_inspection === true` |
| 22 | CheckBox | `Check Box12` | §C.2 — Buyer retains 10-day inspection (default) | YES — auto-checked when `buyer_waives_inspection !== true` |
| 23 | CheckBox | `Check Box13` | §D.1 — Buyer received copies of info listed above | YES — auto-checked unless `agent_acknowledges_receipt === false` |
| 24 | CheckBox | `Check Box14` | §D.2 — Buyer received the pamphlet *Protect Your Family from Lead in Your Home* | YES — auto-checked unless `agent_acknowledges_pamphlet === false` |

**All 19 fillable fields are exercised by this audit. The 6 signature widgets are correctly left blank at the fill stage; DocuSeal collects at signing per project architecture and prior Hadley precedent (TREC 36-11 audit).**

**Field-name observation:** The AcroForm names `Check Box13` / `Check Box14` are keyed by TREC to §D (Buyer's Acknowledgment), NOT §E (Brokers' Acknowledgment). The fill-code variable names in `fillLeadPaintAddendum` — `agent_acknowledges_receipt` and `agent_acknowledges_pamphlet` — are slightly misnamed: they gate the *Buyer's* §D acknowledgments, not any broker checkbox (there are no broker checkboxes on this form; §E is text-only). This is a naming-only observation; the behavior is correct: §D defaults both boxes checked, and either can be individually toggled off. **Flagged as cosmetic tech debt below.**

---

## Scenario design — 10 scenarios exercising every field × every branch

| # | Scenario | B1 branch | B2 branch | C branch | D1 | D2 | Date | Address format |
|---|---|---|---|---|---|---|---|---|
| F1 | Defaults — seller no knowledge, no records, buyer retains | B1(b) | B2(b) | C.2 (retain) | on | on | 07/01/2026 | street + city |
| F2 | Seller aware of hazards + explanation | B1(a) + expl | B2(b) | C.2 | on | on | 07/15/2026 | street + city |
| F3 | Seller no knowledge but HAS records | B1(b) | B2(a) + list | C.2 | on | on | 08/01/2026 | street + city |
| F4 | Worst case — seller aware AND has records | B1(a) + expl | B2(a) + list | C.2 | on | on | 09/05/2026 | street + city |
| F5 | Buyer waives 10-day inspection | B1(b) | B2(b) | C.1 (waive) | on | on | 07/01/2026 | street + city |
| F6 | Agent D1 opt-out | B1(b) | B2(b) | C.2 | **off** | on | 07/01/2026 | street + city |
| F7 | Agent D2 opt-out | B1(b) | B2(b) | C.2 | on | **off** | 07/01/2026 | street + city |
| F8 | Both D1 and D2 off | B1(b) | B2(b) | C.2 | **off** | **off** | 07/01/2026 | street + city |
| F9 | Missing `lead_paint_date` — fall-through to today | B1(b) | B2(b) | C.2 | on | on | today | street + city |
| F10 | Address without city_state_zip | B1(b) | B2(b) | C.2 | on | on | 07/01/2026 | street only |

Rationale for choosing these 10:
- **F1–F4** — every combination of §B.1 × §B.2 (2×2 matrix) — full seller disclosure coverage.
- **F5** — §C branch flip (waive vs retain).
- **F6–F8** — every combination of §D.1 × §D.2 opt-outs (both on / D1 off / D2 off / both off).
- **F9** — date fall-through behavior (no `lead_paint_date` → today formatted via `formatDate`).
- **F10** — address rendering with partial data (no city/state/zip).

---

## Field × scenario matrix (250 checks — all PASS)

### Text fields (110 checks = 11 text fields × 10 scenarios)

| Field | F1 | F2 | F3 | F4 | F5 | F6 | F7 | F8 | F9 | F10 |
|---|---|---|---|---|---|---|---|---|---|---|
| `Street Address and City` | PASS `123 Main St, Boerne, TX 78006` | PASS `456 Oak Ave, San Antonio, TX 78201` | PASS `789 Elm Blvd, Austin, TX 78701` | PASS `1010 Maple Dr, Houston, TX 77002` | PASS `222 Pine St, Dallas, TX 75201` | PASS `333 Cedar Ln, Fort Worth, TX 76102` | PASS `444 Birch Way, El Paso, TX 79901` | PASS `555 Spruce Ct, Corpus Christi, TX 78401` | PASS `666 Willow Rd, Lubbock, TX 79401` | PASS `777 Sycamore Blvd` |
| `undefined` (B1a expl) | PASS `""` | PASS `Peeling paint noticed on window sills in 2019, mitigated with encapsulation` | PASS `""` | PASS `Known lead paint in basement mechanical room; contractor scraped 2021` | PASS `""` | PASS `""` | PASS `""` | PASS `""` | PASS `""` | PASS `""` |
| `b Seller has no actual knowledge…` (B1b overflow) | PASS `""` | PASS unchanged | PASS `""` | PASS unchanged | PASS `""` | PASS `""` | PASS `""` | PASS `""` | PASS `""` | PASS `""` |
| `undefined_2` (B2a list) | PASS `""` | PASS `""` | PASS `EPA lead risk assessment report dated 2018-03-14 by Lead Safe TX Inc.` | PASS `Lead inspection report 2020-11-02; abatement invoice 2021-04-18` | PASS `""` | PASS `""` | PASS `""` | PASS `""` | PASS `""` | PASS `""` |
| `b Seller has no reports…` (B2b overflow) | PASS `""` | PASS `""` | PASS unchanged | PASS unchanged | PASS `""` | PASS `""` | PASS `""` | PASS `""` | PASS `""` | PASS `""` |
| `Date` (Buyer 1) | PASS `07/01/2026` | PASS `07/15/2026` | PASS `08/01/2026` | PASS `09/05/2026` | PASS `07/01/2026` | PASS `07/01/2026` | PASS `07/01/2026` | PASS `07/01/2026` | PASS `<today>` | PASS `07/01/2026` |
| `Date_2` (Buyer 2) | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same |
| `Date_3` (Seller 1) | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same |
| `Date_4` (Seller 2) | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same |
| `Date_5` (Buyer's Broker) | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same |
| `Date_6` (Seller's Broker) | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same | PASS same |

### Checkboxes (80 checks = 8 checkboxes × 10 scenarios). `X` = checked, `.` = unchecked.

| Checkbox | F1 | F2 | F3 | F4 | F5 | F6 | F7 | F8 | F9 | F10 |
|---|---|---|---|---|---|---|---|---|---|---|
| `Check Box7` §B.1(a) | . | X | . | X | . | . | . | . | . | . |
| `Check Box8` §B.1(b) | X | . | X | . | X | X | X | X | X | X |
| `Check Box9` §B.2(a) | . | . | X | X | . | . | . | . | . | . |
| `Check Box10` §B.2(b) | X | X | . | . | X | X | X | X | X | X |
| `Check Box11` §C.1 waive | . | . | . | . | X | . | . | . | . | . |
| `Check Box12` §C.2 retain | X | X | X | X | . | X | X | X | X | X |
| `Check Box13` §D.1 | X | X | X | X | X | . | X | . | X | X |
| `Check Box14` §D.2 | X | X | X | X | X | X | . | . | X | X |

All 80 checkbox states match expectations. **PASS.**

### Signature widgets (60 checks = 6 signatures × 10 scenarios)

All 6 signature widgets (`Signature1` through `Signature6`) reported RESERVED (blank at fill stage) on every scenario — DocuSeal collects at execution per architecture. **PASS on all 60.**

---

## Visual verification (Hadley opened the rendered PDFs)

Rendered scenarios F1, F4, F8 through the flatten path and pdftoppm'd to PNG at 100 DPI. Hadley read each PNG:

**F1 (defaults):**
- Property "123 Main St, Boerne, TX 78006" appears under `CONCERNING THE PROPERTY AT`.
- §B.1(b) "Seller has no actual knowledge…" checkbox rendered checked (▪).
- §B.2(b) "Seller has no reports or records…" checkbox rendered checked (▪).
- §C.2 "Within ten days after the effective date…" checkbox rendered checked (▪).
- §D.1 and §D.2 both rendered checked (▪).
- All 6 date slots on the §F Certification block rendered `07/01/2026`.
- §B.1(a), §B.2(a), §C.1 rendered unchecked (empty box).

**F4 (worst-case seller disclosure):**
- Property "1010 Maple Dr, Houston, TX 77002" rendered correctly.
- §B.1(a) rendered checked with explanation text "Known lead paint in basement mechanical room; contractor scraped 2021" after "(explain):".
- §B.1(b) rendered unchecked.
- §B.2(a) rendered checked with document list "Lead inspection report 2020-11-02; abatement invoice 2021-04-18" after "(list documents):".
- §B.2(b) rendered unchecked.
- §C.2 rendered checked; §D.1, §D.2 rendered checked.
- Dates rendered `09/05/2026`.

**F8 (both D opt-outs):**
- Property "555 Spruce Ct, Corpus Christi, TX 78401" rendered correctly.
- §B defaults rendered as expected.
- §C.2 rendered checked.
- **§D.1 rendered unchecked (▫)** — opt-out verified.
- **§D.2 rendered unchecked (▫)** — opt-out verified.
- Dates rendered `07/01/2026`.

Font warnings from poppler about missing Helvetica-Narrow / Book-Antiqua substitutions are cosmetic (poppler's bundled font set); the AcroForm `/V` slot readout is the ground truth used for the 250-check assertion table.

Rendered artifacts saved at `.tmp/hadley-op-l-fullform/` (F1-1.png, F4-1.png, F8-1.png).

---

## Cosmetic / tech-debt observations (NOT FAIL items)

These do not change the FINAL VERDICT: PASS. Logged for future cleanup.

1. **Variable naming — §D checkboxes are Buyer, not Agent.** The fixture keys `agent_acknowledges_receipt` and `agent_acknowledges_pamphlet` in `fillLeadPaintAddendum` gate `Check Box13` and `Check Box14`, which sit in §D "BUYER'S ACKNOWLEDGMENT" — not §E "BROKERS' ACKNOWLEDGMENT" (which has no checkboxes on this form). Recommend rename to `buyer_received_info` / `buyer_received_pamphlet` in a future clean-up pass. Behavior is correct; only the fixture-key name is misleading.

2. **Legacy overflow text widgets.** Fields `b Seller has no actual knowledge…` (widget #2) and `b Seller has no reports or records…` (widget #4) are AcroForm text widgets that overlay the printed statement lines for §B.1(b) and §B.2(b). The fill code correctly writes `""` into them on the negative-disclosure path (preventing stale values from carrying over). On the positive-disclosure path (B1a / B2a) the code leaves them unchanged, which is fine — they render as empty because the base PDF `/V` is null on a fresh load. Behavior confirmed correct in F4.

3. **Signature-widget ordering.** Signature widget order (`Signature1` through `Signature6`) maps to the visual grid as: `Signature1` = Buyer row 1 (leftmost), `Signature2` = Buyer row 2, `Signature3` = Buyer's Broker, `Signature4` = Seller row 1, `Signature5` = Seller row 2, `Signature6` = Seller's Broker. DocuSeal template `4023469` uses semantic submitter names (`buyer_signature_1`, `seller_signature_1`, etc.) rather than the raw widget ordinals, so the ordinal-vs-semantic mapping never surfaces in customer flow. Noted for the OP-L knowledge file so future Hadley clones don't have to re-derive.

---

## Ground truth methodology

Two independent verification layers:

**Layer 1 — AcroForm `/V` slot readout via pdf-lib.**
The `fillLeadPaintAddendum` function was copied VERBATIM from `api/fill-form.js` into the audit harness. For each of the 10 scenarios, a fresh copy of the base PDF was loaded via pdf-lib, run through `fillLeadPaintAddendum`, and every AcroForm field's rendered value was read back via `getText()` (text fields) or `isChecked()` (checkboxes). The 250 assertions in the matrix above were evaluated against those readouts. This is the same `/V` slot that DocuSeal, Adobe Reader, and Chrome PDF viewer all consume to reproduce field state.

**Layer 2 — Flattened PDF visual inspection.**
Scenarios F1, F4, and F8 were rendered to a flattened PDF (via `form.flatten()`) so the checkbox states and text values are baked into the page's drawing operators. Each was converted to PNG via pdftoppm and opened by Hadley for visual confirmation. Every claim in the "Visual verification" section above is what Hadley observed on the rendered page, not a code-based inference.

---

## Files touched by this audit

| File | Purpose | Kept? |
|---|---|---|
| `.tmp/hadley-op-l-fullform/audit.js` | 250-check audit harness | keep for re-run |
| `.tmp/hadley-op-l-fullform/render-visual.js` | Renders F1/F4/F8 to PDF for visual QA | keep |
| `.tmp/hadley-op-l-fullform/result.json` | Machine-readable pass/fail table | keep |
| `.tmp/hadley-op-l-fullform/F1.pdf` + `F1-1.png` | Rendered defaults scenario | keep |
| `.tmp/hadley-op-l-fullform/F4.pdf` + `F4-1.png` | Rendered worst-case scenario | keep |
| `.tmp/hadley-op-l-fullform/F8.pdf` + `F8-1.png` | Rendered both-D-off scenario | keep |
| `docs/hadley-pass-report-trec-op-l-2026-07-01-fullform.md` | THIS report | keep — source of truth |
| `Shepard-Ventures/Legal/TREC-Forms-Knowledge/op-l.md` | Persistent OP-L knowledge file (Hadley memory) | created by this audit |

**No production files were modified by this audit.** Read-only against `api/fill-form.js`, `api/_assets/trec-lead-paint-base64.js`, `scripts/trec-field-maps/lead-paint-map.js`, and the raw base PDF.

---

## Signed

**FINAL VERDICT: PASS — 0 FAIL items across full form × full scenario matrix**

Hadley_13
2026-07-01
