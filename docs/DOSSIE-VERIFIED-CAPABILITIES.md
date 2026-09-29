# Dossie — Verified Capabilities (Ground Truth for Marketing)

**Purpose.** The single source of truth content generation checks against before any
Dossie/Heath conversation video, feature demo, caption, or sales claim goes out. Per
[[dossie-demo-must-match-real-capability]]: no marketing may show, describe, or imply a
capability that doesn't work in the live product today.

**Method — real user verification, not code reading.** Every WORKS/PARTIAL verdict below was
reached by driving a real Chrome browser (Playwright, via `scripts/_lib/quinn-browser.js`,
Quinn's dedicated profile) against **production** `https://meetdossie.com`, signed in as the
real demo account `demo@meetdossie.com` (Sarah Whitley), clicking/typing exactly what a member
would, and confirming what rendered on screen. Where a claim was corroborated by a direct,
read-only Supabase query against the live `pgwoitbdiyubjugwufhk` project, that is labeled
**(DB-confirmed)** — DB checks were used only to corroborate a UI finding (e.g., counting
completed signatures), never as the sole basis for a WORKS verdict.

**Verified:** 2026-09-14, by Quinn. Starting inventory: `docs/DOSSIE-CAPABILITY-AUDIT-2026-08-31.md`
(2 weeks old at time of this pass — treated as dated, re-verified point by point below where it
matters for marketing).

**Status legend:** WORKS · PARTIAL (real but bounded — see "Do NOT claim") · DOESN'T EXIST ·
BROKEN · UNVERIFIED (not tested this pass, state explicitly instead of guessing).

---

## Quick reference table

| # | Capability | Status | One-line |
|---|---|---|---|
| 1 | Login | WORKS | Real Supabase auth, demo account signs in cleanly. |
| 2 | New Dossier modal (Open New Dossier) | WORKS | 6-step guided intake, "Scan Contract PDF" entry point. |
| 3 | Contract upload + field extraction | WORKS | Live-tested: uploaded a real TREC-1-4-Family PDF, form identified, ~50 fields pre-filled/flagged in ~55s. |
| 4 | Compliance / pre-fill audit on scan | WORKS | Same scan flagged missing signatures, initials, blank required fields, missing addenda, with a real addendum detected from contract text. |
| 5 | Dossier detail view (per-transaction) | WORKS | Rich multi-section record: Deal, Land, Title, Key dates, Option, Inspection, Appraisal, Closing, Post-Close. |
| 6 | TREC deadline calculator | WORKS | Deadlines shown with real TREC paragraph citations (¶5A, ¶5B, ¶6A, ¶9A), recomputed live when a date field is edited. |
| 7 | Stage checklist | WORKS | Per-stage checklist (Pre-Contract → Closed), real check/uncheck state, tied to the dossier's actual stage. |
| 8 | Required-documents tracking | WORKS | Present/missing grid with Send/Request actions per doc type (IABS, Buyer Rep Agreement, Lead Paint, Executed Contract, etc). |
| 9 | Document management | WORKS | Real per-dossier file list (36 files on one seeded demo dossier), upload/view/delete, Form Library. |
| 10 | Pipeline view | WORKS | 10-stage kanban board, real dossier cards with computed urgency text and dates. |
| 11 | Talk to Dossie (text command) | WORKS | Typed "what's urgent today?", got a real, data-grounded text answer referencing actual dossiers. |
| 12 | Voice output/input (spoken) | PARTIAL / UNVERIFIED | UI shows "🔊 Speaking…" state and a "🎤 Voice call" control; actual audio round-trip not verifiable in a headless browser (no mic/speaker) — text-command path underneath is confirmed real. |
| 13 | Morning Brief | WORKS (text) / PARTIAL (voice) | Real, data-grounded daily summary renders with correct counts and per-dossier detail; "Play Brief" audio playback not verified this pass. |
| 14 | Email drafting | WORKS | Real per-dossier draft queue (8 templates), correct recipients pulled from dossier data, explicitly member-sent — not auto-sent. |
| 15 | Email auto-send | DOESN'T EXIST (by design) | Every draft says "send it from your normal email workflow." "AI Email Autopilot" is explicitly labeled Coming Soon everywhere. |
| 16 | E-signature / DossieSign (generate + send) | PARTIAL | Real modal, real 25+-form TREC library, real signer roles — mechanically dispatches to DocuSeal. **Zero envelopes have ever been completed in production** (DB-confirmed, 33/33 `signature_requests` rows are `status='sent'`, none `completed`, as of today). |
| 17 | Send to Compliance / Download ZIP | PARTIAL | Buttons are real and present on every dossier. Per the prior deep audit this emails a packet + offers a ZIP download — it is **not** a brokerage-portal (KW Command/SkySlope/Dotloop) upload. Not re-clicked this pass (would fire a real email); UI presence confirmed only. |
| 18 | Compliance Vault (add-on) | UNVERIFIED (this pass) | Settings sells it live ($15/mo) and "What's Coming" lists it under "works today," but clicking the sidebar entry on the demo account rendered a blank page — the demo account does not have the add-on entitled. Needs a re-check on an account that actually has it enabled. |
| 19 | Connect Gmail (Email Integration) | PARTIAL — improved since 08-31 | Button now genuinely redirects to a real Google OAuth consent screen ("Sign in to continue to meetdossie.com") — this is a real change from the 08-31 finding of a dead "Coming Soon" toast. **But zero members have ever completed the connection** (DB-confirmed: `user_integrations` has exactly 1 row, and it's Heath's Google *Calendar*, not Gmail). Full round-trip (token issuance, inbox reading) unverified this pass — no live Google account was used to complete consent. |
| 20 | CMA generation | DOESN'T EXIST | No route, no UI beyond a checklist-item label, no MLS data feed. Unchanged from prior audit. |
| 21 | MLS integration | DOESN'T EXIST | No RESO/MLS Grid/Bridge/Trestle feed license. Unchanged. |
| 22 | Member SMS capture | DOESN'T EXIST | No SMS provider in the product. Unchanged. |
| 23 | Per-agent contract-term defaults | DOESN'T EXIST | Only broker/agent *identity* defaults (IABS) are saved and reused; option fee/survey/title-payor/etc. defaults are not. Unchanged. |
| 24 | Brokerage compliance portal upload (KW Command etc.) | DOESN'T EXIST | Product hands the member an email + ZIP, not a portal submission. Unchanged. |

---

## Detail, with what was actually seen

### 1–2. Login + New Dossier modal — WORKS
Signed in live as `demo@meetdossie.com`. "Open New Dossier" opens a real 6-step guided flow
(Transaction type → Deal stage → Your side → Property/parties → Dates/money → Notes), plus a
"📄 Scan Contract PDF" shortcut at the top.
**Do NOT claim:** nothing extra — this is straightforwardly real.

### 3–4. Contract upload, field extraction, and compliance audit — WORKS
Uploaded `generated-docs/sample-resale-contract.pdf` through the real "Scan Contract PDF"
control. Took ~55 seconds; the API call (`scan-contract`) returned 200. Result, rendered live:
- Correctly identified the document: "TREC One to Four Family Residential Contract."
- Pre-filled fields with a ✓ (confirmed populated: property address, city/state/zip, buyer
  name, seller name, closing date, earnest money, option fee) and flagged others with a ! where
  the scan couldn't confidently fill them (listing-agent name/email, effective date, option
  period days, sales price, title company, lender name) — it is honest about what it didn't
  get, not silently wrong.
- A real compliance-style audit banner: "Missing signatures (2), Missing initials (8), Blank
  required fields (13), Missing addenda (1), Other warnings (3)," plus a specific, correct
  catch: "Addenda checked: Third Party Financing Addendum (indicated as checked in Paragraph 3B)."
**Say:** "Upload a contract and Dossie reads it, pre-fills what she's confident about, and
flags exactly what's missing before it becomes a problem."
**Do NOT claim:** that the scan is 100% complete or needs no review — the product's own UI
labels the result "Needs review" and lists real gaps. Don't claim it works on any form besides
what it actually classified in a given demo; only claim what the specific recording shows.

### 5–9. Dossier detail view, deadlines, checklist, required docs, documents — WORKS
Opened a real seeded dossier (789 Ranch Rd). Confirmed live, in one continuous render:
- **TREC deadlines** with real paragraph citations tied to editable contract dates: "Earnest
  money due · ¶ 5A," "Option period expires · ¶ 5B," "Title commitment deadline · ¶ 6A,"
  "Financing deadline · Third Party Financing Addendum," "Closing date · ¶ 9A." This is the
  deadline-calculator claim — it is real and it cites the actual TREC paragraph, not a generic
  "X days" label.
- **Per-stage checklist** (Pre-Contract through Closed) with real done/not-done state specific
  to this file's actual stage.
- **Required documents** grid: IABS, Buyer Representation Agreement, Pre-Approval Letter, Lead
  Paint Disclosure, Executed Contract, Third Party Financing Addendum, Closing Disclosure, Wire
  Instructions — each tagged REQUIRED / TX LAW where applicable, each with a Send or Request
  action.
- **Documents tab**: 36 real files on file for this one dossier, each with a type tag
  (`filled_form`, `farm_ranch_contract`, etc.), View/Delete, and a per-file "✍ Send for sig."
  action.
**Do NOT claim:** that every dossier has this much data — this is a seeded demo file; a brand
new member's dossier starts empty and fills in as they work it.

### 10. Pipeline view — WORKS
Clicked "Pipeline." Real 10-stage board (Pre-Listing, Pre-Contract, Active Listing, Under
Contract, Option Period, Inspection, Financing, Title & Survey, Clear to Close, plus Closed
separately) with live counts and real dossier cards, each showing a computed urgency line
("Survey due in 2 days · 9/16/2026," "Option period expires in 4 days · 9/18/2026").

### 11–13. Talk to Dossie, voice, Morning Brief — WORKS (text) / PARTIAL (audio)
Typed "what's urgent today?" into the real command box and hit Send. Got back a real,
data-grounded answer referencing actual dossiers by address and real dates, with a
"🔊 Speaking…" UI state indicating TTS playback was attempted. Morning Brief renders a full,
correctly-computed daily summary (8 active, 3 needing attention, 3 clear to close, specific
per-property urgency reasons) with a "Play Brief" control.
**Do NOT claim:** that the *spoken* audio was independently confirmed this pass — headless
Chrome has no speaker/mic, so only the text-command and TTS-triggered UI state were verified,
not the actual audio. The underlying Q&A capability is real; the audio delivery layer is
UI-confirmed-present but not ear-confirmed this session.

### 14–15. Email drafting — WORKS; auto-send — does not exist by design
"Emails" tab shows a real draft queue grouped by dossier, correct recipients pulled from that
dossier's actual buyer/seller/lender/title contacts, explicit copy: "You can edit the draft
here now, then send it from your normal email workflow." This matches the product's "never
auto-send" design (see [[feedback_draft-means-draft-never-send]]) — Dossie drafts, the member
sends.
**Say:** "Dossie drafts the email, addressed correctly, ready to send."
**Do NOT claim:** "Dossie emails your client for you" / "Dossie sends the email" — she doesn't,
by design. "AI Email Autopilot" (which would send) is explicitly Coming Soon everywhere it's
shown in-app.

### 16. E-signature / DossieSign — PARTIAL, and the highest-risk claim in the product
Clicked "✍ Generate + Sign" on a real dossier. A real "Send for Signature" modal opened:
signer-role picker (Buyer 1/2, Seller 1/2, Buyer/Seller Broker, +Add signer), and a genuine
25-form TREC library to choose from (20-19, 40-11, 49-1, 39-11, 36-11, OP-L, OP-H, 61-0, 11-8,
11-9, 26, 25-17, 30-18, 23-20, 24-20, both IABS variants, Option Period Extension, Sales Price
Change, TAR 1501, Wire Fraud Warning, TREC 10-11, TXR 2602, TXR 1409, TXR-1101), ending in a
real "Generate + Send for Signature" button. This is genuinely built, not a stub.

Did **not** click through to an actual send this pass (per standing QA rule: never trigger a
real send without first proving interception, and this was a verification pass, not a send
test). Confirmed instead by a direct, read-only DB query:

```
signature_requests: 33 rows total, ALL status='sent', 0 status='completed'
```

**Zero envelopes have ever been signed to completion in production**, on any account, ever —
unchanged from the prior audit's 32-row finding two weeks ago (one more test send happened
since, still zero completions).

**Say:** "Dossie can generate a filled TREC form and send it out for signature." A real,
verified mechanical capability.
**Do NOT claim:** "your client signs and it's done" / "get your contract executed through
Dossie" / show a completed/signed document as the outcome of this flow in any demo — that
outcome has never once happened in production. Also do not resolve the live contradiction
in-product without flagging it to Carter: **Settings → Add-ons still labels "E-Signatures" as
"COMING SOON ($10 free, then $0.50/envelope)"** while the "What's Coming" roadmap page says
"Now — E-Signatures (beta) — live in your dossiers" and the dossier UI itself has a fully
working send modal. All three should agree; right now a member reading Settings would think
this doesn't exist yet.

### 17. Send to Compliance / Download ZIP — PARTIAL
Both buttons are real and present on every dossier ("✉️ Send to Compliance," "⬇️ Download
ZIP," with live status "Not yet sent to compliance"). Not clicked this pass (Send to
Compliance fires a real email). Per the prior deep code/DB audit this is an emailed packet +
a ZIP download the member uploads themselves — there is no direct KW Command/SkySlope/Dotloop
API submission.
**Say:** "Dossie can package every document and either email your compliance contact directly
or hand you a ready-to-upload ZIP."
**Do NOT claim:** "Dossie submits to your broker" / "uploads to KW Command" — it does not.

### 18. Compliance Vault — UNVERIFIED this pass (needs re-check)
Settings sells it live, $15/mo, real Stripe checkout button ("Enable Compliance Vault"). It is
also listed under "What Works Today" on the roadmap page. But the sidebar nav entry, when
clicked on the demo account used for this pass, rendered a blank content area — this demo
account does not have the add-on entitled, so the actual feature screen was not observed.
**Do NOT claim** anything about what the Vault screen looks like or does beyond "search/filter
documents across your files, present vs. missing" (the product's own copy) until it's been
opened on an account that actually has it enabled and rendered.

### 19. Connect Gmail (Email Integration add-on) — PARTIAL, real improvement since 08-31
Clicked "Connect Gmail" in Settings. It redirected to a **real Google OAuth consent screen**
("Sign in — to continue to meetdossie.com," with an actual Google-hosted email/phone entry
field). This is a genuine, verified change from the 2026-08-31 finding that this button fired
a "Coming Soon" toast and called nothing — someone has wired the button to
`/api/google-oauth-init` since then.

However: a direct DB query shows **`user_integrations` still has exactly one row in
production, and it is Heath's `google_calendar` connection — not Gmail, and not any other
member.** Nobody has ever completed this flow. Consent completion (token issuance, actual
inbox access) was not tested this pass — that would require signing into a real Google account,
which was not attempted.
**Say:** "You can connect your Gmail" is now defensible as far as *initiating* the connection.
**Do NOT claim:** that a member has actually connected their inbox, that inbound email filing
is proven working end-to-end for a real (non-Heath) account, or that this has cleared Google's
verification requirements — the prior audit's caution about restricted Gmail scopes needing a
CASA security assessment before general availability still applies and was not re-tested.

### 20–24. CMA, MLS integration, SMS capture, per-agent contract defaults, brokerage portal upload — unchanged, DOESN'T EXIST
No contradicting evidence found this pass for any of these five. Re-affirming the 2026-08-31
audit's findings stands. Full detail on each remains in
`docs/DOSSIE-CAPABILITY-AUDIT-2026-08-31.md` sections 1, 3, 4c, 5.
**Do NOT claim any of these exist, in any form, for any tier.**

---

## Feature-demo video_library check (as requested)

Queried `video_library` for every `feature-demo-*` row. All 13 entries were produced
**2026-09-07** (one week before this verification pass) and cover: close-day, dossier-detail,
email-drafting, morning-brief, deadline-calculator, chase-documents, contract-scan,
trec-deadlines, file-a-text, required-docs, draft-amendment, talk-command, stage-checklist.

**None of these map to CMA, MLS, e-signature, Compliance Vault, or Gmail connect** — the five
areas flagged above as PARTIAL/UNVERIFIED/DOESN'T EXIST. Every topic in the current queue maps
to a capability re-verified WORKS in this pass, and the flows observed live today match what
those topics claim to demo. **No re-recording needed based on this check.** (Scope note: this
confirms topic-to-capability match, not frame-by-frame comparison against each video's actual
footage — if a specific video's on-screen copy makes a stronger claim than the feature
supports, e.g. overstating what the scan flags, that would need a frame-level review this pass
didn't do.)

---

## For the conversation-video format specifically

Given Heath's new "ask Dossie a question, she answers" format, the highest-risk failure mode is
Dossie's scripted answer implying a capability from the list above marked PARTIAL/DOESN'T
EXIST/UNVERIFIED. Concretely, a scripted Dossie answer must never say or imply:
- that she gets a document *signed* (only: generates it and sends it out for signature)
- that she pulls comps or MLS data (she doesn't have MLS access at all)
- that she texts, monitors, or reads a client's SMS (no capability)
- that she emails a client automatically (drafts only, member sends)
- that she submits paperwork to a brokerage portal (email + ZIP only)
- that she has "your Gmail connected" as a finished fact for any specific member (nobody's
  ever completed the flow)
- that contract-term preferences (option fee, survey days, title payor, etc.) "remember" a
  member's usual terms — only broker/agent identity fields do

Safe, verified, strong material for the format: contract scan + compliance audit, TREC
deadline citations, the pipeline board, the per-dossier checklist and required-docs tracker,
Morning Brief's data-grounded daily summary, and Talk-to-Dossie's real Q&A over actual
transaction data — all confirmed live today.
