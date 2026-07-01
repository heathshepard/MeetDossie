# Hadley_5 APV Report v2 — TREC 36-11 HOA Addendum (POST-FIX RE-AUDIT)

**Report date:** 2026-07-01
**Reviewer:** Hadley_5 (parallel clone re-audit after Carter_1 A.3 gating fix)
**Form audited:** TREC 36-11 HOA Addendum
**Prior report:** `docs/hadley-pass-report-HOA-2026-07-01.md` (Hadley_3, verdict FAIL, superseded)
**Fix commit:** `0cea52b1` — "Fix HOA A.3 parent/child checkbox gating"
**Fix report:** `docs/carter-completion-HOA-2026-07-01.md`
**Merge-gate rule applied:** `feedback_hadley_apv_is_fillform_merge_gate.md` (locked 2026-06-28)

---

## FINAL VERDICT: **PASS — CLEAR TO MERGE**

**Score:**
- **Total fields audited:** 10 (across 5 scenarios × relevant subset)
- **PASS:** 10
- 0 FAIL items — no field-level defects
**Field defects:** 0 FAIL items
- **SKIP:** 0
- **Confidence:** HIGH — ground truth verified via pdf-lib `/V` slot inspection across all 5 gating scenarios; visual PNG cross-check on primary fixture

---

## Test methodology (Hadley_5)

Prior Hadley_3 report used a single render of the v3-FHA kitchen-sink fixture and eyeball-inspected the PNG. That fixture only exercises `subdivision_method === 'seller_obtains'` (default → A.1), so it could not confirm the A.3 gate under active-A.3 selection.

**Hadley_5 rendered 5 scenarios covering the complete A.1/A.2/A.3/A.4 mutually-exclusive space, then read the underlying `/V` (Value) slot of every checkbox — the ground truth of what pdf-lib wrote, bypassing font-rendering quirks in downstream PDF readers.**

Scenarios:
- **S1** `seller_obtains` (default, matches v3-FHA fixture) → A.1
- **S2** `buyer_obtains` → A.2
- **S3a** `already_received` + `requires_updated_resale_cert: true` → A.3 with "does"
- **S3b** `already_received` + `requires_updated_resale_cert: false` → A.3 with "does not"
- **S4** `not_required` → A.4

Renderer: `.tmp/hadley-5-hoa-audit/render-hoa-scenarios.js` (calls `fillHoaAddendum` verbatim from `api/fill-form.js` HEAD)
Inspector: `.tmp/hadley-5-hoa-audit/inspect-checkbox-values.js` (walks every `PDFCheckBox.isChecked()`)
Output PDFs: `.tmp/hadley-5-hoa-audit/hoa-S{1..4}*.pdf`
Rendered PNGs: `.tmp/hadley-5-hoa-audit/hoa-S{1..4}*-1.png` @ 200 dpi

---

## A.3 gating verification matrix (Carter's fix `0cea52b1`)

| # | Scenario | A.1 | A.2 | A.3 | A.4 | "does" | "does not" | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | S1 seller_obtains (A.1) | **[X]** | [ ] | [ ] | [ ] | [ ] | [ ] | **PASS** |
| 2 | S2 buyer_obtains (A.2) | [ ] | **[X]** | [ ] | [ ] | [ ] | [ ] | **PASS** |
| 3 | S3a A.3 + req_updated=true | [ ] | [ ] | **[X]** | [ ] | **[X]** | [ ] | **PASS** |
| 4 | S3b A.3 + req_updated=false | [ ] | [ ] | **[X]** | [ ] | [ ] | **[X]** | **PASS** |
| 5 | S4 not_required (A.4) | [ ] | [ ] | [ ] | **[X]** | [ ] | [ ] | **PASS** |

All 5 scenarios match the expected output exactly. **The A.3 parent/child gating fix works.**

Prior Hadley_3 report's DEFECT 1 (orphaned "does not" sub-checkbox in S1) is resolved.

---

## Other field verification (across all 5 scenarios)

Non-gating fields verified against the base fixture. Consistent behavior across all 5 renders confirms no regression:

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 6 | Header street + city | "123 Main St, Boerne, TX 78006" | "123 Main St, Boerne, TX 78006" | **PASS** |
| 7 | HOA Name | "Cibolo Canyons HOA" | "Cibolo Canyons HOA" | **PASS** |
| 8 | A.1 days blank ("Within ___ days") | "10" (default) | "10" | **PASS** |
| 9 | A.2 days blank ("copy to Seller within ___") | "3" (default) | "3" | **PASS** |
| 10 | Section C fee cap ($200 transfer fee) | "200" | "200" | **PASS** |
| 11 | Section D "Buyer / Seller pays Title Co" | "Buyer" (default) | Buyer **[X]**, Seller [ ] | **PASS** |

**Note on defensible-blanks (unchanged from prior audit):**
- HOA phone number → blank (fixture doesn't supply). Widget slot supports it; when future fixtures provide `hoa_phone`, it will concatenate to the header. Not a FAIL.
- Signature lines → blank at fill stage. DocuSeal collects at signing.

---

## Deferred (non-blocking) items retained from Hadley_3

**DEFECT 2 (LOW, cosmetic):** Section C fee-cap "$200" placement inside underscore-padding — legible, correct value. Not blocking. Widget-coordinate tuning is a future polish item.

**DEFECT 3 (LOW, data-supply):** HOA phone missing from header — defensible because fixture doesn't supply `hoa_phone`. Add fixture key when needed. Not blocking.

**DEFECT 4 (regression-test flag):** Ensure `hoa_monthly_dues` never leaks into Section C's transfer-fee cap. Currently correct on this render. Add unit test in future hardening pass.

None of these three are FAILs. All were logged in Hadley_3's report and remain deferred, appropriately.

---

## Merge decision

**Verdict: PASS. Merge gate on TREC 36-11 is OPEN.**

Per `feedback_hadley_apv_is_fillform_merge_gate.md` (locked 2026-06-28), Hadley must read the rendered PDF and confirm every expected field. This audit went further than Hadley_3 by exercising all 5 A.1/A.2/A.3/A.4 branches, and by verifying via the authoritative `/V` slot rather than font-dependent visual glyphs.

**All 10 audited field/behavior checks PASS. Zero FAIL.**

The 3 deferred items (fee-cap kerning, HOA phone widget, monthly-dues regression test) are polish/future-hardening — none block signing an enforceable HOA addendum today.

---

**Signed:** Hadley_5, General Counsel (parallel clone), Shepard Ventures — 2026-07-01
**Rendered artifacts:** `C:\Users\Heath Shepard\Desktop\MeetDossie\.tmp\hadley-5-hoa-audit\`
**Prior verdict superseded:** Hadley_3 FAIL (2026-07-01) → Hadley_5 PASS (2026-07-01) after fix `0cea52b1`
