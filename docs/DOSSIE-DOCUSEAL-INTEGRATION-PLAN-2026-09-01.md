# Dossie ⟷ DocuSeal Integration Plan — 2026-09-01

**Strategy (Heath's call, locked):** DocuSeal IS the signing engine. Dossie fills, DocuSeal
signs. This plan designs the marriage and **proves the hard part live**: a real DocuSeal
template was generated from one of the 18 role maps built today, rendered on the actual
signing page, and every field landed exactly on its printed line. Evidence below.

Builds on `docs/DOSSIESIGN-GAP-ANALYSIS-2026-09-01.md` and
`docs/FORM-COORDINATE-INVENTORY-2026-09-01.md` — facts established there are not re-derived.

---

## 0. Proof of concept — the converter works (verified live, then archived)

Ran `.tmp/docuseal-poc/rolemap-to-docuseal.js` against
`.tmp/coord-overlays/role-maps/lead-paint-addendum.json` (TREC OP-L — chosen because it
exercises every case in one page: 6 signer roles, checkboxes, prefill text, date lines):

1. **Converted all 25 role-map fields** → DocuSeal template **5682622** via
   `POST /templates/pdf` (accepted first try, 25 fields echoed back, 7 submitters:
   Preparer, Buyer 1/2, Seller 1/2, Buyer's Agent, Listing Agent).
2. **Created submission 10771902** with the Preparer submitter passed as
   `completed: true` + `values` (property address + 5 checkbox answers), all other
   parties `heath.shepard@kw.com`, `send_email: false` — no email reached anyone.
3. **Opened the real signing pages in a real browser** (Playwright, Buyer 1 and
   Seller 1 slugs) and screenshotted:
   - Prefilled address stamped **exactly on the "(Street Address and City)" line**.
   - All 5 checked boxes landed on the correct printed boxes (1(b), 2(b), C.2, D.1,
     D.2); the 3 unchecked boxes stayed empty. **Stamped values are static text — not
     the pink editable widgets that killed the v10 template path.**
   - Buyer 1 saw interactive signature+date widgets ONLY on the Buyer 1 line;
     Seller 1's signature widget sat dead-center on the first "Seller" line with the
     date box on its Date line. Zero misplacement.
   - Read-back confirmed the established indexing rule: sent `page: 1`, GET echoed
     `page: 0` (1-indexed write / 0-indexed read, matching the 8/31 probe).
4. **Archived both** (`DELETE /submissions/10771902`, `DELETE /templates/5682622`).

Screenshots + converter script: `.tmp/docuseal-poc/` (poc-buyer1-*.png, poc-seller1-*.png).

**Two incidental findings from the run:**
- The `.env.local` copy of `DOCUSEAL_API_KEY` is **stale** (401s). The live key had to be
  pulled via `npx vercel env pull --environment=production`. Fix the local copy.
- The signing page banner reads **"Developer Sandbox. Upgrade to start using in
  Production."** — confirmed in the screenshot. See §8 (go-live blockers).

---

## 1. The template converter

### 1.1 Coordinate transform (proven above)

Role maps store top-left-origin **percentages 0–100** of page width/height
(`x_pct/y_pct/w_pct/h_pct`, per the maps' own description field). DocuSeal `areas[]`
takes top-left-origin **fractions 0–1**. The entire transform is:

```
area = { x: x_pct/100, y: y_pct/100, w: w_pct/100, h: h_pct/100, page: page }
```

No origin flip, no page-size math — the role-map generator already did the
bottom-origin-points → top-origin-fraction conversion (same convention as the shipped
`api/_assets/trec-20-19-esign-coords.json`). `page` passes through unchanged: role maps
are 1-indexed and DocuSeal's docs say `page` "Starts from 1"
([docuseal.com/docs/api](https://www.docuseal.com/docs/api), create-a-template-from-pdf →
`documents.fields.areas`); GET responses echo it 0-indexed (established 8/31, re-confirmed
in the PoC read-back). Never "correct" a page value based on a GET echo.

### 1.2 Roles → submitters

DocuSeal submitters are named roles on the template; emails bind at submission time.
Fixed mapping (implemented and proven in the PoC script):

| Role-map `role` | DocuSeal submitter |
|---|---|
| `buyer1` / `buyer2` | Buyer 1 / Buyer 2 |
| `seller1` / `seller2` | Seller 1 / Seller 2 |
| `listing_agent` | Listing Agent |
| `buyer_agent`, `selling_agent` | Buyer's Agent |
| `escrow_agent` | Escrow Agent |
| `property`, `deal` | **Preparer** (the Dossie agent — see §1.4) |

Notes: `selling_agent` (TREC's archaic term for the buyer's side, appears on 9-17) folds
into Buyer's Agent. `loan-assumption.json` has 1 `UNKNOWN` field — converter must fail
loudly on `UNKNOWN`, not skip silently; that field needs a human call before wiring.

### 1.3 Field types

| Role-map `field_type` | DocuSeal `type` | Notes |
|---|---|---|
| `signature` | `signature` | |
| `checkbox` | `checkbox` | |
| `text`, key `*_date`, party-owned | `date` + `preferences.format: "MM/DD/YYYY"` | auto-fills on sign; proven in PoC |
| `text` (everything else) | `text` | |
| (20-19/9-17 initial footers) | `initials` | already how esign-create does it |

DocuSeal's full type list (same doc page): heading, text, signature, initials, date,
number, image, checkbox, multiple, file, radio, select, cells, stamp, payment, phone,
verification, kba, strikethrough. `radio` is available later for "check one box only"
groups; not needed for v1 (checkbox matches current fill-engine behavior). Production
converter should also set `title` per field (PoC showed the raw key "buyer1_date" as the
signer-facing label — works, but ugly) and `required: true` on party signature fields.

### 1.4 The two output modes — and which one each form uses

**Mode A — signing overlay (default, keeps the v13 doctrine).** Dossie's pdf-lib fill
engine bakes all text/checkbox content into the PDF; the converter emits **only the
party-role fields** (signatures, initials, party date lines) as DocuSeal fields. This is
exactly what `esign-create.js` does for the 20-19 today — the converter generalizes
`trec-20-19-esign-coords.json` to all 24 widget forms, sourced from the role maps'
`signature` + party-owned fields.

**Mode B — party-fill (for forms a signer completes themselves).** The Seller's
Disclosure is filled by the *seller*, not the agent. Here the converter emits ALL fields:
`deal`/`property` fields owned by seller1 (or Preparer where the agent pre-answers), so
the seller answers Y/N/U questions inside DocuSeal's signing ceremony. The PoC's
Preparer-completed-with-values pattern is the prefill mechanism: a submitter passed with
`completed: true` + `values` gets its values **stamped as static content** — this is the
long-sought answer to the pink-editable-widget problem that forced the v13 rollback, and
it's the same pattern the IABS flow already uses (`iabsBrokerSubmitter` in esign-create).

Per-form assignment: all 21 addenda + both contracts → Mode A. SDN 55-1 → Mode B
(seller-side send). Lead paint OP-L → Mode A normally (agent fills B/C/D per client
instruction), Mode B optional later.

### 1.5 Where converted output lives — transient templates, not a template library

Keep the current architecture: **each send builds a transient template from the filled
PDF** (`POST /templates/pdf`) and submits against it. The converter is a **build-time
script** (`scripts/build-esign-field-maps.js`) that turns each role map into a checked-in
per-form JSON at `api/_assets/esign-field-maps/<form>.json`:

```json
{ "form_type": "lead-paint-addendum", "source_role_map_generated_at": "...",
  "blank_pdf_sha256": "<hash of the base64 asset it was measured against>",
  "signers": { "Buyer 1": [ {name,type,areas:[{x,y,w,h,page}]}, ... ], ... },
  "expected_field_count_per_signer": { "Buyer 1": 2, ... } }
```

`esign-create.js` replaces the auto-place fallback (`:649-652`) with a
`document_type → field-map` lookup and extends `assertPlausibleResaleFieldCount` into a
generic per-form gate driven by `expected_field_count_per_signer`. Why not persistent
DocuSeal templates per form: (a) the filled PDF differs per transaction, so a persistent
template can't carry the baked text; (b) versioning lives in git next to the code that
uses it; (c) avoids the clone/default_value bug class documented in esign-create. Cost:
transient templates accumulate — add the reaper (archive template after submission
creation succeeds; DocuSeal keeps the submission's own document copy — verify once on
staging before enabling, then it's one DELETE per send).

---

## 2. The submission flow — corrected contract

### 2.1 What breaks today

- `SendPacketButton.jsx:96-107` POSTs `{transactionId, templateId, fields:<object>,
  signers}`; `esign-create.js:1392` requires `documentId` → 400 every time. `fields` as an
  object would be nulled by the `Array.isArray` check (`:1380`) even if it got further,
  and the default `templateId '4952172'` routes into the abandoned pink-widget path.
- DossieSignModal sends one `esign-create` per form → N emails, N signing sessions.
- No `order` is passed to DocuSeal, and Dossie emails every signer simultaneously.

### 2.2 The corrected contract

**One request, one envelope:**

```
POST /api/esign-create
{ transactionId, documentIds: [uuid, ...],        // filled PDFs, in packet order
  signers: [{name, email, role}], message?,
  sequential?: true }                              // default true
```

- Legacy `documentId` (singular) stays accepted. `templateId` path: delete (see §6).
- For each document: resolve `document_type` → field map → build per-signer fields.
- **One DocuSeal submission for the whole packet.** DocuSeal natively supports
  multi-document submissions — `POST /submissions/pdf` takes `documents: []` (each with
  its own `fields`, each `areas[].page` local to that document) plus a `template_ids`
  array for mixing in existing templates (docs: create-a-submission-from-pdf). **This
  kills the merge-PDFs-and-offset-pages work the gap analysis budgeted** — no page-offset
  math, each form keeps its own 1-indexed pages. One submission = one signing session =
  one email per signer for the entire offer packet.
- **Prefill:** already baked into the PDFs by the fill engine (Mode A). Mode B forms add
  a `completed: true` Preparer/agent submitter with `values`.
- **Signing order:** pass `order: 'preserved'` (DocuSeal default: party 2 is not invited
  until party 1 completes — per docs, and submitter status `awaiting` observed live in
  the PoC for non-first submitters). Since Dossie sends its own emails with
  `send_email: false`, sequencing becomes Dossie's job: **email only the first
  pending signer at create time; email the next signer from the webhook when the prior
  one completes.** Today's email-everyone-at-once + preserved order would strand signer 2
  on an "awaiting" page. For buyer-only packets where order doesn't matter, pass
  `order: 'random'` and email all.
- **What comes back / gets stored:** `submission_id`, per-submitter `{uuid, slug,
  status}` → `signature_requests` row exactly as today, plus new columns
  `docuseal_template_id` (for the reaper) and `signing_order`.

### 2.3 The Send button fix (frontend half)

`interactive-editor-init.js` already returns `documentId` (`:563`). FormEditor never
passes it down. Fix: FormEditor pipes `documentId` to SendPacketButton; on Send the
button first calls the existing fill/persist path with the live field snapshot (the same
merge `interactive-editor-download-pdf` already does — bake drafts into
`documents.storage_path`), then POSTs `{documentIds: [documentId], signers}`. Drop
`templateId` and `fields` from the payload entirely. `DEFAULT_TEMPLATE_ID = '4952172'`
(`FormEditor.jsx:213`) is deleted.

---

## 3. The completion leg — make it defensible

`esign-webhook.js` already fetches `GET /submissions/{id}` on all-signed
(`:572-584`) and stores the signed PDF. **That same response already contains
`audit_log_url` and `submission_events`** (verified against the API docs' GET
/submissions/{id} response schema — event types include send_email, open_email,
start_form, complete_form, etc.). Today both are dropped on the floor. Add, in the same
`form.completed`/allSigned branch:

1. **Download `audit_log_url`** → store at `{userId}/{txnId}/audit-{submissionId}.pdf`
   in the `documents` bucket; insert a `documents` row (`document_type:
   'signing_certificate'`).
2. **Hash both PDFs** — `sha256` of the signed PDF and of the audit log, stored on
   `signature_requests` (`signed_pdf_sha256`, `audit_log_sha256`). This is what lets
   Dossie prove the stored copy is the signed one after the DocuSeal account is gone.
3. **Snapshot `submission_events`** (JSONB column `submission_events` on
   `signature_requests`) — sender-side evidence of invites, opens, and completion times
   independent of the audit PDF.
4. Surface a "Signing certificate" download in the doc panel next to the executed PDF.

Migration:

```sql
ALTER TABLE signature_requests
  ADD COLUMN signed_pdf_sha256 TEXT,
  ADD COLUMN audit_log_sha256 TEXT,
  ADD COLUMN audit_log_document_id UUID REFERENCES documents(id),
  ADD COLUMN submission_events JSONB,
  ADD COLUMN docuseal_template_id TEXT;
```

Failure posture: if the audit fetch fails, complete the flow anyway but stamp
`audit_fetch_failed_at` and retry from `cron-esign-events.js` (the verifier cron already
polls submissions — natural home for audit-log backfill of the 32 legacy rows too).

---

## 4. The two broken pieces — concrete fixes

**Fix 1 — Send button (Defect A1).** §2.3 above. Frontend: 2 files
(`FormEditor.jsx`, `SendPacketButton.jsx`). API: accept `documentIds[]` alongside
`documentId`. Nothing new is invented — every capability already exists; the button is
wired to a contract that never existed.

**Fix 2 — `contract_field_drafts` written, never read (Defect A2).** The drafts must
reach every PDF that leaves the building. Single choke point: the fill engine. In
`fill-form.js` (and therefore `dossiesign-prepare.js`, which uses it), after building
`field_values` from canonical `transactions` columns, merge
`transactions.contract_field_drafts` **on top** (member's explicit edits win), translated
through the existing `trec-20-19-editor-field-translate.js` — the exact merge
`interactive-editor-download-pdf.js` already performs for previews. One function, reused.
Acceptance test: type a survey-days value in the editor, send via DossieSignModal, and the
sent PDF (not just the preview) carries it. Until Fix 2 lands, the editor's autosave is a
lie the member can't see — it is the first thing to ship.

---

## 5. Template lifecycle — forms get revised (20-18 → 20-19 must never repeat)

1. **Pin the asset.** Every `api/_assets/*-base64.js` gets its sha256 recorded in a
   checked-in registry `api/_assets/form-registry.json`: `{form_type, trec_number,
   effective_date, superseded_date?, blank_pdf_sha256, esign_field_map,
   role_map_generated_at}`. Each `esign-field-maps/<form>.json` embeds the
   `blank_pdf_sha256` it was measured against; `esign-create` refuses (422) to apply a
   field map whose hash doesn't match the asset it's stamping — geometry can never
   silently outlive the PDF it was measured on. (This exact mismatch is how 20-18 coords
   ran on the 12-page 20-19 for weeks.)
2. **Detect revisions.** `cron-trec-scanner` diffs HTML today; make it download each
   form's PDF and compare sha256 against the registry. On mismatch → Telegram alert with
   the form name + TREC effective date. (TREC forms are public; TXR forms can't be
   auto-fetched — those get a quarterly manual check until licensing is settled, §8.)
3. **Refresh procedure (mechanical, ~1 session/form, same as today's batch):** drop in
   the new base64 asset → rerun the widget extractor → regenerate the role map → human
   pass on changed/new fields only (diff against the old role map — most revisions move
   nothing) → rerun `build-esign-field-maps.js` → registry updated in the same commit.
   The old map stays in git history; the registry's `superseded_date` closes it.
4. **Kill the escape hatches now:** `docuseal-prefill.js` still maps
   `'resale-contract' → 4018208` (the superseded 20-18 template), and any caller passing
   `templateId` bypasses everything. Remove the map entry; make `esign-create` reject
   `templateId` for TREC form document types (IABS keeps its two templates — they're the
   legitimate template-flow users).

---

## 6. Build sequence — ordered so something real ships each week

**Phase 1 — stop the bleeding (2-3 days, mostly mechanical).**
1. Fix 2 (drafts merge into fill pipeline) — the silent-data-loss bug. ~½ day + test.
2. Fix 1 (Send button contract) — single-document first. ~½ day + Quinn browser pass.
3. Kill the 20-18 escape hatches. ~1 hour.
4. Fix the stale local `DOCUSEAL_API_KEY`. ~minutes.
   *Mechanical: yes, all of it. Every capability exists; this is wiring.*

**Phase 2 — the converter, wired (1 session + review).**
5. `scripts/build-esign-field-maps.js` — productionize `.tmp/docuseal-poc/
   rolemap-to-docuseal.js` (Mode A output, title/required, UNKNOWN-role hard fail).
   Generate the 17 addenda maps + hash pinning. Wire the `document_type → map` lookup
   into `esign-create` + generalize the 422 gate. After this every addendum sends with
   correctly placed signature blocks instead of one auto-placed signature.
   *Mechanical: yes — the PoC proved the transform end-to-end. The only judgment calls
   are the loan-assumption UNKNOWN field and spot-checking auto-derived field keys.*

**Phase 3 — one envelope, ordered, seller-capable (2-4 days).**
6. Multi-document submissions via `documents[]`/`template_ids` (no PDF merging). Seller
   rows in DossieSignModal. `order` + webhook-driven sequential emails.
   *Mostly mechanical; the sequential-email state machine needs care around declines
   and resends.*

**Phase 4 — defensibility (1-2 days).**
7. §3 complete: audit log + hashes + events snapshot + certificate surface + legacy
   backfill via cron.
   *Mechanical.*

**Phase 5 — prove it (not engineering).**
8. One real deal end-to-end. Blocked on Phase 1-4 and on §8. This gate has never
   flipped; nothing above is "true" until it does.

**Deliberately later:** SDN Mode B seller-fill flow (1 session), unimproved-property
9-17 initials footer (1 session), 3 flat TXR forms (~1.5 sessions), reminders/void/
resend lifecycle, per-agent defaults, self-hosted DocuSeal.

**Honest sizing to "a buyer's agent runs a full offer packet through Dossie with
defensible records": ~2 focused weeks.** The genuinely non-mechanical items are three:
the sequential-notification state machine, the one-real-deal gate, and everything in §8.

---

## 7. What was deliberately NOT built into this design

- No DossieSign signing ceremony, no tamper-seal of our own — DocuSeal owns the
  ceremony, per Heath's decision and the gap analysis verdict.
- No persistent per-form DocuSeal template library (rationale §1.5).
- No PDF merging for packets — DocuSeal's multi-document submissions make it unnecessary.

## 8. Go-live blockers (outside the code)

1. **DocuSeal account is a Developer Sandbox.** Confirmed live in this session's PoC
   screenshot: "Developer Sandbox. Upgrade to start using in Production." Signatures
   collected under a sandbox banner are a credibility and possibly a validity problem —
   **upgrade to a paid production plan before any real signer sees a page.** (Heath
   action; pricing decision — DocuSeal Pro is ~$20-40/mo range, verify current.)
2. **TXR/TAR copyrighted forms in a public repo.** `tar-wire-fraud-base64.js`,
   `tar-buyer-rep-base64.js`, `tar-listing-agreement-base64.js`, `t47-affidavit-base64.js`
   ship base64-embedded in public GitHub with no vendor license, served through a paid
   product. Separate from e-sign validity; it's the sharpest legal edge in the gap
   analysis (§4.6 there). Route to Hadley → real attorney; interim mitigation is moving
   those four assets out of the public repo (private storage fetch at runtime).
3. **One personal DocuSeal account holds every member's evidentiary record.** §3
   (hashes + audit copies in Dossie's own storage) reduces this from fatal to
   survivable; self-hosted DocuSeal (AGPL, API-compatible) is the endgame.
4. **Stale local `DOCUSEAL_API_KEY` in `.env.local`** — trivial but it will burn the
   next debugging session.

---

## Sources

- DocuSeal API reference, fetched this session: https://www.docuseal.com/docs/api —
  POST /templates/pdf and POST /submissions/pdf (`documents[].fields[].areas`: x/y/w/h
  Numbers, `page` Integer "Starts from 1"; field `type` enum; `template_ids` for
  multi-document submissions), POST /submissions (`order` random|preserved — "the second
  party will receive a signature request email only after the document is signed by the
  first party"; submitter `values`, `completed`, `send_email`, `external_id`,
  `metadata`), GET /submissions/{id} (`audit_log_url`, `combined_document_url`,
  `submission_events` with event_type enum).
- Live PoC this session: template 5682622 / submission 10771902 (both archived),
  screenshots in `.tmp/docuseal-poc/`.
- Code read: `api/esign-create.js`, `api/esign-webhook.js`, `api/dossiesign-prepare.js`,
  `api/_lib/resolve-blank-template-pdf.js`, `api/interactive-editor-init.js` (grep),
  `Dossie/src/components/dossieSign/phase1/{FormEditor,SendPacketButton}.jsx`.
- Role maps: `.tmp/coord-overlays/role-maps/*.json` (18 files, field/role census run
  this session); `docs/FORM-COORDINATE-INVENTORY-2026-09-01.md`;
  `docs/DOSSIESIGN-GAP-ANALYSIS-2026-09-01.md`.
