# Quinn -> Carter: Comprehensive fill-form field-map audit needed

**Severity:** CRITICAL — Multiple TREC forms have wrong fields filled, mis-labeled parties, or impossible math.

These are independent bugs but the root cause is shared: the field-name -> PDF AcroForm slot map in `api/fill-form.js` was never end-to-end visually validated. Fix as ONE audit pass.

## Confirmed live bugs

### Bug A: TREC 9 (Unimproved Property) — buyer/seller SWAPPED

Input:
```json
{
  "form_type": "unimproved-property",
  "field_values": {
    "buyer_name": "Williams family",
    "seller_name": "Test Seller", ...
  }
}
```

Generated PDF Section 1:
> The parties to this contract are **Williams family (Seller)** and **Test Seller (Buyer)**.

**The labels are swapped.** Williams (input as buyer) is labeled Seller; Test Seller (input as seller) is labeled Buyer.

A signed contract with the parties on the wrong sides is legally void at minimum, fraud-adjacent at worst.

### Bug B: TREC 9 — sales price math is wrong/hallucinated

Input: `sale_price: 225000, financing_type: "cash"`

Generated PDF Section 3:
- A. Cash portion: (blank)
- B. Sum of all financing: $17,500
- C. Sales Price (Sum of A+B): $482,500

Expected for a CASH contract: A=$225,000, B=$0, C=$225,000.
Actual: A blank, B has $17,500 (where?), C has $482,500 (where?).

The numbers are completely disconnected from the input. Either a hardcoded default leaked, OR the field map is pulling data from a different transaction. Carter — investigate.

### Bug C: TREC 9 — property section concatenated

Input: `property_address: "500 FM 471", city_state_zip: "Castroville, TX 78009", county: "Medina"`

Generated PDF Section 2:
> Lot , Block , City of Castroville, TX 78009 Texas, known as500 FM 471, County of Medina Addition, ,

Multiple fields jammed together with no separator, wrong order, "Addition" suffix appearing from nowhere, no space between "as" and "500 FM 471".

### Bug D: TREC 40 (Financing Addendum) — loan amount in years slot

Input: `loan_amount: 340000, financing_type: "conventional", loan_term_years: 30, interest_rate_max: 7.5`

Generated PDF Section A.1:
> A first mortgage loan in the principal amount of $ (excluding any financed PMI premium), **due in full in 340,000 year(s)**, with interest not to exceed % per annum

Loan amount filled into the year-count slot. Principal amount blank. Interest rate not filled. $340,000 also bleeds into Section C (FHA section).

### Bug E: TREC 50 (Seller's Termination Notice) — termination reason missing

Input: `termination_reason: "Buyer cannot obtain financing"`

Generated PDF:
> BETWEEN THE UNDERSIGNED SELLER AND Sandra Test Seller James Bennett Seller notifies Buyer that the contract is terminated pursuant to the following:
> (1) [unchecked] Buyer failed to deliver the earnest money...
> (2) [unchecked] Other (identify the paragraph...) [blank]

Neither checkbox is selected. The `termination_reason` value isn't written into either (1)'s justification or (2)'s "Other" textbox.

Also: "BETWEEN THE UNDERSIGNED SELLER AND **Sandra Test Seller James Bennett**" — seller name and buyer name are jammed on the same line with no separator.

### Bug F: TREC 20-19 (Resale Contract) — DocuSeal role mismatch (already specced)

See `quinn-spec-carter-docuseal-roles.md`. The resale-contract form 422s before the PDF even attempts to render. Need to fix that BEFORE we can visually audit the resale field map.

## What needs to happen

### Phase 1: One-off audit script

Write `scripts/audit-fill-forms.js`:

```js
// For each form_type, generate a PDF with KNOWN inputs.
// Save to ./audit-output/<form-type>.pdf
// Run pdftotext on each, write to ./audit-output/<form-type>.txt
// Print a diff: did the input values land in the right semantic slots?

const FORMS = [
  { type: 'resale-contract',     fields: {...known sample...} },
  { type: 'financing-addendum',  fields: {...} },
  { type: 'termination-notice',  fields: {...} },
  { type: 'wire-fraud-warning',  fields: {...} },
  { type: 'unimproved-property', fields: {...} },
  { type: 'farm-ranch',          fields: {...} },
  { type: 'new-home-incomplete', fields: {...} },
  { type: 'new-home-complete',   fields: {...} },
  { type: 'hoa-addendum',        fields: {...} },
  { type: 'lead-paint-addendum', fields: {...} },
  { type: 'sellers-disclosure',  fields: {...} },
];

for (const form of FORMS) {
  // POST to /api/fill-form with form.type and form.fields
  // Download the PDF
  // pdftotext
  // Print 1500 chars
  // Manual visual verify
}
```

### Phase 2: Fix the field maps

For each broken form (A–F), audit:
1. The AcroForm field names in the PDF (use pdf-lib `form.getFields().map(f => f.getName())`)
2. The code's field-name -> AcroForm-name map
3. The cross-product of inputs and outputs

For TREC 9 (unimproved), specifically:
- Buyer/seller labels are reversed → swap the writes in the fill function
- Sale price section needs entire rework (cash should fill A, not B; total should be A only when cash)
- Property section needs reformatting (don't concatenate; respect Lot/Block/City/State/Zip/County structure)

For TREC 40 (financing), specifically:
- The conventional-section field map is broken
- Verify field A.1.principal-amount, A.1.years, A.1.rate slots
- Make sure FHA section is NOT touched when financing_type=conventional

For TREC 50 (termination), specifically:
- Insert a delimiter between seller_name and buyer_name in the heading
- Check the appropriate (1) or (2) checkbox based on `termination_reason`
- Write the reason text into the appropriate (2) "Other" textbox if (2) is selected

### Phase 3: Re-test with the script

After fixes, re-run `audit-fill-forms.js` and visually verify every form.

### Phase 4: Add an integration test

In CI / pre-deploy, run `audit-fill-forms.js` against staging. Assert at minimum:
- buyer_name appears in the "(Buyer)" parenthetical, not "(Seller)"
- seller_name appears in the "(Seller)" parenthetical
- sale_price appears formatted as currency in the right spot
- loan_amount appears in the principal amount slot, NOT the years slot

Keep a snapshot of acceptable rendered PDFs in `tests/snapshots/` so future regressions get caught.

## Why this matters

This is the most direct trust-failure mode. The agent sees a PDF, signs it, sends it to the lender / title / brokerage compliance. The downstream party sees buyer-on-seller-line and Seller termination listing buyer first — and Heath gets a phone call from Brittney asking "what's wrong with your software."

Every brokerage compliance audit screen / Skyslope / Dotloop will reject malformed TREC forms. Founding member churn risk is direct.

## Sequencing

These all fit in one Carter sprint. Estimate: 6-12h for the audit + fixes + tests. Recommend Carter set aside an uninterrupted block. Once shipped, run the audit script once a week as a regression check.
