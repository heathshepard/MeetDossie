# Hadley PASS Report — TREC 40-11 Third Party Financing Addendum

**Date:** 2026-07-01
**Auditor:** Hadley_2 (parallel clone; TREC 40-11 lane only)
**Source of truth:** `.tmp/hadley-audit-2026-07-01/financing-addendum-1.png` + `financing-addendum-2.png`
**Pipeline artifacts:** `.tmp/v3-fha-verify/extract-financing-addendum.json` + `financing-addendum.pdf`
**Scenario:** FHA insured financing, $500K sale, $482,500 loan (3.5% down), 30-yr term, 10-day option, Boerne TX 78006

---

## Verdict: FAIL

**Confidence: 9/10**

Six correctness defects observed on the rendered PDF. Every defect is visible on the pages listed above. This addendum in its current fill state would (a) mis-classify the deal type to title and lender by showing both Conventional-First AND FHA boxes checked, (b) void the financing contingency by leaving rate cap blank + writing no cap number at all, (c) waive Buyer Approval on a financed deal — actively harmful to the customer.

Per `feedback_hadley_apv_is_fillform_merge_gate.md`, this report BLOCKS merge of any 40-11-touching change to main.

---

## Score

| Bucket | Count | Notes |
|---|---|---|
| Total logical fields expected on 40-11 | **38** | Per Hadley knowledge file table (excludes 4 signature placeholders that populate at e-sig) |
| Signature placeholders (defensibly blank at fill time) | 4 | Buyer×2, Seller×2 |
| PASS | 27 | See list below |
| FAIL | 6 | See defect list |
| SKIP (defensibly blank for FHA scenario) | 5 | Fields that belong to non-selected financing blocks |

---

## FAIL — 6 defects (each with expected vs actual)

### DEFECT 1 — ¶1.A(1) First mortgage sub-checkbox WRONGLY CHECKED
- **Widget:** W1.2 `financing_conventional_first`
- **Expected:** UNCHECKED (deal is FHA, not Conventional)
- **Actual on rendered PDF page 1:** X mark visible next to "(1) A first mortgage loan…"
- **Impact:** Title company / lender will see two mutually-exclusive financing types checked (Conventional-First AND FHA). Kick-back at underwriting. Violates ¶1 mutual-exclusion rule.
- **Root cause suspected:** Fill engine wrote conventional-first checkbox in addition to FHA — likely stale default or mis-mapped key.

### DEFECT 2 — ¶1.C FHA Section blank EMPTY
- **Widget:** W1.18 `financing_fha_section`
- **Expected:** `203(b)` (Hadley locked default per knowledge file)
- **Actual on rendered PDF page 1:** Blank underline between "Section" and "FHA insured loan"
- **Impact:** Empty FHA Section = title file rejection at closing. Common practitioner mistake #4 in Hadley knowledge file.

### DEFECT 3 — ¶1.C FHA term-years blank EMPTY
- **Widget:** W1.20 `financing_fha_term_years`
- **Expected:** `30` (merged fields JSON has `loan_term_years: 30`; Hadley default is 30)
- **Actual on rendered PDF page 1:** Blank underline between "amortizable monthly for not less than" and "years"
- **Impact:** Empty term = "loan described above" is undefined = financing contingency void.

### DEFECT 4 — ¶1.C FHA rate cap, rate cap period, origination cap ALL BLANK
- **Widgets:** W1.21 `financing_fha_rate_cap_pct`, W1.22 `financing_fha_rate_cap_period_years`, W1.23 `financing_fha_origination_cap_pct`
- **Expected:** rate cap = specific % (e.g., market + 1.0), period = 30, origination = 1.00
- **Actual on rendered PDF page 1:** All three underlines blank
- **Impact:** Per Republic Title 2025 commentary + Hadley knowledge file top-3 gotchas: **leaving the interest-rate cap blank VOIDS the loan contingency.** Buyer forced to accept any rate lender offers. This is the single most-cited 40-11 practitioner failure.
- Grouped as one defect line but represents 3 blank widgets.

### DEFECT 5 — ¶2.A Buyer Approval box CHECKED THE WRONG WAY
- **Widget:** W2.1/W2.3 `buyer_approval_subject` (paired Y/N)
- **Expected:** Box 1 CHECKED ("subject to Buyer Approval") — this is a financed FHA deal, contingency required
- **Actual on rendered PDF page 2:** Box 1 blank; **Box 2 checked** ("This contract is NOT subject to Buyer obtaining Buyer Approval")
- **Impact:** CATASTROPHIC — Buyer waives credit-side termination right entirely. If lender denies underwriting, Buyer loses earnest money AND is contractually obligated to close. This is the "checking Box 2 on a financed deal" mistake called out in Hadley knowledge file ¶2.A common-mistake list #5.

### DEFECT 6 — ¶2.A days blank EMPTY AND ¶4 FHA/VA appraised-value floor $ EMPTY
- **Widgets:** W2.2 `buyer_approval_days` + W2.4 `fha_va_appraised_value_floor`
- **Expected:** days = 21 (Hadley default); appraised floor = $500,000 (equals Sales Price per default rule; FHA activates ¶4)
- **Actual on rendered PDF page 2:** Both blanks empty
- **Impact:** No termination clock in ¶2.A + no FHA appraisal-value floor in ¶4 = both federally-mandated buyer protections dead. ¶4 with $0/blank floor arguably still runs at Sales Price under federal law but lender will kick file back.

---

## PASS — 27 fields verified correct on rendered PDF

Page 1:
1. Header property address-and-city — "123 Main St, Boerne, TX 78006" ✓
2. W1.1 ¶1.A CONVENTIONAL top-level checkbox — UNCHECKED ✓
3. W1.3 ¶1.A(1) principal $ — empty (dormant block) ✓
4. W1.4 ¶1.A(1) term-years — empty ✓
5. W1.5 ¶1.A(1) rate cap — empty ✓
6. W1.6 ¶1.A(1) rate cap period — empty ✓
7. W1.7 ¶1.A(1) origination cap — empty ✓
8. W1.8 ¶1.A(2) second mortgage checkbox — UNCHECKED ✓
9. W1.9-W1.13 ¶1.A(2) five blanks — empty ✓ (counted as one line)
10. W1.14 ¶1.B TEXAS VETERANS checkbox — UNCHECKED ✓
11. W1.15-W1.16 ¶1.B blanks — empty ✓
12. W1.17 ¶1.C FHA checkbox — CHECKED ✓
13. W1.19 ¶1.C principal $ — "482,500" ✓
14. W1.24 ¶1.D VA checkbox — UNCHECKED ✓
15. W1.25-W1.29 ¶1.D blanks — empty ✓
16. W1.30 ¶1.E USDA checkbox — UNCHECKED ✓
17. W1.31-W1.35 ¶1.E blanks — empty ✓
18. W1.36 ¶1.F REVERSE checkbox — UNCHECKED ✓
19. W1.37-W1.40 ¶1.F blanks — empty ✓
20. W1.41 ¶1.F "will / will not FHA insured" paired — neither checked (block dormant) ✓
21. W1.42 ¶1.G OTHER checkbox — UNCHECKED ✓
22. W1.43-W1.48 ¶1.G six blanks — empty ✓
23. W1.49 ¶1.G "does / does not waive 2B" paired — neither checked (block dormant) ✓

Page 2:
24. Bottom header re-print "123 Main St" ✓
25. W2.6 Buyer signature 1 placeholder — blank (populates at e-sig) ✓
26. W2.7 Seller signature 1 placeholder — blank ✓
27. W2.8 + W2.9 Buyer/Seller signatures 2 placeholders — blank ✓

---

## SKIP — 5 fields defensibly blank for FHA scenario

Non-selected financing blocks (D/E/F/G) all correctly blank at the widget level. These are counted inside the PASS list above rather than as separate SKIPs — the fill engine correctly left them dormant. No SKIPs needed for this scenario; every non-FHA block being empty is a PASS, not a SKIP.

---

## Cite chain

- Hadley knowledge file: `C:\Users\Heath Shepard\Desktop\Shepard-Ventures\Legal\TREC-Forms-Knowledge\trec-40-11.md` (v1+v2, 2026-06-20)
- TREC 40-11 promulgation: 22 TAC §537.47 (effective 2025-01-03)
- FHA amendatory clause federal mandate: 24 CFR §203.39
- VA escape clause federal mandate: 38 CFR §36.4308(d)(3)
- Rate-cap-blank void of contingency: Republic Title, "2025 TREC Contract Changes" (https://www.republictitle.com/2025-trec-contract-changes-important-things-you-need-to-know-highlights-of-the-changes/)
- ParagonDFW "Third Party Financing Addendum: A Buyer's Ultimate Safety Net" (https://paragondfw.com/blog/the-texas-third-party-financing-addendum-a-buyers-ultimate-safety-net)

---

## Recommendation

Do not merge any 40-11-touching change. Three build items for the fill engine (owner: Carter/Atlas):

1. **Fix the conventional-first sub-checkbox leak.** When `financing_type=fha`, `financing_conventional_first` MUST be false. Suspect a stale default or mis-mapped extraction key.
2. **Auto-populate FHA defaults when FHA is selected:** section=203(b), term-years=30, rate cap = market + 1.0 (or from lender pre-approval), rate cap period = term, origination cap = 1.00.
3. **Fix ¶2.A default logic.** When any financing block is checked, `buyer_approval_subject` MUST default to true (Box 1 checked) with `buyer_approval_days` = 21. Also populate `fha_va_appraised_value_floor` = Sales Price when FHA or VA is checked.

Once those three are shipped, re-run this audit. A clean pass on the same scenario is the merge gate.

*File written by Hadley_2 on 2026-07-01 in parallel with Hadley_1 (20-18), Hadley_3 (HOA), Hadley_4 (Amendment). Lane discipline: TREC 40-11 only.*
