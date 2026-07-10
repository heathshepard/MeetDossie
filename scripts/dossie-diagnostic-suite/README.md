# Dossie End-to-End Diagnostic Suite

**Owner:** Ridge. Coordinates 5 scenario runs verifying every user-facing capability of Dossie works correctly, end-to-end, from a REALTOR's perspective.

**Spec:** `.tmp/comprehensive-dossie-diagnostic-prompt-2026-07-09.md`

## Runs

Phase B (Runs 2-5) verifies T1/T2/T2f/T2g/T4 depth per run. PDF field verification (T3) delegates to Hadley. Signer/esign (T5-T9) is Phase C.

| Run | File | Contract | Property | Status |
|---|---|---|---|---|
| 1 | `run1-buyer-purchase.js` | TREC 20-19 | 1247 Sample Way — buyer | Phase A |
| 2 | `run2-seller-listing.js` | TREC 20-17 (Listing) | 1247 Sample Way — seller | Phase B |
| 3 | `run3-new-construction.js` | TREC 23-15 | 512 Maple Bend | Phase B |
| 4 | `run4-farm-ranch.js` | TREC 25-15 | Tract 5 County Rd 402 | Phase B |
| 5 | `run5-residential-lease.js` | TAR 2001 | 8934 Oakview Dr | Phase B |

Phase B runs share a common runner (`_lib/scenario-runner.js`) driven by a per-scenario config in each `runN-*.js`.

## Shared helpers

- `_lib/signin.js` — Playwright sign-in helper (demo@meetdossie.com)
- `_lib/talk-to-dossie.js` — invokes Talk to Dossie chat panel + waits for tool result
- `_lib/verify-pdf.js` — downloads filled PDF, renders pages via pdftoppm, returns paths
- `_lib/incident-log.js` — records failures into `customer_experience_incidents` Supabase table
- `_lib/config.js` — base URL + credentials + output paths

## Environment

```bash
# Choose base URL
BASE_URL="https://meetdossie.com"                           # prod
BASE_URL="https://<preview>.vercel.app"                     # staging preview

# Credentials
APV_EMAIL="demo@meetdossie.com"
APV_PASSWORD="<DEMO_PASSWORD from Vercel env>"
SUPABASE_SERVICE_ROLE_KEY="<...>"                           # for incident logging

# Output
OUT_DIR=".tmp/dossie-diagnostic-suite/run-<N>"
```

## Running Run 1

```bash
# Against staging preview (has round-6 fill handler)
node scripts/dossie-diagnostic-suite/run1-buyer-purchase.js \
  --base "https://meet-dossie-9ud3l1gts-heathshepard-6590s-projects.vercel.app"

# Against prod (only after staging → main merge for round-6 fill handler)
node scripts/dossie-diagnostic-suite/run1-buyer-purchase.js \
  --base "https://meetdossie.com"
```

## Watch-and-fix protocol

1. Screenshot the failure state → `.tmp/dossie-diagnostic-suite/run-<N>/incident-<n>.png`
2. Log to `customer_experience_incidents` Supabase table (severity: critical/high/medium/low)
3. Spawn Carter to draft fix
4. Spawn Atlas to ship through two-gate merge (Hadley APV gate for any fill-form changes)
5. Re-run failing step until clean

## Report format per run

```json
{
  "run": 1,
  "name": "Buyer Purchase (Single-Family Resale)",
  "base_url": "...",
  "started_at": "...",
  "finished_at": "...",
  "verdict": "PASS | FAIL",
  "test_points": [
    { "id": "T1-signin", "verdict": "PASS", "detail": "..." },
    { "id": "T2-create-dossier", "verdict": "PASS", "screenshot": "...", "tool_result": {...} },
    { "id": "T3-fill-20-19", "verdict": "PASS", "pages_rendered": 12, "footer_stamp": "TREC NO. 20-19", "receipts_blank": true },
    ...
  ],
  "console_errors": [],
  "page_errors": [],
  "incidents": []
}
```
