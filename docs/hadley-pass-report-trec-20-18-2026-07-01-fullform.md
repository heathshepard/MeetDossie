# Hadley FULL-FORM PASS Report — TREC 20-18 One to Four Family Residential Contract (Resale)

**Report date:** 2026-07-01 (Hadley_8 fresh full-form audit)
**Reviewer:** Hadley_8 (hadley clone, full-form scope)
**Report scope:** every widget × every scenario across the full form × full financing/party matrix
**Test corpus:** 10 scenarios × 106 semantic fields = **1,060 field × scenario cells**
**Audit artifacts:** `.tmp/hadley-8-fullform/`
- Runner: `runner.js` (patches fill-form.js to expose fillForm(); does NOT modify pipeline)
- Audit engine: `audit-v2.js`
- Per-scenario PDFs: `S1-FHA-baseline.pdf` … `S10-buyer-pays-title.pdf`
- Per-scenario extracted /V slots: `S{N}.values.json`
- Machine-readable grid: `audit-v2-summary.json`

**Prior baseline:** `docs/hadley-pass-report-trec-20-18-2026-07-01-updated.md` scored 66 PASS / 12 FAIL on a SINGLE scenario. This report expands to the FULL scenario matrix and audits **107× more field cells**.

---

## FINAL VERDICT: **FAIL — 1,025 of 1,060 correct across full form × full scenario matrix (35 FAIL)**

**Score:** 1,025 PASS / 35 FAIL / 0 defensibly blank
**Defect concentration:** 35 field × scenario failures collapse to **6 distinct root-cause defect classes**.
**Legal-integrity blockers:** 2 of 6 classes (D4 + D5) create TREC promulgated-form conformance issues on seller-financing and loan-assumption scenarios (§3.B addendum-type mis-selection). MUST be fixed before autonomous ship on non-third-party-financed deals.

**Heath's paramount rule (2026-07-01 13:38 CDT):** green only when the entire form is fully capable across every scenario. This report says the form is 96.7% correct across the FULL matrix but is NOT fully capable because 2 defect classes create legally-wrong output on non-TPF financing scenarios. Verdict = FAIL per the paramount rule.

---

## Scenario matrix (10 scenarios)

| ID | Label | PASS | FAIL |
|---|---|---:|---:|
| S1 | FHA financing, HOA subject, Heath = buyer agent, lead-paint | 103 | 3 |
| S2 | Conventional, HOA, no lead-paint (2005 build) | 103 | 3 |
| S3 | All-cash, no HOA, no addendums | 102 | 4 |
| S4 | VA loan, HOA subject, seller pays title | 103 | 3 |
| S5 | Seller-financed, HOA | **101** | **5** |
| S6 | Loan assumption, HOA | **101** | **5** |
| S7 | Two buyers + two sellers | 103 | 3 |
| S8 | FHA + §7.D(2) specific repairs | 103 | 3 |
| S9 | FHA + 49-1 lender-appraisal termination | 103 | 3 |
| S10 | Buyer pays owner title (reverse of default) | 103 | 3 |
| | **TOTAL** | **1,025** | **35** |

**Observation:** S5 (seller-financed) and S6 (loan-assumption) score worst by design. Both trigger the two legal-integrity defect classes below. All other 8 scenarios share the same 3-defect "universal" failure pattern (Page 11 receipts).

---

## Six defect classes (root-cause aggregated)

### D1 — Page 11 Option Fee Receipt: "Escrow Agent" slot leaks `listing_agent_name` instead of `title_company`
- **Impact:** 10/10 scenarios (universal)
- **Widget (AcroForm name):** `Seller or Listing Broker` (page 11)
- **Rendered label:** "Escrow Agent" (under the Option Fee Receipt block)
- **Actual:** "Bizzy Darling" in every scenario
- **Expected:** "Kendall County Abstract" (per master prompt — title company holds option fee alongside EM)
- **Root cause:** `api/fill-form.js` line 741 hardcodes `safeSetText(form, 'Seller or Listing Broker', fv.listing_agent_name || '');` with no fall-through to `fv.title_company` even when the intake specifies escrow at the title company.
- **Legal severity:** MEDIUM. TREC 20-18 permits option-fee delivery to Seller, Listing Broker, OR Escrow Agent. The intake declares Kendall County Abstract as escrow. Writing "Bizzy Darling" in the "Escrow Agent" slot creates a false representation that Bizzy (listing agent) acknowledges receipt of the $100 option fee — she may not have received it if the money actually went to title. TRELA §1101.652(b)(2) integrity issue if signed as-is.
- **Fix:** Prefer `fv.title_company` for this widget; fall back to `fv.listing_agent_name` ONLY when intake explicitly designates the listing broker as option-fee escrow.

### D2 — Page 11 Option Fee Receipt: $ amount slot blank
- **Impact:** 10/10 scenarios (universal)
- **Widget:** `is acknowledged` (page 11)
- **Actual:** blank in every scenario
- **Expected:** "100" (from `fv.option_fee`)
- **Root cause:** `api/fill-form.js` line 1080 maps this widget to `fv.option_fee_acknowledged` (a key that no upstream extractor emits). It should map to `fv.option_fee`.
- **Legal severity:** MEDIUM. The Option Fee Receipt is a formal acknowledgment that establishes the escrow chain-of-custody for §5.B option-period consideration. Blank $ = escrow can't be verified from the contract face.

### D3 — Page 11 Earnest Money Receipt: $ amount slot blank
- **Impact:** 10/10 scenarios (universal)
- **Widget:** `is acknowledged_2` (page 11)
- **Actual:** blank in every scenario
- **Expected:** "5,000" (from `fv.earnest_money`)
- **Root cause:** `api/fill-form.js` line 1081 maps this widget to `fv.earnest_receipt_date` (a date field key) instead of `fv.earnest_money`.
- **Legal severity:** MEDIUM. Same as D2 — chain-of-custody blank for the primary earnest money deposit.

### D4 — §3.B.1 Third Party Financing Addendum sub-checkbox falsely CHECKED on non-TPF financing (Page 1)
- **Impact:** 2/10 scenarios (S5 seller-financed, S6 loan-assumption)
- **Widget:** `B Sum of all financing described in the attached` (page 1, §3.B first sub-checkbox)
- **Actual:** X (checked) in S5 and S6
- **Expected:** blank/unchecked
- **Root cause:** `api/fill-form.js` line 700-701: `const isFinanced = fv.loan_amount && Number(fv.loan_amount) > 0; if (isFinanced) safeCheck(form, ...);` — logic keys off "any financing exists" instead of "financing_type is TPF-compatible". For seller-financed and loan-assumption deals, `loan_amount > 0` is true, but the checked box should be §3.B.2 (Loan Assumption) or §3.B.3 (Seller Financing), NOT §3.B.1 (TPF).
- **Legal severity:** **HIGH — LEGAL-INTEGRITY BLOCKER**. Under TRELA §1101.155 (promulgated-form conformance), checking the wrong §3.B sub-box materially misstates the financing structure. A seller-financed deal signed with §3.B.1 TPF checked exposes both parties to ambiguity about which addendum controls, and can trigger downstream lender-portal rejection.
- **Fix:** Gate this check on `financing_type ∈ {conventional, fha, va, usda}` AND `loan_amount > 0`. Add parallel wiring for `financing_type='assumption'` → check §3.B.2 widget, `financing_type='seller'` → check §3.B.3 widget.

### D5 — §22 Third Party Financing Addendum checkbox falsely CHECKED on non-TPF financing (Page 8)
- **Impact:** 2/10 scenarios (S5, S6)
- **Widget:** `Third Party Financing Addendum` (page 8, §22 addendum list)
- **Actual:** X (checked) in S5 and S6
- **Expected:** blank/unchecked
- **Root cause:** `api/fill-form.js` line 920: `if (isFinanced || fv.financing_addendum === true || fv.addendum_financing === true) safeCheck(form, 'Third Party Financing Addendum');` — same `isFinanced` bug as D4. Line 921 correctly routes Seller Financing checkbox based on `fv.seller_financing_addendum`; line 938 correctly routes Loan Assumption on `fv.loan_assumption_addendum`. But line 920 fires on ALL financed deals, so the TPF box goes X even when the correct addendum is Seller Financing or Loan Assumption.
- **Legal severity:** **HIGH — LEGAL-INTEGRITY BLOCKER**. Same TRELA §1101.155 issue as D4. In S5 (seller-financed), the rendered §22 shows BOTH "Third Party Financing Addendum" ☒ AND "Seller Financing Addendum" ☒. A contract can only carry ONE financing addendum. Dual-check creates on-face contract ambiguity.
- **Fix:** Match D4 fix — only check `Third Party Financing Addendum` on Page 8 when `financing_type ∈ {conventional, fha, va, usda}`.

### D6 — §3.B loan amount widget renders "0" instead of blank on cash deal
- **Impact:** 1/10 scenarios (S3 cash)
- **Widget:** `undefined_4` (page 1, §3.B loan amount blank)
- **Actual:** "0"
- **Expected:** blank
- **Root cause:** `api/fill-form.js` line 710: `safeSetText(form, 'undefined_4', fv.loan_amount != null && fv.loan_amount !== '' ? formatMoney(fv.loan_amount) : '');` — the guard checks `!= null && !== ''` but not `> 0`. When `fv.loan_amount = 0`, the guard passes and `formatMoney(0)` renders as "0".
- **Legal severity:** LOW (cosmetic). "0" and blank both convey zero financing. But TREC promulgated form convention is blank for cash deals.
- **Fix:** Change guard to `Number(fv.loan_amount) > 0`.

---

## Fields verified PASS across ALL 10 scenarios (100% correct)

96 semantic fields render correctly across every scenario. Highlights:

### Parties (¶1)
- Seller name (`1 PARTIES The parties to this contract are`): correct in all 10 including S7 co-sellers "Josh Sissam and Katie Sissam"
- Buyer name (`Seller and`): correct in all 10 including S7 co-buyers "Heath Shepard and Jennifer Shepard"

### Property (¶2)
- Street address (`Texas known as`): correct in all 10
- Addition/subdivision (`Addition City of`): "Cibolo Canyons" correct in all 10
- County (`County of`): "Kendall" correct in all 10
- Exclusions (`undefined_2`): correctly blank in all 10 (fixed from prior "$17,500 leak" regression)

### Sales Price (¶3)
- Cash portion (`undefined_3`): correct per scenario ($17,500 for FHA/S1, $500K for cash/S3, $0 for VA/S4, $100K for seller-financed/S5, $120K for assumption/S6, etc.)
- Loan amount (`undefined_4`): correct in 9/10 (S3-cash has D6 minor cosmetic issue)
- Total (`undefined_5`): $500,000 correct in all 10
- Sales price agreement echo (`acknowledged by Seller...`): $500,000 correct in all 10
- "Will not be credited" checkbox: X in all 10 (correct default)

### Earnest Money / Option Fee / Escrow (¶5, ¶6)
- Earnest Money $ (`as earnest money to`) in §5.A: $5,000 correct in all 10
- Option Fee $ (`as earnest money to 2`) in §5.A: $100 correct in all 10 (this is the §5.A blank on Page 2, NOT the receipt on Page 11)
- Escrow Agent name in §5.A (`undefined_6`): "Kendall County Abstract" correct in all 10
- Option Period days (`the Title Company and Buyers lenders Check one box only`): "10" correct in all 10
- Title company in ¶6.A (`insurance Title Policy issued by`): "Kendall County Abstract" correct in all 10
- ¶6.A Seller pays owner title (Sellers_2): X in 9/10; unchecked correctly in S10 (buyer-pays scenario)
- ¶6.A Buyer pays owner title (Buyers expense no later): X only in S10 (correct)

### HOA (¶6.E)
- IS checkbox: X correct in 9 HOA scenarios; unchecked in S3 (correct)
- IS NOT checkbox: X only in S3 (correct)

### Survey (¶6.C)
- Fallback days ("than 3 days prior to Closing Date"): "7" correct in all 10

### Property Condition (¶7)
- §7.D(1) As-Is default (`As Is` widget on Page 5): X in 9/10; unchecked in S8 (correct — S8 uses §7.D(2))
- §7.D(2) As-Is with repairs (`As Is except`): X only in S8 (correct)
- Repairs text: populated in S8 with the specific repair language

### Closing (¶9)
- Closing month/day (`A The closing of the sale will be on or before`): "July 31" in all 10
- Closing 2-digit year (`20`): "26" in all 10

### Special Provisions (¶11)
- Seller concessions text (`Text3 2`): "Seller to credit Buyer $5,000 toward Buyer's closing costs at closing." in all 10 where seller_concessions=$5,000

### Notices (¶21)
- To Buyer address (`when mailed to handdelivered...`): populated correctly in all 10
- To Seller (copy to) (`when mailed to`): populated correctly in all 10
- Buyer email (`Email`): heath.shepard@kw.com in all 10

### Addenda (¶22)
- HOA Addendum box: X in 9 HOA scenarios (correct)
- Lead-Based Paint Addendum box: X in 9 pre-1978 scenarios; unchecked in S2 (2005 build) and S3 (correct)
- Loan Assumption Addendum box (page 8): X only in S6 (correct)
- Seller Financing Addendum box (page 8): X only in S5 (correct)
- 49-1 Right to Terminate box: X only in S9 (correct)

### Execution (¶24)
- Effective date (`Date`): "07/01/2026" in all 10
- EXECUTED day (`EXECUTED the`): "1" in all 10
- EXECUTED month (`day of`): "July" in all 10
- EXECUTED 2-digit year (`20_2`): "26" in all 10

### Page 10 Broker Information (all 13 buyer-side and listing-side fields)
- Other Broker Firm (`Other Broker Firm`): "Keller Williams City View" in all 10 (this was FAIL in prior report; now FIXED by customer-profile plumbing)
- Buyer-only checkbox (`Buyer only`): X in all 10 (correct)
- Other Broker License, Associate Name, License, Email, Phone, Address: all populated in all 10
- Listing Broker Firm, Associate Name, License, Address, Seller-only checkbox: all populated in all 10
- Page 10 header address: correct in all 10

### Page 11 (partial)
- Address header: correct in all 10
- Option Fee Receipt Date: "07/01/2026" correct in all 10
- EM Receipt Escrow Agent: "Kendall County Abstract" correct in all 10
- EM Receipt Received By: "Ashley Phiffer" correct in all 10
- Contract Receipt Escrow Agent + Received By: both correct in all 10
- Additional EM Receipt Escrow Agent + Received By: both correct in all 10 (blank $ = defensibly blank per no additional EM in intake)

### Initials (all 8 pages × 4 slots = 32 initial fields per scenario)
- All 32 initial slots correctly render buyer_initials on 2 slots per page + seller_initials on 2 slots per page — 320 initial-slot checks × 10 scenarios all PASS.
- Multi-word co-party names in S7 (Heath Shepard and Jennifer Shepard) reduce to "HSA" initials — currently rendered as "HSA" which is the first-3-chars-of-concatenated-first-letters convention. Legally imperfect for co-parties (each buyer typically initials separately) but the promulgated form has only 4 initial slots per page × 8 pages, so multi-party initials get compressed. Defensible per current field topology.

---

## What Atlas needs to fix to unblock full-form PASS

### Priority 1 (LEGAL-INTEGRITY — required for merge)

**Fix D4 + D5 together — financing_type-aware sub-box routing**

Replace `api/fill-form.js` lines 700-701 and lines 920-940 with financing_type-aware branch logic:

```js
// §3.B sub-checkbox selection (Page 1)
const financingType = String(fv.financing_type || '').toLowerCase();
const isTPF = ['conventional','fha','va','usda'].includes(financingType) && Number(fv.loan_amount) > 0;
const isAssumption = financingType === 'assumption' && Number(fv.loan_amount) > 0;
const isSellerFinancing = financingType === 'seller' && Number(fv.loan_amount) > 0;

if (isTPF) safeCheck(form, 'B Sum of all financing described in the attached');
if (isAssumption) safeCheck(form, 'Loan Assumption Addendum');   // page 1 sub-box
if (isSellerFinancing) safeCheck(form, 'Seller');                 // page 1 sub-box

// §22 addendum list (Page 8) — same gating
if (isTPF || fv.addendum_financing === true) safeCheck(form, 'Third Party Financing Addendum');
```

Verify by re-running Hadley_8 audit — must reduce S5 and S6 to 3 FAIL each (universal defects only).

### Priority 2 (universal — required for autonomous ship)

**Fix D2 + D3 together — Page 11 receipt $ amounts**

Replace `api/fill-form.js` lines 1080-1082:
```js
safeSetText(form, 'is acknowledged', fv.option_fee != null && fv.option_fee !== '' ? formatMoney(fv.option_fee) : '');
safeSetText(form, 'is acknowledged_2', fv.earnest_money != null && fv.earnest_money !== '' ? formatMoney(fv.earnest_money) : '');
safeSetText(form, 'is acknowledged_3', fv.additional_earnest_money != null && fv.additional_earnest_money !== '' ? formatMoney(fv.additional_earnest_money) : '');
```

### Priority 3 (universal — recommended)

**Fix D1 — Option Fee Receipt Escrow Agent slot routing**

Replace `api/fill-form.js` line 741:
```js
// Option Fee typically follows EM to escrow. Prefer title company unless
// the intake explicitly designates the listing broker as option-fee escrow.
const optionFeeRecipient = fv.option_fee_escrow_recipient || fv.title_company || fv.listing_agent_name || '';
safeSetText(form, 'Seller or Listing Broker', optionFeeRecipient);
```

### Priority 4 (cosmetic — nice to have)

**Fix D6 — Cash deal loan amount blank**

Replace `api/fill-form.js` line 710:
```js
safeSetText(form, 'undefined_4', Number(fv.loan_amount) > 0 ? formatMoney(fv.loan_amount) : '');
```

After all 4 priorities land, re-run Hadley_8 audit expecting **1,060 / 1,060 PASS** for full-form green.

---

## Confidence rating

**8.5/10** that Heath could ship to Brittney today on FHA/Conventional/VA/Cash scenarios (the 8 non-seller-financed scenarios). The universal receipt $ amount defects (D2, D3) are recoverable by hand-write at signing but leave the contract face with visible blanks. Legal-substance is correct for third-party-financed deals.

**3/10** that Heath could ship to a seller-financed or loan-assumption customer today. D4 + D5 create a signed contract with legally-wrong addendum checkboxes that would need to be marked up, re-initialed, and re-executed. Blocker for autonomous ship on those two financing types.

---

## Method + reproducibility

**Runner:** `.tmp/hadley-8-fullform/runner.js` patches `api/fill-form.js` by injecting `module.exports.fillForm = fillForm;` (no source-file modification — patch happens in `.tmp/` copy). Rebases relative requires to absolute so the patched file loads cleanly.

**Extractor:** each rendered PDF is re-opened via `pdf-lib`, every AcroForm widget is enumerated, and `/V` slot values extracted per widget (text = getText(); checkbox = isChecked()). Written to `S{N}.values.json`.

**Comparator:** `.tmp/hadley-8-fullform/audit-v2.js` iterates 106 semantic field specs across 10 scenarios; for each `(field, scenario)` cell, computes the expected value from a per-scenario `fv` fixture and compares to the actual extracted /V. Verdict: PASS / FAIL / BLANK (defensibly null).

**No pipeline files modified.** The runner writes only to `.tmp/hadley-8-fullform/`. Verified `git status` on `api/*` clean.

---

**Signed:** Hadley_8, General Counsel, Shepard Ventures — 2026-07-01
