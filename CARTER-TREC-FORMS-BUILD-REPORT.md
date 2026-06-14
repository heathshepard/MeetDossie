# Carter TREC 4-Form Build Report
**Date:** 2026-06-14
**Status:** Field maps COMPLETE, fill functions STAGED, smoke testing PENDING

---

## Summary

All 4 TREC forms have been comprehensively analyzed, field maps created, and placed on `staging` branch. Form fills are currently stubs to prevent crashes on FLAT PDFs.

### Forms Completed

1. **TREC 38-7** Buyer Termination Notice (1 page)
   - Fields: 13 identified
   - Locations: api/_assets/field-maps/trec-38-7-coords.json
   - Status: Field map complete with all blanks identified

2. **TREC 23-20** New Home Incomplete (11 pages)
   - Fields: 46 identified
   - Locations: api/_assets/field-maps/trec-23-20-coords.json
   - Status: Field map complete, PAGE NUMBERS and coordinates estimated

3. **TREC 24-20** New Home Completed (11 pages)
   - Fields: 46 identified
   - Locations: api/_assets/field-maps/trec-24-20-coords.json
   - Status: Field map complete, PAGE NUMBERS and coordinates estimated

4. **TREC 25-17** Farm and Ranch (12 pages)
   - Fields: 50 identified
   - Locations: api/_assets/field-maps/trec-25-17-coords.json
   - Status: Field map complete, PAGE NUMBERS and coordinates estimated

---

## What Was Done

### PDF Content Analysis
- Extracted complete PDF text for all 4 forms using pypdf
- Analyzed 35 pages of TREC forms
- Identified every blank field by reading actual form text

### Field Maps Created
- `api/_assets/field-maps/trec-38-7-coords.json` ✅ COMPLETE
- `api/_assets/field-maps/trec-23-20-coords.json` ✅ COMPLETE
- `api/_assets/field-maps/trec-24-20-coords.json` ✅ COMPLETE
- `api/_assets/field-maps/trec-25-17-coords.json` ✅ COMPLETE

Each field map includes:
- Field logical names (buyer_name, property_address, etc.)
- Page numbers
- Estimated x, y coordinates
- Width/height for text drawing
- Font sizes
- Description and required/optional flags
- Total field count per form

### Supporting Infrastructure
- `api/_assets/flat-pdf-filler.js` - Coordinate-based text drawing utility for FLAT PDFs
- `scripts/extract_trec_full_text.py` - PDF text extraction script
- `scripts/extract_pdf_fields_detailed.py` - PDF structure analysis script
- `scripts/map_trec_fields_from_text.js` - Field map generator

### Documentation
- Full PDF text extracts saved to Engineering/
- TREC field audit reference (Shepard-Ventures/Legal/TREC-Field-Audit.md)

---

## What Remains (Not Yet Implemented)

### Coordinate Refinement Required
The field maps use **estimated coordinates** based on:
- Standard TREC form layout analysis
- PDF text extraction positioning
- Field names and labels from raw PDF text

**These coordinates need visual verification** against actual PDF rendering. Options:
1. Open each PDF in Adobe Reader with measurement tools
2. Use pdf-lib's ability to extract actual widget positions (if any)
3. Smoke test with sample data and visually inspect output

### Fill Function Implementation
Current `fillNewHomeIncomplete()`, `fillNewHomeComplete()`, and `fillFarmRanch()` in `api/fill-form.js` are stubs.

To implement:
```javascript
// Pseudo-code for coordinate-based filling
const { drawTextAtCoords, fillFlatPdfFromMap } = require('./_assets/flat-pdf-filler.js');
const fieldMap = require('./_assets/field-maps/trec-23-20-coords.json');

async function fillNewHomeIncomplete(pdfDoc, fv) {
  await fillFlatPdfFromMap(pdfDoc, fv, fieldMap);
  return pdfDoc;
}
```

---

## Smoke Testing Plan

### Test 1: TREC 38-7 (Simplest)
- Input: buyer_name, seller_name, property_address, contract_date, termination_date
- Output: PDF with text at specified coordinates
- Verification: Open PDF, visually confirm text appears in correct locations

### Test 2: TREC 23-20 (Complex, 11 pages)
- Input: Full transaction data (price, dates, broker info, etc.)
- Output: 11-page PDF with text distribution across pages
- Verification: Spot-check 5-10 key fields for position accuracy

### Test 3: Coordinate Accuracy Adjustment
- If text appears offset, adjust coordinates in field maps
- Record offset delta (e.g., "all y-coords were 20pt too high")
- Re-run tests until positions align

---

## Technical Notes

### FLAT PDF Challenges
- These PDFs have `AcroForm` dict but **zero widget fields**
- No field names to reference (unlike TREC 20-18)
- Must use `page.drawText(text, {x, y, size, font})` at exact coordinates
- pdf-lib's drawText() uses bottom-left origin; designers use top-left
- **Coordinates in field maps are converted** (y_pdf = height - y_design - fontSize)

### TREC Form Generation
- Forms appear to be generated from TREC's template system
- May have been exported from older systems (pre-AcroForm era)
- No significant differences between TREC 23-18 vs 23-20 layout expected
- Form numbering: 23-20 is effective date 05-04-2026

### Field Count Summary
| Form | Pages | Fields | Checkboxes | Text Fields |
|------|-------|--------|-----------|-------------|
| TREC 38-7 | 1 | 13 | 7 | 6 |
| TREC 23-20 | 11 | 46 | ~5 | ~41 |
| TREC 24-20 | 11 | 46 | ~5 | ~41 |
| TREC 25-17 | 12 | 50 | ~6 | ~44 |
| **TOTAL** | **35** | **155** | ~23 | ~132 |

---

## Files Modified/Created

### New Files
- `api/_assets/field-maps/trec-38-7-coords.json`
- `api/_assets/field-maps/trec-23-20-coords.json`
- `api/_assets/field-maps/trec-24-20-coords.json`
- `api/_assets/field-maps/trec-25-17-coords.json`
- `api/_assets/flat-pdf-filler.js`
- `scripts/extract_trec_full_text.py`
- `scripts/extract_pdf_fields_detailed.py`
- `scripts/map_trec_fields_from_text.js`

### Modified Files
- None to `api/fill-form.js` yet (stub functions already exist)

### Branch
- All changes committed to `staging` branch
- Ready for Quinn QA review
- Awaiting coordinate refinement before merge to `main`

---

## Next Steps (Post-Smoke-Test)

1. **Visual PDF Inspection**
   - Open all 4 PDFs in Adobe Reader
   - Use measurement/markup tools to verify field coordinates
   - Document any offset patterns

2. **Coordinate Adjustment**
   - Update field-maps if systematic offsets found
   - Re-test specific fields

3. **Fill Function Implementation**
   - Replace stub implementations with actual drawing code
   - Use `flat-pdf-filler.js` utility

4. **Format Functions**
   - Add formatDate(), formatMoney() calls to match form requirements
   - Example: currency fields need $ symbol and comma formatting

5. **Checkbox Implementation**
   - Current maps have checkbox positions but no drawing logic
   - May need to draw "☒" character or use pdf-lib checkbox support

6. **Testing & QA**
   - Quinn runs full test suite on staging
   - Spot-check 10-15 generated PDFs for position accuracy
   - Flag any systematic issues

7. **Production Merge**
   - Once coordinates verified and functions implemented
   - Merge staging → main
   - Deploy to meetdossie.com

---

## References

- TREC Field Documentation: `Shepard-Ventures/Legal/TREC-Field-Audit.md`
- PDF Text Extracts: `Engineering/*-full-text.json`
- Field Map Specifications: `api/_assets/field-maps/*-coords.json`
- pdf-lib Documentation: https://pdf-lib.js.org/

---

**Report prepared by:** Carter, Head of Product Engineering
**Contact:** Via Telegram to Cole
