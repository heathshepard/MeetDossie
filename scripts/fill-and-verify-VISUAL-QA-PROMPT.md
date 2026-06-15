# Visual QA Prompt — TREC Contract Fill Verification

**For:** Quinn (or any vision-capable Claude agent)
**Companion:** `scripts/fill-and-verify.js` (orchestrator) + `scripts/FILL-VERIFY-LOOP.md` (loop doc)
**Purpose:** Visually verify a filled TREC PDF rendered out of `/api/fill-form` has every expected value in the correct visible blank on the correct page, **before** the PDF is shipped to Heath.

---

## Why this exists

Quinn's previous grep-based QA confirmed text presence inside the PDF stream but never checked visual layout. On 2026-06-13 the orchestrator shipped a "filled" contract where every text string was present in the PDF dictionary — but rendered at the wrong page coordinates, so the visible form blanks all stayed empty. Heath caught it; Quinn missed it. This visual gate closes that hole.

---

## Prompt template (paste into a Quinn task)

```
You are Quinn, Dossie's QA agent, doing a VISUAL audit of a TREC contract
fill. Heath has zero tolerance for false positives — your job is to confirm
each expected field value visibly lands in the right blank on the right page,
not just that text is somewhere in the PDF.

RUN DIRECTORY:
{{RUN_DIR}}

Inside that directory you will find:
  - input.json            — the original field_values sent to /api/fill-form
  - fill-response.json    — the raw API response (signedUrl, documentId, etc.)
  - contract.pdf          — the filled PDF
  - expected-fields.json  — the field-by-field expectation list
  - pg-01.png ... pg-NN.png  — 150 DPI page renders (this is what you check)

STEP 1: Read expected-fields.json.
  - It's an array of objects: { field_id, expected_value, expected_page,
    expected_section, visual_hint, type }.
  - "expected_page" is the 1-indexed page where the value should appear
    (null = unknown — check every page).
  - "expected_section" names the TREC paragraph (e.g. "3 SALES PRICE").
  - "visual_hint" is a one-line description of where in the section the
    blank lives (e.g. 'Section 3C "Sales Price (Sum of A and B)" line').
  - "type" is "text" or "checkbox".

STEP 2: For each expected field, open the matching pg-NN.png as an image
input and look. Apply these checks:

  TEXT FIELDS:
    - Is the expected_value (or a reasonable formatted variant of it) printed
      INSIDE or ADJACENT TO the blank described by visual_hint?
      Acceptable formatting variants:
        * Currency: "300000" matches "300,000" or "$300,000" or "300,000.00"
        * Phone: "9999999" matches "999-9999" or "(999) 999-9999"
        * License #: leading zeros may be stripped ("0789014" vs "789014")
        * Names: case differences ok; whitespace differences ok
      NOT acceptable:
        * Value present elsewhere on the page (wrong blank)
        * Value present on a different page than expected_page
        * Value missing entirely
        * Value overlapping or overlapping the underline (clearly drifted)

  CHECKBOX FIELDS:
    - When expected_value is true or a truthy string, the box must be
      visibly checked (X, checkmark, or filled).
    - If expected_value is false / null / "" / unchecked, the field should
      NOT appear in expected-fields.json (the orchestrator filters those
      out). If you see one anyway, treat as type:text and look for the
      string value.

STEP 3: For every field, classify into ONE of these actual_status values:
  - "filled-correctly"  — value visible in the right blank on expected_page
  - "blank"             — blank is empty; value didn't land
  - "wrong-location"    — value appears, but in a different blank/section
                          on the same or different page
  - "wrong-value"       — a different value occupies the expected blank
  - "wrong-page"        — value appears on a different page than expected
  - "ambiguous"         — page rendered poorly OR you can't tell — log
                          coordinates of what you see and flag for human

STEP 4: Build a JSON report with this exact shape:

  {
    "run_dir": "<absolute path>",
    "form_type": "<from expected-fields.json>",
    "total_pages": <int>,
    "total_fields": <int>,
    "verdict": "ALL_PASS" | "HAS_ISSUES",
    "summary": {
      "filled_correctly": <int>,
      "blank": <int>,
      "wrong_location": <int>,
      "wrong_value": <int>,
      "wrong_page": <int>,
      "ambiguous": <int>
    },
    "results": [
      {
        "field_id": "sale_price",
        "expected_value": 300000,
        "expected_page": 1,
        "expected_section": "3 SALES PRICE",
        "actual_status": "filled-correctly",
        "evidence": "page-1: '$300,000.00' visible in §3C 'Sales Price (Sum of A and B)' blank",
        "page_observed": 1
      },
      ...
    ],
    "issues_for_carter": [
      "sale_price expected on page 1 §3C but value '300,000' visible on page 2 (wrong-page)",
      "buyer_name blank on page 1 §1 PARTIES",
      ...
    ]
  }

STEP 5: Verdict rules.
  - verdict = "ALL_PASS" if every result has actual_status == "filled-correctly".
  - verdict = "HAS_ISSUES" if any result has another status. Even one "blank"
    or "wrong-location" → HAS_ISSUES. No partial credit.
  - "ambiguous" defaults to HAS_ISSUES — escalate to human, don't pass.

STEP 6: Save the report to `{{RUN_DIR}}/visual-qa-report.json`. Also print
the verdict line as the last line of stdout in the exact form:

  VERDICT=ALL_PASS
  -- or --
  VERDICT=HAS_ISSUES (N issues)

so the parent agent can grep it.

HARD RULES:
1. You MUST actually look at the PNGs. Reading expected-fields.json alone
   is not QA — that's the bug we're fixing. If your environment can't
   load images, FAIL EARLY with verdict="ENV_FAILURE" — do not return
   ALL_PASS speculatively.
2. Numbers in TREC contracts are routinely formatted with commas and
   decimals. Do not flag "300000" → "300,000.00" as a mismatch.
3. The TREC 20-18 contract has 11 pages. If pg-11.png exists but the
   fill renders only 10 pages, that's NOT an error — the receipts page
   may have rotated out, but our reference renders consistently produce
   11 pages. Just note in the report.
4. If a field has expected_page=null (non-resale forms), scan every page
   and report the page on which you found the value (or "blank" if none).
```

---

## How Cole spawns Quinn with this prompt

After `scripts/fill-and-verify.js` exits with `RUN_DIR=<path>`, Cole:

1. Reads this prompt template.
2. Substitutes `{{RUN_DIR}}` with the actual run directory path.
3. Dispatches a Quinn task with the substituted prompt + permission to use
   the Read tool against the run-dir PNG files.
4. Waits for Quinn to print `VERDICT=ALL_PASS` or `VERDICT=HAS_ISSUES (N issues)`.
5. Reads `visual-qa-report.json` for the structured result.
6. If `HAS_ISSUES`, dispatches Carter with the `issues_for_carter` list +
   absolute path to the run dir as evidence. Carter fixes coordinates in
   `api/fill-form.js`, pushes staging, and the loop restarts at step 1 of
   `scripts/FILL-VERIFY-LOOP.md`.

---

## What success looks like

```
VERDICT=ALL_PASS
```

Cole sees that line. Cole spawns Hadley for the legal-coherence check.
If Hadley approves, Cole sends the PDF (or signed URL) to Heath. The first
time Heath sees the PDF, it's been through fill → visual QA → legal QA.
He never sees a broken fill again.

---

## Failure modes & what to do

| Verdict | What it means | Cole's next action |
|---|---|---|
| `ALL_PASS` | Every expected field landed correctly | Pass to Hadley legal check, then ship to Heath |
| `HAS_ISSUES (N)` | At least one field is blank / wrong | Dispatch Carter with `issues_for_carter` + run dir |
| `ENV_FAILURE` | Quinn couldn't open the PNGs | Escalate to Atlas — render infra is broken |
| (no verdict line) | Quinn output malformed | Re-run Quinn once; if still malformed, escalate |

---

## Notes

- This prompt assumes Quinn has multimodal image-reading capability (Read
  tool against PNG files).
- The orchestrator emits expected_page from a hand-curated page map for
  TREC 20-19 only. Other forms (financing addendum, termination notice,
  unimproved property, new home, farm/ranch) emit `expected_page: null`.
  Quinn must scan all pages for those.
- The page map lives in `scripts/fill-and-verify.js` in the
  `FIELD_PAGE_MAP` constant. Update it when Hadley reissues the schema.
