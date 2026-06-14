# Quinn -> Carter: Stage enum drift — DB has 7 stage variants, chat.js defines 9 different ones

**Severity:** HIGH — pipeline display and TREC deadline calculation rely on stages.

## Bug

The `transactions.stage` column has no enforced enum. Different writers use different conventions:

**DB stages (current state — Sarah's demo data):**
- `closed`
- `clear-to-close` (hyphen)
- `clear_to_close` (underscore) — SAME meaning, different format
- `pre-listing`
- `pre-contract`
- `under-contract` (hyphen)
- `under_contract` (underscore) — SAME meaning, different format

**Chat.js canonical list (9 stages):**
- `pre-contract`, `active-listing`, `under-contract`, `option-period`, `inspection`, `financing`, `title-survey`, `clear-to-close`, `closed`

**Mismatches:**
- DB has `pre-listing` — not in chat list. Chat would use `active-listing` instead.
- DB has BOTH `clear-to-close` AND `clear_to_close` for same logical stage.
- DB has BOTH `under-contract` AND `under_contract`.
- Chat's `option-period`, `inspection`, `financing`, `title-survey`, `active-listing` — **NONE appear in DB rows**.

## Impact

- Agent says "move to option period" → Dossie returns `advance_stage stage: option-period` → DB stores `option-period` → UI may not render correctly (probably renders, but searches may miss).
- DB rows with `clear_to_close` (underscore) won't match DB rows with `clear-to-close` (hyphen) in any UI filter that's case-sensitive.
- Pipeline display logic may treat `pre-listing` and `pre-contract` as different stages when they're functionally similar.
- TREC deadline computation looks for specific stages (`under-contract` for option period start). If the row has `under_contract`, deadlines won't fire.

## Investigation steps

1. Run a SQL audit: `SELECT stage, COUNT(*) FROM transactions GROUP BY stage ORDER BY count DESC;`
2. Find the writers for each format:
   - `pre-listing` — likely the dossier-create flow used a different default
   - `_` variants — likely an older migration or seed script
   - Test rows from Brittney's account
3. Cross-reference each stage with the chat.js canonical list. Pick a winning format per logical stage.

## Fix

### Phase 1: Migration

Normalize all DB rows:
```sql
UPDATE transactions SET stage = 'clear-to-close' WHERE stage = 'clear_to_close';
UPDATE transactions SET stage = 'under-contract' WHERE stage = 'under_contract';
UPDATE transactions SET stage = 'active-listing' WHERE stage = 'pre-listing';
```

Add a CHECK constraint:
```sql
ALTER TABLE transactions
  ADD CONSTRAINT transactions_stage_valid CHECK (
    stage IN ('pre-contract','active-listing','under-contract','option-period',
              'inspection','financing','title-survey','clear-to-close','closed','terminated')
  );
```

(Or use a PostgreSQL ENUM type if more stability is desired.)

### Phase 2: Backend validation

In `api/chat.js` or wherever stage updates land, validate against the canonical list. Reject mismatches with 400 + sanitized message.

### Phase 3: Frontend dispatcher

The `advance_stage` dispatcher in the workspace bundle just passes through whatever Dossie returns. Add client-side normalization too:
```js
const STAGE_NORMALIZE = {
  'clear_to_close': 'clear-to-close',
  'under_contract': 'under-contract',
  'pre-listing': 'active-listing',
  // ...
};
const canonicalStage = STAGE_NORMALIZE[input] || input;
```

### Phase 4: TREC deadline computation

Audit the TREC deadline calculation to make sure it queries the canonical stage names. Cross-reference: which stages drive the option-period clock start? The contract-effective-date? Verify each handler.

## Why this matters

When Heath demos: "Watch — I'll say 'we just got into option period' and Dossie will mark it." If Dossie writes `option-period` and the UI shows nothing visibly different (because no row currently uses that stage), Heath looks like he's hallucinating. If the DB silently accepts a non-canonical value, the deal becomes invisible to the pipeline filter.

This is a quiet data integrity issue that doesn't surface as a hard error — it just creates "Dossie doesn't seem to do anything" moments.

## Sequencing

Low urgency relative to the chat 401, dispatcher, and field-map bugs. But MUST be cleaned up before launching to non-demo paying users — or Brittney's deals will end up with mixed stage formats.
