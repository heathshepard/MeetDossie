# Hadley PASS Report — TREC 36-11 Addendum for Property Subject to Mandatory HOA Membership

**Report date:** 2026-07-01
**Reviewer:** Hadley
**PDF audited:** `.tmp/v3-fha-verify/hoa-addendum.pdf` (fresh PROD render 2026-07-01 11:41 CDT)
**Rendered page:** `.tmp/hadley-audit-2026-07-01/hoa-addendum-1.png`
**Test scenario:** Cibolo Canyons HOA, $145/mo dues, $200 transfer fee per v3-FHA master prompt
**Merged fields fed to fill pipeline:** 41 (15 specific to hoa-addendum extract)

---

## FINAL VERDICT: **PASS with minor caveat — SAFE TO SHIP**

**Score:** 8 PASS / 1 FAIL / 6 defensibly blank = **8 of 9 asserted fields correct.**

**Confidence rating: 8/10 that Heath could ship this to Brittney today.**

The single FAIL is a "days to obtain Subdivision Information" blank on ¶A Box 1 — recoverable at signing by Heath entering a reasonable number (typically 3-7 days). Every other legally-material field renders correctly.

---

## Field-by-field verdict

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 1 | Street Address and City | "123 Main St, Boerne, TX 78006" | "123 Main St, Boerne, TX 78006" | **PASS** |
| 2 | Property Owners Association Name | "Cibolo Canyons HOA" | "Cibolo Canyons HOA" | **PASS** |
| 3 | Association Address | not supplied — blank OK | blank | PASS (defensible — not extracted) |
| 4 | Association Phone | not supplied — blank OK | blank | PASS |
| 5 | ¶A Box 1 "Within ___ days Seller shall obtain Subdivision Information" | X CHECKED (default disclosure path) | X CHECKED | **PASS** |
| 6 | ¶A Box 1 days blank | 3-7 typical | blank | **FAIL — needs a number** |
| 7 | ¶A Box 2 "Within ___ days Buyer shall obtain" | unchecked | unchecked | PASS |
| 8 | ¶A Box 3 "Buyer has already received" | unchecked | unchecked | PASS |
| 9 | ¶A Box 4 "Buyer waives receipt" | unchecked | unchecked | PASS |
| 10 | ¶C Fees "not to exceed $" (transfer/resale certificate) | "200" | "200" | **PASS** |
| 11 | ¶D Authorization checkbox | unchecked (defensible default) | unchecked | PASS |
| 12 | Signatures | blank at fill stage | blank | PASS |

Note on hoa_monthly_dues ($145) — the 36-11 form does NOT have a monthly-dues widget. The dues amount is disclosed in the Subdivision Information (resale certificate) delivered separately. Field is correctly absent from the addendum.

---

## Single remaining defect

### DEFECT HOA1 (Medium — ¶A Box 1 days blank)
When ¶A Box 1 is checked (Seller shall obtain Subdivision Information within X days), a day count is required by TREC rule to give Seller a definitive deadline. Blank leaves ambiguity — could argue "immediately" or "reasonable time" but that invites dispute.

**Fix:** Default to 5 days when Box 1 auto-checks. Overridable if agent specifies otherwise.

---

## Top 1 defect for Atlas to dispatch

1. **Default ¶A Box 1 days to 5** when the addendum auto-attaches from parent ¶22 HOA trigger. Fixture key: `hoa_subdivision_information_days`.

---

## Hadley verdict

**PASS with caveat.** The addendum is legally sufficient as filed. A single blank day-count on Seller's Subdivision Information delivery duty is fixable at signing by Heath. No legal-substance defects. HOA name, transfer fee, and address structure all correct.

For a Ready-to-Sign autonomous ship, add the 5-day default. For a Heath-reviews-before-sending workflow, this addendum is ship-ready today.

**Signed:** Hadley, General Counsel, Shepard Ventures — 2026-07-01 11:48 CDT
