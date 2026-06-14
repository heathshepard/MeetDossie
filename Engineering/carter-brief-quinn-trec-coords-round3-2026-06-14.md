# Carter -> Quinn: TREC field-map Round 3 — staging push complete

**Commit:** `89673ad` on `staging`
**Spec executed:** `.claude/quinn-spec-carter-trec-coords-round3-2026-06-14.md`
**Files changed:** `api/_assets/field-maps/trec-{38-7,23-20,24-20,25-17}-coords.json` (field-map JSON only — `flat-pdf-filler.js` and base64 assets untouched)

## What landed

Re-derived every coordinate from a fresh PyMuPDF anchor scan of each form's own base PDF. New tooling lives in `Engineering/quinn-trec-fill-reverify-2026-06-14/`:

- `scan_anchors.py` — exhaustive label scan across every page of each base PDF; dumps `anchors-trec-*.json` with every hit per label
- `build_coords.py` — derives field (page, x, y) from anchor positions + measured offsets, writes field-map JSONs
- `base-trec-*.pdf` — extracted from the live `api/_assets/trec-*-base64.js` modules (so we're scanning what production actually uses)
- `verify-report.json`, `trec-*-OVERLAY-p1.png`, `trec-*-ZOOM-top.png` — output of your existing `fill-all.js` + `verify.py` + `overlay.py` against the new maps

## Field counts (previous → current)

| Form | Before | After | Pages covered |
|---|---|---|---|
| TREC 38-7 | 13 | **15** | 1 (8 termination checkboxes + objections_not_cured + buyer_name_2) |
| TREC 23-20 | 10 | **38** | 1, 2, 4, 5, 6, 7, 9, 10, 11 |
| TREC 24-20 | 10 | **39** | 1, 2, 4, 5, 6, 7, 9, 10, 11 |
| TREC 25-17 | 8 | **42** | 1, 2, 3, 5, 6, 7, 8, 10, 11, 12 |

All exceed the 80% Round-1 anchor-inventory threshold from your spec.

## Specific Round 2 misplacements fixed

- **38-7 `seller_name`** (was `(50, 172)` overprinting label): now `(49, 160)` on the long blank wrap line ending at `(SELLER)` at `x=507`
- **38-7 `buyer_name`** (was `(50, 175)` overprinting seller): now `(72, 651)` at bottom signature line 1. (Round 2's "top line above (Street Address and City)" guess turned out to be the title text — there is no buyer-name blank at the top of TREC 38-7; the buyer signs at the bottom.)
- **38-7 termination checkboxes:** form actually has 8 numbered items (1)-(8), not 7. Added a separate `termination_checkbox_objections` for item (7) "Para 6.D objections not cured" and kept `termination_checkbox_other` mapped to item (8). All 7 of your verified checkboxes still pass.
- **25-17 `buyer_name`** (was `(320, 79)` right of `(Buyer)` label at `x=419.8`): now `(120, 79)` between `and` and `(Buyer)` on the label line
- **25-17 `acreage`** (was `(180, 200)`): now `(80, 606)` per actual `acres` label at `(117.3, 606.4)`
- **25-17 `county`** (was `(380, 115)` on page 1 header that doesn't exist): now `(365, 121)` at the end of `A. LAND: ... in the County (or Counties) of ___` in section 2A
- **38-7 base PDF identity:** your `embedded-termination.pdf` from Round 1/2 was actually TREC 50-0 (Seller's Notice of Termination). The live `trec-termination-base64.js` IS correctly TREC 38-7 — I re-extracted it as `base-trec-38-7.pdf` for the rescan. The base64 swap from Round 2 (`6cad6a1`) was correct; the scan artifact was stale. Worth knowing if you see drift in future rounds.

## Verify-report notes

A few fields show large `dy` in `verify-report.json` (e.g. `block_number found=(513.2, 33.3) dy=-80`, `earnest_money dy=-195`, `acreage dy=-438`). These are **search-string collisions in the verify script**, not placement bugs:

- `block_number` value `"5"` matches the `"5"` in the page-header date "05-04-2026" at `(513.2, 33.3)` before reaching the actually-filled position
- `earnest_money` value `"5000"` matches the `"5000"` prefix inside `sales_price="450000"` first
- `acreage` value `"125"` matches `"125"` inside `property_description="125 acres in Bandera County..."` first

The fill **is** at the configured coordinate — `verify.py` just returns the first `page.search_for()` hit. If you want, a Round 4 hardening is to pick unique fixture values per field, or rank `verify.py` hits by proximity to `(cfg_x, cfg_y)`.

## Visual confirmation

Page-1 overlays + ZOOM-top crops in the harness dir show all four forms placing party/property/price/signature fields in the correct row and column, no overprints, no wrong-column placements. Worth a fresh look at:

- `trec-38-7-OVERLAY-p1.png` — 8 checkboxes, both seller+buyer name lines, signature block
- `trec-23-20-ZOOM-top.png` + `trec-24-20-ZOOM-top.png` — confirm seller name on PARTIES wrap line, buyer name between `and` and `(Buyer)`
- `trec-25-17-ZOOM-top.png` — confirm `Rancher Family Trust` on PARTIES wrap, `Bandera` after `in the County (or Counties) of`, property description block under section 2

Ready for your re-verify pass. If anything looks off on pages I haven't visually inspected (signature pages, broker pages, escrow receipt pages), flag the specific page/field and I'll re-tune from the anchor data already in `anchors-trec-*.json`.
