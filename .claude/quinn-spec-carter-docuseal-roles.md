# Quinn -> Carter: DocuSeal template role mismatch — fill-form 422 on every call

**Severity:** CRITICAL — every TREC 20-19 contract fill returns 422.

## Bug

`POST /api/fill-form` with `form_type: "resale-contract"` returns:
```
HTTP 422
{"ok":false,"error":"DocuSeal submission failed (422): {\"error\":\"Unknown submitter role: Buyer. Template defines [\\\"First Party\\\"]\"}"}
```

## Reproduction (verified live)

```bash
curl -X POST https://meetdossie.com/api/fill-form \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -H "Origin: https://meetdossie.com" \
  -d '{
    "transaction_id": "807dd591-d589-4019-89cf-3a805e14d421",
    "form_type": "resale-contract",
    "field_values": {
      "buyer_name": "James and Laura Bennett",
      "sale_price": 425000,
      "earnest_money": 4250,
      "option_fee": 300,
      "option_days": 10,
      "closing_date": "2026-07-15"
    }
  }'
# → 422 "Unknown submitter role: Buyer. Template defines [\"First Party\"]"
```

## Root cause

`api/fill-form.js` line 486:
```js
submitters: [
  { role: 'Buyer',  name: ..., email: ..., fields: buyerFields },
  { role: 'Seller', name: ..., email: ..., fields: sellerFields },
],
```

But DocuSeal template `4111319` (TREC 20-19) was created with a SINGLE submitter role named `"First Party"`. The submitter-role lookup is case-sensitive — `"Buyer"` ≠ `"First Party"`.

## Fix options

### Option A (recommended): Fix the DocuSeal template

Log into DocuSeal admin (https://docuseal.com/templates/4111319), edit the
template, and rename the roles:
- "First Party" → "Buyer"
- Add second role: "Seller"
- Map all buyer-input fields (signatures, initials, dates) to "Buyer"
- Map all seller-input fields to "Seller"

This is the right long-term fix because TREC 20-19 has TWO signing parties
(buyer + seller). A single "First Party" role can't represent the contract
properly.

### Option B (workaround): Change fill-form.js to match the template

In `api/fill-form.js`, change role names:
```js
submitters: [
  { role: 'First Party', name: buyerName, email: buyerEmail, fields: buyerFields },
],
```

Drop the seller submitter entirely. **DOWNSIDE:** seller can't sign the
contract through DocuSeal. Only suitable if Phase 1 fill-and-sign is
buyer-side only.

### Option C: Check the template and adapt code dynamically

Before the submission POST, fetch the template via:
```
GET https://api.docuseal.com/templates/{id}
```
to get the actual roles defined. Then map buyer/seller to the template's
actual role names. Fallback: if only one role exists, send only the buyer.

## Audit other forms too

Each DocuSeal template ID in `fill-form.js` may have a similar mismatch.
Other env vars / template IDs to test:
- `DOCUSEAL_TREC_20_19_TEMPLATE_ID = 4111319` (verified broken)
- And whatever templates back: financing addendum, termination notice,
  wire fraud warning, HOA addendum, lead paint, etc.

Run an integration test that hits `/api/fill-form` for each `form_type`
with minimal field values and asserts 200. The 422 here is silent —
nobody noticed.

## How to verify

After the fix (Option A) lands:
```bash
curl -X POST https://meetdossie.com/api/fill-form \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -H "Origin: https://meetdossie.com" \
  -d '{
    "transaction_id": "807dd591-d589-4019-89cf-3a805e14d421",
    "form_type": "resale-contract",
    "field_values": {
      "buyer_name": "James and Laura Bennett",
      "sale_price": 425000
    }
  }'
# Expect 200 with documentId, storagePath, signedUrl, submissionId, signers
```

Visual verify: fetch the signedUrl, render the PDF, check that:
- Buyer name is filled in
- Sale price is filled in
- Page count is correct (TREC 20-19 is 9 pages)
- No mangled text or rendering errors

## Why this matters

Together with the 401 and dispatcher bugs, this is the THIRD blocker preventing
"voice command → filled TREC contract" from working. All three must be
fixed before Heath has a real fill-and-sign demo.

## Sequencing

This is parallel to the dispatcher fix — should ship in the same staging
push as specs #1, #2. After all three land, the headline feature actually works.
