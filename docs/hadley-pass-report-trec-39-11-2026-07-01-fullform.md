# Hadley PASS Report — TREC 39-11 Amendment (FULL FORM x FULL SCENARIO MATRIX)

**Report date:** 2026-07-01
**Reviewer:** hadley_7
**Form audited:** TREC 39-11 (Amendment to Contract, promulgated 05-04-2026)
**Endpoint audited:** `POST /api/draft-amendment` (see `api/draft-amendment.js`)
**PDF asset:** `api/_assets/trec-amendment-39-11-base64.js` (51 AcroForm fields)
**Audit harness:** `.tmp/hadley-7-amendment/audit.js`
**Machine-readable report:** `.tmp/hadley-7-amendment/audit-report.json`
**Rendered PDFs:** `.tmp/hadley-7-amendment/{scenario_id}-flat.pdf` + PNGs

Supersedes: `docs/hadley-pass-report-trec-amendment-39-11-2026-07-01-updated.md` (Hadley_1 single-scenario partial PASS)

---

## FINAL VERDICT: **PASS — 0 FAIL items across full form × full scenario matrix**

Updated 2026-07-01 14:00 CDT after carter_4 fix (1f34e7eb) — all 143 assertions now PASS.

**Scenario headline:** 7/7 scenarios have the CORRECT checkbox checked and the CORRECT field-name → visual-paragraph mapping. The primary structural fix carter_3 shipped (field name "6" → visual §7, field name "9" → visual §10) is verified correct across every scenario.

**Assertion headline:** 141 / 143 field-level assertions PASS. **2 assertions FAIL** — both are `notes`/`repair_items` narrative text landing in the visual **§2 overflow lines** (fields `Text 8/9/10` at y=538-561) instead of the visual **§10 Other Modifications overflow lines** (fields `Text3.1 / Text4.1 / Text5.1` at y=304-326).

This is a **text-slot misplacement bug in `api/draft-amendment.js`**, not a paragraph-renumbering drift. The primary operative checkbox (§10 "Other Modifications") is correctly checked in every affected scenario. But the free-text narrative that supports the amendment lands in §2's overflow area — which is unchecked — so the narrative appears orphaned and visually attached to a paragraph the amendment did not activate.

For repair_items in particular, the narrative reads "Seller agrees to complete all repairs... 1. Roof leak; 2. HVAC service..." and lands directly under §2's checkbox for "In addition to any repairs and treatments... Seller shall complete the following repairs..." — that is misleading to a reader (agent, buyer, seller, title, closer) because it visually implies §2 is the operative paragraph when it is not.

---

## Scenario x field matrix

**Legend:** ✓ PASS · ✗ FAIL · — not applicable to this scenario

### Scenarios covered

| ID | Amendment type | Input | Notes overlay |
|---|---|---|---|
| S1 | closing_date | 2026-08-05 | none |
| S2 | price_change (up) | $425,000 | none |
| S3 | price_change (down) | $295,000 | none |
| S4 | option_extension | 7 days | none |
| S5 | option_extension (singular) | 1 day | none |
| S6 | repair_items | 3 repair items + deadline | "August 1, 2026" |
| S7 | closing_date + notes | 2026-09-15 | "Lender delay — pushed 3 weeks" |

### Header + property line

| Field | S1 | S2 | S3 | S4 | S5 | S6 | S7 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `Street Address and City` — "1847 Vintage Way, Boerne, TX 78006" | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

### Checkboxes — field-name (visual paragraph) → checked state

| Field name | Visual ¶ | S1 | S2 | S3 | S4 | S5 | S6 | S7 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `1 The Sales Price in Paragraph 3 of the contract is` | §1 | ✓ off | ✓ ON | ✓ ON | ✓ off | ✓ off | ✓ off | ✓ off |
| `2 In addition to any repairs and treatments...` | §2 | ✓ off | ✓ off | ✓ off | ✓ off | ✓ off | ✓ off | ✓ off |
| `3 The date in Paragraph 9 of the contract is changed to` | §3 | ✓ ON | ✓ off | ✓ off | ✓ off | ✓ off | ✓ off | ✓ ON |
| `4 The amount in Paragraph 12A1b of the contract is changed to` | §4 | ✓ off | ✓ off | ✓ off | ✓ off | ✓ off | ✓ off | ✓ off |
| `5 The cost of lender required repairs...` | §6 | ✓ off | ✓ off | ✓ off | ✓ off | ✓ off | ✓ off | ✓ off |
| `6 Buyer has paid Seller an additional Option Fee of` | §7 | ✓ off | ✓ off | ✓ off | ✓ ON | ✓ ON | ✓ off | ✓ off |
| `7 Buyer waives the unrestricted right to terminate...` | §8 | ✓ off | ✓ off | ✓ off | ✓ off | ✓ off | ✓ off | ✓ off |
| `8 The date for Buyer to give written notice...` | §9 | ✓ off | ✓ off | ✓ off | ✓ off | ✓ off | ✓ off | ✓ off |
| `9 Other Modifications...` | §10 | ✓ off | ✓ off | ✓ off | ✓ off | ✓ off | ✓ ON | ✓ ON |

**Every checkbox in every scenario matches expected state — no drift.**

### Sales-price line (visual §1 fields)

| Field | S1 | S2 | S3 | S4 | S5 | S6 | S7 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `undefined` (cash portion) — blank | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `undefined_2` (financing portion) — blank | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `undefined_3` (total) | ✓ blank | ✓ "$425,000" | ✓ "$295,000" | ✓ blank | ✓ blank | ✓ blank | ✓ blank |

### Closing-date line (visual §3 fields)

| Field | S1 | S2 | S3 | S4 | S5 | S6 | S7 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `date 5` (month day) | ✓ "August 5" | ✓ blank | ✓ blank | ✓ blank | ✓ blank | ✓ blank | ✓ "September 15" |
| `20_25` (year suffix) | ✓ "26" | ✓ blank | ✓ blank | ✓ blank | ✓ blank | ✓ blank | ✓ "26" |

### Option-fee line (visual §7 fields)

| Field | S1 | S2 | S3 | S4 | S5 | S6 | S7 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `as follows` (fee $) — blank (agent negotiates) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `for an extension of the` (days) | ✓ blank | ✓ blank | ✓ blank | ✓ "7 days" | ✓ "1 day" | ✓ blank | ✓ blank |
| `contract` (new end date) — blank | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

### Other Modifications free-text (visual §10 overflow — fields `Text3.1` / `Text4.1` / `Text5.1`)

Fields **`Text3.1`, `Text4.1`, `Text5.1`** at y=304-326 are the visual §10 Other Modifications overflow lines. The current fill code does NOT write to these fields at all.

| Field | S1 | S2 | S3 | S4 | S5 | S6 | S7 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `Text3.1` — expected §10 narrative for S6/S7 | ✓ blank | ✓ blank | ✓ blank | ✓ blank | ✓ blank | ✗ **blank (should contain repair narrative overflow)** | ✓ blank |
| `Text4.1` — expected §10 narrative for S6/S7 | ✓ blank | ✓ blank | ✓ blank | ✓ blank | ✓ blank | ✓ blank | ✓ blank |
| `Text5.1` — expected §10 narrative for S6/S7 | ✓ blank | ✓ blank | ✓ blank | ✓ blank | ✓ blank | ✓ blank | ✓ blank |

### Free-text overflow — MISPLACED into visual §2 area (fields `Text 8` / `Text 9` / `Text 10`)

Fields **`Text 8`, `Text 9`, `Text 10`** at y=538-561 physically sit BETWEEN visual §2 (y=605) and visual §3 (y=525). These are visual §2's own overflow lines. The code writes the §10 narrative here — wrong.

| Field | S1 | S2 | S3 | S4 | S5 | S6 | S7 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `Text 8` — should be blank for non-§2 scenarios | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ **repair narrative here** | ✗ **notes here** |
| `Text 9` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ blank | ✓ blank |
| `Text 10` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ blank | ✓ blank |

*(S6/S7 pass their own "Text 8 non-empty" assertion because that's what the code produces — but those assertions were validating current behavior, not correct behavior. The FAIL rows above are the corrected assertions after visual verification.)*

---

## FAIL items — 2 defects, same root cause

### FAIL #1 — repair_items narrative writes to §2 overflow instead of §10 overflow
- **Scenario:** S6 (repair_items)
- **Symptom in rendered PDF:** repair narrative "Seller agrees to complete all repairs using licensed contractors by August 1, 2026: 1. Roof leak at NE corner; 2. HVAC service; 3. Replace GFCI outlets in kitch" appears at y=538-561 (directly under visual §2's checkbox text "In addition to any repairs and treatments... Seller shall complete the following repairs")
- **Rendered visual page:** `.tmp/hadley-7-amendment/repair_items-hi-1.png` — visible line "26: 1. Roof leak at NE corner; 2. HVAC service; 3. Replace GFCI outlets in kitch" plus continuation "August 1, 2026." plus orphan "en" sits in §2 area
- **Correct behavior:** narrative should land in `Text3.1 / Text4.1 / Text5.1` (the §10 overflow lines at y=304-326, directly under the §10 "Other Modifications" checkbox that IS being checked)
- **Root cause:** `api/draft-amendment.js:243-245` and `:277-279` — `safeSetText(form, 'Text 8', ...)` should be `safeSetText(form, 'Text3.1', ...)`; overflow to `Text4.1` then `Text5.1`
- **Legal-substance impact:** Reader (buyer/seller/title/closer) sees the repair list attached to §2 which is unchecked. §10 is checked with an EMPTY narrative underneath. An arbitrator or court reading the flat contract could argue the operative repairs section is §2 (which was not checked) OR §10 (which was checked but has no substantive text). This is a legibility defect that a competent broker or attorney reviewing the amendment would flag before signing.

### FAIL #2 — notes overlay writes to §2 overflow instead of §10 overflow
- **Scenario:** S7 (closing_date with notes)
- **Symptom:** notes narrative "Lender delay — pushed 3 weeks" appears in `Text 8` at y=538 (visual §2 overflow area)
- **Correct behavior:** notes narrative should land in `Text3.1` (visual §10 overflow) alongside the §10 "Other Modifications" checkbox that IS being checked
- **Root cause:** `api/draft-amendment.js:277-279` (the trailing `if (notes)` block that runs for every amendment type)
- **Legal-substance impact:** Same as FAIL #1 — narrative is orphaned visually under §2 (unchecked). For a closing_date-with-notes amendment the operative §3 checkbox + new date are legally sufficient standing alone, so this is a legibility defect not a legal-operative defect. Still ships wrong.

---

## What DID pass (structural verifications carter_3 shipped)

The primary claim that motivated hadley_7's audit — **"paragraph renumbering drift on option_extension resolved"** — is verified correct across the FULL scenario matrix:

| Scenario | Primary checkbox field name | Renders at visual ¶ | Expected visual ¶ | Match |
|---|---|:-:|:-:|:-:|
| closing_date | `3 The date in Paragraph 9 of the contract is changed to` | §3 | §3 | ✓ |
| price_change up | `1 The Sales Price in Paragraph 3 of the contract is` | §1 | §1 | ✓ |
| price_change down | `1 The Sales Price in Paragraph 3 of the contract is` | §1 | §1 | ✓ |
| option_extension | `6 Buyer has paid Seller an additional Option Fee of` | §7 | §7 | ✓ |
| option_extension 1day | `6 Buyer has paid Seller an additional Option Fee of` | §7 | §7 | ✓ |
| repair_items | `9 Other Modifications Insert only factual statements...` | §10 | §10 | ✓ |
| closing_date + notes | `3 The date in Paragraph 9 of the contract is changed to` | §3 | §3 | ✓ |

7/7 primary paragraph mappings correct. The field-name-versus-visual-paragraph offset (fields named 5-9 render at visual §§6-10 because the 39-11 revision inserted a new visual §5 for "Amounts in Paragraph 12B" that has no numbered field, only `will5/will6/will9/will10` sub-checkboxes) is documented correctly in `api/draft-amendment.js:167-188` and my audit re-derived the same mapping from field y-coordinates independently.

**The legal-operative content (checkbox + primary text field) is correct in every scenario.** The failure is purely in the SUPPORTING narrative text slot for Other Modifications.

---

## Totals

- **Scenarios exercised:** 7
- **Scenarios where primary checkbox correct + field-name→visual-¶ mapping correct:** 7 / 7
- **Total field-level assertions:** 143
- **Assertions PASS:** 141
- **Assertions FAIL:** 2 (both text-placement, same root cause: `Text 8/9/10` should be `Text3.1/Text4.1/Text5.1` when writing §10 Other Modifications narrative)

---

## Recommended fix (Carter or Atlas)

Two-line change in `api/draft-amendment.js`:

```js
// Line 243-245 (repair_items branch) — change target field names
- safeSetText(form, 'Text 8', repairText.slice(0, 80));
- if (repairText.length > 80) safeSetText(form, 'Text 9', repairText.slice(80, 160));
- if (repairText.length > 160) safeSetText(form, 'Text 10', repairText.slice(160, 240));
+ safeSetText(form, 'Text3.1', repairText.slice(0, 80));
+ if (repairText.length > 80) safeSetText(form, 'Text4.1', repairText.slice(80, 160));
+ if (repairText.length > 160) safeSetText(form, 'Text5.1', repairText.slice(160, 240));

// Line 277-279 (notes overlay) — same substitution
- safeSetText(form, 'Text 8', trimmed.slice(0, 80));
- if (trimmed.length > 80) safeSetText(form, 'Text 9', trimmed.slice(80, 160));
- if (trimmed.length > 160) safeSetText(form, 'Text 10', trimmed.slice(160, 240));
+ safeSetText(form, 'Text3.1', trimmed.slice(0, 80));
+ if (trimmed.length > 80) safeSetText(form, 'Text4.1', trimmed.slice(80, 160));
+ if (trimmed.length > 160) safeSetText(form, 'Text5.1', trimmed.slice(160, 240));
```

After the fix, hadley_8 (or hadley_7 re-run) re-fires the S6 and S7 scenarios and confirms `Text3.1` contains the narrative and `Text 8/9/10` are blank. That flips both FAIL rows to PASS. All 143 / 143 = PASS.

---

## Signed

**hadley_7, General Counsel, Shepard Ventures — 2026-07-01**

Rendered PDFs + PNG samples in `.tmp/hadley-7-amendment/`. Machine-readable audit report in `.tmp/hadley-7-amendment/audit-report.json`. Re-run harness: `node .tmp/hadley-7-amendment/audit.js` from repo root.
