# Chicago Title Swap Legal Review — Hadley

**Date:** 2026-07-12
**Requested by:** Heath (via Atlas mission brief)
**Blocker:** All 5 Chicago Title fillable PDFs are OLDER TREC revisions and differ materially from current TREC contract text.

## Executive Summary — ALL 5 SWAPS BLOCKED

Per Heath's paramount rule ("If contract text differs beyond trivial — SKIP + flag for Hadley review"), NONE of the 5 Chicago Title donors can be used as-is. Each is 5-7 revisions behind current TREC. Text-diff shows 15-24% character-count deltas — that's paragraphs of contract text, not typos.

| Form | Current TREC | Chicago Title donor | Rev gap | Text delta | Page gap | Verdict |
|---|---|---|---|---|---|---|
| 23-20 New Home Incomplete | 23-20 (11 pgs) | 23-14 (9 pgs) | 6 revs | 22.4% (10,052 chars) | +2 pages | BLOCKED |
| 24-20 New Home Complete | 24-20 (11 pgs) | 24-14 (9 pgs) | 6 revs | 21.5% (9,909 chars) | +2 pages | BLOCKED |
| 25-17 Farm & Ranch | 25-17 (12 pgs) | 25-11 (10 pgs) | 6 revs | 24.3% (12,519 chars) | +2 pages | BLOCKED |
| 30-18 Condo | 30-18 (10 pgs) | 30-12 (8 pgs) | 6 revs | 16.5% (7,163 chars) | +2 pages | BLOCKED |
| 26-8 Seller Financing | 26-8 (2 pgs) | 26-7 (2 pgs) | 1 rev | 15.0% (988 chars) | 0 pages | BLOCKED |

## Why each is blocked

### 26-8 vs 26-7 (Seller Financing) — the "easy" case that isn't easy

Even the 1-rev gap has a materially different structure. Tail-of-document comparison:

**26-7 (Chicago Title):**
> "The casualty insurance must name Seller as a mortgagee loss payee. (3) PRIOR LIENS: Any default under any lien superior to the lien securing the Note will be a default under the deed of trust securing the Note."

**26-8 (current TREC):**
> "...w service. (4) PRIOR LIENS: Any default under any lien superior to the lien securing the Note will be a default under the deed of trust securing the Note."

The renumbering from (3) → (4) plus the mention of a new "w service" clause indicates 26-8 added a new numbered paragraph before PRIOR LIENS. Shipping 26-7 would omit that new clause from every prefilled contract — **a legal defect**.

### 23-20 / 24-20 / 25-17 / 30-18 — all 6-rev gaps, +2 page delta

These four have identical patterns: Chicago Title donors are the versions issued around 2018-2020. Since then TREC has issued 6 mandatory revisions (typical TREC pace = 1-2 revs/year). The +2 page delta on each strongly suggests:

- Added Public Improvement District (PID) notice section (added statewide 2021)
- Added cybersecurity / wire fraud notice (added 2022)
- Updated mediation clauses
- Updated financing addendum trigger language
- Possibly the July-2026-mandatory language present in the 20-19 update

**Text deltas of 16-24% of character count are far beyond "trivial edits."** Using these would produce contracts that omit legally-required language.

## Hadley's charge

Legal review is not needed — the math already shows structural change. But your standing quarterly review of TREC form releases should confirm:

1. That current TREC.gov downloads (as of 2026-07-11) are the ONLY authoritative source for these 5 forms.
2. Whether the 20-19 fill-form pipeline can accept flat (non-AcroForm) PDFs from TREC.gov, since the current TREC.gov versions of these 5 forms are flat (per prior swap-attempt notes) — the Chicago Title approach was a workaround that failed.

## Alternative path

The correct path is either:
- **A.** Use TREC.gov's flat PDFs and continue the pdf-lib coordinate-mapping approach (labor-intensive, but legally correct — how 20-19 was mapped before the DocuSeal fillable swap).
- **B.** Find another donor source that publishes the CURRENT TREC revisions as AcroForm PDFs (Zerion? PandaDoc? Another Texas title company that's kept templates current?).
- **C.** Wait for TREC to publish AcroForm versions themselves (they historically don't, so this is a non-starter).

Heath: I recommend Path A — keep the flat-PDF pdf-lib maps for 23-20 / 24-20 / 25-17 / 30-18 / 26-8 until we find a current-rev AcroForm source. The July-2026 flat PDFs are already in `.tmp/deephunt/probe-*-trec-official.pdf`.

## Files reviewed

- `.tmp/deephunt/probe-23-20-source-chicago-title.pdf` (title = "TREC NO. 23-14 NEW HOME CONTRACT (INCOMPLETE CONSTRUCTION)")
- `.tmp/deephunt/probe-24-20-source-chicago-title.pdf` (title = "TREC NO. 24-14 NEW HOME CONTRACT (COMPLETED CONSTRUCTION)")
- `.tmp/deephunt/probe-25-17-source-chicago-title.pdf` (title = "TREC NO. 25-11 FARM AND RANCH CONTRACT")
- `.tmp/deephunt/probe-30-18-source-chicago-title.pdf` (title = "TREC NO. 30-12 RESIDENTIAL CONDOMINIUM CONTRACT (RESALE)")
- `.tmp/deephunt/probe-26-8-source-chicago-title.pdf` (title = "TREC NO. 26-7, SELLER FINANCING ADDENDUM")

## Sign-off

Hadley: When you sign this off, note the sign-off timestamp + your recommendation on Path A vs Path B. If you disagree with the BLOCKED verdict on any single form (e.g., 26-8 might have a narrow enough change that TREC would consider 26-7 substantively compliant), flag the specific one for Heath's second look.

—Atlas, 2026-07-12
