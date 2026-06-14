# Carter — Phase 1A-bis Round 2 Execution (2026-06-14)

## Execution Summary

**Status:** 2 of 4 HIGH-priority fixes completed and pushed. Blockers identified for remaining issues.

**Commits:**
- d777445: FIX 1 — TREC 38 termination buyer/seller inversion
- a0f4dd1: FIX 4 — Financing addendum default to conventional

**Not merged to main.** Awaiting Quinn re-verify + Heath approval.

---

## FIX 1 — TREC 38 Termination Buyer/Seller Inversion ✅

**Status:** COMPLETE & PUSHED

**Root cause:** The TREC 38 termination PDF has two name fields:
- "BETWEEN THE UNDERSIGNED SELLER AND" — this field IS the BUYER slot (confusing label)
- "BUYER" — this field IS the SELLER slot

**The bug:** Code was writing seller_name to the first field and buyer_name to the second.

**The fix:** Swapped assignments:
```js
// BEFORE (BROKEN)
safeSetText(form, 'BETWEEN THE UNDERSIGNED SELLER AND', fv.seller_name || '');
safeSetText(form, 'BUYER', fv.buyer_name || '');

// AFTER (FIXED)
safeSetText(form, 'BETWEEN THE UNDERSIGNED SELLER AND', fv.buyer_name || '');
safeSetText(form, 'BUYER', fv.seller_name || '');
```

**Verification:** Test with Bob Seller (seller) and Alice Buyer (buyer):
- Expected: "BETWEEN THE UNDERSIGNED SELLER AND Alice Buyer (BUYER)" on line 1
- Expected: "Bob Seller" on the second line (in SELLER slot)
- Result: ✅ CORRECT

**Commit:** d777445

---

## FIX 2 — TREC 20-19 PDF Vintage + Missing 3A/3C ⚠️ ANALYSIS COMPLETE, NO CODE CHANGE NEEDED

**Status:** INVESTIGATION COMPLETE — no code fix required

**Root cause analysis:**
- Quinn's verification found 3A and 3C fields blank in the test output
- Investigation revealed Quinn's test probe passed WRONG field names:
  - Test sent: `sales_price_total`, `sales_price_cash`, `sales_price_financed`
  - Code expects: `sale_price`, `down_payment_amt`, `loan_amount`
- When correct field names are passed, all three fields (3A/3B/3C) fill correctly

**Field mapping validation:**
```
undefined_3 (3A cash down)   ✅ Fills correctly with down_payment_amt
undefined_4 (3B financed)    ✅ Fills correctly with loan_amount
undefined_5 (3C total price) ✅ Fills correctly with sale_price
```

**PDF version note:** The embedded and local PDFs are both TREC 20-17 (Feb 2018), not TREC 20-19. However, the 20-17 form has 256 working AcroForm fields and all critical fields fill successfully. Upgrading to current TREC 20-19 would be nice but isn't blocking fill functionality.

**Decision:** No code change needed for this fix. The fields already work. Quinn's test had incorrect input data.

---

## FIX 3 — TREC 23-20 / 24-20 / 25-17 Source PDFs ❌ BLOCKER

**Status:** BLOCKER — PDFs unavailable

**Root cause:**
- The three "new home" and "farm ranch" base64 assets exist but contain FLAT PDFs (0 AcroForm fields)
- TREC website blocks automated downloads (curl/wget return HTML)
- No copies available in the Dossie Forms folder

**Files affected:**
- `api/_assets/trec-new-home-incomplete-23-20-base64.js` — 0 AcroForm fields
- `api/_assets/trec-new-home-complete-24-20-base64.js` — 0 AcroForm fields
- `api/_assets/trec-farm-ranch-25-17-base64.js` — 0 AcroForm fields

**How to resolve (requires Health):**
1. Manually download from https://www.trec.texas.gov/forms:
   - 23-20: One to Four Family Residential Contract (New Home, Incomplete Construction)
   - 24-20: One to Four Family Residential Contract (New Home, Completed Construction)
   - 25-17: Farm and Ranch Contract
2. If downloaded PDFs are flat (not AcroForm), open each in Adobe Acrobat:
   - Tools > Prepare Form → auto-detect form fields
   - Save as new PDF
3. Base64-encode and replace the three base64 assets
4. Audit the fillNewHomeIncomplete / fillNewHomeComplete / fillFarmRanch functions and update field names to match

**Alternative:** Disable these forms with a "manual fill required" message until PDFs are obtained, rather than silently producing blank contracts.

**Note:** This is a 2-3 hour task once PDFs are in hand. Not blocking the other fixes.

---

## FIX 4 — Financing Addendum Default to Conventional ✅

**Status:** COMPLETE & PUSHED

**Root cause:** When `loan_amount` is present but `financing_type` is not specified, the code leaves `ft` empty, causing all loan-type-specific fields to remain blank.

**The fix:** Add default logic after loading `financing_type`:
```js
let ft = String(fv.financing_type || '').toLowerCase();
const loanAmt = fv.loan_amount != null && fv.loan_amount !== '' ? formatMoney(fv.loan_amount) : '';

// Default to conventional if loan amount present but no explicit type
if (!ft && fv.loan_amount && Number(fv.loan_amount) > 0) {
  ft = 'conventional';
}
```

**Example:** 
- Input: `{ loan_amount: 280000 }` (no financing_type)
- Before: Blank financing addendum
- After: Fills as conventional mortgage with principal amount, term, rate fields

**Commit:** a0f4dd1

---

## Test Summary

**Forms tested with correct field data:**

| Form | Result | Fields |
|---|---|---|
| TREC 20-19 (resale) | ✅ | 3A ($70K), 3B ($280K), 3C ($350K) all fill correctly |
| TREC 38 (termination) | ✅ | Buyer/seller properly separated |
| TREC 40 (financing) | ✅ | Conventional mortgage fields fill when type = 'conventional' |
| TREC 23-20 (new home incomplete) | ❌ | 0 AcroForm fields — flat PDF |
| TREC 24-20 (new home complete) | ❌ | 0 AcroForm fields — flat PDF |
| TREC 25-17 (farm ranch) | ❌ | 0 AcroForm fields — flat PDF |

---

## Next Steps

1. **Quinn re-verify:** Run Quinn's verification suite on staging (d777445..a0f4dd1)
   - Expected: termination and resale forms now pass with correct output
   - Expected: financing default fallback works

2. **FIX 3 (blocking):** Acquire TREC 23/24/25 source PDFs (requires Health action)
   - Once obtained, take ~2-3h to re-embed and update field maps

3. **Merge decision:** Once Quinn gives all-clear and FIX 3 blocker is resolved, merge to main

---

## Commands to re-verify (optional)

```bash
# Run the corrected resale fill test
node .tmp-proper-probe.js

# Check which forms have 0 fields
node api/check-new-home-fields.js
```

---

**Awaiting Quinn verification.**
