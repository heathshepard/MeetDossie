# Quinn -> Carter: Financing Addendum field-mapping bug — loan amount in wrong slot

**Severity:** CRITICAL — every generated TREC 40 financing addendum has the loan amount stamped into the loan-term-years field.

## Bug

`/api/fill-form` with `form_type: "financing-addendum"` generates the TREC 40 PDF, but the AcroForm field map writes `loan_amount` into the wrong slot.

## Reproduction (verified live)

```bash
curl -X POST https://meetdossie.com/api/fill-form \
  -H "Authorization: Bearer $JWT" -H "Origin: https://meetdossie.com" \
  -d '{
    "transaction_id": "807dd591-d589-4019-89cf-3a805e14d421",
    "form_type": "financing-addendum",
    "field_values": {
      "buyer_name": "James Bennett",
      "loan_amount": 340000,
      "down_payment_pct": 20,
      "financing_type": "conventional",
      "property_address": "987 Magnolia Creek Dr",
      "interest_rate_max": 7.5,
      "loan_term_years": 30
    }
  }'
# → 200 with signed URL
```

Inspect the generated PDF (`pdftotext`):

```
q A. CONVENTIONAL FINANCING:
q (1) A first mortgage loan in the principal amount of $ (excluding any
financed PMI premium), due in full in 340,000 year(s), with interest not to exceed
% per annum for the first year(s) of the loan...
```

**Expected:** "principal amount of $**340,000**, due in full in **30** year(s), with interest not to exceed **7.5** %"

**Actual:**
- principal amount: blank
- "due in full in **340,000 year(s)**" — the loan amount got jammed into the year-count field
- interest rate (7.5): missing entirely

Also: $340,000 ALSO appears in Section C (FHA financing) area. The conventional vs FHA marker is mis-routed.

## End-user impact

Brittney records "Fill out a financing addendum for 123 Main, $340k conventional 20 down 30 years 7.5% max."
She gets back a PDF that:
- Has the dollar amount in the wrong row
- Has no interest rate
- Says she's borrowing 340,000 years (clearly absurd)

She catches it before sending. Loses all trust.

## Root cause

`api/fill-form.js` has a field map for the TREC 40 Third Party Financing
Addendum. Either:
- The field-name -> AcroForm-name mapping for `loan_amount` is wrong (mapped
  to a field that's the year-count slot in the PDF).
- OR the underlying PDF asset has fields named in an order that mismatches
  the code's expectation.

The trec-financing-base64.js asset embeds the PDF. The field-map portion of
fill-form that handles financing-addendum needs an audit — likely the order
of the conventional-section fields was swapped at some point and the field
map wasn't re-verified.

Suggested audit:
```bash
# Inspect the actual AcroForm field names of the embedded TREC 40 PDF
python scripts/inspect_financing_fields.py
```

(Or write a one-off script using pdf-lib to list `form.getFields()` and
their coordinates.)

Then cross-reference against the code's hard-coded field map for financing.

## Fix

In `api/fill-form.js`, find the financing-addendum field map section and:
1. Re-derive the correct field name for the "principal amount" slot.
2. Re-derive the correct field name for the "amortizable monthly for not less than ___ year(s)" slot.
3. Re-derive the correct field name for "with interest not to exceed ___%".
4. Verify conventional vs FHA section selection works (when financing_type=conventional, FHA section should NOT be filled).

## How to verify

After the fix:
```bash
curl -X POST .../api/fill-form -d '{..."loan_amount":340000,"loan_term_years":30,"interest_rate_max":7.5,...}'
# Fetch the PDF
# Run pdftotext on it. Expect:
# "principal amount of $340,000"
# "due in full in 30 year(s)"
# "with interest not to exceed 7.5 % per annum"
```

Visual verification:
- Section A (Conventional) checkbox: checked
- Sections B–F (TX Vet, FHA, VA, USDA, Reverse): unchecked
- $340,000 in Section A (1) principal amount line
- 30 in Section A (1) "due in full in" slot
- 7.5 in Section A (1) "interest not to exceed" slot

## Audit other forms

Run the same end-to-end + visual inspection on:
- `termination-notice` (looked OK in pdftotext but verify)
- `wire-fraud-warning`
- `unimproved-property`
- `new-home-incomplete`
- `new-home-complete`
- `farm-ranch`
- `hoa-addendum` (TREC 36-11)
- `lead-paint-addendum` (OP-L)
- `sellers-disclosure` (OP-H or 55-1)

For each, generate a real PDF, run pdftotext, verify the input values land in the visually-correct slots.

If any others have field-map bugs, group them in a single follow-up commit.

## Why this matters

Heath's positioning is "TC who never makes mistakes." A financing addendum
with the loan amount written as "years" is a mistake a human TC would NEVER
make. It immediately breaks the positioning.

Worse, this is harder to catch than a missing field — the agent might trust
the document is correct because all the OTHER fields look right, and only
notice the wrongness when the lender reviews it. By then the contract is in
play.

## Sequencing

Fix priority: parallel to the DocuSeal role mismatch (spec
`quinn-spec-carter-docuseal-roles.md`). Both are PDF-fill correctness bugs;
ship them together in one deploy.
