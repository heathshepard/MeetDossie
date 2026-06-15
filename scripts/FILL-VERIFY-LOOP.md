# Fill-and-Verify Loop — Closed-Loop TREC Contract Fill Pipeline

**Owner:** Atlas (infra) + Cole (orchestration) + Quinn (visual QA) + Carter (code fixes) + Hadley (legal coherence)
**Shipped:** 2026-06-14 (Atlas)
**Status:** Live on `staging` branch
**Trigger:** Any time Heath asks Dossie to fill a TREC contract end-to-end

---

## Why this loop exists

On 2026-06-13 Cole shipped Heath a "filled" TREC contract that looked broken on screen. Investigation showed every expected text string was present inside the PDF object stream — Quinn's grep-style QA said the file was fine — but the strings rendered at wrong page coordinates, so every visible form blank stayed empty. Quinn passed it. Heath caught it.

The fix is a closed loop: every fill gets rendered to images and visually checked **before** Heath sees it. No more grep-only QA. No more "text is in there somewhere" passes.

---

## The loop (7 steps)

```
1. Cole writes input JSON
2. Run scripts/fill-and-verify.js → produces run dir with pdf + 11 pngs + expected.json
3. Cole spawns Quinn with the Visual QA prompt + run dir path
4. Quinn returns ALL_PASS or list of issues
5. If issues, Cole spawns Carter with the issue list + run dir → Carter fixes coordinates in api/fill-form.js → pushes staging → loop back to step 2
6. After ALL_PASS, Cole spawns Hadley for legal coherence check
7. If Hadley approves, Cole sends PDF to Heath
```

**MAX_ITERATIONS = 5.** If the loop hasn't reached ALL_PASS after 5 trips through Carter, Cole escalates to Heath with the run dirs and the final issues list. Don't grind forever.

---

## Step-by-step playbook

### Step 1 — Cole writes input JSON

Cole drafts a `field_values` payload based on Heath's intent. The minimal shape:

```json
{
  "form_type": "resale-contract",
  "field_values": {
    "buyer_name": "Joe Shmo",
    "seller_name": "Janette Lunss",
    "sale_price": 300000,
    "earnest_money": 3000,
    "option_fee": 100,
    "option_period_days": 10,
    "...": "..."
  }
}
```

Save under `.tmp-fill-verify/inputs/<deal-slug>.json` (the orchestrator copies the input into the run dir, so it's archived per run). Use the field IDs from Hadley's schema (`Shepard-Ventures/Legal/dossie-fill-system/trec-20-19-field-schema.md`).

### Step 2 — Run the orchestrator

```bash
node scripts/fill-and-verify.js .tmp-fill-verify/inputs/<deal-slug>.json --label <slug>
```

Or inline:

```bash
node scripts/fill-and-verify.js --inline '{"form_type":"resale-contract","field_values":{...}}' --label <slug>
```

The script:
- Signs in to Supabase as `demo@meetdossie.com`
- POSTs to `https://meetdossie.com/api/fill-form` with `strict:true`
- Downloads the signed-URL PDF
- Renders every page at 150 DPI to `pg-NN.png` via Poppler `pdftoppm`
- Emits `expected-fields.json` cross-referenced to Hadley's page map
- Prints `RUN_DIR=<absolute path>` as the last stdout line

Exit code 0 means infra succeeded — visual QA still needs to run.

### Step 3 — Cole spawns Quinn with the Visual QA prompt

Cole reads `scripts/fill-and-verify-VISUAL-QA-PROMPT.md`, substitutes `{{RUN_DIR}}` with the run path from step 2, and dispatches a Quinn task. Quinn must have multimodal image-reading capability (Read tool against PNG files).

### Step 4 — Quinn returns verdict

Quinn writes `visual-qa-report.json` into the run dir and prints either:

```
VERDICT=ALL_PASS
```

or

```
VERDICT=HAS_ISSUES (N issues)
```

Cole reads the report. If ALL_PASS, skip to step 6. Otherwise step 5.

### Step 5 — Carter fixes and reships

Cole dispatches Carter with:
- The full `issues_for_carter` array from Quinn's report
- The absolute path to the run dir (Carter can look at the PNGs himself to confirm what Quinn flagged)
- The current `api/fill-form.js` field-map area for the affected form type

Carter:
- Edits coordinates / field-name routing in `api/fill-form.js`
- Commits to `staging`
- Pushes (Vercel auto-deploys to Preview URL)
- Tells Cole the new staging URL OR confirms the prod URL is updated

Cole jumps back to step 2 with the same input JSON (regenerating from the same input is the whole point — fixed code, same input, see if the visible output is now correct).

### Step 6 — Hadley legal coherence check

After ALL_PASS, Cole spawns Hadley with:
- The run dir path (so Hadley can read the PDF + page renders)
- The original input JSON

Hadley checks for things grep + visual QA can't:
- Buyer/seller name consistency across all pages
- Sale price math (3A + 3B = 3C)
- Earnest money / option fee compliance
- Addendum checkboxes match what the contract demands (financing addendum if financed, lead paint if pre-1978, etc.)
- TREC paragraph references are internally consistent

Hadley returns `LEGAL_APPROVED` or `LEGAL_ISSUES` with a list. `LEGAL_ISSUES` → back to Carter (step 5).

### Step 7 — Ship to Heath

Cole sends Heath the signed URL OR the PDF directly via Telegram. The first PDF Heath ever sees has been through fill → visual QA → legal check. He should never see a broken fill again.

---

## File layout per run

```
.tmp-fill-verify/
  inputs/                              (optional — Cole's input JSONs by deal slug)
    joe-shmo.json
    sarah-jones.json
  run-<timestamp>-<label>/              (orchestrator output)
    input.json                          (echo of caller payload)
    fill-response.json                  (raw /api/fill-form response — has signedUrl, documentId)
    contract.pdf                        (downloaded filled PDF)
    expected-fields.json                (field → page → section → visual_hint)
    pg-01.png ... pg-NN.png             (150 DPI page renders)
    visual-qa-report.json               (Quinn writes this)
    legal-review.json                   (Hadley writes this, optional)
    run.log                             (orchestrator timing log)
```

---

## Constraints baked in

- **Production rate limit:** `scripts/fill-and-verify.js` calls the live `/api/fill-form` exactly once per invocation. Each call is a real Supabase Storage write — don't loop the orchestrator more than 5 times per Heath-facing build session.
- **Strict mode only:** the orchestrator hard-codes `strict:true` so transaction-row defaults can't leak into the test fills. Caller `field_values` are the ONLY data written.
- **Demo transaction:** the orchestrator uses `807dd591-d589-4019-89cf-3a805e14d421` (demo@meetdossie.com's seeded deal). Don't change this without updating the page map.
- **Page map source of truth:** `FIELD_PAGE_MAP` in `scripts/fill-and-verify.js`. Updated when Hadley reissues `trec-20-19-field-schema.md`.

---

## When to skip the loop

You don't skip the loop for production sends. But you can skip the loop for:
- Atlas infra probes that don't ship to Heath
- Quinn's own E2E smoke tests where she's checking the fill code path itself
- Carter sanity-checking a quick coordinate fix before committing

Anything Heath will see goes through the loop. Period.

---

## Failure escalation

| Failure point | Who fixes |
|---|---|
| `/api/fill-form` returns 500 / 502 | Atlas (production infra) |
| `pdftoppm` not found / render exit≠0 | Atlas (re-install Poppler) |
| Quinn can't read PNGs | Atlas (image-tool permissions) |
| Quinn returns ALL_PASS on broken fill | Atlas + Quinn (tighten prompt) |
| Coordinates wrong → blank field | Carter (fix `api/fill-form.js`) |
| Field map outdated → wrong section assigned | Atlas (update `FIELD_PAGE_MAP`) |
| Legal coherence error | Hadley flags → Carter fixes |
| 5 iterations no improvement | Cole escalates to Heath |

---

## Files

- `scripts/fill-and-verify.js` — orchestrator
- `scripts/fill-and-verify-VISUAL-QA-PROMPT.md` — Quinn's prompt template
- `scripts/FILL-VERIFY-LOOP.md` — this doc

## See also

- `Shepard-Ventures/Legal/dossie-fill-system/trec-20-19-field-schema.md` — Hadley's authoritative field map (91 fields, page assignments)
- `api/fill-form.js` — the fill function Carter owns
- `Shepard-Ventures/Engineering/INDEX.md` — `SV-ENG-FORMFILL-001-2026-06-13` work stream
- `scripts/MERGE-GATE.md` — broader pre-merge T00 app-pages smoke gate (orthogonal but parallel; both gates must pass before any contract-fill ship that touches the app bundle)

---

**Last updated:** 2026-06-14 (Atlas), shipped on `staging` branch.
