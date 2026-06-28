# TREC 20-18 Fill Validation System — Ground Truth Artifacts

These are the **domain-knowledge artifacts** for the contract fill pipeline. They are
hand-built against the real TREC 20-18 layout, not inferred by an agent. Cole wires
them into the existing pipeline; he does NOT regenerate them.

## Files

**trec-20-18-field-rules.json** — All 263 widgets mapped to real legal intent.
Each field has: internalName (the inventory key), fieldId (Dossie canonical id),
page, valueType, purpose, paragraph, format, conditional, crossRef, group, fillPriority.
- `fillPriority`: core | conditional | derived | broker | receipt | signature | ignore
- `conditional`: predicate string — field fills ONLY when true (e.g. `financing_type == 'seller'`)
- `crossRef`: cross-field rule — `MUTEX(...)`, `MUST_EQUAL(...)`, `DERIVE_FROM(...)`

**trec-validator.js** — Layer 3. `validate(rules, assignments, intake)` returns
`{ report, pass, fillable, flags }`. Enforces:
- Confidence floor 0.85 (auto-flag confident-wrong before it gets signed)
- Format/regex per field
- Mutex checkbox groups (only one true)
- 3C = 3A + 3B arithmetic
- Conditional fields stay blank when predicate false (the #1 TREC failure mode)
- Derived fields (page headers, closing-year suffix) auto-computed
- NO catch-all bucket: every field is PASS | FAIL | SKIP | UNMATCHED

**golden-case-conventional.json** — Hand-verified correct offer. This is the
regression baseline. Every pipeline change MUST keep this at `pass: true`.

**run-tests.js** — Runs golden (must PASS) + broken (must FAIL on each injected error).

## How Cole wires it in

1. Layer 2 (mapper) outputs `assignments = { fieldId: {value, confidence, matchReason} }`
   using the `internalName`→`fieldId` map from the rules file + coordinate engine.
2. Pass that + intake into `validate()`.
3. On any FAIL/UNMATCHED flag → re-run mapping for ONLY those fieldIds, injecting the
   rule `purpose` + failure `reason` as context. Max 2 retries. Never fabricate to pass.
4. When `pass: true`, render `fillable` via pdf-lib at each field's `coords`,
   then package as DocuSeal envelope. DocuSeal for signing only — do NOT add DocuSign.

## Rules
- TREC 20-18 only (FinCEN Para 20B). Never 20-17.
- Add new golden cases per financing type (cash, FHA, VA, seller, assumption) over time.
- Atlas runs visual verification after render.
