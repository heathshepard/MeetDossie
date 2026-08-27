# Semantic field-map review — human approval queue

Step 5 of `dossie-esign-productization-plan`: turn geometry-only coord files
(`api/_assets/*-coords.json`, WHERE a field is) into semantic labels (WHAT it
is), one form at a time, human-approved once, reused forever.

**Nothing in this folder is wired into fill-form.js, esign-create.js, or any
live send path.** These are candidate labels awaiting a human PASS/FAIL —
Hadley today, eventually a subscriber for their own non-standard forms.

## What's here

| File | Form | Coverage | Status |
|---|---|---|---|
| `trec-39-11-amendment.json` | Amendment to Contract (39-11) | 51/51 fields — full form | pending_human_approval |
| `trec-55-1-sellers-disclosure-page1.json` | Seller's Disclosure Notice (55-1) | 73/186 fields — page 1 of 4 | pending_human_approval, partial |

**TREC 20-18 (1-4 Family Residential Contract) and TXR 1101 (Listing
Agreement) are NOT in this folder** — both are already fully semantically
mapped elsewhere and locked:
- 20-18: `api/_lib/trec-20-18-field-rules.json`, 263/263 fields, wired live
  into `api/fill-form.js` / `api/_lib/trec-validator.js`. Per the header
  comment in that file, **do not regenerate, rewrite, or "improve" it** — it's
  Heath's hand-built source of truth.
- TXR 1101: `api/_assets/txr-1101-listing-agreement-coords.json`, already
  38/38 mapped in place.

## How each entry was produced

1. **Geometry** comes from the existing AcroForm widget-rect extraction
   (`scripts/extract-acroform-fields.js` / `scripts/extract-trec-field-coords*.js`)
   — unchanged, never re-derived here.
2. **Neighbor text** — `scripts/extract-field-neighbor-text.js` runs
   `pdftotext -bbox` (poppler-utils, already installed, no new npm
   dependency) against the real PDF content stream and pulls the words
   physically near each widget rect. On dense multi-column forms (e.g. 55-1's
   Y/N/U checklist) the search window auto-clamps against same-row neighbor
   fields so a label doesn't bleed into the next column.
3. **Key / party / paragraph** — assigned by reading the neighbor text
   against the real rendered PDF page (`pdftoppm`) and, wherever the position
   was ambiguous, the exact `pdftotext -bbox` word coordinates. `pdf_field_name`
   was read as a hint only, never trusted blindly — see "Confirmed pdf_field_name
   defect" below.
4. **Structured-field detection** — the same script flags
   `structured_group_hint: "address_component"` when 2+ same-row text fields'
   neighbor text hits different address keywords (street/city/state/zip/
   county). Deterministic, geometry-only, never guesses a coordinate. Neither
   39-11 nor 55-1 page 1 has a real multi-part address group (both confirmed
   clean — verified with a synthetic positive-case test too, see session
   notes); the detector exists for forms that do (the plan cites zipForm's
   escrow-agent address as the motivating real example).

## Confirmed pdf_field_name defect (39-11)

Several checkbox fields on TREC 39-11 carry a name whose **leading number
matches their true paragraph position** but whose **descriptive text is
pulled from the wrong (adjacent) paragraph** — e.g. the checkbox positioned
at paragraph (8) is literally named `"8 The date for Buyer to give written
notice..."`, which is paragraph (9)'s wording. Confirmed by rendering the
actual page and reading `pdftotext -bbox` word coordinates at that exact x/y.
This is the concrete case for why labeling must verify against real
position + text, never trust `pdf_field_name` alone — even when it looks
descriptive. Full list of every mismatch found is inline in
`trec-39-11-amendment.json` (`notes` field, "NAME MISMATCH").

On 55-1 the point is moot — `pdf_field_name` is XFA-generic
(`TextField3[12]` etc.) and carries zero semantic signal either way.

## Review format

Each field entry:
```
{
  "pdf_field_name": "...",      // raw AcroForm name, reference only
  "page": 1, "x_pt": .., "y_pt": .., "w_pt": .., "h_pt": ..,  // unchanged geometry
  "key": "para5_1_seller_pay_dollar_amount",  // proposed stable semantic id
  "party": "seller",            // buyer | seller | both | broker | n/a
  "paragraph": "5(1)",          // TREC paragraph/sub-item reference
  "field_kind": "flat_text",    // flat_text | checkbox | signature
  "format": "currency",         // optional: currency | percent | date_full | year_2_digit_suffix | count | number
  "notes": "..."                // optional: disambiguation, name-mismatch flags
}
```

To approve: change `review_status` to `approved`, set `reviewer` and
`approved_at`. To reject/fix a single field: edit its `key`/`party`/
`paragraph` in place — the file is hand-editable JSON, no tooling required to
review it.

## Storage decision for this pass

**File-based, not a new Supabase table.** The plan's target state is a
`form_field_maps` table keyed `(form_code, trec_revision, pdf_sha256)` in
Supabase, replacing `api/_assets/` entirely. Building and wiring that table is
a real migration + a change to how `fill-form.js` loads its maps — out of
scope for a single labeling pass whose job is to produce reviewable output,
not to re-architect storage. Proposed schema for when that migration happens:

```sql
create table form_field_maps (
  id uuid primary key default gen_random_uuid(),
  form_code text not null,          -- e.g. 'trec-55-1'
  trec_revision text not null,      -- e.g. '55-1'
  pdf_sha256 text not null,         -- pins the exact PDF this map was built against
  field_count int not null,
  coverage_note text,               -- e.g. 'page 1 of 4'
  fields jsonb not null,            -- array of {pdf_field_name,page,x_pt,y_pt,w_pt,h_pt,key,party,paragraph,field_kind,format,notes}
  review_status text not null default 'pending_human_approval',
  reviewer text,
  approved_at timestamptz,
  labeled_by text not null,
  labeled_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (form_code, trec_revision, pdf_sha256)
);
```

Each `signature_request` would eventually pin the map version it used
(`form_field_maps.id`) so a later TREC revision or field-name drift never
silently reuses a stale map — this is also where the plan's weekly
TREC-PDF-hash-drift check plugs in.

## Next slice

- 55-1 pages 2-4 (remainder of the 186 fields — additional Y/N/U items,
  flood/insurance/HOA history, sale-by-owner disclosures, signature block).
- Third Party Financing Addendum (40-11, 65 fields, currently 0 mapped) —
  next highest-value target, used on nearly every financed purchase.
- Once 2-3 more forms are done, revisit the Supabase migration above instead
  of adding more files here.
