# DossieSign Form Library — Implementation Plan

Status: **PLAN ONLY.** No code changed, no migration applied, no behavior changed
this pass. Written by Carter, 2026-09-28.

Two features, per Heath's direction:

1. **Custom form upload + visual field mapping** — a subscriber uploads a
   brokerage-specific PDF, maps signing fields visually, saves it once, never
   maps it again.
2. **Transaction-type template bundles** — named form sets (Buyer, Seller,
   Land, Ranch, Commercial, Lease) that preload the right forms for a deal,
   including conditionally-triggered ones (lead paint, HOA, septic).

This plan **consumes** `docs/TEXAS-FORM-EXECUTION-REFERENCE.md` (a separate
agent's output — which forms exist, who signs, where, what's mandatory per
transaction type) as its data source for seeding `form_templates` and the
bundle contents. It does not re-derive that research.

---

## 0. What already exists — read this before building anything

Both features have real, live infrastructure already in production. This is
not a greenfield build. Skipping this section risks rebuilding something that
works (Rule 1/3 in CLAUDE.md).

**Feature 2 (bundles) is ~60% built:**
- `form_templates` / `form_packages` / `form_package_items` tables are live
  (created via Supabase MCP, documented in the SQL comment blocks at the top
  of `api/form-templates.js` and `api/form-packages.js` — no tracked
  migration file exists for the original CREATE TABLE, which is itself a gap,
  see §6).
- `form_packages.side` already takes `'buyer' | 'seller' | 'custom'`, with
  `user_id NULL` = system default, `user_id = <uuid>` = a member's own
  package. Per-member ownership is already correct and wired (RLS in
  `api/form-packages.js`'s header SQL: `fp_read`/`fp_insert`/`fp_update`/
  `fp_delete`, gated on `auth.uid() = user_id`).
- `api/dossiesign-prepare.js` fills every form in a package from transaction
  data and returns preview PDFs; `api/form-packages.js` (`action: 'apply'`)
  bulk-attaches a package's forms to a transaction as `documents` rows.
- `transactions.transaction_type` is a real, live column with these values
  today (from `Dossie/dossie-app.jsx` line ~11412, `txTypeOptions`):
  `buyer_purchase`, `seller_listing`, `new_home_purchase`, `land`,
  `residential_lease_landlord`, `residential_lease_tenant`. Land and Lease
  transactions already have dedicated column families (`land_acreage`,
  `land_legal_description`, `land_survey_type`, ... ; `lease_monthly_rent`,
  `lease_tenant1_name`, ...) per `api/chat.js`'s field enum. **Ranch and
  Commercial do not exist yet** — genuinely new work, not a rename.
- Conditional-forms logic already exists, but only **client-side and
  read-only**: `getRequiredDocs(deal, brokerDocs)` in `Dossie/dossie-app.jsx`
  (line 515) computes `needsLeadPaint` (`year_built < 1978` or unknown),
  `hasHOA` (`hoa_name` set), `hasSeptic` (`septic_present`), `isFinancing`
  (`financing_days > 0`), and branches on `role` (buyer vs. listing). It
  drives the Documents-tab checklist UI only — it does not filter what
  `form_packages` apply-attaches. Closing that gap is the real work in §4.

**Feature 1 (custom forms) is ~40% built — storage exists, mapping does not:**
- `member_form_templates` (migration `supabase/migrations/20260921_member_form_templates.sql`,
  live) stores a member's own uploaded PDF: `label`, `description`,
  `file_name`, `file_type`, `file_size`, `storage_path` (bucket `documents`,
  path `{user_id}/member-forms/...`). RLS: owner-only (`auth.uid() =
  user_id`) + service_role. `api/member-form-templates.js` is the CRUD
  endpoint (`GET ?scope=list`, `POST action: upload_url|create`, `PATCH`,
  `DELETE`).
- A member's stored form is already attachable to any dossier —
  `api/_lib/form-library-tools.js`'s `attachMemberForm()` (Dossie chat tool)
  and the client's `handleAttachStandardDoc` insert a `documents` row
  pointing at the same `storage_path` (`document_type: 'other'`, **no**
  `form_type`, **no** link back to `member_form_templates.id`).
- **The gap:** that attached document has no field map. Every send today
  requires the member to hand-place signature/date fields on the canvas
  (`Dossie/src/components/dossieSign/InteractiveEditor.jsx`'s
  `handlePaletteDropOnCanvas`, drag-drop from `FieldOverlay.jsx`) — and
  **this placement is never saved.** They re-place fields on the same CMA
  Acknowledgement every single send. This is exactly the "never have to map
  it again" ask.
- A prior attempt at a generic visual mapper exists but is **retired**:
  `api/dossiesign-auto-map.js` and `api/dossiesign-approve-field-map.js` both
  return `410 Gone` — the auto-map endpoint asked a model to guess field
  *positions* (wrong instrument for the job; see `acroform-field-names-lie`
  memory), and the approve endpoint had three fatal integration bugs (wrong
  DocuSeal host, wrong auth header, wrong coordinate contract). Their UI
  component, `Dossie/src/components/DossieSignEditor.jsx` (uses
  `PdfViewer.jsx` + `FieldOverlay.jsx` + `FieldSidebar.jsx`), is still wired
  to the dead endpoints — **do not resurrect this path.** Its component
  pieces are reusable; its backend is not.
- The send-time contract for an unmapped document is already solid and does
  **not** need to change: `api/esign-create.js`'s `validateCustomFieldsForDoc`
  + `buildPacketDocEntry` accept caller-placed `fields[]` keyed by
  `documentId`, each `{ name, type, signerRole, areas: [{x, y, w, h, page}] }`
  — `x/y/w/h` are 0-1 fractions, `page` is 1-indexed, exactly DocuSeal's
  write contract. This is the exact shape Feature 1's saved map must
  reproduce so it plugs in with zero changes to the send path's validation.

---

## 1. The `required` field lesson — binding constraint, not a suggestion

2026-09-26, the Barry Whyte incident (commit `81aa8334`, current HEAD of this
worktree): DocuSeal defaults an **omitted** `required` key to `true`. A
23-checkbox Seller's Disclosure correction went out with every election
field forced required, blocking submission until every box was checked
regardless of truth.

The fix already in `api/esign-create.js` is `dsFieldRequired(type)` —
`required = true` only for `signature` and `date`; every other type
(`initials`, `text`, `checkbox`) is `false` — computed centrally, at the
single point every field object is finalized for DocuSeal, **never trusted
from a caller or a stored map.**

Feature 1's saved field maps must not reopen this hole:
- The mapping UI **does** ask the member to confirm type per field (that
  determines `required` deterministically — there is no free "is this
  required?" toggle to leave unset, because that's exactly the omission that
  caused the incident).
- The **stored** JSON still carries an explicit `required` key per field
  (satisfies "never leave it implicit" at the data layer, and lets a human
  reviewing the JSON see the real value) — but `dsFieldRequired(type)` is
  recomputed fresh at send time from `type` alone and wins over whatever is
  stored, exactly like every other field-building path in `esign-create.js`.
  This is defense in depth, not a contradiction: store it explicitly, never
  trust it on read.

---

## 2. Feature 1 — custom form upload + visual field mapping

### 2.1 Schema

Extend `member_form_templates` in place rather than adding a join table —
one form, one current map, matches the existing "single row per stored form"
model and avoids a second RLS surface to get right.

**New migration:** `supabase/migrations/20261001_member_form_field_maps.sql`

```sql
ALTER TABLE public.member_form_templates
  ADD COLUMN IF NOT EXISTS page_count INTEGER,
  ADD COLUMN IF NOT EXISTS pdf_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS field_map JSONB,
  ADD COLUMN IF NOT EXISTS field_map_status TEXT NOT NULL DEFAULT 'unmapped';

ALTER TABLE public.member_form_templates
  ADD CONSTRAINT member_form_templates_field_map_status_check
  CHECK (field_map_status IN ('unmapped', 'draft', 'mapped'));

COMMENT ON COLUMN public.member_form_templates.field_map IS
  'Array of {id, name, type, signerRole, required, areas:[{x,y,w,h,page}]}.
   x/y/w/h are 0-1 fractions, page is 1-indexed — the exact DocuSeal write
   contract esign-create.js already validates for caller-placed fields
   (validateCustomFieldsForDoc). required is stored explicitly but NEVER
   trusted at send time — dsFieldRequired(type) always wins.';
COMMENT ON COLUMN public.member_form_templates.pdf_sha256 IS
  'sha256 of the PDF at storage_path when field_map was last saved. If the
   file at storage_path changes (re-upload to the same row is not exposed by
   the API today, but a future path might add one) this pins the map to the
   bytes it was measured against — same pattern as
   esign-field-maps.json blank_pdf_sha256.';

-- No RLS changes needed: member_form_templates.owner_all / service_all
-- (20260921_member_form_templates.sql) already cover these new columns.
```

No new table, no new RLS policy shape — additive columns on an existing,
correctly-scoped, owner-only table. `field_map_status = 'unmapped'` is the
default for the ~existing rows with no map yet, same non-breaking pattern
already used for `storage_path IS NULL` (label-only legacy rows).

`documents` also needs a back-reference so a document attached from a
member's stored form can be resolved back to its saved map at send time:

```sql
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS member_form_template_id UUID
    REFERENCES public.member_form_templates(id) ON DELETE SET NULL;
```

### 2.2 Where this lives in the codebase

**New API endpoint:** `api/member-form-field-map.js`
- `GET ?id=<member_form_template_id>` — auth + ownership check (mirrors
  `api/member-form-templates.js`'s pattern exactly: `verifySupabaseToken`,
  then `user_id=eq.<uid>` on every query, never trust a client-supplied
  `user_id`). Returns the current `field_map`, `field_map_status`,
  `page_count`, and a signed URL to the PDF (same signed-URL pattern as
  `api/dossiesign-fetch-field-map.js`).
- `POST { action: 'suggest_widgets', id }` — best-effort. Loads the PDF from
  Storage, runs it through `pdf-lib` (`PDFDocument.load` + `form.getFields()`
  + `field.acroField.getWidgets()` → rectangle), same technique as
  `scripts/extract-acroform-fields.js`. Returns raw widget **rectangles**
  only (page, x, y, w, h as fractions) — no name, no type, no role. Most
  brokerage PDFs (scanned/flattened) will return an empty list; that's
  expected and fine, not an error. These are candidate boxes only, never
  auto-applied — see §1 and the AcroForm-lies lesson: the geometry is real
  and trustworthy (it's measured off the actual widget), but the **meaning**
  of a field is not inferable from its programmatic name, so the UI always
  requires the member to look at the rendered page and assign type/role
  themselves, exactly as the TREC pipeline's human-reviewed role maps do
  (`scripts/esign-role-maps/*.json`).
- `POST { action: 'save', id, fields, pageCount }` — validates `fields`
  against the **same** shape `api/esign-create.js`'s
  `validateCustomFieldsForDoc` already enforces (extract that function into
  `api/_lib/custom-field-validate.js` so there is one validator, not two that
  drift — `esign-create.js` imports it for the send-time gate,
  `member-form-field-map.js` imports it for the save-time gate). On success:
  computes `pdf_sha256` from the stored PDF bytes, sets
  `field_map_status = 'mapped'`, writes the row.

**Modified:** `api/esign-create.js`
- `getDocumentRow` (line ~104) and the packet-fetch query add
  `member_form_template_id` to their `select=`.
- New `api/_lib/member-field-map.js` exporting
  `async function resolveMemberFormEntry(doc)`: if
  `doc.member_form_template_id` is set, fetch the `member_form_templates`
  row, require `field_map_status === 'mapped'`, and convert the flat
  `field_map` array into the **same `formEntry` shape**
  `buildMappedFieldMap`/`assertPlausibleMappedFieldCount` already consume for
  the 23 TREC/TAR maps: group by `signerRole` into `roles.{buyer1,buyer2,
  seller1,seller2,buyer_agent,listing_agent}`, derive
  `expected_field_count_per_role` from the group sizes. **This is the load-
  bearing design decision** — it means the custom-form send path inherits
  every existing safety gate (signature/date pairing, unsignable-packet
  check, `dsFieldRequired`) for free, with zero new gate logic, because it
  runs through the identical functions the TREC forms use.
- `resolveEsignFieldMapForDoc` gets a new caller: `buildPacketDocEntry`
  (line ~623) and the single-document send path (line ~2505) both try the
  static TREC/TAR map first, then fall back to `resolveMemberFormEntry(doc)`
  when `doc.member_form_template_id` is present. If neither resolves, the
  document still falls through to the existing caller-placed-fields path
  (`validateCustomFieldsForDoc`) unchanged — so a member who attaches a form
  they haven't mapped yet still gets today's behavior, not an error.

**Modified:** `api/_lib/form-library-tools.js`'s `attachMemberForm()` and the
client's equivalent attach call (`Dossie/dossie-app.jsx`,
`handleAttachStandardDoc` — grep confirmed this exists; exact line not
re-verified this pass since no code changes were made) both need to stamp
`member_form_template_id: memberForm.id` on the inserted `documents` row.
Today they insert `document_type: 'other'` with no back-reference — that's
the missing link that makes step 2.3's "never map it again" promise real.

**New/modified UI component:** `Dossie/src/components/dossieSign/MemberFormMapper.jsx`
- Reuses existing, already-proven pieces: `PdfViewer.jsx` (takes any
  `pdfUrl`, not just the static base64 assets — confirmed by reading its
  props contract), `FieldOverlay.jsx` (drag/resize boxes, vanilla pointer
  events, already has party-color constants), and the palette/type-picker
  pattern from `InteractiveEditor.jsx`'s `handlePaletteDropOnCanvas`.
- Does **not** reuse `DossieSignEditor.jsx` (wired to the retired
  `dossiesign-*` endpoints) or `FieldSidebar.jsx` from that dead path without
  re-pointing its fetch calls.
- Launch point: `Documents → My Forms` (where `member_form_templates` already
  lists) — each row gets a "Map fields" action when `field_map_status !==
  'mapped'`, and "Edit field map" when it already is.

### 2.3 UI flow — what the member actually does

1. **Settings → My Standard Documents** (or Documents → My Forms — both
   already exist and list the same table). Member clicks "Add a document" →
   file picker opens (already built, 2026-09-21) → uploads their KW CMA
   Acknowledgement PDF. Row appears with a "Map fields" badge.
2. Clicks **Map fields**. `MemberFormMapper` opens full-screen, loads the PDF
   via `PdfViewer`, calls `suggest_widgets` in the background.
3. If the PDF has real AcroForm widgets, their rectangles render as dashed
   outline suggestions on the page — click one to accept it as a starting
   box (still requires assigning type + role next), or ignore it and draw a
   fresh box. If the PDF is flat/scanned (the common case for a brokerage
   form), the member drags a box directly onto the rendered page image —
   identical interaction to the existing unmapped-upload canvas flow they
   already use today, just persisted this time.
4. For each box: pick **type** (Signature / Initials / Date / Text /
   Checkbox — same five types `CUSTOM_FIELD_TYPES` in `esign-create.js`
   already accepts) and **signer role** (Buyer 1, Buyer 2, Seller 1, Seller
   2, Buyer's Agent, Listing Agent — the same six semantic roles
   `SIDE_TO_SEMANTIC_ROLES` already uses, so nothing new to teach the send
   pipeline). No separate "required" toggle is shown — required is implied
   by the type choice and is fixed, per §1.
5. Repeat per page. A running tally shows signature/date pairing per role
   live (client-side mirror of `assertPlausibleMappedFieldCount`'s pairing
   gate) so a mismatch is visible before Save, not discovered at first send.
6. **Save as default.** POST to `save`. Confirmation: "Saved. This form will
   use this layout every time you send it — you won't need to place fields
   again." Row's badge flips to "Mapped."
7. Next time this form is attached to any dossier and added to a signing
   packet, `esign-create.js` resolves its saved map automatically — the
   member picks signers and hits Send, same as any TREC form today.

### 2.4 Build sequence — Feature 1

1. Migration (§2.1) — additive, zero risk, ships alone first.
2. Extract `validateCustomFieldsForDoc` into `api/_lib/custom-field-validate.js`,
   re-import in `esign-create.js` unchanged (pure refactor, verify via
   existing `esign-create.js` tests, no behavior change) — de-risks step 3
   by proving the shared validator still passes today's suite before new
   code depends on it.
3. `api/member-form-field-map.js` GET + save (skip `suggest_widgets` at
   first — manual-only placement ships a usable v1; widget suggestions are
   a pure UX accelerant, not a blocker).
4. `MemberFormMapper.jsx` — manual placement only, wired to step 3.
5. Wire `member_form_template_id` onto attach (both the chat tool and the
   client attach handler) + `resolveMemberFormEntry` in `esign-create.js`.
   **This step is the one that makes mapping durable** — ship 3+4 behind it
   being incomplete and a member could map a form that still isn't
   auto-used at send time, which is worse than not shipping the UI yet.
   Land 4 and 5 in the same push.
6. `suggest_widgets` (AcroForm rect extraction) as a fast-follow — pure
   addition, no dependency on anything already shipped.

---

## 3. Feature 2 — transaction-type template bundles

### 3.1 Schema

`form_templates` / `form_packages` / `form_package_items` already exist
(§0). Two additive changes:

**Migration:** `supabase/migrations/20261001_form_bundle_conditions.sql`

```sql
-- Register the real bundle sides. No CHECK exists today (side is a bare
-- TEXT column per the SQL block in api/form-packages.js) — add one now to
-- catch a typo before it silently creates an unreachable bundle. Includes
-- the two genuinely new sides (ranch, commercial) alongside the four that
-- already have transaction_type support.
ALTER TABLE public.form_packages
  ADD CONSTRAINT form_packages_side_check
  CHECK (side IN ('buyer', 'seller', 'land', 'ranch', 'commercial', 'lease', 'custom'));

-- Conditional inclusion: NULL = always attach when the package is applied.
-- A non-null condition is evaluated against the transaction row at apply
-- time (see api/_lib/bundle-conditions.js). Kept as a small closed enum
-- (not a free-text expression language) — every condition this needs is
-- already a single boolean predicate ported from
-- Dossie/dossie-app.jsx's getRequiredDocs(); an expression engine would be
-- solving a problem this feature doesn't have.
ALTER TABLE public.form_package_items
  ADD COLUMN IF NOT EXISTS condition TEXT;

ALTER TABLE public.form_package_items
  ADD CONSTRAINT form_package_items_condition_check
  CHECK (condition IS NULL OR condition IN (
    'lead_paint_if_pre_1978',
    'hoa_if_present',
    'septic_if_present',
    'financing_if_applicable'
  ));

COMMENT ON COLUMN public.form_package_items.condition IS
  'NULL = always included when the package is applied. Non-null = evaluated
   against the transaction row by api/_lib/bundle-conditions.js at apply
   time — server-side port of Dossie/dossie-app.jsx getRequiredDocs()''s
   conditional predicates (needsLeadPaint / hasHOA / hasSeptic /
   isFinancing). Intentionally duplicates that client logic rather than
   sharing it across the two repos — same trade-off already made and
   documented in api/_lib/required-documents.js''s header for a different
   caller.';
```

`form_templates.category` also gets `'land'`, `'ranch'`, `'commercial'`
added to its documented (not DB-enforced — it's a bare TEXT column per
`api/form-templates.js`'s header SQL) value set, alongside the existing
`'purchase' | 'addendum' | 'disclosure' | 'listing' | 'lease' | 'other'`.

### 3.2 Where this lives

**New:** `api/_lib/bundle-conditions.js` — the four predicates above, each a
pure function `(tx) => boolean`, ported 1:1 from `getRequiredDocs`:
- `lead_paint_if_pre_1978`: `!tx.year_built || tx.year_built < 1978`
- `hoa_if_present`: `Boolean(tx.hoa_name)`
- `septic_if_present`: `Boolean(tx.septic_present)`
- `financing_if_applicable`: `Number(tx.financing_days) > 0`

**Modified:** `api/form-packages.js`, `handleApply` — after fetching
`form_package_items` for the package, filter out any item whose `condition`
predicate evaluates false against the fetched `tx` row (the transaction row
is already fetched earlier in that handler for ownership verification — no
new query). Unconditional items (`condition IS NULL`) behave exactly as
today.

**New system-default packages** (six, `user_id IS NULL`, seeded via a
one-time admin migration script following the existing
`api/admin-migrate-*.js` pattern, e.g. `api/admin-seed-form-bundles.js`):
Buyer, Seller, Land, Ranch, Commercial, Lease — `side` set accordingly.
`form_package_items` populated from `docs/TEXAS-FORM-EXECUTION-REFERENCE.md`
once that doc exists: every form the reference marks mandatory for that
transaction type gets a row with `condition = NULL`; every form it marks
conditional (lead paint, HOA resale certificate, septic/on-site sewer, third
-party financing addendum) gets the matching `condition` value from the enum
above. Ranch and Commercial bundles are net-new — they need their own
`form_templates` rows first (also sourced from that reference doc; likely
TREC Farm & Ranch Contract, Commercial Contract forms not currently in
`form_templates` at all per the category list in §0).

**Per-member override:** already works today with zero new code — a member
can `POST /api/form-packages { action: 'create', ... }` to clone a system
bundle into their own `user_id`-owned package and edit its `templateIds` via
`PATCH`. The only gap this plan adds is making the *system* bundles
condition-aware; per-member customization already inherits it once `handleApply`
respects `condition`.

### 3.3 UI flow

1. Starting a new transaction, member picks `transactionType` (existing
   Step-1 picker in `Dossie/dossie-app.jsx`, `txTypeOptions`) — extended with
   Ranch and Commercial entries alongside the existing six.
2. On the dossier's Documents tab, a "Load form bundle" action (new, next to
   the existing per-form "Attach" flow) lists packages visible to the member
   (system default for their transaction's `side` first, then their own
   saved packages) — reuses `GET /api/form-packages`, already returns
   `items` expanded with template details.
3. Selecting a bundle calls `POST /api/form-packages { action: 'apply',
   packageId, transactionId }` — now condition-aware. Attaches only the
   forms that are mandatory or conditionally-triggered for this real deal;
   skips ones already attached (existing de-dupe logic, unchanged).
4. Member sees the resulting document list immediately — same UI the
   existing `dossiesign-prepare` preview and per-form attach flows already
   render into.

### 3.4 Build sequence — Feature 2

1. Migration (§3.1) — additive, ships alone.
2. `api/_lib/bundle-conditions.js` + `handleApply` filter — small, testable
   in isolation against a handful of fixture transaction rows (pre-1978 +
   HOA, post-1978 + no HOA + financing, etc.).
3. Seed script for the four bundles that need **no new forms**: Buyer,
   Seller, Land, Lease (their `form_templates` rows and PDFs already exist
   per `dossiesign-prepare.js`'s `SHORT_NAME_TO_FORM_TYPE` map covering
   most of them — verify per-form coverage against
   `TEXAS-FORM-EXECUTION-REFERENCE.md` once available, gaps become new
   `form_templates` rows same as any other missing form).
4. Ranch + Commercial — blocked on `TEXAS-FORM-EXECUTION-REFERENCE.md`
   naming the actual TREC/TAR forms required, and on sourcing/adding those
   PDF assets the same way every other form in `api/_assets/` was added
   (`scripts/build-esign-field-maps.js` pipeline if they need e-sign field
   maps too). This is the long pole of Feature 2, not the conditional logic.
5. UI: "Load form bundle" action on the Documents tab (step 3.3).

---

## 4. Build sequence — combined, ship order

Both features are independently shippable; Feature 1 has no dependency on
Feature 2 or vice versa. Recommended order, soonest-useful first:

1. Feature 1 steps 1-2 (migration + shared validator extraction) — zero
   behavior change, de-risks everything after it.
2. Feature 1 steps 3-5 (mapping endpoint + UI + the attach-time wiring that
   makes it durable) — this is the single highest-value chunk: it directly
   fixes Heath's stated pain ("upload that manually and manually map it and
   then save as a default and never have to map it again") for the exact
   form he named (KW CMA Acknowledgement), and generalizes to any brokerage
   form any member uploads.
3. Feature 2 steps 1-3 (migration + conditions + the four bundles that need
   no new form assets) — reuses infra that already exists, mechanical work.
4. Feature 1 step 6 (AcroForm widget suggestions) — pure UX polish, do
   whenever.
5. Feature 2 step 4-5 (Ranch/Commercial + UI) — gated on the forms-reference
   doc landing; do this last since it's the only piece with an external
   research dependency.

---

## 5. What's genuinely hard, and where this is likely to go wrong

1. **Signer-role mismatch on a real brokerage form.** The six semantic roles
   (`buyer1/2`, `seller1/2`, `buyer_agent`, `listing_agent`) fit every TREC
   contract because TREC contracts always have that shape. A brokerage
   acknowledgement form might have a role the pipeline doesn't model well —
   e.g. a line for the **team leader** or **broker** distinct from the
   listing agent, or a form seller-side-only that a buyer-side send would
   never touch. `buildMappedFieldMap`'s existing behavior (throw 422 if a
   signer has no matching role) is probably the right fallback, but the
   error message needs testing against a real weird form before this ships,
   not just the clean CMA Acknowledgement case Heath named.
2. **Scanned PDFs with rotated or skewed pages.** `PdfViewer.jsx` renders at
   a fixed 1.5x scale assuming a normal-orientation page. A phone-scanned
   brokerage form saved as PDF is a realistic input and may render sideways
   or with margin drift that makes fraction-based coordinates line up
   differently than they appeared during mapping. Needs a real test with an
   actual scanned (not born-digital) brokerage PDF before calling this done
   — the Creative Director standard's "verify in a real browser" rule
   applies doubly hard here since a misplaced signature field on someone
   else's brokerage form is a legal-document defect, not a cosmetic one.
3. **`pdf_sha256` staleness has no enforcement path yet.** The plan pins the
   hash at save time but there is currently no API surface that lets a
   member replace the PDF behind an existing mapped row (only `create`,
   which makes a new row) — so the guard is inert today. If a future change
   adds "replace file" to `member-form-templates.js`, that code MUST check
   the hash and force `field_map_status` back to `'unmapped'\|'draft'`, or a
   member could silently get field boxes from a five-page-old form revision
   placed onto a six-page new one. Flagging now so it isn't missed later.
4. **Ranch and Commercial are not scoped by any doc in this repo yet.**
   Everything in §3 for those two bundles is provisional pending
   `TEXAS-FORM-EXECUTION-REFERENCE.md`. There's real risk the actual TREC
   Farm & Ranch / Commercial contracts have signer structures (multiple
   trustees, corporate signers, a notary block) the current six-role model
   doesn't cover at all — this may turn out to need a 7th/8th semantic role,
   not just new `form_templates` rows. Don't commit to the Feature 2 build-4
   step's scope until that reference doc is read.
5. **Condition predicates read `transactions` columns that can be null,
   blank-string, or the string `"0"` depending on which of the many write
   paths touched them last** (`chat.js`, `dossie-voice-fill.js`,
   `extract-form-fields.js`, manual edits all write these fields with
   different normalization). `getRequiredDocs` already handles this
   defensively client-side (`!yearBuilt || isNaN(yearBuilt)`) — the ported
   server predicates in `bundle-conditions.js` must copy that same
   defensiveness exactly, not a naive truthy check, or a bundle apply will
   silently skip a legally-required form because `financing_days` arrived as
   the string `"0"` instead of the number `0`.

---

## 6. Housekeeping flagged, not fixed, this pass

`form_templates`, `form_packages`, and `form_package_items` have no tracked
migration file for their original `CREATE TABLE` — they exist live in
Supabase (applied via the Supabase MCP directly, per the SQL comment blocks
in `api/form-templates.js` / `api/form-packages.js`) but `supabase/migrations/`
has no record of it. This plan's migrations assume those tables already
exist and only ALTER them — correct for the live database, but the missing
baseline migration means a fresh environment (or a schema-drift audit) can't
reconstruct history from `supabase/migrations/` alone. Worth a follow-up
migration that `CREATE TABLE IF NOT EXISTS`-documents the current live shape,
out of scope for this plan.
