# Dossie Product Gap Analysis: Pre-Contract to Close

## Architecture Verified From Codebase

**Confirmed live in code:**
- `fill-form.js`: 3 generators — `resale-contract`, `financing-addendum`, `termination-notice`
- `draft-amendment.js`: TREC 39-10 generator — 3 types (`closing_date`, `option_extension`, `price_change`)
- `scan-contract.js`: Identifies 20+ document types including IABS, buyer rep, wire fraud warning, title commitment — but NO generators for any of them
- `transactions/download-zip.js`: ZIP download exists (5 MB cap, STORE mode)
- `esign-create.js`: DocuSeal live, sequential signing buyer → agent
- `form-templates.js` + `form-packages.js`: Form library fully implemented
- `chat.js`: `update_deal_field` exposes `appraisal_deadline`, `survey_deadline`, `hoa_document_deadline`, `loan_approval_deadline` as updateable
- `cron-deadline-reminders.js`: Tracks 7 deadline fields with T-7, T-1, T-0 reminders
- `transactions` table: Has `inspector_name/phone/email`, `hoa_name/phone`, all deadline fields — but NO `transaction_type` enum

---

## Phase-by-Phase Gap Table

### Phase 0 — Pre-Contract

| Gap | Criticality | Complexity | Type |
|---|---|---|---|
| IABS delivery tracking (required before representation) | Critical | Small | Workflow + tracking |
| TAR 1501 (Buyer Representation Agreement) generator | Critical | Medium | Generator |
| Pre-approval letter capture + parsing | High | Small | Tracking |
| Transaction type differentiation (buyer_purchase / seller_listing / land / new_home / lease) | High | Small | Data model |
| Auto-load correct form package based on transaction type | High | Small | Workflow |
| Pre-contract phase / dossier state before contract execution | High | Medium | Workflow |
| Seller-side: Listing agreement tracking | Medium | Medium | Tracking + generator |
| Seller-side: MLS input sheet | Medium | Medium | Generator |
| Seller-side: Seller's net sheet generator | Medium | Large | Generator |
| Seller-side: Offer comparison tool | Medium | Large | Workflow |

### Phase 1 — Contract Execution

| Gap | Criticality | Complexity | Type |
|---|---|---|---|
| Wire fraud warning delivery + acknowledgment log (TAR 2517 — LEGALLY REQUIRED) | **CRITICAL** | Small | Generator + Workflow |
| Option fee receipt tracking | Critical | Small | Tracking |
| Earnest money delivery tracking | Critical | Small | Tracking |
| TREC 36-11 (HOA Addendum) generator | High | Medium | Generator |
| OP-L (Lead-Based Paint Addendum) generator | High | Medium | Generator |
| OP-H (Seller's Disclosure Notice) generator | High | Medium | Generator |
| TREC 49-1 (Right to Terminate Due to Lender's Appraisal — Jan 2025) | High | Medium | Generator |
| TREC 38-7 (Buyer's Termination of Contract) generator | High | Small | Generator |
| TAR 1503 (Earnest Money Release) generator | High | Small | Generator |

### Phase 2 — Option Period

| Gap | Criticality | Complexity | Type |
|---|---|---|---|
| Inspection scheduling / tracking (fields exist in DB, no workflow UI) | Critical | Small | Workflow |
| Repair amendment specific flow (extend draft-amendment.js) | High | Small | Workflow |
| Buyer's termination notice generator (TREC 38-7) | High | Small | Generator |
| Earnest money release generator (TAR 1503) | High | Small | Generator |
| Option fee receipt confirmation log | Critical | Small | Tracking |

### Phase 3 — Under Contract (Post-Option)

| Gap | Criticality | Complexity | Type |
|---|---|---|---|
| Appraisal tracking workflow (ordered, received, value vs. price, gap) | Critical | Small | Tracking |
| Title commitment upload + deadline extraction | Critical | Medium | Workflow |
| Loan approval / clear-to-close tracking | Critical | Small | Tracking |
| Survey receipt tracking | High | Small | Tracking |
| HOA document request tracking | High | Small | Tracking |
| TREC 49-1 invocation workflow (auto-surface when appraisal low) | High | Small | Workflow |
| T-47 Residential Real Property Affidavit | High | Small | Generator |

### Phase 4 — Closing

| Gap | Criticality | Complexity | Type |
|---|---|---|---|
| Wire fraud warning delivery log (must be documented) | Critical | Small | Generator + Tracking |
| Wiring instructions verification log | High | Small | Tracking |
| CDA (Commission Disbursement Authorization) tracking | High | Small | Tracking |
| CD / HUD-1 review checklist | High | Small | Workflow |
| Final walkthrough checklist | Medium | Small | Workflow |

### Phase 5 — Post-Closing

| Gap | Criticality | Complexity | Type |
|---|---|---|---|
| Recorded deed storage workflow | Medium | Small | Tracking |
| Title policy delivery tracking | Medium | Small | Tracking |
| CDA tracking (broker signature + file copy) | High | Small | Tracking |
| Post-closing compliance packet ZIP (API built — needs UI) | High | Already built | UI |

### Cross-Cutting

| Gap | Criticality | Complexity | Type |
|---|---|---|---|
| Transaction type enum on `transactions` table | Critical | Small | Data model |
| ZIP download UI button in dossier (API exists, no frontend button) | Critical | Small | UI |
| SkySlope / Dotloop-ready ZIP format (standard naming + cover page) | High | Medium | Workflow |
| Direct SkySlope / Dotloop integration | Medium | Large | Integration |

---

## Prioritized Build Roadmap

### Phase 1 — "Complete the Buyer Purchase Transaction" (10-12 dev days)
Everything uses existing infrastructure. No new dependencies.

**1A. Transaction Type Model (1 day)**
- Add `transaction_type` enum to `transactions` table
- Update dossier creation to set type
- Auto-load Buyer Transaction or Seller Transaction package on creation

**1B. Wire Fraud Warning Generator + Delivery Log (2 days) — MOST URGENT**
- Generate TAR 2517 with buyer name + property + date
- Route through DocuSeal for buyer acknowledgment
- Log delivery in `wire_fraud_deliveries` table
- Surface warning badge on dossier if not delivered

**1C. Option Fee + Earnest Money Receipt Tracking (1 day)**
- Add `option_fee_paid_at`, `option_fee_paid_to`, `earnest_money_deposited_at`, `earnest_money_confirmed_at`
- UI: checkbox + timestamp in Option Period section

**1D. TREC 38-7 (Buyer's Termination) Generator (1 day)**
- Same pattern as `fill-form.js` — base64 embed + FORM_CONFIGS entry
- Route through DocuSeal for buyer signature

**1E. TAR 1503 (Earnest Money Release) Generator (1 day)**
- Same pattern — buyer/seller signatures via DocuSeal

**1F. Inspection Tracking Workflow (1 day)**
- Add `inspection_scheduled_at`, `inspection_completed_at`, `inspection_report_received`
- Add Inspection section to dossier detail view
- Talk to Dossie: "inspection is tomorrow at 2pm" → updates `inspection_scheduled_at`

**1G. Appraisal Tracking Workflow (1 day)**
- Add `appraisal_ordered_at`, `appraisal_received_at`, `appraisal_value`
- Gap calculation: if `appraisal_value < sale_price`, surface TREC 49-1 option

**1H. Title Commitment Workflow (2 days)**
- When title commitment uploaded + scanned → extract key dates
- Add `title_commitment_received_at`, `title_exceptions` (JSONB)
- Add T-47 Affidavit to form library as blank attach

**1I. ZIP Download UI Button (0.5 days)**
- `/api/transactions/download-zip` is fully built — just needs a frontend "Download Compliance ZIP" button in the Documents section

**1J. SkySlope/Dotloop-Ready ZIP (1 day)**
- Extend download-zip with standard file naming prefix (`01-Contract.pdf`, `02-Amendment.pdf`)
- Add brokerage-submission cover page PDF
- Output: `[address]-compliance-package.zip`

---

### Phase 2 — "Close the Pre-Contract Gap" (High-Value, Not Blocking)

- TAR 1501 (Buyer Representation Agreement) generator
- IABS delivery tracking + confirmation
- TREC 36-11 (HOA Addendum) generator
- OP-L (Lead-Based Paint Addendum) generator — auto-trigger when `year_built < 1978`
- OP-H (Seller's Disclosure Notice) blank attach + tracking
- Repair amendment specific flow (extend draft-amendment.js with `repair_items` type)
- Pre-contract dossier phase (stage before `under-contract`)
- TREC 49-1 generator

---

### Phase 3 — "Seller Side + Post-Closing + Integrations"

- Seller-side transaction type (listing agreement, offer comparison, net sheet)
- T-47 Affidavit generator (upgrade from blank attach)
- CD / HUD-1 review checklist
- Final walkthrough checklist
- Post-closing workflow (recorded deed, title policy, CDA)
- SkySlope / Dotloop direct API integration

---

## The Single Most Important Missing Feature

**Wire fraud warning delivery log (TAR 2517) with buyer acknowledgment.**

Every transaction Dossie handles today involves funds transfers — earnest money, option fee, closing wire. Texas agents have been held liable for wire fraud losses when they failed to document the warning. The infrastructure is already in place: DocuSeal is wired, the scanner identifies `wire-fraud-warning` documents, and the PDF exists as a TAR standard form. This is a 2-day build and the highest liability gap in the product.

---

## What Dossie Can Claim After Each Phase

- **After Phase 1:** "Buyer-side residential resale transaction management from option fee receipt through compliance package delivery to the brokerage."
- **After Phase 2:** "Pre-contract through close for buyer or seller, including representation agreement, all required disclosures, and full form generation."
- **After Phase 3:** "Full transaction lifecycle management — buyer, seller, and post-closing — with brokerage portal integration."

---

## Key Files for Implementation

| File | Role |
|---|---|
| `api/fill-form.js` | Pattern for ALL new generators (38-7, 1503, wire fraud, 36-11, OP-L, T-47) |
| `api/draft-amendment.js` | Extend `ALLOWED_TYPES` for `repair_items` amendment type |
| `api/chat.js` | Extend `update_deal_field` enum + add new tools for inspection/appraisal workflows |
| `api/cron-deadline-reminders.js` | Extend `DEADLINE_FIELDS` with all new date columns |
| `api/transactions/download-zip.js` | Extend with filename ordering + cover page for brokerage submission |
