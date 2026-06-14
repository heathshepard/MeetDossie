# PHASE 1A-BIS STATUS (2026-06-14)

## Commits on staging

1. **40ad881** — Replace flat base64 PDFs + remove DocuSeal route
   - TREC 20-19: 0 → 257 AcroForm fields
   - TREC 40: 0 → 64 AcroForm fields  
   - TREC 38: 0 → 14 AcroForm fields
   - Removed DocuSeal route: resale now uses pdf-lib

2. **b3310dd** — Fix TREC 9-17 buyer/seller inversion
   - Swapped buyer_name and seller_name in PARTIES section

## Remaining blockers

- TREC 9-17, 23-20, 24-20, 25-17: Source PDFs not found in Dossie Forms folder
- Need to source these from TREC or skip Phase 1A-bis completion for these forms

## Expected improvements

- Resale contracts: Now has proper PDF with 257 fields (was DocuSeal with 0 data fields)
- Financing addendum: Field names should now match; field map isolation still pending review
- Termination notice: Field names corrected; buyer/seller should separate correctly  
- Unimproved property: Buyer/seller inversion fixed; but PDF still unknown AcroForm status

## Next: Quinn testing

Ready for full E2E test run on staging deployment.
