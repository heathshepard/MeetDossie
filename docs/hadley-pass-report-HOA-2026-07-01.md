# Hadley_3 APV Report — TREC 36-11 Addendum for Property Subject to Mandatory Membership in a Property Owners Association (HOA)

**Report date:** 2026-07-01
**Reviewer:** Hadley_3 (clone spawned 2026-07-01 11:41 CDT for parallel TREC audit)
**Form audited:** TREC 36-11 HOA Addendum (DocuSeal template 4111321)
**PDF audited:** `C:\Users\Heath Shepard\Desktop\MeetDossie\.tmp\v3-fha-verify\hoa-addendum.pdf`
**PDF timestamp:** 2026-07-01 06:41 (most recent PROD render from v3-FHA "kitchen sink" test)
**Rendered page:** `C:\Users\Heath Shepard\Desktop\MeetDossie\.tmp\hadley-audit-2026-07-01\hoa-addendum-1.png` @ 200dpi
**Extracted text:** `.tmp/v3-fha-verify/hoa-addendum.txt`
**Merged fields fed to fill pipeline:** `.tmp/v3-fha-verify/merged-fields.json` (43 keys, HOA-relevant: 6)
**Test prompt used:** v3-FHA "kitchen sink" per `reference_master_prompts_critical.md`
**Merge-gate rule applied:** `feedback_hadley_apv_is_fillform_merge_gate.md` (locked 2026-06-28)

---

## FINAL VERDICT: **FAIL — DO NOT MERGE**

**Score:**
- **Total fields audited:** 10
- **PASS:** 7
- **FAIL:** 3
- **SKIP:** 0
- **Confidence:** HIGH (form is single-page, all widgets visible in rendered PNG)

Field count is small because TREC 36-11 is a single-page addendum. All expected/fillable widgets were reviewed field-by-field against the rendered PDF at 200 dpi.

---

## Field-by-field audit

### Header block

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 1 | Property Street Address + City header | "123 Main St, Boerne, TX 78006" | "123 Main St, Boerne, TX 78006" | **PASS** |
| 2 | Association Name | "Cibolo Canyons HOA" | "Cibolo Canyons HOA" | **PASS** |
| 3 | Association Phone Number (same slot label — "Name of Property Owners Association, (Association) and Phone Number") | HOA phone number (not in merged fields → blank defensible) | blank | **PASS** (defensibly blank — no HOA phone supplied in fixture) |

### Section A — Subdivision Information (mutually exclusive 1/2/3/4)

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 4 | A.1 checkbox — Seller obtains + delivers Subdivision Info within N days | CHECKED (default when Seller is source of HOA info; prompt did not override) | CHECKED | **PASS** |
| 5 | A.1 days blank | reasonable default (10) | "10" | **PASS** |
| 6 | A.2 checkbox — Buyer obtains at Buyer's expense | UNCHECKED | UNCHECKED | **PASS** |
| 7 | A.3 checkbox — Buyer already received; sub-checkbox "does not require updated resale certificate" | UNCHECKED at A.3 level | A.3 UNCHECKED at top-level; but "does not require updated resale certificate" sub-box **shown as CHECKED (qX)** | **FAIL — orphaned sub-checkbox** |
| 8 | A.4 checkbox — Buyer does not require delivery of Subdivision Info | UNCHECKED | UNCHECKED | **PASS** |

### Section C — Transfer Fee Cap

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 9 | C. transfer fee cap $ (Buyer pays association fees "not to exceed $____") | "$200" (from `hoa_transfer_fee: 200`) | "200" | **PASS** |

### Section D — Authorization (who pays Title Company for HOA info if Buyer waives Sub Info)

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 10 | D. paired checkbox — "Buyer" OR "Seller" pays Title Company for Association info | Ambiguous — prompt does not specify. Texas market default is Buyer (Buyer pays for its own diligence when it declines Sub Info). Since Buyer selected A.1 (Seller delivers Sub Info), Section D is arguably moot. Reasonable default = "Buyer" checked. | "Buyer" CHECKED, "Seller" unchecked | **PASS** (defensible default) |

---

## Fields NOT populated but expected blank (SKIP-defensible)

None. TREC 36-11 has no other fillable widgets. Signature lines at bottom (Buyer × 2, Seller × 2) are correctly blank at the fill stage — DocuSeal collects those at signing.

---

## Failure clusters (root causes)

### DEFECT 1 — Orphaned "does not require updated resale certificate" sub-checkbox inside A.3 (field #7)

**Severity:** Medium.

Section A of TREC 36-11 is a four-way mutually-exclusive choice (A.1, A.2, A.3, A.4 — pick exactly one). The rendered PDF correctly checks A.1 at the top level, and correctly leaves A.2, A.3, A.4 top-level boxes unchecked.

However, **inside A.3** — which is UNCHECKED at the top level and therefore inactive — the sub-choice "Buyer q does qX does not require an updated resale certificate" has the "does not" box CHECKED (visible in rendered PNG as `qX does not`).

This is a fill-engine artifact: the sub-checkbox has been asserted even though the parent A.3 choice is not the active branch. Reading the form as a signed instrument, this is contradictory — the Buyer cannot simultaneously (a) require Seller to deliver Sub Info under A.1 AND (b) be recording a preference about updated resale certificates under an inactive A.3 branch.

**Fix required:** The fill engine must gate all A.3 sub-widgets (the paired "does / does not require updated resale certificate" checkboxes) on A.3 itself being the selected top-level choice. If A.1, A.2, or A.4 is chosen, the A.3 sub-widgets must remain blank.

**Cross-reference:** This is the same class of failure as the ¶3.B financing-checkbox failure on TREC 20-18 (Hadley_1 report) — child widgets rendered independently of parent selection state.

### DEFECT 2 — Section C fee-cap value placement acceptable, but presentation is cramped (field #9)

**Severity:** Low — cosmetic.

The "200" appears rendered inside the fee-cap slot, but the extracted text shows it as `$____________2_0_0_` — implying the digits are placed inside underscore-padding rather than cleanly overlaying the blank. Visually on the PDF this is legible ("$200") but character-spacing on the fill-engine overlay is inconsistent.

**Fix required:** Non-blocking. Widget-coordinate tuning for the fee-cap slot to center or left-align the value cleanly.

**Not counted as a FAIL** — value is correct and readable. Flagged for polish.

### DEFECT 3 — HOA Association Phone Number missing from header (field #3)

**Severity:** Low — blank is defensible since no phone was supplied in the merged fields.

The header label reads "(Name of Property Owners Association, (Association) and Phone Number)" — meaning both the HOA name AND its phone belong in that block. Only the name populates. If future prompts supply an HOA phone number, the fill engine must extend the header string to `"Cibolo Canyons HOA, (555) 555-5555"`.

**Fix required:** Add `hoa_phone` fixture key + append to the header widget when present.

**Not counted as a FAIL** — the underlying fixture didn't include HOA phone, so blank is correct behavior.

---

### DEFECT 4 (LOGGED, NOT COUNTED) — Association-fee vs monthly-dues data leakage risk

**Severity:** Low — no defect on this render, but audit surface flag.

The merged fields include `hoa_monthly_dues: 145` and `hoa_transfer_fee: 200`. The form correctly uses `hoa_transfer_fee` in Section C (fees "associated with the transfer of the Property"). Monthly dues ($145) should NEVER appear on this form (they're prorated at closing per Paragraph 13 of the master contract, per Section C's explicit exclusion).

Currently, `hoa_monthly_dues` correctly does not appear on the addendum. But if the fill engine ever regresses and pipes `hoa_monthly_dues` into Section C, the resulting fee cap of $145 would silently under-cap the buyer's association-fee exposure and misrepresent the deal terms.

**Fix required:** Add a regression test asserting `hoa_monthly_dues` never writes to any TREC 36-11 widget.

---

## Real 3 defects that matter (Telegram-priority order)

1. **A.3 sub-checkbox orphaned** — "does not require updated resale certificate" is CHECKED even though A.3 itself is not the selected branch. Contradictory contract state.
2. **HOA phone number not in header** — accepted this render since phone wasn't in fixture, but the widget slot is designed to hold it.
3. **Section C value overlay cosmetic** — "$200" reads correctly but placement inside underscore-padding is uneven.

---

## Fields correctly filled (7 PASS)

For record — do not regress:

1. Header street address + city — "123 Main St, Boerne, TX 78006"
2. Association name — "Cibolo Canyons HOA"
3. A.1 checkbox CHECKED (Seller obtains + delivers)
4. A.1 days blank — "10"
5. A.2 UNCHECKED
6. A.4 UNCHECKED
7. Section C fee cap $ — "200"
8. Section D "Buyer pays Title Company" — CHECKED (reasonable default)

(HOA phone blank + A.3 top-level blank + signatures blank all counted as defensible-blank, not PASS lines above.)

---

## Hadley_3 acceptance decision

**Verdict: FAIL. Merge gate remains CLOSED on TREC 36-11.**

Per `feedback_hadley_apv_is_fillform_merge_gate.md` (locked 2026-06-28):

> "No code change touching `api/fill-form.js` [or related pdf-lib handlers] merges to `main` until Hadley reads the rendered PDF output from a test fire of the v3-FHA master prompt, verifies EVERY expected field per canonical expected-output table, confirms each field appears in the correct POSITION on the form, writes a PASS report listing each field + value + position confirmed."

I cannot sign PASS on this PDF while Defect 1 (orphaned A.3 sub-checkbox) is unresolved. The A.3 sub-choice being asserted while A.3 itself is not the active branch produces a contradictory contract instrument. A TX REALTOR receiving this addendum could reasonably ask "did my buyer decline the updated resale certificate or not?" — the answer is ambiguous because A.3 isn't even the selected option.

**Fix scope is small** — one child-widget gate on the parent A.3 selection state. Once resolved, re-render the v3-FHA kitchen-sink test, and I will re-audit.

**On the other 7 of 10 fields the form is clean.** This addendum is one small defect away from PASS — meaningfully better shape than TREC 20-18 (which Hadley_1 flagged 24 FAILs on).

---

**Report saved to:** `C:\Users\Heath Shepard\Desktop\MeetDossie\docs\hadley-pass-report-HOA-2026-07-01.md`
**Rendered page available at:** `C:\Users\Heath Shepard\Desktop\MeetDossie\.tmp\hadley-audit-2026-07-01\hoa-addendum-1.png`
**Signed:** Hadley_3, General Counsel (parallel clone), Shepard Ventures — 2026-07-01
