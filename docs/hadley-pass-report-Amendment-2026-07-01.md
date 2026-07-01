# Hadley_4 APV Report — TREC Amendment (39-11 / DocuSeal template 4111320)

**Report date:** 2026-07-01
**Reviewer:** Hadley_4 (parallel clone)
**Form audited:** TREC 39-11 (revision 05-04-2026) — the current promulgated Amendment
**PDF source:** production base64 asset `api/_assets/trec-amendment-39-11-base64.js` (used by `api/draft-amendment.js`)
**Local fills produced:** `.tmp/hadley4-amendment/PROD-closing_date.pdf`, `PROD-option_extension.pdf`, `PROD-price_change.pdf` (via mirrored production fill logic — no pipeline files touched)
**Rendered pages:** `.tmp/hadley4-amendment/PROD-*-p01.png` @ 200dpi + zoom crops
**Merge-gate rule applied:** `feedback_hadley_apv_is_fillform_merge_gate.md` (locked 2026-06-28)

---

## FINAL VERDICT: **FAIL — DO NOT MERGE**

**Totals across the three amendment scenarios production supports (closing_date, option_extension, price_change) plus the shared property-header assertion:**

- Total fields asserted across scenarios: **15**
- **PASS: 10**
- **FAIL: 5**
- **SKIP (defensibly blank per scenario intent): all remaining Amendment fields not exercised — repair_items scenario not test-fired here; broker/attorney/signature blocks correctly left to DocuSeal**

**Confidence:** HIGH. All three scenarios were rendered from the production base64 asset using the production `FIELDS` map + production checkbox/text-set helpers. Only the storage/DB write path was skipped.

The `option_extension` scenario is catastrophically misfiring: the stale AcroForm field names embedded in the 39-11 PDF point to paragraph (6) "cost of lender required repairs" rather than paragraph (7) "additional Option Fee". Every value in that scenario lands in the wrong paragraph.

The `closing_date` and `price_change` scenarios pass cleanly.

---

## Scenario 1 — closing_date

**Test inputs:** property "1847 Vintage Way, Boerne, TX 78006"; new closing date "August 5, 2026"; no notes.
**Rendered PDF:** `.tmp/hadley4-amendment/PROD-closing_date-p01.png`

| # | Field | Expected | Actual (observed on rendered page) | Verdict |
|---|---|---|---|---|
| 1 | Property header "Street Address and City" | "1847 Vintage Way, Boerne, TX 78006" | "1847 Vintage Way, Boerne, TX 78006" | PASS |
| 2 | ¶(3) "The date in Paragraph 9..." checkbox | CHECKED | CHECKED (bold filled square) | PASS |
| 3 | ¶(3) closing date — Month + Day slot | "August 5" | "August 5" | PASS |
| 4 | ¶(3) closing date — 2-digit year (following pre-printed "20") | "26" | "26" (renders as "August 5, 20 26") | PASS |
| 5 | EXECUTED footer "DATE OF FINAL ACCEPTANCE" | BLANK (broker fills at signing per production comment) | blank | PASS |

**Verdict for closing_date scenario: 5/5 PASS. Production `formatLongDateNoYear` + `formatTwoDigitYear` fix from `draft-amendment.js` lines 227-235 works correctly against the 39-11 asset.**

---

## Scenario 2 — option_extension

**Test inputs:** property "1847 Vintage Way, Boerne, TX 78006"; extension days = 7; no notes.
**Rendered PDF:** `.tmp/hadley4-amendment/PROD-option_extension-p01.png`

| # | Field | Expected | Actual (observed on rendered page) | Verdict |
|---|---|---|---|---|
| 6 | Property header | "1847 Vintage Way, Boerne, TX 78006" | "1847 Vintage Way, Boerne, TX 78006" | PASS |
| 7 | ¶(7) "Buyer has paid Seller an additional Option Fee" checkbox | CHECKED | unchecked | **FAIL** |
| 8 | ¶(6) "cost of lender required repairs" checkbox | UNCHECKED (this test does not touch lender repairs) | CHECKED (stale AcroForm name `'6 Buyer has paid Seller an additional Option Fee of'` mapped here) | **FAIL — wrong paragraph checked** |
| 9 | ¶(7) extension-days text | "7 days" written next to "for an extension of the" | ¶(7) slot is blank | **FAIL** |
| 10 | ¶(6) "$______ by Buyer" slot | BLANK (nothing about lender repairs in this scenario) | "7 days" (stale AcroForm name `'for an extension of the'` renders in the ¶(6) "by Buyer" slot on 39-11) | **FAIL — value in wrong paragraph slot** |
| 11 | EXECUTED footer | BLANK | blank | PASS |

**Verdict for option_extension scenario: 2/6 PASS. 4 FAIL cluster around a single defect (stale AcroForm field names shifted from ¶(6) → ¶(7) between 39-10 and 39-11).**

**Root-cause diagnosis:** The 39-11 revision (05-04-2026) renumbered paragraphs — what used to be `6 Buyer has paid Seller an additional Option Fee of` is now visually paragraph `(7)`. The AcroForm dictionary in `trec-amendment-39-11-base64.js` retained the OLD field NAMES (still starting with "6 Buyer has paid…") but their VISUAL POSITIONS on the flattened page moved down one paragraph in the pre-printed layout. When production code does `form.getCheckBox('6 Buyer has paid Seller an additional Option Fee of').check()`, the checkbox found by that name is now positioned adjacent to visual paragraph (6) "cost of lender required repairs." Same drift affects the `for an extension of the`, `as follows`, `contract`, `Fee`, `Fee 2` field names.

---

## Scenario 3 — price_change

**Test inputs:** property "1847 Vintage Way, Boerne, TX 78006"; new sales price total = $325,000.
**Rendered PDF:** `.tmp/hadley4-amendment/PROD-price_change-p01.png`

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 12 | Property header | "1847 Vintage Way, Boerne, TX 78006" | "1847 Vintage Way, Boerne, TX 78006" | PASS |
| 13 | ¶(1) "The Sales Price in Paragraph 3 of the contract is" checkbox | CHECKED | CHECKED | PASS |
| 14 | ¶(1)(C) "C. Sales Price (Sum of A and B)" total | "$325,000" | "$325,000" | PASS |
| 15 | ¶(1)(A) Cash portion / (B) Financing portion | BLANK (production intentionally leaves these to the agent per code comment lines 246-249) | blank | PASS |
| — | EXECUTED footer | BLANK | blank | PASS |

**Verdict for price_change scenario: 3/3 asserted fields PASS. Production intentionally leaves the A/B cash/financing split blank — reasonable per the code comment and defensible for the agent to complete at signing.**

---

## Failure clusters

Only ONE defect cluster, but it kills the option_extension scenario outright.

### DEFECT 1 — Stale AcroForm field names in `trec-amendment-39-11-base64.js` misalign with the 39-11 visual paragraph layout

**Severity:** Critical for the `option_extension` code path. `closing_date` and `price_change` happen to align because their AcroForm names (`'1 The Sales Price…'`, `'3 The date in Paragraph 9…'`) still correspond to visual paragraphs (1) and (3) on the new form. But between visual (3) and (10), the paragraph numbering shifted — 39-10 had 9 paragraphs, 39-11 has 10 paragraphs (a new lender-repairs paragraph inserted). Every FIELDS constant naming visual paragraph 6+ is now off-by-one:

- `optionFeeCheckbox: '6 Buyer has paid Seller an additional Option Fee of'` → NOW checks visual ¶(6) lender repairs (wrong)
- `optionFeeAmount: 'as follows'` → likely renders in ¶(6) "by Seller" slot (wrong)
- `optionFeeExtensionDays: 'for an extension of the'` → renders in ¶(6) "by Buyer" slot (wrong)
- `optionFeeNewEndDate: 'contract'` → probably lands somewhere else in the ¶(6)/¶(7) transition (wrong)
- `optionFeeCreditYes: 'Fee'`, `optionFeeCreditNo: 'Fee 2'` → possibly mapped to lender-repair-related checkboxes now, unverified

**Fix required (out of scope for this audit — pipeline files frozen):**
Re-run `scripts/probe-39-10-positions.js` (rename to `probe-39-11-positions.js` and point at `trec-amendment-39-11-base64.js`) to dump every AcroForm field name plus its (x, y) coordinates, then re-verify each of the `FIELDS` constants against a rendered 39-11 page. The AcroForm field name-to-visual-paragraph map must be rebuilt for the 39-11 revision. Once the map is corrected, all 4 FAIL items in Scenario 2 should resolve.

### Adjacent risk — `repair_items` code path not exercised

The production `draft-amendment.js` supports a 4th scenario, `repair_items`, which writes to `Text 8` / `Text 9` / `Text 10` and checks `9 Other Modifications Insert only factual statements and business details applicable to this sale`. Given the paragraph drift, that checkbox now maps to visual ¶(9) "date for Buyer to give written notice…Third Party Financing Addendum is changed to" (a completely unrelated lender-approval-deadline paragraph). This was CONFIRMED by inspection of the SMOKE-option_extension.pdf render where notes triggered exactly this defect. `repair_items` will fail the same way if any customer fires it.

**Recommendation to engineering:** freeze the `repair_items` code path until the field-name map is rebuilt.

---

## Fields correctly filled (10 PASS)

1. Property header on all 3 scenarios (3× "1847 Vintage Way, Boerne, TX 78006")
2. ¶(3) closing date checkbox
3. ¶(3) Month+Day text ("August 5")
4. ¶(3) 2-digit year suffix ("26" — production fix works)
5. ¶(1) sales price checkbox
6. ¶(1)(C) total sales price ("$325,000")
7. ¶(1)(A/B) intentionally blank (defensible)
8. EXECUTED footer intentionally blank on all 3 scenarios (production fix works)

---

## Hadley acceptance decision

**Verdict: FAIL. Merge gate remains CLOSED on TREC Amendment (39-11 / DocuSeal template 4111320).**

Per `feedback_hadley_apv_is_fillform_merge_gate.md`, I cannot sign PASS while any option-extension customer would receive a legally garbled Amendment. The failure is not an edge case — it is 100% reproducible against production code and the current base64 asset.

If a customer fires "extend the option period by 7 days," they will receive a PDF that:
- Fails to check the option-fee amendment paragraph
- Places "7 days" as the seller's lender-repair contribution
- Checks the lender-repair amendment paragraph (which the customer never selected)

This would misrepresent the amendment to opposing counsel, title, and the buyer's own record.

**Next action:** Route the AcroForm-field-name-to-visual-paragraph re-mapping to the fill-pipeline engineers. Once the map is rebuilt against the 39-11 asset, re-fire all 4 scenarios (closing_date, option_extension, price_change, repair_items) and I re-audit.

---

**Report saved to:** `C:\Users\Heath Shepard\Desktop\MeetDossie\docs\hadley-pass-report-Amendment-2026-07-01.md`
**Rendered pages available at:** `C:\Users\Heath Shepard\Desktop\MeetDossie\.tmp\hadley4-amendment\PROD-*.png`
**Signed:** Hadley_4, parallel clone, Shepard Ventures — 2026-07-01
