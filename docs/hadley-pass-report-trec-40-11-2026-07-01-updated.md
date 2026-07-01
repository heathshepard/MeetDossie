# Hadley PASS Report — TREC 40-11 Third Party Financing Addendum

**Report date:** 2026-07-01
**Reviewer:** Hadley
**PDF audited:** `.tmp/v3-fha-verify/financing-addendum.pdf` (fresh PROD render 2026-07-01 11:41 CDT)
**Rendered pages:** `.tmp/hadley-audit-2026-07-01/financing-addendum-1.png` and `-2.png`
**Test scenario:** FHA financed ($500k sale, 3.5% down, $482,500 loan, 30 yr) per v3-FHA master prompt
**Merged fields fed to fill pipeline:** 41 (14 specific to financing-addendum extract)

---

## FINAL VERDICT: **FAIL — CRITICAL LEGAL DEFECT — DO NOT SHIP**

**Score:** 12 PASS / 5 FAIL / 26 defensibly blank (form has 37 fillable fields; most are conditional on financing type not selected) = **12 of 17 populated fields correct.**

**Confidence rating: 2/10 that Heath could ship this to Brittney today.**

Two defects render this addendum unenforceable / dangerous for Buyer even though the property + FHA info is technically populated.

---

## Field-by-field verdict

### Page 1 — Financing Type + Terms

| # | Field | Expected (FHA scenario) | Actual | Verdict |
|---|---|---|---|---|
| 1 | Street Address and City | "123 Main St, Boerne, TX 78006" | "123 Main St, Boerne, TX 78006" | **PASS** |
| 2 | ¶1.A Conventional (1) checkbox | UNCHECKED (not conventional) | **X CHECKED** | **FAIL — critical mutually-exclusive violation** |
| 3 | ¶1.A Conventional (1) principal $ | blank | blank | PASS |
| 4 | ¶1.A Conventional (1) term-years | blank | blank | PASS |
| 5 | ¶1.A Conventional (1) rate cap % | blank | blank | PASS |
| 6 | ¶1.A Conventional (1) origination cap | blank | blank | PASS |
| 7 | ¶1.A Conventional (2) checkbox | unchecked | unchecked | PASS |
| 8 | ¶1.B Texas Veterans checkbox | unchecked | unchecked | PASS |
| 9 | ¶1.C FHA checkbox | **X CHECKED** | X CHECKED | **PASS** |
| 10 | ¶1.C FHA Section # | "203(b)" (most common) | blank | **FAIL — file-rejection risk** |
| 11 | ¶1.C FHA principal $ | "482,500" | "482,500" | **PASS** |
| 12 | ¶1.C FHA term-years | "30" | blank | **FAIL — loan_term_years=30 in fixtures but not propagated** |
| 13 | ¶1.C FHA interest rate cap % | not supplied — blank OK | blank | PASS (strict mode — blank if not provided; but risky per practice — Republic Title "do NOT leave blank") |
| 14 | ¶1.C FHA rate-cap-period years | not supplied — blank OK | blank | PASS |
| 15 | ¶1.C FHA origination cap % | not supplied — blank OK | blank | PASS |
| 16 | ¶1.D VA checkbox | unchecked | unchecked | PASS |
| 17 | ¶1.E USDA checkbox | unchecked | unchecked | PASS |
| 18 | ¶1.F Reverse mortgage checkbox | unchecked | unchecked | PASS |
| 19 | ¶1.G Other financing checkbox | unchecked | unchecked | PASS |
| 20 | Footer initials | "HS" & "JS" | "HS" & "JS" | PASS |

### Page 2 — Approval, FHA/VA Provision, Signatures

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 21 | Page 2 header "Address of Property" | "123 Main St" | "123 Main St" | **PASS** |
| 22 | ¶2.A Box 1 "This contract IS subject to Buyer Approval" | **X CHECKED** (financed deal — preserve credit contingency) | UNCHECKED | **FAIL — CRITICAL** |
| 23 | ¶2.A Box 1 days | 21-30 typical | blank | FAIL (blocked by upstream Box 1 choice) |
| 24 | ¶2.A Box 2 "This contract is NOT subject to Buyer Approval" | UNCHECKED | **X CHECKED** | **FAIL — CRITICAL — Buyer waives credit contingency on an FHA loan** |
| 25 | ¶4 FHA/VA appraised-value floor $ | "500,000" (sale price) | blank | **FAIL — protective FHA amendatory-clause floor missing** |
| 26 | Signatures | blank at fill stage | blank | PASS |

---

## Critical defects

### DEFECT F1 (CRITICAL — Multi-checkbox violation)
¶1.A Conventional (1) is X CHECKED simultaneously with ¶1.C FHA. **Mutually-exclusive rule violated.** Any lender or title company reviewing this will kick back the file. Root cause: fill engine writing both `financing_conventional_first` AND `financing_fha` when only `financing_type='fha'` was set. Extract JSON only has `financing_type:'fha'` — the engine is asserting Conventional(1) by default somewhere.

### DEFECT F2 (CRITICAL — Buyer waives credit contingency)
¶2.A Box 2 "This contract is NOT subject to Buyer Approval" is X CHECKED. On a financed deal (¶3.B is $482,500 FHA loan) Box 1 should be checked with 21-30 day window. Checking Box 2 waives the entire credit-contingency safety net. If Buyer can't qualify for the FHA loan, they lose earnest money and can be sued for specific performance. **This is legal-malpractice-level defect.** Root cause: same fill-engine slot mixup as F1 — the "IS NOT subject to" checkbox is defaulting to CHECKED when Box 1 should default CHECKED on any deal with financing_type set.

### DEFECT F3 (Medium — FHA Section blank)
¶1.C requires "Section ____ FHA insured loan" — the HUD program section. Not supplied in the master prompt, but the fill engine should default to "203(b)" for standard single-family FHA. Blank triggers title-file rejection at underwrite.

### DEFECT F4 (Medium — FHA term-years blank)
`loan_term_years: 30` IS in the merged fields JSON. Fill engine is not propagating this to the ¶1.C term-years widget. Simple mapping bug.

### DEFECT F5 (Medium — ¶4 FHA appraised-value floor)
¶4 FHA/VA Required Provision requires appraised-value dollar amount (typically = sale price, giving Buyer termination right if appraisal < that amount). Blank leaves the FHA amendatory-clause with no operative dollar figure — Buyer cannot exercise the FHA-specific appraisal termination right.

---

## Top 3 defects for Atlas to dispatch

1. **Fix the Conventional-Block-A(1) auto-check** — F1. Investigate the fill engine's `financing_conventional_first_principal` widget mapping — the CHECKBOX is being asserted even when `financing_type != 'conventional'`. Add gate: only check Conventional (1) if `financing_type === 'conventional'` OR `financing_conventional === true`.
2. **Fix ¶2.A Buyer Approval box selection** — F2. Default Box 1 CHECKED when parent contract has any financing_type checked. Default Box 2 CHECKED only if `financing_type === 'cash'` or explicitly `buyer_approval_waived: true`.
3. **Populate FHA Section 203(b) default + loan_term_years + appraised-value floor** — F3, F4, F5. Wire `loan_term_years` to `financing_fha_term_years` widget. Add default `financing_fha_section = '203(b)'` when financing_type === 'fha' and no override. Add default `fha_appraised_value_floor = sale_price` for FHA scenarios.

---

## Hadley verdict

**FAIL. Merge gate remains CLOSED on TREC 40-11.**

The FHA principal $ is correct and the FHA checkbox fires — but the two critical defects (F1 Conventional multi-check, F2 Buyer Approval waiver) make this addendum legally dangerous. A signed 40-11 with these defects would leave a buyer without credit contingency AND with two conflicting financing types checked — the deal would fall apart at title AND the buyer would be sued for specific performance if the FHA loan fails.

**Signed:** Hadley, General Counsel, Shepard Ventures — 2026-07-01 11:47 CDT
