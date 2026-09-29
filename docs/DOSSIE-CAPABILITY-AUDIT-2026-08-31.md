# Dossie Capability Audit — 2026-08-31

**Purpose.** An evidence-based answer to "what can Dossie actually do for a paying member
today?" — written because assumptions about what was built have repeatedly been wrong. Every
verdict below was reached by reading code, schema, and live production data, not by trusting
memory files or prior summaries. Where something could not be determined, it says so.

**Method.** Source: `/mnt/c/Users/Heath/Projects/MeetDossie` (API routes, crons, scripts,
assets) and `/mnt/c/Users/Heath/Projects/Dossie` (React source). Live DB queried read-only via
the Supabase MCP against project `pgwoitbdiyubjugwufhk`. No code was changed. Nothing was
committed.

**The one number that frames everything else.** Every e-signature request ever created in
production came from `demo@meetdossie.com` (31) or `heath.shepard@kw.com` (1). Zero real
members have ever sent a document for signature through Dossie. Zero envelopes have ever
completed. The last one was created 2026-08-25.

```
signature_requests: 32 rows total, ALL status='sent', 0 completed
  demo@meetdossie.com     31   2026-05-30 → 2026-08-25
  heath.shepard@kw.com     1   2026-07-12
```

Real member transaction usage, for scale:

```
brittney@setxrealty.com     63 dossiers   last touch 2026-08-28
demo/demo2/demo-team-*      31 dossiers
heath.shepard@kw.com         9 dossiers
tgill@phyllisbrowning.com    3
mikirgvrealtor@gmail.com     2
jenn / amanda / heath@gmail  1 each
```

One real member (Brittney) has meaningful usage. The product's transaction shell is real and
used. Nearly every "agent does the work for you" capability below is not.

---

## Verdict table

| # | Capability | Verdict | One-line reason |
|---|---|---|---|
| 1 | CMA generation | **NOT BUILT** | No route, no UI, no MLS data license. ~40 local Playwright scripts bound to Heath's own passkey-gated connectMLS session. |
| 2 | Contract fill + e-signature | **PARTIAL** | Fill engine is real and good. Send path is real but places initials from the *superseded* TREC 20-18 geometry onto a 20-19, and gives addenda zero initials. |
| 3 | Brokerage compliance upload | **NOT BUILT** | The product emails a packet and hands the member a ZIP to upload themselves. "Compliance Vault" ($15/mo, live Stripe) is a present-vs-missing document grid. KW Command work is untracked local scripts on Heath's own session. |
| 4a | Transaction timeline | **PARTIAL** | Inbound-email-only digest. No event table. E-sign and ShowingTime entries are written and then silently filtered out of the UI. |
| 4b | Member email connection | **NOT BUILT** | Backend is genuinely multi-tenant. The Settings "Connect Gmail" button is a `Coming Soon` toast that calls nothing. |
| 4c | Member SMS capture | **NOT BUILT** | No provider, no dependency, no A2P registration. Heath's 196k-row store is a single-PC scraper with no tenancy column. |
| 5 | Per-agent contract defaults | **NOT BUILT** | What exists is broker *identity* defaults for IABS. Zero contract-term defaults; the 20-19 engine never reads `profiles` at all. |
| 6 | Agent/task queue | **BUILT, but internal-ops only** | Real, elaborate, running. Every write path is gated on `CRON_SECRET` or Heath's email. Not reusable as a member backbone without a new system. |
| 7 | Member education / discovery | **PARTIAL, stale** | A 5-step checklist plus one capabilities page that contradicts itself and omits most shipped features. `help-pages.js` (8 articles) and `whats-new.js` are fully built with **zero consumers**. |

---

## 1. CMA generation — NOT BUILT (member-facing)

### What's in the product

Nothing. Confirmed by exhaustive search across both repos.

- **No API route** generates a CMA or pulls comps. The only `cma` string in `api/` is a
  *document classification label* in `api/scan-contract.js` (lines 59, 86 — `'cma':
  'Comparative Market Analysis'`), which recognizes a CMA someone else made.
- **No UI.** `Dossie/dossie-app.jsx` (13,716 lines) contains exactly one CMA reference:
  line 187, the string `"Prepare comparative market analysis"` — a checklist item label in
  `CHECKLIST_BY_STAGE["pre-listing"]`. It tells the agent to go do it somewhere else.
- **No MLS data feed.** No Bridge / Trestle / Spark / MLSGrid / RESO key in `.env.local`,
  `docs/ENV.md`, `vercel.json`, `api/config.js`, or `package.json` dependencies.
- `api/cron-mls-status-staleness.js` is a pure date check, and its own header is explicit:
  *"Dossie has no visibility into the live MLS record at all."*
- **Not promised to members.** No CMA feature page in `marketing/features-data/`; no mention
  on `/agents`, `/coordinators`, `index.html`, `faq.html`, `help.html`. The only forward
  claim is the in-app roadmap row `Q4 2026 — Compliance Vault + MLS integration`
  (`dossie-app.jsx:6680`), honestly labelled as future.

### What actually produced the Ridge Bluff CMA

`.tmp/ridgebluff-cma/` — a hand-driven artifact, not a product output.

- Data: live-scraped from connectMLS by `scripts/brokerage-cma-ridgebluff-01-solds-78216.js`
  and siblings, which `page.goto('https://lera.connectmls.com/...')` inside a persistent
  Chrome profile.
- PDF: `.tmp/ridgebluff-cma/build-cma-pdf.js` — a one-off that **hardcodes the eight comps as
  a literal JS array**, including a hand-assigned `tier` of primary/secondary/ceiling/demoted,
  base64-inlines the photos, and calls Playwright `page.pdf()`. There is no comp-selection
  logic, no adjustment engine, no reusable function. The analysis was done by a human/LLM and
  typed into an array.

### Why this is the hard one to productize

The blocker is not the PDF. It is **per-member MLS data access**, and it has three distinct
walls:

1. **Auth cannot be delegated.** `scripts/_lib/connectmls-actions.js` documents the login as a
   **QR-code cross-device WebAuthn passkey** flow — scan with the phone, phone approves.
   `scripts/brokerage-login-setup.js` states plainly: *"This cannot be scripted (by design) —
   Heath completes it himself, once."* There is no credential that could be stored on a
   member's behalf even in principle, and asking members for MLS credentials would violate
   most MLS rules of participation anyway.
2. **One profile, one machine, one at a time.** `scripts/_lib/brokerage-browser.js` pins a
   single `launchPersistentContext` directory (`~/.brokerage-browser-profile`, overridable
   via `BROKERAGE_PROFILE_DIR`) and needs a cooperative lock (`chrome-profile-unlock.js`)
   because only one job may hold it. 191 scripts reference that profile. This architecture
   cannot serve two members, let alone two hundred.
3. **A licensed feed is a business deal, not an integration ticket.** The legitimate route is
   a RESO Web API feed (MLS Grid, Bridge Interactive, Trestle) under a signed data-license
   agreement with **each MLS individually**, plus broker/participant authorization per agent.
   SABOR alone would be one negotiation; "statewide Texas" is a dozen more. Cost is modest
   (tens of dollars per feed per month); **time and approval are the cost**, and neither is
   engineering work.

### The honest cheap path

Do not license data first. Do what `scan-contract.js` already proves works: **let the member
bring the data.** Every MLS, connectMLS included, lets an agent export a search result or
download its own CMA PDF. A "upload your sold-comps export → Dossie does the analysis,
adjustments, ceiling check, and produces the client-ready CMA" feature needs **no MLS
relationship at all**, and the analysis half is the part that made the Ridge Bluff document
good. The scraping half is the part that cannot ship.

---

## 2. Contract fill + e-signature ("DossieSign") — PARTIAL

### What genuinely works

- **The 20-19 fill engine is real and is the best-engineered thing in the codebase.**
  `api/_lib/fill-trec-20-19.js` (1,216 lines) draws text onto the 12-page flat TREC 20-19 by
  coordinate, driven by `api/_assets/trec-20-19-field-coords.json` (`pageCount: 12`,
  deterministically computed from label anchors via pdfjs-dist). Today's three merged commits
  hardened it: `2a86a483` (enforce per-field `maxWidth`, wrap→shrink→truncate degrade order;
  nudge page-11 broker widget rects 3.5pt off their printed labels), `1cadd5c3` (route
  unbreakable single tokens through the same degrade pipeline), `22fb0f91` (swap ¶21 NOTICES
  agent-block x-coordinates — buyer's-agent and seller's-agent columns were transposed).
  Each shipped with a real regression script (`scripts/regression-trec-20-19-*.js`).
- **A pre-send field audit exists and blocks.** `api/_lib/pre-send-field-audit.js`, called at
  `api/fill-form.js:4347`, reads the write ledger that `drawFieldText`/`safeSetText` populate
  and blocks the save when a financially material field (sale price, closing date, earnest
  money, option fee/days) had a real source value but never landed on the page. It raises a
  `dossie_asks` card rather than returning a silent 200. It is honest about coverage: fields
  it cannot attribute to a stable semantic name are reported as `untracked`, never conflated
  with `verified`.
- **Post-completion verification exists.** `api/_lib/signature-verifier.js` +
  `api/cron-esign-events.js` ingest e-sign notification emails from any provider
  (authentisign|docusign|docuseal|adobesign), download the document, and verify it visually —
  it has already returned `partially_signed` against a provider that reported completion.
  62 `esign_events` rows exist. All belong to one user.
- **Contract intake works.** `api/scan-contract.js` extracts ~50 structured fields from an
  uploaded TREC PDF (Haiku 4.5, Opus for large docs) into `transactions`. Member-facing,
  wired at `dossie-app.jsx:2532`. This is a genuine, shipped, useful capability.
- **A member can manually place fields.** `EsignModal.jsx` "Place fields" tab (`mode:
  "canvas"`) + `dossieSign/FieldOverlay.jsx` give real drag/resize placement of
  signature/initials/date/text/checkbox fields onto rendered PDF pages, sent to
  `esign-create.js` as `fields[]` with `x_pct/y_pct/w_pct/h_pct`.

### Can a member fill a TREC contract and send it for signature end-to-end today?

**Mechanically yes. Correctly, no.** Here is the actual gap list.

**Gap 1 — the automatic initials map is for the wrong form version, and is short by two pages.**
This is the concrete defect.

- `api/fill-form.js:83-96` fills form type `resale-contract` from
  `trec-resale-20-19-base64.js` and tags it `formVersion: '20-19'`, writing
  `documents.document_type = 'resale_contract'`.
- `api/esign-create.js:1557` sees `document_type === 'resale_contract'` and calls
  `buildResaleContractFieldMap()`, which loads **`api/_assets/trec-20-18-esign-coords.json`**
  (`esign-create.js:146`) — a map extracted from the AcroForm widget rects of TREC **20-18**,
  the form 20-19 superseded effective 2026-07-01 (`fill-form.js:1458`).
- That map contains **8 initial positions per party** (pages 1–8) and one signature (page 9).
- I counted the real 20-19 blank page by page with `pdftotext`. It has **10 pages carrying an
  "Initialed for identification by Buyer/Seller" line — pages 1–9 and 12** — and its
  `EXECUTED the` signature block is on **page 10**, with `BROKER CONTACT INFORMATION` on
  page 11.

  ```
  page  1..9   initialLine=1
  page 10      EXECUTED block
  page 11      BROKER CONTACT INFORMATION
  page 12      initialLine=1
  ```

  So regardless of whether DocuSeal's `areas[].page` is 0- or 1-based, **at least two pages of
  required initials are never placed**. (The indexing base could not be settled from the code:
  `esign-create.js:1057` carries a comment saying "0-indexed page = 2" immediately above a
  literal `page: 3`. That inconsistency needs resolving before anyone trusts the signature
  page number either — under 1-based indexing the buyer signature lands on page 9, which on a
  20-19 is a contract page, not the signature block. **Determine this empirically against a
  live DocuSeal submission before shipping any fix.**)

**Gap 2 — addenda get zero initials, by design.** The auto field map only fires for
`document_type === 'resale_contract'`. For every other document — the 40-11 financing
addendum, the 49-1 appraisal addendum, the HOA addendum, the lead-paint addendum —
`esign-create.js:592-596` falls through to:

```js
// Default: a signature + date field per submitter, DocuSeal auto-places them.
allFields.push({ name: `${role} Signature`, type: 'signature', role });
allFields.push({ name: `${role} Date`, type: 'date', role });
```

One signature, one date, auto-placed wherever DocuSeal decides. This is exactly the failure
Heath caught by hand on 2026-08-30 — a packet with three signature fields per buyer and zero
initials across 15 pages — and it is live in the product, not just in the throwaway script.

**Gap 3 — there is no packet.** `DossieSignModal.jsx:371` sends **each selected form as its own
`esign-create` call**, producing N separate DocuSeal submissions and N separate signing links
emailed to the client. A buyer receiving an offer gets three emails and three signing
sessions, not one packet in signing order.

**Gap 4 — no bulk "initial every page" tool.** Manual placement (the working escape hatch)
means one drag per page per signer. A 12-page 20-19 with two buyers is 24 placements before
you touch the addenda. Grep for `all pages` / `every page` / `apply to all` / `bulk` across
`EsignModal.jsx` and `FieldOverlay.jsx` returns nothing.

**Gap 5 — three competing send paths, only one of them normally reachable.**
1. `DossieSignModal` → `esign-create` per document → PDF-with-widgets path. **This is the live
   member path.**
2. `dossieSign/phase1/FormEditor.jsx` → `SendPacketButton.jsx` → DocuSeal *template* 4952172
   (a real 20-19 template). Reachable **only via the hidden URL params** `?editorV1=<txnId>`
   or `?v1=1` (`dossie-app.jsx:1744-1757`). Not a member path.
3. `api/_assets/docuseal-prefill.js` `DOCUSEAL_TEMPLATES['resale-contract'] → 4018208`, which
   is the **TREC 20-18** template. Still the id the whole `docs/DOSSIE-SIGN-DOD.md` 72-gate
   program is written against (`'resale_contract': 'TREC-20-18'` at
   `cron-dossie-sign-completion-loop.js:264`).

  The form-version split between these three paths is a compliance problem, not a tidiness
  problem: 20-18 is superseded.

**Gap 6 — one shared DocuSeal account.** A single `DOCUSEAL_API_KEY` (Heath's personal
account) serves every customer. Multi-tenancy exists only as Supabase rows. One suspension or
account-global email-suppression flag takes down every member. `esign-create.js` also clones a
transient template per envelope with no reaper.

**Gap 7 — never proven.** Zero real members, zero completed envelopes, ever (see the framing
number above). Gate 9 of the DoD (`real_deal_closed`) has never been flipped.

### What today's Ridge Bluff work actually says about the product

It did not use the product. `scripts/send-trec-offer-packet.js` states it in its own header:

> *PREREQUISITE: the transaction must already exist in zipForm with Parties added and the TREC
> forms already filled + saved as Documents (via zipForm's own native fill UI, **NOT** the
> local `api/_lib/fill-trec-20-19.js` engine …)*

`scripts/_lib/zipform-fill-trec.js` (299 lines) is a hardened re-implementation of field fill
against **zipForm's DOM**, written after a 2026-08-30 post-mortem where three compounding bugs
(per-document-instance hash-prefixed field names, colliding `title` attributes, and never
re-reading after save) sent a packet out with sale price and earnest money silently blank.
`.tmp/ridgebluff-offer/` contains 157 screenshots, a `build-offer.js` that calls the product's
`fill-form.js` `__testing.fillForm` **as a library for a draft only**, and a
`docuseal-send-offer.mjs` fallback. The commits merged today fixed the product's fill engine.
The client's actual offer went out through Heath's own zipForm session.

**Both things are worth having, and they are different products.** The zipForm scripts are
Heath's practice tooling and cannot be multi-tenanted (see §1's profile/lock argument, which
applies identically). The DocuSeal path is the productizable one, and it needs the seven gaps
above closed.

---

## 3. Brokerage compliance upload (KW Command) — NOT BUILT

### What the product actually does today

Two things, and neither is an upload to a brokerage system.

1. **Email a packet.** `api/send-compliance-packet.js` (422 lines) pulls every `documents` row
   for a transaction, downloads each from Supabase Storage, base64-attaches them (25 MB raw
   cap), and sends **one email via Resend** to `profiles.compliance_email` — an address the
   agent types into Settings. `from: "<Agent> via Dossie"`, `reply_to` the agent, `bcc`
   Heath. Logged to `compliance_sends` (**1 row in production**). No brokerage platform is
   involved at any point. UI: `dossie-app.jsx:10654` "✉️ Send to Compliance", which also
   auto-fires when a deal moves to `closed`.
2. **Hand the member a ZIP.** `dossie-app.jsx:10661` "⬇️ Download ZIP" →
   `/api/transactions/download-zip`. Its own tooltip is the honest statement of the current
   capability: *"Download all documents as a ZIP — upload to SkySlope, Dotloop, or your
   brokerage portal."*

**"Compliance Vault" is a different thing than its name implies.** It is a **present-vs-missing
document grid** (`api/solo-documents.js` → `SoloDocumentVaultView.jsx`), gated by
`subscriptions.compliance_vault_enabled`. There is no "submit", "upload to broker", or portal
string anywhere in it. It **is sold live** — Stripe price `price_1U7zXXL920SKTEEi70gU4p5o`,
$15/mo ($7.50 founding), live since 2026-08-24 (`docs/PRICING-HISTORY.md:18,91`). The name
oversells the feature.

Also note `api/send-compliance-email.js` is misleadingly named — it is a one-time
`CRON_SECRET`-gated **marketing broadcast** about the July TREC form change, unrelated to
brokerage compliance.

And `api/_lib/required-documents.js` is not a compliance checklist — it is a follow-up-nag
guard (16 `{id, match, transactionFlag, documentType, label}` entries) built 2026-08-25 so
`cron-followup.js` stops emailing a client asking for a document already on file. Its own
header says it deliberately omits deal-shape applicability, so it cannot tell you what a given
deal requires. The real present/missing list is `REQUIRED_DOC_TYPES` in
`api/_lib/team-risk-rollup.js`.

### What the KW Command work actually is

Local Playwright against Heath's own logged-in session. Greenfield as of 2026-08-29 — nothing
in the repo had ever authenticated to Command before that date.

- **Tracked, general-purpose (3):** `scripts/brokerage-command-login.js` (headed Chrome so
  Heath completes KW SSO by hand — never automates credentials),
  `scripts/brokerage-command-open.js`, and `scripts/brokerage-command-recon.js` (644 lines,
  **read-only**; its `isForbiddenClick()` hard-stops on `/submit to mc/i`, Save/Create, and
  **never calls `setInputFiles`**).
- **Untracked one-offs (11):** `scripts/.wc-command-*.js`, every one hard-coded to opportunity
  `id=14116577` (104 Wild Cherry Ln). `.wc-command-upload.js` is the only real upload code —
  and it works — but its file list is a literal array of six local paths under
  `.tmp/wildcherry-compliance/` and `OPP_URL` is one hard-coded opportunity. `git ls-files
  scripts/ | grep brokerage-command` returns **0** while 1,183 other scripts are tracked.
- **Not reachable from the product.** `grep -rln "command.kw.com|brokerage-command|
  launchBrokerageContext" api/` returns **zero**. No API route imports Playwright for this.

### What the recon actually learned (`.tmp/command-recon/`, ~280 artifacts)

Genuinely valuable and worth keeping:

- **Auth:** KW SSO / Auth0 at `console.command.kw.com` (`command.kw.com` is a redirect entry
  point only). **No API key, no OAuth app, and no public API was found.** No `.har`, no network
  capture, no reverse-engineered REST call exists anywhere in the folder — the entire approach
  is DOM automation of a logged-in human session.
- **Working selectors:** row `[data-testid="compliance-documents-table-item"]`, name
  `…-document-name`, status `…-status` ("Uploaded"/"Not uploaded"), upload
  `…-file-drop-zone` containing a hidden `input[type=file]`, tabs
  `[data-testid="opportunity-tabs-tab-item"]`.
- **Submit button located, deliberately never clicked** —
  `{tag:"button", className:"btn btn--primary btn--large px-4", text:"Submit to MC"}`.
- **Checklist model:** 27–30 placeholder rows; Residential checklist enumerated with
  `Required`/`Conditional`/`Optional` flags; document-type vocabulary is Addendum, Agreement,
  Amendment, Authorization, Contract, Disclosure, Inspection, Lender, Other.
- **Real uploads happened:** progress went `0 of 27` → `3 of 27` → `8 of 28`.
- Also documented: two duplicate empty folders created accidentally and undeletable, plus
  repeated Chrome-profile lock contention with Heath's own manual zipForm logins.

### What a member-facing version needs

The recon is the easy half. The hard half is the same wall as §1:

1. **Session, not credentials.** Command has no partner API. Every member would need their own
   authenticated Command session, obtained through KW SSO/Auth0, which cannot be scripted and
   dies regularly (`.wc-command-upload.js:69-73` has an explicit `SESSION_DEAD` bail, and
   `*-SESSION-DEAD.txt` artifacts exist on disk proving it). A cloud version means running a
   browser per member with a stored session — real cost, real fragility, real security
   surface, and questionable standing under KW's terms.
2. **A per-brokerage config layer.** Even done well, KW Command covers only KW agents. Most
   non-KW Texas brokerages land on SkySlope, Dotloop, Brokermint, or Lone Wolf. The core
   ("match a closed file's documents to a required-document checklist, upload, submit, track
   review state") is reusable; the checklist→placeholder mapping and submit flow is per
   brokerage. `DOSSIE-TRANSACTION-GAP-ANALYSIS.md:96-97,172` already scopes this: ZIP naming
   = Medium complexity, direct integration = **Large**, parked in Phase 3.
3. **The "Submit to MC" boundary must survive productization.** It is the irreversible,
   compliance-attesting click. Keep it human.
4. **Marketing has already committed to the modest version.**
   `answers/best-tc-software-texas-agents/index.html:22` says publicly: *"Dossie is designed to
   complement compliance platforms, not replace them"*, and the comparison table rates Dossie's
   broker compliance trail "Lighter". Building the full integration would be a positioning
   change, not just a feature.

**The pragmatic middle.** A "SkySlope/Dotloop/Command-ready ZIP" — correct file naming per the
target brokerage's checklist vocabulary, a cover page, and a mapping report telling the member
which file goes in which placeholder — captures most of the tedium with none of the session
problem, and is Medium complexity by the repo's own estimate. That is the shippable version.

---

## 4. Transaction timeline, member email, member SMS

### 4a. Per-transaction activity timeline — PARTIAL

**There is no timeline or event table.** Confirmed against live `information_schema`. The
`%event%` / `%activity%` tables in `public` are all internal ops (`agent_activity`,
`jarvis_agent_events`, `ventures_activity_events`, `stripe_webhook_events`, `share_events`,
`activation_events`) plus the two real deal-data ones, `esign_events` and
`showingtime_feedback`. No `activity_log`, no `transaction_events`, no `dossier_events`.

What exists instead:

- **`transactions.notes_log jsonb`** — the only append-style activity store.
- **`transactions.email_history jsonb`** — outbound email log, written client-side
  (`dossie-app.jsx:3769-3772`), **never rendered anywhere**; it is only read by
  `getExistingEmailTypes()` (`dossie-app.jsx:1013`) to grey out already-sent templates.
- **~40 discrete `*_at` columns** on `transactions` (`inspection_completed_at`,
  `appraisal_received_at`, `clear_to_close_at`, `closed_at`, …). These are **state, not
  history** — overwriting one destroys the prior value, and no record exists that a status
  ever changed.
- **`email_queue`** (outbound), **`action_items`**, **`documents`** all carry timestamps but
  are rendered as their own separate lists, never merged into a feed.
- Schema debt worth knowing before building: `transactions.id` is `uuid`, but
  `documents.transaction_id`, `action_items.transaction_id`, and `email_queue.transaction_id`
  are all **`text` with no FK**. `esign_events.transaction_id` and
  `showingtime_feedback.transaction_id` are proper `uuid` FKs. A merged timeline query has to
  cast across three text columns.

**The UI:** one component, `EmailActivityFeed` (`dossie-app.jsx:12924-12965`), rendered three
times (`:12490`, `:12569`, `:12078`) behind two nav pills both labelled "Activity"
(`:10522`, `:10530`). It reads `deal.notesLog` and hard-filters:

```js
.filter((n) => n && n.source === "email" && (stageId ? n.stageId === stageId : true))
```

**Live bug found.** Three crons write `notes_log` with three different `source` values:

| Cron | line | `source` |
|---|---|---|
| `api/cron-email-to-dossier.js` | 300 | `'email'` |
| `api/cron-esign-events.js` | 666 | `'esign'` |
| `api/cron-showingtime-feedback.js` | 313 | `'showingtime'` |

The UI renders only `'email'`. **E-sign completions and ShowingTime feedback are written to
`notes_log` and then silently dropped on the floor** — 62 and 30 production rows respectively.
Two of the three capabilities the $15/mo Email Integration add-on is sold on
(`dossie-app.jsx:7372`) produce data no member can see. (E-sign does surface separately as a
`dossie_asks` card via `cron-esign-events.js:385` → `DossieAsks.jsx`; ShowingTime creates no
ask at all.) This is a one-line-class fix and should be near the front of the queue.

**Verdict: PARTIAL.** An inbound-email digest exists and works. There is no merged
chronological timeline, no event table, no status-change history, and two of three sources are
filtered out.

### 4b. Member email connection — NOT BUILT

**The backend is genuinely multi-tenant and correct.**

- `api/google-oauth-init.js` requires a member's Supabase JWT (line 111), writes a CSRF row to
  `oauth_states` bound to `user_id` (line 130).
- `api/google-oauth-callback.js` upserts into `user_integrations` on
  `(user_id, oauth_provider)` (lines 224-234).
- `public.user_integrations` (`supabase/migrations/20260706_user_integrations.sql:10`):
  `user_id, oauth_provider, access_token, refresh_token, scopes, expires_at, google_email`,
  unique on `(user_id, oauth_provider)`, RLS user-read/delete-own, service-role writes.
- `api/_lib/gmail-oauth.js` gives `loadGoogleTokensForUser(userId)` and
  `makeGmailClient({userId, tokens})` with auto-refresh + persist.
- `api/_lib/email-integration-customers.js:41` joins
  `subscriptions.email_integration_enabled = true` × `user_integrations.google_email IS NOT
  NULL`. All three watcher crons (`cron-email-to-dossier`, `cron-esign-events`,
  `cron-showingtime-feedback`) were generalized onto it on 2026-08-22.

**The blocker is the front door.** `dossie-app.jsx:7324-7333`:

```jsx
<button onClick={() => announce("Gmail connect coming soon — once linked, Dossie can send and read on your behalf.")}>
  Connect Gmail <span>Coming Soon</span>
</button>
<button onClick={() => announce("Outlook connect coming soon …")}>
  Connect Outlook <span>Coming Soon</span>
</button>
```

Both fire a toast and nothing else. Grepping the entire Dossie repo for `google-oauth-init`
returns **zero hits**. The only caller in the whole product surface is Heath's internal Jarvis
PWA (`jarvis-pwa.html:9420`, `connectGoogleCalendar()`, `redirect_after=/myjarvis`).

Live DB confirms: `user_integrations` has **exactly 1 row**, `oauth_provider='google_calendar'`
— not even Gmail. Exactly one subscription has `email_integration_enabled=true`, and its
user_id is the hardcoded `HEATH_KW_USER_ID` in `api/reply-monitoring-status.js:37`.

**Meanwhile the add-on is on sale.** `dossie-app.jsx:7355-7372` sells Email Integration at
$15/mo with a working Stripe checkout, positioned next to a Connect button that does nothing.
A member can pay and then have no way to connect. That is the most urgent honesty problem in
the product right now.

**The real external dependency nobody has started.** Scopes requested
(`google-oauth-init.js:52-59`) include `gmail.readonly`, `gmail.send`, and `gmail.compose` —
all Google **restricted** scopes. An unverified app is capped at 100 test users and shows the
unverified-app interstitial. Shipping this to paying members requires Google's **CASA security
assessment**: weeks of calendar time, a third-party assessor, and money. Nothing in `docs/`
states the consent screen's publishing status; the closest evidence (`docs/PIPELINE.md:144-151`,
about the same GCP project) implies still-in-Testing. **Treat as unverified until proven
otherwise, and start the verification now** — it is the long pole, and it is not engineering
work.

Also worth flagging: `api/gmail-refresh.js` PATCHes filtered on `google_email` only, not
`user_id` (line 82) — fine at n=1, wrong shape at n>1. And `api/cron-inbox-scan.js` is not part
of the multi-tenant path at all; it uses standalone `GMAIL_*` env vars against Heath's mailbox.

**Microsoft/Outlook: nothing.** No Graph, MSAL, Azure AD, or IMAP code anywhere.

### 4c. Member SMS capture — NOT BUILT, and the hardest item in this document

**In the product: nothing.** No `twilio`/`telnyx`/`vonage`/`plivo`/`messagebird` dependency in
`package.json`, no code in `api/`. The only SMS in the shipped app is
`ShareDossieModal.jsx:75-81`, an `sms:?&body=` link that opens the user's own messaging app.
`docs/TECH-DEBT.md:29` has "SMS escalation (Twilio) … Phase 2 deferred." Twilio exists only as
a Zapier action for the internal Jarvis agent.

**Heath's setup is structurally unshippable.** `scripts/import-phone-link.py` reads the
Microsoft Phone Link SQLite DB at a hardcoded path on one Windows machine, snapshots it past
its write lock, and upserts to Supabase with the **service-role key** (read from
`C:\Users\Heath\.claude\sms-poller.env`), driven by a Windows Task Scheduler job every 12
minutes (`register-sms-poller.ps1`). Heath's own number is hardcoded at line 33. The
`sms_messages` table has **no `user_id`, no `org_id`, no `transaction_id`** — 196,361 rows with
no tenancy at all, RLS-enabled with zero policies, and **no API route reads it**. It is a
personal corpus, invisible to the product, and cannot be extended to members without being
rebuilt from scratch.

**The real options, honestly.**

| Option | What it gets you | What it costs / why it fails |
|---|---|---|
| **Twilio (or Telnyx) number provisioned per member** | Full two-way capture, both directions, on the transaction, automatically. The only option that actually delivers the timeline Heath described. | It is a **new number**. Existing clients, listing agents, and title officers all text the member's real cell. Capture is zero on day one and only grows for counterparties introduced *after* adoption. Also requires **A2P 10DLC brand + campaign registration** before a single compliant message sends — carrier approval is typically 1–4 weeks, plus one-time brand vetting and a monthly campaign fee, plus per-segment carrier surcharges. Non-negotiable in the US. |
| **Twilio number scoped to new counterparties only** ("deal line") | Sidesteps the adoption problem by only being used where Dossie introduces the contact — title, lender, the other agent. Realistic, useful, and captures the exact class of message that mattered in the Low Oak dispute. | Same 10DLC dependency. Client texts still invisible. Needs the member to actually use the deal line, which is a behavior change. |
| **Carrier-level forwarding of the member's existing number** | Would be perfect. | **Does not exist.** US carriers offer call forwarding, not SMS forwarding, to a third party. There is no consumer API. Dead end — do not scope it. |
| **Android companion app reading the SMS inbox** | Full capture of the real number. | Google Play restricts `READ_SMS`/`RECEIVE_SMS` to the device's **default SMS app**. A transaction-coordination app will not pass that policy review. Effectively dead. |
| **iOS** | — | Third-party apps have **no** SMS read access. Structurally impossible. |
| **Member manually logs a text exchange into the timeline** | Zero infra, works on both platforms, works retroactively, and is what the capability-spec memory already scoped as realistic (workflow #15). | Relies on the member remembering. But it puts texts in the *same* record as everything else, which is the whole point of a dispute-ready timeline. |
| **Paste / screenshot ingestion** | Cheap. Claude already reads screenshots. A "paste this thread" box would work. | Manual. Not continuous. |

**Recommendation: build the manual-log path first (days, not weeks), and treat Twilio as a
separate, later, opt-in "deal line" product** whose 10DLC registration should be *started* early
because it is a calendar dependency, not an engineering one. Do not promise automatic capture of
a member's personal cell — it is not achievable on either mobile platform.

---

## 5. Per-agent configurable contract defaults — NOT BUILT

There is a per-agent defaults system. It stores the wrong category of thing.

**What exists and works:**

- `api/get-agent-defaults.js` / `api/save-agent-defaults.js` — JWT-gated GET/POST against
  `profiles`. Save strips nulls so a blank never clobbers, and forces
  `iabs_defaults_completed = true`.
- Migration `api/_migrations/0025-iabs-defaults.sql` (the only file in that orphan migration
  directory), applied — all 15 columns confirmed live on `profiles`.
- **The 15 fields are all broker/agent *identity*:** `broker_name`, `broker_license_number`,
  `broker_phone`, `broker_email`, `broker_address_{street,city,state,zip}`,
  `supervising_broker_{name,license,phone}`, `agent_license_number`, `agent_phone`,
  `agent_relationship_type`, `iabs_defaults_completed`.
- Settings UI at `dossie-app.jsx:7637-7742` exposes **9 of the 15** (the four
  `broker_address_*` fields and `agent_relationship_type` are API-writable with no input).
  A second surface hydrates them inline when sending an IABS envelope
  (`EsignModal.jsx:557-696`).
- They feed exactly two things: **IABS envelopes** (`esign-create.js:480-501`, gated on
  `iabs_defaults_completed`, mapping to DocuSeal keys) and the **Wire Fraud Warning footer +
  listing-agent license block** in `fill-form.js:4184-4196`.

**What does not exist:**

- **No contract-term defaults of any kind.** No default title company, option fee, option
  period days, earnest money amount or %, financing type, survey election/days, survey payer,
  title-policy payor, residential service company, appraisal-addendum option, commission
  rates, or possession terms. Grepping both repos for `contract_defaults`,
  `transaction_defaults`, `default_option_fee`, `default_earnest`, `default_title_company`
  returns zero hits outside `node_modules`.
- **The contract engine never reads `profiles` at all.** `api/_lib/fill-trec-20-19.js` has
  zero references to any profiles column. `api/_lib/trec-20-19-transaction-field-map.js` pulls
  `listing_broker_firm_name` (line 296) and `other_broker_firm_name` (line 302) from
  `transactions.listing_broker_name` / `.other_broker_name` — **not** from the member's saved
  profile. A member retypes their own brokerage on every deal despite having saved it in
  Settings.
- `api/dossiesign-*.js` and `api/transactions/` have zero references to agent defaults.

**Consequence for the Ridge Bluff observation.** Every one of Heath's dozen standing
preferences (survey 25 days at seller's expense, title policy seller-paid, 2.5% listing /
3% buyer-broker ask, TREC 49-1 Option 3 at offer price, TPFA 30-year with 1% origination cap
and 15-day approval, ¶7 As-Is, possession on closing and funding, water-disclosure 14-day
branch, executed date always blank) currently has **nowhere to live in the product**. If they
ship as constants in the engine, the product produces legally binding documents that are wrong
for every member who is not Heath. The infrastructure pattern to copy already exists — the
IABS columns + `get-/save-agent-defaults` + a Settings section — it just needs a second,
versioned category.

**One schema note before extending:** `profiles` already carries duplicate concepts —
`license_number` (old) vs `agent_license_number` (IABS), and `brokerage` (old free text) vs
`broker_name` (IABS). `fill-form.js:4184,4190` has to `||`-fallback between them. Resolve
that before adding a third layer. Also: a live bug shipped here once — the SELECT at
`fill-form.js:4137` referenced a nonexistent `trec_license_number` column, 400-ing on every
call so `profile` was always `{}` and every `listing_agent_*` and `wire_fraud_*` field
silently blanked, for about four weeks (fixed 2026-08-13). Version the new columns and test
the read path.

---

## 6. The agent/task queue — BUILT, running, and internal-ops only

The memory note (`agent-queue-parked-since-july.md`) is **wrong on both specifics** and the
real situation is more complicated.

**The "once a year cron" claim is refuted.** `vercel.json`'s `crons` array (starts line 404,
**exactly 100 entries — Vercel's cap**):

| Path | line | schedule |
|---|---|---|
| `/api/cron-agent-worker-tick` | 406 | `* * * * *` |
| `/api/cron-agent-queue-tick` | 622 | `*/5 * * * *` |
| `/api/cron-fanout-builds-to-agent-queues` | 642 | `10 */6 * * *` |
| `/api/cron-agent-queue-dispatch` | 646 | **`*/2 * * * *`** |
| `/api/cron-agent-queue-orphan-reset` | 650 | `*/30 * * * *` |

Only two crons remain on the `0 0 1 1 *` freeze marker, and neither is agent-queue:
`cron-coverage-check` and `cron-generate-pages`. Live `cron_runs` telemetry confirms the
dispatcher fired at 2026-08-31 15:20:48Z, ok, 87ms.

**But the dispatcher was deliberately retired as a row-claimer.**
`api/cron-agent-queue-dispatch.js:7` says so in its header
(`RETIRED AS A ROW-CLAIMER, 2026-08-09`). Lines 86-90 exclude every real agent by name, and
the fetch at 401-406 filters `metadata->>task_type=is.null&agent_name=not.in.(...)`. The code's
own comment (line 399): *"Given the current agent roster this excludes everything — this fetch
will normally return zero rows."* The 87ms runtime is the proof — it fires every two minutes
and does nothing but a stale-row sweep.

**The real consumer is Heath's PC.** `scripts/agent-queue-poller.js` spawns Claude Code
(`claude --print --agent <name> ... --max-budget-usd 5`) with full tool access;
`scripts/claude-code-worker.js` handles `metadata.task_type` rows via deterministic JS; both
registered as Windows Task Scheduler jobs. **If that machine is off, nothing drains the
queue, and the cloud will never pick it up.**

**Actual counts (live, not ~55):**

```
agent_queue:      completed 593 | blocked 105 | cancelled 76 | pending 14
```

All 14 pending rows are Sage marketing tasks carrying `metadata.task_type` — explicitly
excluded from the cloud dispatcher, owned by the PC worker: `trending_audio_scan` ×10 (daily
2026-08-22 → 2026-08-31, never once consumed), `competitor_scan` ×2, `sage_weekly_review` ×2.
Blocked backlog by agent: sage 28, atlas 26, hadley 14, pierce 13, carter 13, quinn 6, ridge 3,
sterling 1, cole 1 (oldest 2026-06-17). The watchdog knows —
`cron-agent-queue-tick-watchdog` last ran 14:31Z with `last_status: "alerted"` and
`{"stuck_ready": 5, "oldest_age_min": 13231}` — **9.2 days stuck**.

**A bigger stranded pile nobody has mentioned: `agent_requests` has 860 pending rows** (858 to
Quinn, oldest 2026-06-15, newest 2026-08-30; six completions ever). Cause:
`/api/cron-process-agent-requests` **is not in `vercel.json`'s crons array at all** — its
header says it runs "every 1 minute via cron-job.org (Vercel cron cap reached)", and
`cron_runs` shows its last run was **2026-08-25 23:34Z, six days ago**. That external
scheduler appears dead. Same for `cron-agent-requests-stale-check`.

**Also dead code:** `agent_task_queue` (3 rows, all `done`) and `agent_workers` (3 rows, all
`dead`) have **no migration file anywhere in the repo** — created out of band, ran three tasks
in June, idle since, while `cron-agent-worker-tick` fires every single minute.

**Is it usable as the backbone for member transaction work? No.** Every write path is gated on
a secret Heath controls — `api/queue-task.js:36` hardcodes
`ALLOWED_EMAIL = 'heath.shepard@kw.com'`; `cole-enqueue`, `claude-code-enqueue`,
`agent-queue-{claim,peek,complete}`, and `agent-bus/*` all require `Bearer CRON_SECRET`;
`agent-task-{enqueue,execute}` require a `jarvis_users` tenant row. The agents themselves are
Heath's staff (Carter's prompt in `api/_lib/agent-prompts/carter.js` literally contains the
Stripe price id and Supabase project ref). Two of the three execution paths call the Anthropic
API **with no tools** and return text; only the PC poller can actually do anything. The one
place it touches product surface is `cron-dossie-sign-completion-loop.js:38`, which dispatches
engineering work against DossieSign's own 72-gate checklist — agents fixing the product, not
agents running a member's deal.

**Reusable pieces if you build the member-facing version:** the `agent_queue` table shape, the
`depends_on` DAG + `agent_queue_ready` view, and the audit-loop state machine in
`api/_lib/agent-queue-complete-core.js` (`pending → in_progress → pending_audit → completed`,
3-retry cap then blocked+escalate). Everything else — auth model, roster, prompts, executor —
is new work.

---

## 7. Member education / feature discovery — PARTIAL, and drifting

### What a new member actually sees

**One thing: a 5-step onboarding card** on the Morning Brief dashboard
(`dossie-app.jsx:2365-2440`, `renderOnboardingCard`), backed by `onboarding_progress` and a
`create_onboarding_after_profile` DB trigger. Headline: *"Welcome to Dossie. Let's get you set
up."* The five steps (`:2388-2394`):

1. Open your first dossier
2. Play your Morning Brief
3. Set your compliance email
4. Add a document to a dossier
5. Talk to Dossie

The card auto-hides 24h after completion, leaving a "Getting Started ✓ Done" sidebar recap.

Everything else is passive reassurance copy — ~19 `EmptyCopy`/`emptyPreview` strings, none of
which teach a capability. One has a CTA (`:6577` "No active files. You're clear." → Open New
Dossier).

**There is no tour.** `grep -ci` on `dossie-app.jsx`: `tour` = 0, `coachmark` = 0, `tooltip`
= 0 (the 5 `walkthrough` hits are property final-walkthrough fields).

### The one page that lists capabilities contradicts itself

Sidebar "What's Coming" (`dossie-app.jsx:6620-6700`) has three panels: **What works today**
(10 bullets), **Coming soon**, **Roadmap**.

- Line `:6642` lists Compliance Vault under *what works today*. Line `:6680` lists
  `{ quarter: "Q4 2026", item: "Compliance Vault + MLS integration" }` under *roadmap*, two
  panels below. Vault shipped 2026-08-24 and is on sale in Settings. A member cannot tell from
  this page whether the thing they can buy exists.
- **Most of what shipped is missing from "works today":** DossieSign / e-signature, the TREC
  form library and Form Packages, Team view, Closing Milestone cards, Analytics, Send-to-
  Compliance, Download ZIP, Dossie Asks.
- This exact bug has already been fixed once — a code comment notes the old "E-Signatures,
  Q2 2026 beta" roadmap row "made the roadmap contradict the working product on the next
  screen," and was retro-fitted to `{ quarter: "Now" }`. The same failure is now live for
  Compliance Vault.
- The **"Support"** sidebar item (`:1208`) is not help — `:6429` overrides its click to open
  the feedback/ticket modal.

### Two complete help systems are built and wired to nothing

- **`api/help-pages.js`** — 311 lines, **8 hand-written help articles** (getting-started,
  morning-brief, talk-to-dossie, dossiesign, trec-deadlines, compliance-vault,
  sharing-milestones). The copy is genuinely good. **Zero consumers in the React app.** And it
  has already rotted: (a) the index at `:33` links `slug: 'faq'` but there is no `faq` key in
  `HELP_PAGES` → hard 404; (b) `:188`/`:207` say Compliance Vault is *"in development"* at
  **$10/mo** — it shipped at **$15**; (c) `:196` promises Dossie *"can either email the packet
  directly or generate a ZIP"* for SkySlope/Dotloop/Brokermint and `:200` promises a per-dossier
  green/yellow/red compliance indicator — **neither the checklist ingestion nor the indicator
  exists**; (d) `:132` lists the supported contract as TREC **20-18**, superseded 2026-07-01 by
  the very change the product emailed members about.
- **`api/whats-new.js`** — GET undismissed `whats_new_announcements`, POST a dismissal. Fully
  built. **Zero consumers** — `whats-new`/`whatsNew` appears nowhere in `dossie-app.jsx`,
  `src/`, or any HTML. No member has ever seen an announcement.
- **`Dossie/src/components/EmptyStateHint.jsx`** — orphaned. `grep -rn "EmptyStateHint"`
  returns only its own definition. (Latent bug too: it spreads `{as:"a", href}` onto a
  `<button>`, which React ignores.)
- **`help.html`** ("30-60 second tutorials for every feature", reads `tutorial_videos` from
  Supabase) is a **logged-out marketing page**. The React app never links to `/help` — only
  `faq.html`, `learn.html`, `index.html`, and `api/chat.js` prompts do. `learn.html:206` even
  accurately describes the Send-to-Compliance + ZIP workflow, but only signed-out visitors can
  read it.
- `api/complete-onboarding.js` is not education — it is the 645-line post-Stripe account
  provisioner. `welcome.html` is a profile-completion form.

**Verdict: PARTIAL.** A member gets a 5-step checklist and one self-contradicting capabilities
page that omits most of the product. The two systems that would fix it are already written and
connected to nothing. Mounting `/api/help-pages` behind the existing "Support" slot, fixing the
four stale claims in it, and resolving the `:6642`-vs-`:6680` contradiction is the
highest-leverage, lowest-risk work in this entire audit.

---

# Prioritized build sequence

The organizing question: **what has to be true for a member to run a transaction end to end?**
Ordered so each item unblocks the next and nothing is built on an unverified assumption.

Sizes assume one focused engineer (Carter) with Quinn's QA gate, and are honest about calendar
time where an external party is on the critical path.

---

### Tier 0 — Stop selling what doesn't work (this week)

These are integrity fixes. Every one is small. Leaving them is the largest reputational risk in
the product.

**0.1 — Kill or connect the "Connect Gmail" button.** *(hours)*
Right now Settings sells Email Integration at $15/mo with live Stripe checkout
(`dossie-app.jsx:7355-7372`) sitting next to a Connect button that fires a toast and calls
nothing (`:7324-7333`). A member can pay and have no way to connect.
**Depends on:** nothing. **Fails if:** you wire the button to `/api/google-oauth-init` before
Google verification (item 2.1) — members would hit the unverified-app interstitial, which is
worse than a "Coming Soon" badge. **Correct move today:** disable checkout for the add-on until
2.1 lands, or gate it to a named beta list.

**0.2 — Render `notes_log` entries whose `source` isn't `'email'`.** *(hours)*
`EmailActivityFeed` (`dossie-app.jsx:12926`) hard-filters `n.source === "email"`, so the 62
`esign` and 30 `showingtime` notes three crons already write are invisible. Two of the three
things the add-on is sold on produce data no one can see.
**Depends on:** nothing. **Fails if:** the feed's per-source rendering assumes an email shape
(from-name, subject, Gmail deep link) — needs a small branch per source, not just a wider
filter.

**0.3 — Fix the roadmap contradiction and the stale help copy.** *(hours)*
`dossie-app.jsx:6642` vs `:6680` (Vault both shipped and Q4-2026). Add the missing shipped
features to "works today". Fix the four rotted claims in `api/help-pages.js` (missing `faq`
page, $10 vs $15, promised SkySlope routing + compliance indicator that don't exist, TREC
20-18).
**Depends on:** nothing.

**0.4 — Mount the help library.** *(1 day)*
`api/help-pages.js` has 8 finished articles and zero consumers; the "Support" sidebar slot
already exists and currently opens a ticket form. Point it at the help index, keep the ticket
form as a secondary action.
**Depends on:** 0.3 (don't publish stale copy). **Fails if:** you publish before correcting —
you'd be shipping wrong prices and non-existent features into the one place members trust.

---

### Tier 1 — Make the contract path actually correct (1–2 weeks)

This is the highest-value engineering work in the document, and it is mostly mechanical.

**1.1 — Settle DocuSeal's `areas[].page` indexing base, empirically.** *(half a day)*
`esign-create.js:1057` documents 0-indexing directly above a literal `page: 3`. Everything
below depends on knowing this. Send one test envelope, render the result, read the page it
landed on.
**Depends on:** nothing. **Fails if:** anyone reasons about it from the code instead of
observing a real submission — the code is self-contradictory.

**1.2 — Build a 20-19 e-sign geometry map and retire the 20-18 one.** *(2–3 days)*
Extract signature and initial rects from the 20-19 blank the way
`scripts/extract-acroform-fields.js` did for 20-18, producing
`api/_assets/trec-20-19-esign-coords.json` covering the **10** initial-bearing pages (1–9 and
12) and the page-10 signature block, then point `esign-create.js:146` at it.
**Depends on:** 1.1. **Fails if:** you trust the 20-19 blank's own AcroForm names — it has 280
widgets but only 10 whose names mention sign/initial, and 4 of those are named
`Initialed for identification by Buyer_N` with no seller counterpart. Derive from rendered page
geometry and verify visually, per the discipline that already works in this codebase.

**1.3 — Generalize the initials map to every form in the packet.** *(3–4 days)*
Today `buildResaleContractFieldMap` fires only for `document_type === 'resale_contract'`;
every addendum falls through to `esign-create.js:592-596` and gets one auto-placed signature
and zero initials. Extend the per-form coord-file pattern to 40-11, 49-1, 36-11, OP-L, OP-H.
**Depends on:** 1.2. **Fails if:** done as five hardcoded special cases instead of one
form-code→coord-file lookup — the next TREC revision then breaks five places.

**1.4 — Pre-send tag-count gate.** *(1 day)*
Before any envelope goes out, assert total placed fields ≈ (initial-bearing pages × signers) +
signature blocks, and **fail loudly** below a floor. This is the check that would have caught
the 2026-08-30 packet with 3 tags across 15 pages. Mirror `pre-send-field-audit.js`'s pattern:
block, raise a `dossie_asks` card, do not send.
**Depends on:** 1.2, 1.3. **Fails if:** it warns instead of blocking.

**1.5 — One packet, one signing session.** *(3–4 days)*
`DossieSignModal.jsx:371` loops `esign-create` per document, producing N submissions and N
emails. Merge the selected forms into one DocuSeal submission with per-document field sets and
a defined signing order.
**Depends on:** 1.3. **Fails if:** merged PDFs break the per-form page offsets in the coord
files — page numbers become packet-relative, so every coord lookup needs a document page
offset. This is the item most likely to be underestimated.

**1.6 — Retire the 20-18 template path.** *(1–2 days)*
`DOCUSEAL_TEMPLATES['resale-contract'] → 4018208` is still TREC 20-18, superseded 2026-07-01,
and `docs/DOSSIE-SIGN-DOD.md`'s entire 72-gate program is written against it
(`cron-dossie-sign-completion-loop.js:264`). Decide on one send path — the PDF+widgets path is
the live one — and delete or clearly deprecate the other two.
**Depends on:** 1.2. **Fails if:** left alone; a member sending a superseded promulgated form
is a real TREC problem, not tech debt.

**1.7 — Prove it end to end, once, with a real deal.** *(1 day + waiting)*
DoD gate 9 (`real_deal_closed`) has never been flipped. Zero completed envelopes exist. Until
one real member sends and one real counterparty signs, none of the above is verified.
**Depends on:** 1.1–1.6. **Fails if:** validated with the demo account, which is what produced
31 of the 32 existing rows.

---

### Tier 2 — Per-agent defaults, so the engine isn't wrong for everyone who isn't Heath (1 week)

**2.0 — Contract-defaults profile.** *(4–5 days)*
Add a versioned per-member contract-defaults store (new table, or a versioned jsonb on
`profiles` — **not** more flat columns; `profiles` already carries duplicate
`license_number`/`agent_license_number` and `brokerage`/`broker_name` pairs that
`fill-form.js:4184,4190` has to `||`-fallback between). Cover the standing-preference category
from the field taxonomy: survey days + payer, title-policy payor, appraisal-addendum option +
floor rule, TPFA term / origination cap / approval days, ¶7 As-Is, possession, water-disclosure
branch, commission rates, executed-date-always-blank. Then make
`api/_lib/fill-trec-20-19.js` **read them** — today it references zero `profiles` columns and
`trec-20-19-transaction-field-map.js:296,302` even pulls the member's own brokerage from the
`transactions` row instead of their profile.
Populate via a "save this as your default?" prompt after each answer, not an onboarding wall.
**Depends on:** nothing technically; sequence after Tier 1 so you're not changing the engine
and its inputs simultaneously. **Fails if:** (a) values are stored unversioned, so editing a
default silently rewrites how a past deal would render; (b) regulatory/conditional fields
(lead-paint by build year, HOA addendum by mandatory-membership) get modelled as preferences —
they are facts, not defaults; (c) the read path isn't tested — the identical pattern already
shipped broken once, when a nonexistent `trec_license_number` column 400'd the profile SELECT
for ~4 weeks and silently blanked every dependent field.

---

### Tier 3 — The timeline and the inbox (2–4 weeks engineering, plus an external clock)

**3.1 — Start Google OAuth verification NOW.** *(days of work, weeks of calendar)*
`gmail.readonly` + `gmail.send` + `gmail.compose` are **restricted** scopes. Shipping them to
paying members requires Google's CASA security assessment — a third-party assessor, money, and
weeks. Only one account has ever connected and no doc states the consent screen's publishing
status; treat it as Testing (100-user cap + unverified interstitial) until proven otherwise.
**This is the longest pole in the entire document and it is not engineering work.** Start it
before anything else in Tier 3.
**Depends on:** nothing. **Fails if:** deferred until the code is ready — then the code waits
weeks on Google.

**3.2 — Ship member Gmail connect.** *(2–3 days)*
The backend is already correct and multi-tenant: `user_integrations` keyed
`(user_id, oauth_provider)` with RLS, `gmail-oauth.js` per-user client with refresh,
`email-integration-customers.js` entitlement join, and all three watcher crons generalized off
Heath's mailbox on 2026-08-22. What is missing is the button. Also fix
`api/gmail-refresh.js:82`, which PATCHes filtered on `google_email` only, not `user_id` — fine
at n=1, wrong at n>1.
**Depends on:** 3.1. **Fails if:** shipped before 3.1 (see 0.1).

**3.3 — A real transaction event table.** *(4–5 days)*
There is no timeline table today — only `transactions.notes_log`, an unrendered
`email_history` jsonb, and ~40 `*_at` state columns that destroy their own history on
overwrite. Create an append-only `transaction_events(id, user_id, transaction_id uuid, kind,
occurred_at, actor, summary, source_ref, payload jsonb)` and write to it from: inbound email
(`cron-email-to-dossier`), e-sign (`cron-esign-events`), ShowingTime
(`cron-showingtime-feedback`), outbound email (`email_queue`), document upload, action-item
completion, and stage/status change.
**Depends on:** 0.2 (which proves the render path handles multiple sources). **Fails if:** you
don't fix the type mismatch first — `transactions.id` is `uuid` but
`documents.transaction_id`, `action_items.transaction_id`, and `email_queue.transaction_id` are
all **`text` with no FK**. A merged query has to cast across three text columns; migrate them or
the timeline is slow and fragile from day one.

**3.4 — Manual text/call logging into the same timeline.** *(2 days)*
The realistic answer to SMS (see 4c). One "log a text exchange / call" entry point writing the
same `transaction_events` shape, plus screenshot/paste ingestion.
**Depends on:** 3.3.

**3.5 — Same-day financial deadline surfacing + title-instructions watcher.** *(3 days)*
Compute earnest-money/option-fee due dates from effective date and surface them as the day's
top item *before* they blow, and pattern-match title/escrow senders on a connected inbox to
relay payment instructions the moment they land. Directly traceable to the Low Oak relay gap.
**Depends on:** 3.2, 3.3.

---

### Tier 4 — The genuinely hard ones (do not start until Tiers 0–3 are real)

**4.1 — CMA, the shippable half.** *(1 week)*
"Upload your MLS sold-comps export → Dossie does the comp selection, adjustments, price-per-sqft,
DOM, sale-to-list, and neighborhood-ceiling check → client-ready CMA." Reuses the
`scan-contract.js` pattern exactly. **Requires no MLS relationship at all.**
**Depends on:** nothing. **Fails if:** scoped as "and also pull the comps automatically" —
that's 4.2, and bundling them means shipping neither.

**4.2 — Licensed MLS data feed.** *(months, mostly not engineering)*
A RESO Web API feed (MLS Grid / Bridge / Trestle) under a signed data license with **each MLS
individually**, plus broker/participant authorization per member. SABOR first. Cost is modest;
approval time is the cost.
**Depends on:** a business conversation Heath has to have. **Fails if:** anyone tries to solve
it with browser automation — connectMLS auth is a cross-device WebAuthn passkey
(`scripts/_lib/connectmls-actions.js`), it cannot be delegated, and 191 scripts share one
single-user Chrome profile behind a mutual-exclusion lock. That architecture cannot serve two
members, and asking members for MLS credentials would breach most MLS rules of participation.

**4.3 — Brokerage compliance, the shippable half.** *(1 week)*
A "brokerage-ready ZIP": files renamed to the target brokerage's checklist vocabulary (the KW
Command Residential checklist is already enumerated in `.tmp/command-recon/`), a cover page, and
a mapping report saying which file goes in which placeholder. `DOSSIE-TRANSACTION-GAP-ANALYSIS.md:96`
rates this Medium; the direct integration at `:97` is Large and parked in Phase 3.
**Depends on:** nothing. **Fails if:** scoped as the full Command upload — that needs a live
per-member Command session with no partner API, and "Submit to MC" must stay a human click
regardless.

**4.4 — Twilio "deal line" SMS.** *(2 weeks engineering, 1–4 weeks carrier approval)*
Per-member provisioned number for counterparties Dossie introduces (title, lender, other agent).
**Start A2P 10DLC brand + campaign registration early** — it is a calendar dependency like 3.1.
**Depends on:** 3.3 (somewhere to put the messages). **Fails if:** sold as "Dossie captures
your texts" — it captures the deal line only. Automatic capture of a member's personal cell is
**impossible on iOS** and a Play-policy violation on Android. Do not promise it.

---

### Deliberately not in the sequence

- **Reviving the agent queue for member work.** It is running fine (dispatcher `*/2 * * * *`,
  593 completed) and it is Heath's internal staff — every write path is gated on `CRON_SECRET`
  or his email, two of three executors are tool-less text calls, and the only capable executor
  is a Windows Task Scheduler job on his desktop. Member transaction work would be a new system
  reusing the table shape and the `depends_on` DAG, nothing more.
- **Separate maintenance items worth a ticket, not a place in this sequence:** the 860 pending
  `agent_requests` rows (858 to Quinn, oldest 2026-06-15) stranded because
  `/api/cron-process-agent-requests` is not in `vercel.json` and its external cron-job.org
  scheduler last fired 2026-08-25; the 14 pending `agent_queue` rows and 9.2-day watchdog
  alert; and the dead `agent_task_queue`/`agent_workers` subsystem (no migration in the repo,
  3 done rows, 3 dead workers) that `cron-agent-worker-tick` still polls every minute.
- **`vercel.json` is at exactly 100 crons — Vercel's cap.** Anything new needs a slot freed or
  an external scheduler, and the external scheduler already in use is dead. Worth resolving
  before Tier 3 adds crons.

---

## Sources

Verified by reading, this session: `api/fill-form.js`, `api/_lib/fill-trec-20-19.js`,
`api/esign-create.js`, `api/_lib/pre-send-field-audit.js`, `api/_assets/trec-20-18-esign-coords.json`,
`api/_assets/trec-20-19-field-coords.json`, `api/_assets/docuseal-prefill.js`,
`api/scan-contract.js`, `api/get-agent-defaults.js`, `api/save-agent-defaults.js`,
`api/google-oauth-{init,callback}.js`, `api/_lib/gmail-oauth.js`,
`api/_lib/email-integration-customers.js`, `api/cron-{email-to-dossier,esign-events,showingtime-feedback}.js`,
`api/cron-agent-queue-dispatch.js`, `api/send-compliance-packet.js`, `api/solo-documents.js`,
`api/help-pages.js`, `api/whats-new.js`, `api/_lib/required-documents.js`, `vercel.json`,
`Dossie/dossie-app.jsx`, `Dossie/src/components/{DossieSignModal,EsignModal,SoloDocumentVaultView}.jsx`,
`Dossie/src/components/dossieSign/phase1/{FormEditor,SendPacketButton}.jsx`,
`scripts/send-trec-offer-packet.js`, `scripts/_lib/{zipform-fill-trec,brokerage-browser,connectmls-actions}.js`,
`scripts/brokerage-command-*.js`, `scripts/import-phone-link.py`, `docs/DOSSIE-SIGN-DOD.md`,
`docs/ZIPFORM-INTEGRATION-SCOPE.md`, `docs/TECH-DEBT.md`, `.tmp/ridgebluff-cma/`,
`.tmp/ridgebluff-offer/`, `.tmp/command-recon/`, and commits `2a86a483`, `1cadd5c3`, `22fb0f91`.

Live DB (read-only): `signature_requests`, `transactions`, `profiles`, `documents`,
`action_items`, `email_queue`, `user_integrations`, `sms_messages`, `esign_events`,
`showingtime_feedback`, `compliance_sends`, `agent_queue`, `agent_requests`,
`agent_task_queue`, `agent_workers`, `cron_runs`, `information_schema`.

Page-by-page census of the TREC 20-19 blank done with `pdftotext` against the asset the
product actually ships (`api/_assets/trec-resale-20-19-base64.js`): 12 pages, 280 AcroForm
widgets, initial lines on pages 1–9 and 12, EXECUTED block page 10, broker contact page 11.

**Explicitly undetermined:** DocuSeal's `areas[].page` indexing base (the code contradicts
itself); the publishing status of the Google OAuth consent screen (no doc states it).
