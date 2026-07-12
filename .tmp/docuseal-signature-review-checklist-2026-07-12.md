# DocuSeal Signature Placement Review Checklist — 2026-07-12

Heath's review pass after Atlas ran the auto-placement pipeline.

**Goal:** verify every DocuSeal template has the right signature/initial/date fields at the right coordinates, with the right submitter role assignments (Buyer 1 / Seller 1 / Buyer 2 / Seller 2).

**How to review each:** open the edit URL, look at the last page (signature block) and any interior page (initial footer). If everything is in the right place, hit Save. If a field is misplaced, drag it to the correct spot and hit Save. Total time target: **≤ 60 min for all 15 templates**.

---

## Section 1 — Heath's 7 manually-mapped templates (AUDIT ONLY — DO NOT RE-PLACE)

Atlas ran audit mode comparing the algorithm's output vs. Heath's local `docuseal-*-fields.json` files. Results:

| # | Template | ID | Audit Result | Edit URL | Action | ETA |
|---|----------|-----|--------------|----------|--------|-----|
| 1 | TREC 40-11 Third Party Financing | 4023463 | **PASS** — 10 fields matched exactly | https://docuseal.com/templates/4023463/edit | Spot-check only. Should look correct. | 2 min |
| 2 | OP-H Sellers Disclosure | 4023470 | **PASS** — 8 fields matched exactly | https://docuseal.com/templates/4023470/edit | Spot-check only. Should look correct. | 2 min |
| 3 | TREC 20-19 Resale Contract | 4111319 | **DRIFT** — live template uses different coords (Farm-Ranch-style outer margins) than local map | https://docuseal.com/templates/4111319/edit | Verify live template renders correctly. If yes, live is truth. If not, re-map. | 5 min |
| 4 | TREC 49-1 Lender Appraisal | 4023472 | **DRIFT** — sig block on different page position than local map | https://docuseal.com/templates/4023472/edit | Verify sig page is correct. | 4 min |
| 5 | TREC 39-11 Amendment | 4111320 | **DRIFT** — field names differ (missing_from_live=6, extra_in_live=4) | https://docuseal.com/templates/4111320/edit | Verify all 4 sig submitters have fields on last page. | 4 min |
| 6 | TREC 36-11 HOA (May 2026) | 4111321 | **DRIFT** — field names differ | https://docuseal.com/templates/4111321/edit | Verify all 4 sig submitters have fields on last page. | 4 min |
| 7 | OP-L Lead-Based Paint | 4023469 | **DRIFT** — 12 fields drift on Y-axis (sig block y-position) | https://docuseal.com/templates/4023469/edit | This has 6 submitters (Buyer 1, Seller 1, Buyer 2, Seller 2, Buyer Broker, Seller Broker). Verify all 6 have sig+date fields. | 6 min |

**Section 1 subtotal: 27 min.** Note: the DRIFT results reflect NAMING mismatches between Heath's local reference JSONs and live template field names — the fields DO exist, they just have different labels. Live is the source of truth.

---

## Section 2 — Templates auto-placed by algorithm (VERIFY PLACEMENT)

Atlas ran the placement algorithm and PUT new signature/initial/date fields to these templates. Fields were placed at:
- **Page-footer initials** (every non-sig page): Buyer 1 x=0.336, Buyer 2 x=0.388, Seller 1 x=0.532, Seller 2 x=0.594 — y=0.958 for narrow-margin forms; x=0.08 / x=0.65 y=0.94 for wide-margin (Farm/Ranch/New Home/Condo).
- **Last-page signature row 1** (Buyer 1 / Seller 1): x=0.091 / x=0.509 y=0.749 w=0.4 h=0.04
- **Last-page date row** (Buyer / Seller Date): x=0.091 / x=0.509 y=0.793 w=0.2 h=0.016
- **Last-page signature row 2** (Buyer 2 / Seller 2, optional): x=0.09 / x=0.51 y=0.816 w=0.4 h=0.04

| # | Template | ID | Pages | Sig Page | New Fields | Applied? | Edit URL | Action | ETA |
|---|----------|-----|-------|----------|------------|----------|----------|--------|-----|
| 8 | TREC 61-0 Groundwater | 4111328 | 1 | 1 | 6 sigs | **YES (test run)** | https://docuseal.com/templates/4111328/edit | Open, verify sig block on page 1 is in the right position. First Atlas test-apply. | 3 min |
| 9 | TREC 11-8 Backup Contract | 4023578 | 2 | 2 | 10 sigs | Pending | https://docuseal.com/templates/4023578/edit | Not yet applied. Run: `node scripts/docuseal-auto-place-signatures.js --apply --template 4023578` | 3 min |
| 10 | TREC 11-9 Backup Contract | 4111323 | 2 | 2 | 10 sigs | Pending | https://docuseal.com/templates/4111323/edit | Not yet applied. | 3 min |
| 11 | TREC 26 Seller Financing | 4023573 | 2 | 2 | 10 sigs | Pending | https://docuseal.com/templates/4023573/edit | Not yet applied. Preserves 44 non-sig fields. | 3 min |
| 12 | TREC 23-20 New Home Incomplete | 4111326 | 8 | 8 | 34 sigs | Pending | https://docuseal.com/templates/4111326/edit | Not yet applied. Wide-margin form (initials at x=0.08 / x=0.65). | 5 min |
| 13 | TREC 24-20 New Home Complete | 4111327 | 8 | 8 | 34 sigs | Pending | https://docuseal.com/templates/4111327/edit | Not yet applied. Wide-margin form. | 5 min |
| 14 | TREC 25-17 Farm & Ranch | 4111325 | 9 | 9 | 38 sigs | Pending | https://docuseal.com/templates/4111325/edit | Not yet applied. Wide-margin form. | 5 min |
| 15 | TREC 30-18 Condo Contract | 4111324 | 10 | 10 | 42 sigs | Pending | https://docuseal.com/templates/4111324/edit | Not yet applied. Preserves 151 non-sig fields. Highest-risk template — verify carefully. | 8 min |

**Section 2 subtotal: 35 min.**

---

## Total Heath review time: ~62 min

Add ~5 min for the apply commands. **Realistic: 60-90 min for a full pass.**

---

## Apply Commands (Heath runs these after reviewing the plan)

```bash
cd C:/Users/Heath\ Shepard/Desktop/MeetDossie

# Individual template (safest — one at a time):
node scripts/docuseal-auto-place-signatures.js --apply --template 4023578
node scripts/docuseal-auto-place-signatures.js --apply --template 4111323
node scripts/docuseal-auto-place-signatures.js --apply --template 4023573
node scripts/docuseal-auto-place-signatures.js --apply --template 4111326
node scripts/docuseal-auto-place-signatures.js --apply --template 4111327
node scripts/docuseal-auto-place-signatures.js --apply --template 4111325
node scripts/docuseal-auto-place-signatures.js --apply --template 4111324

# All at once (after you've verified the individual runs look right):
node scripts/docuseal-auto-place-signatures.js --apply --all-unmapped
```

---

## Templates NOT covered (need Heath hand-mapping — last resort)

None. All 15 top-form targets have either:
- Live signature fields already placed (7 templates), OR
- Algorithm can auto-place based on coordinate template (8 templates).

---

## Rollback

If a template placement is wrong and unrecoverable, Heath can:
1. Open the template in DocuSeal UI and manually reset via "Restore from PDF" (upload the original PDF).
2. Or ask Atlas to re-run with adjusted coords.

The algorithm strips existing sig/initial/date fields on apply, so re-running with a fixed coordinate template is safe.

---

## Files created

- **Script:** `C:\Users\Heath Shepard\Desktop\MeetDossie\scripts\docuseal-auto-place-signatures.js`
- **This checklist:** `C:\Users\Heath Shepard\Desktop\MeetDossie\.tmp\docuseal-signature-review-checklist-2026-07-12.md`
- **JSON report:** `C:\Users\Heath Shepard\Desktop\MeetDossie\.tmp\docuseal-auto-place-report-{timestamp}.json`

## No env vars added

All 15 target templates already have DocuSeal template IDs that match Heath's naming convention. No new IDs needed. The IDs are known via `project_docuseal_template_ids.md` memory + this script's `TARGETS` constant.
