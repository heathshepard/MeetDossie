# DossieSign Gap Analysis — 2026-09-01

**Question answered:** can DossieSign replace zipForm/Authentisign and DocuSign for a working
Texas agent, and if not, what exactly is missing? Every claim below was verified by reading the
current code on `staging` (and the production bundle on `main` where reachability mattered), plus
read-only queries against the live DB. Builds on `docs/DOSSIE-CAPABILITY-AUDIT-2026-08-31.md`
and `docs/FORM-COORDINATE-INVENTORY-2026-09-01.md`; facts established there are not re-derived.

**The two sentences that frame everything:**
1. Zero real members have ever completed a signature. 32 `signature_requests`, all
   `status='sent'`, 0 completed — the entire post-send half of the product (webhook, signed-PDF
   storage, completion emails) has never once run against a real signer.
2. Heath's instinct — "we don't really have a way for people to fill in fields" — is *almost*
   right, and the precise version is worse: **two interactive editors exist and are live in the
   production bundle, but the full-featured one cannot send (its Send button 400s every time),
   and ~170 of the ~200 fields a member types into it never reach any document that actually
   goes out.**

---

## 1. The member journey, end to end

Path: "I need to send this buyer's offer" → "I have a fully executed PDF in my file."

### Step 1 — Get the deal into Dossie: WORKS
`api/scan-contract.js` (upload a PDF, ~50 fields extracted to `transactions`), manual entry, and
Talk-to-Dossie voice fill all work and have real usage. No wall here.

### Step 2 — Fill the forms: THE FIRST WALL, and it's the big one

Three fill surfaces exist. Each fails differently.

**Path A — "✏️ Fill Contract" (Phase-1 FormEditor, TREC 20-19 only).**
Correction to yesterday's audit: this is NOT hidden-URL-only. A real button sits on the dossier
detail toolbar (`dossie-app.jsx:10711`) and it is in the production bundle
(`main:assets/workspace-DNWGjcuj.js` contains the string and the `/api/interactive-editor-init`
call — verified by grep). The editor itself is genuinely good: ~200 fields in
progressive-disclosure sections (`api/_lib/trec-20-19-field-metadata.js`), 500ms-debounced
autosave, provenance review, a verification-attestation gate, live PDF preview that renders the
member's in-progress values (`POST /api/interactive-editor-download-pdf` with the live snapshot →
`fillTrec2019`). A member CAN type into fields and see the result. Then two defects kill it:

- **Defect A1 — the Send button has never been able to work.**
  `SendPacketButton.jsx:96-107` POSTs `{ transactionId, templateId, fields: <object>, signers }`
  to `/api/esign-create`. The handler (`esign-create.js:1376,1392`) requires `documentId` and
  throws `ValidationError('documentId is required.')` — there is no code path that reads
  `transactionId` in the send branch. Every click returns 400. Even if `documentId` were passed,
  `fields` must be an array (`esign-create.js:1380` — `Array.isArray` else `null`), so the
  member's typed values would be dropped, and the default `templateId` (`'4952172'`,
  `FormEditor.jsx:213`) would route through the pink-editable-widgets template path that the
  v13 rollback explicitly abandoned (`esign-create.js:1436-1454`). The one editor that lets a
  member fill everything ends at a dead button. **This alone explains "I don't think it really
  works right now."**

- **Defect A2 — draft fields are written to a table nothing else reads.**
  Non-canonical fields (~170 of ~200 on the 20-19: survey days, ¶6 objection language, ¶7
  checkboxes, commission %, notices blocks, special provisions …) persist to
  `transactions.contract_field_drafts` (`interactive-editor-update-field.js:195-249`). Grep of
  the entire `api/` tree: only `interactive-editor-init.js` and `interactive-editor-update-field.js`
  reference that column. **`fill-form.js`, `fill-trec-20-19.js`, `dossiesign-prepare.js`, and
  `esign-create.js` never read it.** The stored `documents.storage_path` PDF — the thing
  `esign-create` actually sends — is filled from canonical `transactions` columns only. So the
  member sees their edits in the editor's preview (which passes the live snapshot), then any
  send path that works (Path B/C below) sends a PDF **without those edits**. Saved-but-never-
  shipped is the worst possible failure shape: it looks like it worked. Live DB shows 3
  transactions already carry drafts.

**Path B — "✍ Generate + Sign" (DossieSignModal, the live send path).**
Select forms from a package → `dossiesign-prepare` fills each from `transactions` columns →
preview → recipients → send. Works mechanically, and the fill engine behind it
(`fill-trec-20-19.js` + `trec-20-19-field-coords.json`, hardened 8/30-8/31 with the maxWidth/
overflow, ¶21 column-swap, and pre-send field-audit fixes) is real. Walls:
- Fill quality is capped at what the ~35 canonical columns + the field map can derive. Anything
  else — the exact fields on the required-contract-fields checklist that killed three real
  offers (survey shortage box, ¶7 As-Is, disclosure received/not-received branch, 12B commission,
  TPFA origination cap) — has **no member-facing input that reaches the document** (see A2). If
  the engine's derived value is wrong, the member's only fix is editing a canonical column or
  giving up.
- **Recipients are buyer-side only.** `DossieSignModal.jsx:339-385` builds signers as Buyer +
  Co-Buyers + optional Agent. There is no Seller row. A listing agent cannot send a seller-side
  packet through the main flow at all (the per-document EsignModal does have a Seller-role
  dropdown, but that's Path C).
- **No packet.** The send loop (`:371-410`) fires one `esign-create` per selected form → N
  DocuSeal submissions → N emails → N separate signing sessions for the client. A 3-form offer
  = 3 emails.

**Path C — upload your own PDF + EsignModal "Place fields".**
Real drag/resize placement of signature/initials/date/text/checkbox per signer, Buyer/Seller
roles supported. Walls: every field placed by hand, one per page per signer (no "initial all
pages" bulk tool — the exact tool Authentisign's palette has and Heath asked to mirror); and
**the member cannot type a value into the document themselves** — text fields are placed *for a
signer* to fill at signing. There is no fill-and-annotate for an uploaded PDF (DocuSign's
"Fill & Sign" has no equivalent). An MLS-downloaded Seller's Disclosure can be routed for
acknowledgment, but not corrected or completed by the agent first.

### Step 3 — Send: PARTIAL, with a correctness cliff off the 20-19
The 8/31 fixes are live and real: `esign-create.js:163` loads
`trec-20-19-esign-coords.json` (built from the real 20-19 AcroForm rects), places 10 initial
pages + signature + date per buyer/seller, and `assertPlausibleResaleFieldCount` (`:259-286`)
throws a blocking 422 on implausible counts. The page-indexing ambiguity is resolved
(1-indexed input, documented at `:140-146`). **But this covers exactly one `document_type` —
`resale_contract`.** Every other form falls through to `docusealCreateFromPdf`'s default
(`:649-652`): one auto-placed signature + date per signer, zero initials, no plausibility gate.
That is the same failure class as the 8/30 Ridge Bluff packet, still live for addenda. The 17
addenda role maps built today (`.tmp/coord-overlays/role-maps/`) contain exactly the data needed
and are wired to nothing. Per the coordinate inventory, all 24 single/two-page addenda need only
one end-of-form signature block — so this is close, not far.

Other send-time gaps: no signing-order control is passed to DocuSeal (`submBody` at `:748-753`
has no `order` field; whether DocuSeal's default sequencing blocks signer 2 before signer 1 is
**unverified** — meanwhile Dossie emails every signer their link simultaneously via Resend);
the superseded-form escape hatch still exists (any caller passing `templateId` can still reach
20-18 template 4018208, and `api/_assets/docuseal-prefill.js` still maps
`'resale-contract' → 4018208`); one shared personal `DOCUSEAL_API_KEY` serves all tenants; and
each PDF send creates a transient DocuSeal template with no reaper.

### Step 4 — Track, remind, correct: MOSTLY MISSING
- Status exists only as `GET /api/esign-status`, called from EsignModal for one document. No
  envelope dashboard, no per-transaction "outstanding signatures" list; the doc badge in the app
  is set to `"sent"` client-side once (`dossie-app.jsx:8123`) and never refreshed.
- **No reminders** (the deadline-reminder crons are transaction deadlines, not envelope nudges).
  **No expiration.** **No void/cancel** (the 8/30 archived-link incident — client clicked a dead
  link — was done by hand in DocuSeal; there is no product path, and no path that un-sends the
  email). **No resend**, **no correct-and-reissue**.

### Step 5 — Completion → executed PDF in the file: BUILT, NEVER EXERCISED
`esign-webhook.js` is genuinely solid: HMAC-verified with replay window, fail-closed on missing
secret, downloads the signed PDF on `form.completed`, stores it at
`{userId}/{txnId}/signed-…` in Storage, inserts a `documents` row, emails signers and the agent
with the executed PDF attached, flips `signature_requests` to `completed`. The independent
post-completion verifier (`signature-verifier.js` + `cron-esign-events.js`) is a real
differentiator — it has caught a provider-reported completion that was actually partial. **But
with zero completed envelopes ever, this entire leg is unproven in production.** And the webhook
never fetches DocuSeal's **audit log** — see §4.

**Where does a real member hit a wall?** At step 2, immediately: either their edits can't be
sent (Path A), can't be made (Path B), or must be hand-placed one field at a time with no
self-fill (Path C). A member who somehow gets past that hits the buyer-only recipient list, the
N-envelope client experience, addenda with no initials, and then silence — no reminders, no
status, no way to fix a mistake short of emailing Heath.

---

## 2. Field filling by the member — the direct answer to Heath's question

**Is there an interactive editor?** Yes — two, both live in production:
- `InteractiveEditor.jsx` (legacy, 27 forms): opens automatically after Talk-to-Dossie
  `fill_forms` and after the Gap Wizard. Edits save to real `transactions` columns and re-render
  the PDF via `fill-form` — this loop genuinely works. But its editable-field list
  (`interactive-editor-init.js:202-304`) is ~12 fields on the resale contract and **exactly one
  field (`property_address`) on almost every addendum**. The Seller's Disclosure has 186 mapped
  widget rects and one editable key. Geometry without semantics, exactly as the productization
  memo predicted.
- `FormEditor.jsx` (Phase 1, 20-19 only): the real thing — ~200 fields, typed input, live
  preview, provenance, attestation. Reachable from the "✏️ Fill Contract" button. Crippled by
  Defects A1 (send always 400s) and A2 (drafts never reach a sent document).

**So the actual state is:** members can type into fields and see the result on the 20-19; they
cannot get what they typed onto a document a client signs. On every other form they can edit
almost nothing. On their own uploaded PDFs they can fill nothing. Heath experienced the
composite of those three and summarized it correctly.

Also missing relative to what an agent expects from zipForm's fill UI: click-a-checkbox-on-the-
page interaction (everything is form-field-list-driven; checkboxes on addenda have coordinates
but no editable keys), and any notion of "fill this addendum's ¶A option 2."

---

## 3. Benchmark: DossieSign vs zipForm/Authentisign vs DocuSign

| Capability | zipForm + Authentisign | DocuSign | DossieSign |
|---|---|---|---|
| Transaction/file container | Yes | Rooms (weaker) | **YES** — dossiers, real usage, arguably better UX |
| TX form library — TREC | Yes, always current | No (BYO PDF) | **PARTIAL** — 31 forms bundled; version pinning/monitoring thin (`trec_effective_date` populated for ~1 row; `cron-trec-scanner` diffs HTML, never hashes PDFs) |
| TX form library — TXR/TAR proprietary forms | **Yes, licensed** (the TAR member benefit) | No | **PARTIAL and legally exposed** — TXR-1101 listing agreement, TAR-1501 buyer rep, TAR-2517 wire fraud, T-47 are bundled as base64 **in a public GitHub repo** with no license (see §4) |
| Auto-fill from deal data | Yes (native fill UI) | Minimal | **PARTIAL** — engine real for 20-19; canonical-columns-only ceiling; per-agent contract defaults NOT BUILT (engine never reads `profiles`) |
| Member fills any field interactively | Yes | Fill & Sign | **BROKEN** — §2 above |
| Templates / doc-set reuse | Yes (templates, clauses) | Yes (templates) | **PARTIAL** — `form_packages` (system + user-defined packages) exists and works; no clause library, no saved field-placement templates for uploaded docs |
| Multi-doc envelope ("packet") | Yes | Yes | **NO** — one submission per form, N emails |
| Signing order / routing rules | Yes | Yes (advanced) | **PARTIAL/UNVERIFIED** — agent-last append exists; no order param sent to DocuSeal; all links emailed at once |
| Auto-placed initials on every page | Yes ("Initial Pages" bulk tool) | Yes (templates/AutoPlace) | **20-19 ONLY** — with a real blocking gate; every addendum gets 1 signature, 0 initials; no bulk tool in manual placement |
| CC / non-signing recipients | Yes | Yes | **NO** (seller's agent gets executed copy post-completion only) |
| In-person signing | Yes | Yes | **NO** |
| Delegated/assisted signing, signer reassignment | Yes | Yes | **NO** |
| Reminders / expiration | Yes | Yes (auto) | **NO** |
| Void / correct / resend | Yes | Yes | **NO** — not even a cancel |
| Status dashboard | Yes | Yes | **MINIMAL** — per-doc modal fetch; badge set once client-side |
| Audit trail + completion certificate | Yes (Authentisign cert) | Yes (Certificate of Completion, court-tested) | **NO on Dossie's side** — DocuSeal keeps one, Dossie never fetches/stores/surfaces it |
| Tamper-evident seal on executed PDF | Yes | Yes (digital cert, hash) | **DELEGATED, UNVERIFIED** — whatever DocuSeal Cloud applies; Dossie stores no document hash |
| Signer identity options (access code, SMS, KBA, IDV) | Access-code option | Yes, tiered | **NO** — email link only |
| Mobile signing | Yes | Yes | **LIKELY YES** (DocuSeal responsive pages) — never verified with a real signer |
| White-label signing experience | Broker-branded | Branded | **PARTIAL** — Dossie-branded emails, but the signing page is `docuseal.com/s/…` under Heath's personal account |
| Storage / retrieval of executed docs | Yes | Yes | **BUILT, never exercised** (0 completions) |
| Share to title/broker | Via email | Via CC | **PARTIAL** — compliance email + ZIP exist; seller-agent copy on completion coded, never run |
| Post-completion independent verification | No | No | **YES — unique to Dossie** (`signature-verifier.js`; caught a real false completion) |
| MLS integration / import | Yes (zipForm MLS connect) | No | **NO** |

The two rows where Dossie is genuinely ahead: the transaction container and the independent
completion verifier. Everything in the signing lifecycle between "send" and "completed" is
missing, not weak.

---

## 4. Legal sufficiency — ESIGN and Texas UETA

Texas adopted UETA as Tex. Bus. & Com. Code ch. 322; federal ESIGN (15 U.S.C. §7001 et seq.)
defers to it (§7002). The bar for *validity* is low; the bar for *defensibility* is where
DossieSign is short. Real-estate purchase contracts are covered (UETA excludes wills/codicils,
not real-estate transactions; TREC/TAR practice has run on Authentisign/DocuSign for years).

1. **Intent to sign (§322.002(8) — "executed or adopted … with intent to sign").**
   Click-to-sign on DocuSeal's page satisfies this. **MET, delegated to DocuSeal.**
2. **Agreement to conduct the transaction electronically (§322.005(b)).**
   Determined from context and conduct — a buyer who receives "Review & Sign Document" and
   completes the flow has agreed by conduct. Dossie's own email (`esign-create.js:1003-1031`)
   contains no consent language and no paper-copy/withdraw-consent notice; whatever consent
   screen exists is DocuSeal's. The stricter ESIGN §7001(c) consumer-consent regime applies
   mainly where another law requires a writing be *provided* to a consumer (e.g., certain
   disclosures) — mostly not triggered here, but nobody has verified what DocuSeal's signing
   page actually displays. **LIKELY MET; UNVERIFIED — one real signing session would settle it.**
3. **Attribution (§322.009 — attributable if it was the act of the person, shown by any means
   including the efficacy of a security procedure).** Email-link-only authentication. That is
   the same default Authentisign uses, so it is industry-acceptable — but Dossie offers no
   access code, SMS, or IDV even as an option, and stores only name/email/role/status per
   signer. **MINIMALLY MET.**
4. **Association of the signature with the record + record retention (§322.012 — a retained
   record must accurately reflect the information and remain accessible).** The executed PDF
   with embedded signatures is stored to Supabase Storage on completion — coded, never run in
   production. **The critical gap: DocuSeal's audit log (signer IP, timestamps, viewed/started/
   completed events, email verification) is never fetched, stored, or shown** — grep of
   `esign-webhook.js`/`esign-download.js` for `audit_log`: zero hits. `esign_events` rows and
   `signature_requests.signers` statuses are a partial shadow, not a certificate. If the shared
   personal DocuSeal account is ever suspended, deleted, or its retention lapses, **the
   evidentiary record for every member's executed contract dies with it.** Dossie also stores no
   hash of the executed PDF, so it cannot itself prove the stored copy is the signed one.
5. **TREC compliance.** The live default path now fills and sends the current 20-19 — good. But
   the superseded 20-18 remains reachable: `docuseal-prefill.js` still maps
   `resale-contract → 4018208`, and any explicit `templateId` passes straight through
   (`esign-create.js:1459,1489`). Sending a superseded promulgated form is a TREC problem, not
   tech debt. Kill the path.
6. **TXR/TAR form licensing — separate from e-sign law and probably the sharpest legal edge.**
   TREC-promulgated forms are public. TXR forms are copyrighted, licensed to Texas REALTORS
   members through authorized platforms (zipForm). Dossie bundles TXR-1101, TAR-1501, TAR-2517,
   and the T-47 as base64 assets **in a public repo** and serves them through a paid product
   with no vendor license. Route to Hadley → a real attorney before this scales.

**Verdict:** a signature collected through DossieSign today would very likely be *enforceable* —
UETA's bar is low and DocuSeal's signing ceremony carries intent and conduct-consent. What
Dossie cannot currently do is *prove it well*: no stored audit trail, no certificate to hand a
title company or a court, no document hash, retention never exercised, and the whole evidence
chain resting on one personal third-party account. That is the practical difference between "a
signed PDF" and "an enforceable record you can defend two years later," and it is exactly the
artifact (Certificate of Completion) that makes brokers comfortable with DocuSign.

---

## 5. Hard vs mechanical

**Already solved — needs wiring only (days):**
- 17 addenda signature role maps exist at `.tmp/coord-overlays/role-maps/` → wire into
  `esign-create` as a `document_type → coord-file` lookup replacing the auto-place fallback,
  and extend the 422 plausibility gate to every form (addenda: signature-block count only).
- Fix Defect A1: the Phase-1 send needs the filled document's `documentId` and the
  signer-widget path — both already exist; the button is just wired to the wrong contract.
- Read `contract_field_drafts` in the fill pipeline (Defect A2): `fill-form`/`fillTrec2019`
  already accept arbitrary `field_values`; merge drafts in at fill time and at
  `dossiesign-prepare`. The editor field names already translate
  (`trec-20-19-editor-field-translate.js` exists and is used by download-pdf).
- Retire the 20-18 escape hatches (`docuseal-prefill.js` map, template-path passthrough).

**Straightforward engineering (1-3 weeks total):**
- One packet per envelope: merge selected PDFs, offset per-form coord pages, single DocuSeal
  submission with signing order — the item most likely to be underestimated (page-offset math),
  but still ordinary work.
- Envelope lifecycle: reminders cron (DocuSeal has a resend endpoint), expiration policy,
  void/cancel (archive + suppress-notification handling — remember the dead-link incident),
  resend, a per-transaction signature-status panel fed by `esign-status`.
- Store the evidence: on completion, fetch and store DocuSeal's audit log alongside the signed
  PDF, record a sha256 on `signature_requests`, surface a "signing certificate" view.
- Seller-side recipients in DossieSignModal; CC recipients.
- SDN 55-1 semantic layer + unimproved-property 9-17 initials footer + 3 flat forms (already
  sized at ~4.5 sessions in the coordinate inventory).
- Per-agent contract defaults (Tier 2 of yesterday's audit — the engine must stop being
  right only for Heath).
- Bulk "initial all pages" tool in the manual-placement UI.

**Genuinely difficult (weeks-to-months, or not engineering at all):**
- **Proving it** — one real member, one real counterparty, one completed envelope. Blocked on
  everything above being trustworthy, and on Heath's willingness to route a real deal through
  it. This is the single gate that has never flipped.
- **Multi-tenant signing infrastructure** — the shared personal DocuSeal account is a
  single point of failure for every member's legal records. Self-hosted DocuSeal (it's
  open-source, AGPL; the API is compatible) or per-tenant accounts + a custom signing domain.
  Real ops work, and it is also the white-label answer.
- **TXR form licensing** — a business/legal negotiation, not code. Without it, "replace
  zipForm" can never be fully true, because half of what zipForm is for a Texas REALTOR is the
  licensed TXR library (listing agreements, buyer rep, amendments TXR flavors, addenda).
- **Signer identity options beyond email** — mechanical to add via DocuSeal (phone/access
  code), listed here because deciding the policy (when to require it) is the hard part.
- **Semantic field maps for all 24 widget forms at editor quality** — not hard per form
  (the inventory proves geometry is clean), but it is the long tail that makes "fill any form"
  true, and each form needs a one-time human-approved labeling pass.

---

## 6. The honest verdict

**Should DossieSign try to replace the signing layer itself? No — and it already doesn't.**
The architecture is Dossie-fill + DocuSeal-rails, and that is the right call: building
tamper-sealing, audit certificates, and a signing ceremony from scratch is a compliance product
in itself with zero differentiating value. The in-house asset worth owning is everything Dossie
already leads on: the transaction container, the TREC fill engine, the pre-send audits, the
post-completion verifier. Keep DocuSeal (eventually self-hosted, so "in house" becomes literally
true and the shared-account risk dies), and stop treating "replace DocuSeal" as a goal.

**Can it replace zipForm + Authentisign for a working agent?** Not today — a member cannot get
their own field values onto a sent document, cannot send a seller-side packet, cannot remind,
void, or prove anything. But the distance is shorter than the gap list looks, because the
expensive parts (fill engine, coordinate maps, verification, webhook leg) are built and the
remaining walls are mostly wiring and lifecycle CRUD:

1. **Week 1 — make filling real:** fix the Phase-1 send contract (A1), merge
   `contract_field_drafts` into the fill pipeline (A2), wire the 17 addenda role maps + extend
   the 422 gate, kill the 20-18 paths. After this, one member can fill a 20-19 + addenda
   correctly and send it with full initials.
2. **Week 2 — make sending professional:** one packet/one email, seller-side recipients,
   signing order, reminders/expiration/void/resend, status panel.
3. **Week 3 — make it provable:** store the DocuSeal audit log + PDF hash on completion,
   surface a signing certificate, then run **one real deal end to end** (DoD gate 9). Nothing
   is true until that happens.
4. **Then:** per-agent defaults, SDN/9-17/flat-form maps, self-hosted DocuSeal, and the TXR
   licensing conversation — the last of which decides whether the pitch is "replace zipForm"
   (needs the license) or "TREC-complete deal room that verifies what your e-sign platform
   tells you" (needs nothing and is honest today, for buyer-side TREC work).

Realistic sizing to "a working buyer's agent can genuinely run TREC offers through DossieSign
instead of zipForm": ~3 focused weeks of engineering plus one real proven deal. To "replaces
zipForm outright, both sides, all forms, defensible records": add the TXR license, the
self-hosted signing layer, and the long-tail semantic maps — a quarter, and the license is out
of engineering's hands.

---

## Sources (verified this session)

Code read: `api/esign-create.js` (full send path, coord loading, 422 gate, DocuSeal calls,
emails), `api/esign-webhook.js` (HMAC verify, completion leg), `api/esign-status.js`,
`api/esign-download.js`, `api/interactive-editor-init.js`, `api/interactive-editor-update-field.js`,
`api/interactive-editor-download-pdf.js`, `api/dossiesign-prepare.js`, `api/form-packages.js`,
`api/fill-form.js` (pre-send audit wiring), `api/_assets/` inventory,
`Dossie/dossie-app.jsx` (editor/modal reachability, status badge),
`Dossie/src/components/{DossieSignModal,EsignModal}.jsx`,
`Dossie/src/components/dossieSign/{InteractiveEditor.jsx,phase1/*}`.
Bundles: `main:assets/workspace-DNWGjcuj.js` and staging `workspace-BYzo2Ytk.js` grepped for
feature reachability. Live DB (read-only): `signature_requests` (32/all-sent/0-completed),
`dossiesign_auto_map_runs` (Fable5 run present), `transactions.contract_field_drafts` (3 rows),
`form_templates` (29), `contract_verification_events` (3), `esign_events` (76).
Prior docs built on, not re-derived: `docs/DOSSIE-CAPABILITY-AUDIT-2026-08-31.md`,
`docs/FORM-COORDINATE-INVENTORY-2026-09-01.md`, memory `esign-packet-send-playbook`,
`feedback_required-contract-fields-checklist`, `dossie-esign-productization-plan`.

**Explicitly unverified:** what consent/disclosure language DocuSeal's signing page shows a
signer; whether DocuSeal Cloud applies a cryptographic seal to completed PDFs; DocuSeal's
default signing-order behavior when no `order` is passed. Each needs one live signing session
to settle — the same session that would flip DoD gate 9.
