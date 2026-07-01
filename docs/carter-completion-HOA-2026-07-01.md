# Carter Completion Report — HOA A.3 Parent/Child Gating Fix

## Defect Fixed

**DEFECT 1 (CRITICAL):** A.3 sub-checkbox "does not require updated resale certificate" was CHECKED even though parent A.3 checkbox was UNCHECKED.

**Root cause:** The resale cert checkbox logic was unconditionally executed, independent of the subdivision_method selection. Code path:
`javascript
// OLD (broken)
if (fv.requires_updated_resale_cert === true) {
  safeCheck(form, 'does');
} else {
  safeCheck(form, 'does not require...');  // <-- Always executes
}
`

**Fix applied:** Gate the entire resale cert block on parent selection state:
`javascript
// NEW (fixed)
if (subMethod === 'already_received') {  // <-- Only if A.3 is selected
  if (fv.requires_updated_resale_cert === true) {
    safeCheck(form, 'does');
  } else {
    safeCheck(form, 'does not require...');
  }
}
`

## Files Modified
- **api/fill-form.js** (lines 1471-1480): Added conditional gating

## Verification Completed
- Test render with v3-FHA kitchen-sink fixture (same input as Hadley's audit)
- Result: Both "does" and "does not require" checkboxes are now BLANK when A.3 is not selected ✓
- Test PDF: .tmp/carter-hoa-retest.pdf (rendered to .tmp/carter-hoa-retest-01.png at 200 dpi)

## Commit

Commit: 0cea52b1
- Commit message: "Fix HOA A.3 parent/child checkbox gating — resale cert sub-widgets now gate on A.3 selection"
- Branch: main (auto-pushed from staging merge)
- Change: 1 file changed, 10 insertions(+), 6 deletions(-)

## Next Steps for Hadley

1. Re-audit TREC 36-11 HOA with v3-FHA kitchen-sink fixture
2. Verify A.3 sub-checkbox gating: if A.3 parent is unchecked, both child checkboxes must be blank
3. Confirm all 7 other PASS fields remain unchanged
4. Report: PASS (or FAIL with new defect details)

## Defects NOT Fixed (deferred)

Per Hadley report, Defects 2 and 3 are cosmetic/data-supply issues:
- **Defect 2 (LOW):** Section C fee-cap value overlay is cramped (cosmetic)
- **Defect 3 (LOW):** HOA phone number missing from header (defensible since no phone in fixture)

These are not blocking and were not in the critical-fix list.
