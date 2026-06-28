# TREC 20-18 Validation Pipeline — Handoff (2026-06-28)

This file describes the current state of the TREC 20-18 contract fill pipeline
after Atlas wired Heath's hand-built Layer-3 validator + ground-truth rules
into the existing fill-form path.

---

## Pipeline layers

### Layer 1 — PDF rendering (unchanged)
**Owner:** legacy `api/fill-form.js` (`fillResaleContract`)
**Input:** legacy `fv.*` shape (snake_case friendly keys)
**Output:** filled PDF bytes via pdf-lib at each widget's coordinate.

### Layer 2 — Field mapping (NEW)
**Owner:** `api/_lib/trec-20-18-pipeline.js` → `mapToAssignments(fv, intake)`
**Input:** legacy fv-shape + strict intake (`{financing_type, has_second_buyer, ...}`)
**Output:** canonical `assignments = { fieldId: {value, confidence, matchReason} }`
keyed to `fieldId` values in `scripts/trec-20-18-field-rules.json`.

Key responsibilities:
- §3 sales-price tri-split: `sale_price + loan_amount + down_payment_amt` →
  `sales_price_total + sales_price_cash_portion + sales_price_financing_portion`,
  validator arithmetic-checked 3A + 3B = 3C.
- Conditional gating: cash deals get NO `sales_price_financing_portion`;
  seller/assumption financing deals get NO `add_third_party_financing` checkbox.
- Intake derivation: when caller doesn't supply intake, derive
  `financing_type` / `has_second_buyer` / `has_second_seller` / `hoa_is_subject`
  from the fv values directly.

### Layer 3 — Validation (UNCHANGED — Heath's source of truth)
**Owner:** `scripts/trec-validator.js` → `validate(rules, assignments, intake)`
**Returns:** `{ report, pass, fillable, flags }`

Enforces:
- Confidence floor 0.85 (auto-flag confident-wrong before signing)
- Format/regex per field
- Mutex checkbox groups (only one true)
- 3C = 3A + 3B arithmetic
- Conditional fields stay blank when predicate false
- Derived field auto-compute (page headers, closing-year suffix)
- NO catch-all bucket: every field is PASS | FAIL | SKIP | UNMATCHED

### Layer 4 — Self-correction loop (NEW)
**Owner:** `api/_lib/trec-20-18-pipeline.js` → `validateWithRetry()`
On any FAIL or UNMATCHED flag, re-runs LLM extraction (Opus 4.7) for ONLY
the failing fieldIds, passing each rule's `purpose` + failure `reason` as
context. Max 2 retries per field. NEVER fabricates to pass — surfaces as
UNMATCHED for human review instead. Patches with confidence < 0.85 are
rejected (anti-fabrication floor — see retry test scenario C).

### Layer 5 — Fillable → Legacy fv conversion (NEW)
**Owner:** `api/_lib/trec-20-18-pipeline.js` → `fillableToLegacy()`
After validator passes, translates canonical `fillable` back into the
legacy fv-shape that `fillResaleContract()` expects so the existing pdf-lib
coordinate engine renders unchanged.

---

## How to invoke strict validation

POST `/api/fill-form`:
```json
{
  "transaction_id": "<uuid>",
  "form_type": "resale-contract",
  "field_values": { /* legacy fv shape */ },
  "intake": { "financing_type": "fha", "has_second_buyer": false, ... },
  "strict_validate": true
}
```

- Without `strict_validate:true` the legacy path runs unchanged (back-compat).
- With `strict_validate:true` AND `form_type === 'resale-contract'`, the
  validator runs end-to-end. On pass:true, the fill proceeds. On pass:false,
  the endpoint returns `422` with a structured `validation` object listing
  every FAIL / UNMATCHED fieldId so the caller can surface for human review.
- The success response includes `validation` (null when not requested).

`/api/fill-forms-batch` passes `strict_validate` through ONLY for
`resale-contract` form types. Other forms in the batch (40-11, 36-11, etc.)
fill via the legacy path unchanged.

---

## DocuSeal envelope packaging

DocuSeal remains the e-sign provider. **DO NOT add DocuSign.** After the
validator returns `pass:true` and pdf-lib renders the contract, the existing
DocuSeal envelope flow (`api/fill-form-via-docuseal.js` /
`api/_assets/docuseal-prefill.js`) packages the filled PDF for signature
as before. No changes to that path were needed in this wire-in.

---

## Tests

### Standalone regression (Heath's source of truth)
```
cd scripts && node run-tests.js
```
Asserts all 6 golden cases PASS, broken case FAILS on each injected error.
Exit code: 0 = pass, 1 = regression. **DO NOT MODIFY** the goldens or the
validator; this gate must stay clean for every PR.

### Pipeline integration
```
node scripts/pipeline-integration-test.js
```
Synthesizes legacy fv-shape from each golden, pipes through the Layer-2
mapper + Layer-3 validator, asserts pass:true. Exit code: 0 = pass, 1 = regression.

### Self-correction loop
```
node scripts/pipeline-retry-test.js
```
Three scenarios:
- **A**: extractor repairs the failing field → pass:true after 1 retry.
- **B**: extractor gives up → pass:false, UNMATCHED surfaced (never fabricated).
- **C**: extractor returns low-confidence patch → patch REJECTED, original failure preserved.

Uses a stub extractor — no real Anthropic API call.

### CI
`.github/workflows/trec-validator-tests.yml` runs all three suites on every
push or PR that touches the validator, rules, goldens, pipeline, or fill API.

---

## Hard rules (locked 2026-06-28 by Heath)

- **NO regenerating, rewriting, or "improving"** the rules file or golden
  cases. Use them AS-IS. Heath built them by hand against the real TREC layout.
- **No catch-all notes bucket.** Every widget = CONFIDENT MATCH or explicit UNMATCHED.
- **Never edit bundle files.** Source changes only, rebuild via Vite, deploy to staging FIRST.
- **TREC 20-18 only.** Never 20-17.
- **DocuSeal for signing only.** Do NOT add DocuSign.
- **Never fabricate to pass validation.** Surface UNMATCHED for human review.

---

## Files touched in this wire-in

| File | Status | Purpose |
|---|---|---|
| `scripts/trec-validator.js` | **UNCHANGED** (Heath) | Layer 3 validator (source of truth) |
| `scripts/trec-20-18-field-rules.json` | **UNCHANGED** (Heath) | 263-widget rules file (source of truth) |
| `scripts/golden-case-*.json` (6 files) | **UNCHANGED** (Heath) | Hand-verified regression baselines |
| `scripts/run-tests.js` | **UNCHANGED** (Heath) | Standalone golden + broken suite |
| `scripts/README.md` | **UNCHANGED** (Heath) | Wire-in spec |
| `scripts/pipeline-integration-test.js` | **NEW** | Mapper + validator integration test |
| `scripts/pipeline-retry-test.js` | **NEW** | Self-correction loop test |
| `api/_lib/trec-20-18-pipeline.js` | **NEW** | Layer 2 + 4 + 5 wire-in module |
| `api/fill-form.js` | **MODIFIED** | Opt-in `strict_validate` flag (lines ~2976-3030) |
| `api/fill-forms-batch.js` | **MODIFIED** | Pass-through of `strict_validate` for resale-contract only |
| `.github/workflows/trec-validator-tests.yml` | **NEW** | CI gate |
| `HANDOFF.md` | **NEW** | This file |

---

## Pre/post tags

- `GOLD-20260628-pre-validation-wire` — before this wire-in (pushed by Heath)
- `GOLD-20260628-post-validation-wire` — after this wire-in (pushed by Atlas after staging APV)
