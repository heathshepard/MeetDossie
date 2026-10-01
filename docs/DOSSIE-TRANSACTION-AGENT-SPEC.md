# Dossie Transaction Agent — Implementation Spec

Status: **PLAN ONLY.** No code changed, no migration applied, no behavior changed
this pass. Written by Carter, 2026-10-01.

Heath's ask, verbatim: *"Dossie needs to be able to do all of this paperwork just
by talking to her just like I'm talking to you. So I need you to figure out how
to train her to do all of these things."*

## Method

This spec is derived from real transaction work Cole did for Heath over the last
two days — not imagined. Each capability below exists because a real task needed
it; each gate exists because a real mistake happened. Where code already does
the job, this spec says so and does not propose rebuilding it (CLAUDE.md Rules
1/3). Every file path below was read, not assumed, on 2026-10-01 against this
worktree's checkout.

---

## 0. The target interaction

From `dossie-agent-capability-spec.md` (2026-08-15), Heath's own framing of what
"done" looks like:

> *"Kanika wants to put in offers for Homestead and Mainland... We need to also
> pull comps around Homestead as well. Don't send anything to the clients without
> my proofing it first."*

That is the bar: one conversational message, Dossie does the multi-step
transaction work, and the one rule that never bends — nothing reaches a client
without the member seeing it first — holds automatically, not because the member
remembered to say it.

The concrete tasks Cole did this session that this spec reverse-engineers from:
finding the executed contract among lookalikes and computing a deadline off the
receipted copy; auditing KW Command for missing documents; pre-filling TREC/TXR
forms from an executed contract while leaving judgment fields blank; building
and verifying DocuSeal packets from the recipient's seat; assembling an 18-document
closing file with per-document execution status; building a net sheet from a real
payoff; comparing counteroffers; updating MLS status and contract dates.

---

## 1. The tool surface

Status legend: **BUILT** (live, multi-tenant, in production or on staging) ·
**BUILT, SINGLE-TENANT** (works, but only for Heath's own account) ·
**PLANNED** (a written plan exists, not yet coded — `docs/DOSSIESIGN-FORM-LIBRARY-PLAN.md`) ·
**NOT BUILT** (no code in `api/` today).

### 1.1 Mailbox — read

**BUILT.** `api/_lib/inbox-tools.js` — `search_inbox`, `read_email`,
`find_contact_email`, `import_email_attachments`. Resolved server-side inside
`api/chat.js`'s action loop via `api/_lib/server-tool-resolve-loop.js`. Gated by
`assertInboxAccess(userId)`: checks `subscriptions.email_integration_enabled`
(the paid add-on), then calls `makeMailClient({ userId })`
(`api/_lib/mail-client.js`), which loads **that member's own** Gmail or
Microsoft Graph tokens from `user_integrations` (never a shared mailbox). Three
distinct failure messages — not entitled / not connected / connection
expired — so Dossie never confuses "no mail access" with "no matching email."

Credential: member's own Gmail or Outlook OAuth consent, via
`api/google-oauth-callback.js` / the Microsoft equivalent. Connects in Settings.
This is the credential model every other connector in this spec should copy.

### 1.2 Mailbox — send

**BUILT**, but gate-less at the tool layer. `send_email` and `draft_email` are
client-dispatched actions defined in `api/chat.js` (not server-resolved like the
inbox tools above). `draft_email` only ever produces a draft for the member to
review. `send_email`'s own tool description says "only when agent explicitly
wants to send now" — correct for a member sending to **their own** client by
explicit voice instruction, but there is **no code-level check today on who
`to_email` is.** See Gate 2 below — this is the single most important gap to
close before this tool surface goes further.

### 1.3 Document fetch + page rendering

**BUILT**, two complementary layers, neither exposed yet as a general
mid-conversation "show me page 3" chat tool (flagged as a gap in
`dossie-esign-productization-plan.md` and still true):
- `api/_lib/pdf-to-images.js` hands the whole PDF to Claude as a native
  `document` content block — Claude renders every page internally. This is how
  `api/scan-contract.js` and `api/_lib/contract-extraction-tools.js` already
  "look at" a contract rather than trust its text layer.
- `api/_lib/signature-verifier.js` does a deterministic AcroForm/byte probe
  **plus** a vision pass (`verifySignaturesVisually`) with "visual wins on
  is-it-blank" — already caught one real `partially_signed` against a
  provider-reported completion (`cron-esign-events.js`, 2026-08-14).

What's missing: a **tool** a member's own conversation turn can call to open and
look at an arbitrary document ("render page 3 of the seller's disclosure") the
way Cole does by hand every session. Today rendering only happens inside
specific flows (scan, verify) — never on ad hoc request. This is new, small
work: wrap `pdf-to-images.js` + `signature-verifier.js`'s render path as a
server-resolved tool (`render_document_page`) with the same ownership-check
pattern as `contract-extraction-tools.js`'s `resolveOwnedTransaction`.

### 1.4 Form fill by widget rectangle

**BUILT for 25 TREC/TAR forms.** Geometry extracted deterministically from
AcroForm widget rects (`scripts/extract-acroform-fields.js`), never guessed —
the `acroform-field-names-lie` lesson is already load-bearing here:
`api/esign-create.js`'s `buildMappedFieldMap` + `assertPlausibleMappedFieldCount`
compute from the widget rect and the known-good role map, and refuse (422) when
a signer has no matching role or the field count is implausible for the page
count. `api/fill-form.js` fills the forms; `api/_lib/trec-20-19-editor-field-translate.js`
and siblings hold the per-form semantic maps.

**PLANNED, not built:** member-uploaded custom forms (a brokerage's own CMA
Acknowledgement, etc.) have storage (`member_form_templates`,
migration `20260921_member_form_templates.sql`) but **no saved field map** — a
member re-places signature boxes by hand on every single send today. The fix is
fully scoped in `docs/DOSSIESIGN-FORM-LIBRARY-PLAN.md` Feature 1 (new columns on
`member_form_templates`, `api/member-form-field-map.js`, `MemberFormMapper.jsx`)
and is not re-derived here — see §5 Build Sequence for where it slots in.

### 1.5 E-sign create / verify

**BUILT**, one real architectural constraint: `api/esign-create.js` sends
through **DocuSeal**, one shared account (`DOCUSEAL_API_KEY`), not zipForm or
Authentisign. This is a deliberate, already-made call — see §1.8. Verification
is real (§1.3) and the inbound watcher (`api/cron-esign-events.js`) is
**already multi-tenant** as of this check — it loops `for (const customer of
scoped)` over every connected mailbox, not a single hardcoded account (this
corrects `dossie-esign-productization-plan.md`'s 2026-08-21 note calling it
single-tenant; it has since been generalized, same as `cron-email-to-dossier.js`,
which loops `for (const customer of customers)` per its own 2026-08-22 comment
block).

Real scale gap, unchanged from the 2026-08-15 assessment: **one shared DocuSeal
account** means one provider-side suspension or email-deliverability flag is
account-global across every Dossie member, and `esign-create.js` clones a
template per envelope with no reaper. Not urgent at current customer count;
flagged for §6.

### 1.6 MLS

**NOT BUILT.** Zero MLS code exists in `api/`. The only MLS automation anywhere
in the repo is `scripts/_lib/brokerage-browser.js` driving connectMLS through
Heath's own persistent Chrome profile (`~/.brokerage-browser-profile`) — his
personal practice tooling, explicitly not a per-member product surface (one
shared physical profile, one login, Windows-Hello-gated re-auth). MLS has no
public API for a third party to request session grants against on a member's
behalf (SABOR/MLSGrid access requires a vendor agreement, not a per-user OAuth
flow) — this is the honest gap in §6, not a near-term build.

### 1.7 Brokerage compliance portal (KW Command, etc.)

**NOT BUILT as a product capability.** `dossie-compliance-upload-capability.md`
(2026-08-29) sets the direction — vertical-agnostic core (match documents to a
checklist, upload, submit, track) + a per-brokerage config layer (KW Command
first, then eBrokerHouse/SkySlope/Dotloop/Brokermint/Lone Wolf) — but what
exists today is Heath's own `scripts/brokerage-command-login.js` /
`-recon.js`, single-tenant Playwright against his own session, with
`"Submit to MC"` deliberately left a human click. No code in `api/` drives this
for any member yet.

### 1.8 County / CAD lookup

**NOT BUILT.** No API code exists for appraisal-district or county-records
lookup (the jurisdiction/deed-restriction research in `dossie-agent-capability-spec.md`
§6 was done by hand, via web search + GIS layers, not a reusable tool). This
is real, valuable work (it caught two dead STR deals) but has no automation
today — flagged in §6.

### 1.9 zipForm / Lone Wolf — architecture decision, already made

**Deliberately excluded, not a gap.** `dossie-agent-capability-spec.md`'s
Architecture Note and `dossie-esign-productization-plan.md`'s Architecture Call
both land on the same answer: never drive a member's zipForm/Authentisign
account directly. It needs their Lone Wolf credentials, it breaks on every UI
change, and it costs a browser session per send — real debt this product does
not carry today and should not start carrying. DocuSeal is the send path; the
inbound e-sign watcher (§1.5) is how Dossie still sees documents signed inside
zipForm/Authentisign without ever touching it.

---

## 2. Per-member credentials — the hard part

Heath's sessions are hardcoded in `scripts/` today (one Chrome profile, one
login, his own hands at MFA). `transactions` is multi-tenant Supabase data — a
credential leak here exposes **another agent's clients**, not Heath's. This
section is written to that standard.

### 2.1 The model that already works — copy it

`user_integrations` (migration `20260706_user_integrations.sql`) is the
template:
- One row per `(user_id, oauth_provider)`, `UNIQUE` constraint enforced.
- RLS: owner can `SELECT`/`DELETE` their own row. **No client-side `UPDATE` or
  `INSERT` policy at all** — tokens are written only by the server-side OAuth
  callback (`api/google-oauth-callback.js`) using the service-role key. A
  member cannot forge or edit another member's token row even if a bug let them
  try, because the policy surface for writes doesn't exist on the client side.
- `makeMailClient({ userId })` resolves strictly from that user's own rows.
  Nothing upstream of it accepts a caller-supplied mailbox identity — `userId`
  always comes from the verified Supabase session (`verifySupabaseToken`),
  never from tool input. `inbox-tools.js` has a standing guard for exactly this
  (`assertNoIdentityParams` / `isIdentityKey`) — a defense this spec should
  require every new connector to inherit.

This is a real, working multi-tenant OAuth model. **It only covers providers
with real OAuth: Gmail, Microsoft Graph.** It does not solve the harder case
below.

### 2.2 The harder case — credentials with no OAuth

zipForm, connectMLS, and KW Command (and every brokerage portal after it) use
username/password form login, not OAuth. There is no token to refresh, no
scope to request, no third-party consent screen — just a member's actual
password to a system that also holds every other agent's deals at their
brokerage. Three real options, ranked:

1. **Don't store the password at all — session-token capture per connection,
   same pattern already proven for Heath's own zipForm login**
   (`zipform-credential-login.md`: "storageState does NOT work and breaks
   connectMLS" — meaning cookies alone aren't durable). The real working
   pattern there is a **one-time, visible, human-driven login** into a
   persistent browser profile, after which the session stays alive without
   re-prompting for MFA. Productized: one dedicated, isolated browser profile
   **per member**, created once during onboarding with the member physically
   present for their own MFA, never touched by any other member's agent run.
   This is real infrastructure cost (one profile directory per member, not one
   shared install) and real failure surface (profile corruption, expired
   session needing re-auth) — it is not free, but it needs no password at
   rest anywhere in Dossie's database.
2. **Encrypted credential vault, decrypted only inside a short-lived automation
   job.** Supabase has no column-level encryption turned on anywhere in this
   schema today (`user_integrations` stores tokens in plaintext columns,
   relying on RLS + at-rest disk encryption only) — a vault would need
   `pgsodium`/`pgcrypto` or an external secrets manager (not Vercel env vars;
   those are per-deployment, not per-member), decrypted only server-side,
   never returned to the client, never logged. Real engineering lift and a
   genuinely larger blast radius than option 1 if the encryption key itself
   leaks (one key failure exposes every member's password at once; option 1's
   failure mode is "one member's own browser session," never another's).
3. **Never automate it — member does the zipForm/MLS/portal step by hand,
   Dossie prepares everything up to that point.** The honest fallback. Zero
   new credential risk. Directly supported by the architecture note already
   made for zipForm/Authentisign (§1.9) — the same reasoning (brittle,
   credential-bearing, no public API) applies identically to connectMLS and
   KW Command. **This is the recommended default for v1**, not a cop-out: it
   matches what the e-sign architecture already decided, and it means MLS
   status updates and compliance submission ship as "Dossie drafts/detects,
   member clicks" rather than as a new credential-storage system this spec
   would otherwise need to get right on the first try.

**Recommendation:** ship v1 entirely on option 3 (detect + draft + hand off)
for MLS and compliance portals. Revisit option 1 only if enough members ask for
full automation to justify per-member browser-profile infrastructure, and
build it exactly on the `zipform-credential-login.md` pattern that already
works for one real account, not a new design. Never build option 2 for
username/password credentials without a dedicated security review — it is the
one path in this section that creates a single point of catastrophic,
cross-member exposure, and this repo is public (CLAUDE.md §15).

### 2.3 Multi-tenancy checklist for any new connector

Every connector this spec adds must satisfy all of these before it ships,
modeled on what `inbox-tools.js` already enforces:
- `userId` comes only from a verified session token, never from tool/caller
  input (`assertNoIdentityParams` is the existing guard to extend, not
  reinvent).
- Entitlement check (is this an add-on the member has turned on) is a
  **different, earlier** check than connection status (is their account
  actually linked) — conflating the two produces a wrong "no matching data"
  answer when the truth is "Dossie can't see this yet," exactly the failure
  mode `assertInboxAccess`'s three-reason design already avoids.
- No row written by a client-authenticated request; credential writes are
  service-role-only, same as `user_integrations`'s RLS.
- A dead/expired credential surfaces a clear, actionable message
  (`mapMailError`'s `connection_expired` path is the template), never a silent
  "nothing found."

---

## 3. The gates — refusals the agent cannot talk itself out of

Per `teaching-pipeline-cole-to-dossie.md`: **a rule Cole follows is a gate
Dossie enforces.** Every gate below names the enforcement point — either
"already enforced, here" or "not enforced yet, here's where it has to go."

### Gate 1 — Parties, price, and opposing agent come from the executed contract only

Incident: `feedback_parties-come-from-the-executed-contract.md`, 2026-09-30 —
Cole matched a dollar figure across two documents in the same folder and
emailed the wrong lender. The real buyers were different people at a different
price.

**Not enforced in code today.** `api/_lib/contract-extraction-tools.js`'s
`extract_contract_terms` already pulls from the contract document, but nothing
stops a different tool call (`find_contact_email`, `send_email`) from resolving
a name/price/agent against whatever matched a search, rather than requiring it
to trace back to the one document flagged `document_type = 'contract'` AND
`execution_status = 'executed'` on that transaction. **Build:** every tool that
emits a party name, price, or agent identity for a specific transaction must
resolve it through a single shared function that reads the executed contract
row and refuses (returns a flagged/null result, not a best guess) when zero or
more than one document on that transaction is marked executed, or when two
candidate values disagree by more than a rounding tolerance.

### Gate 2 — Never contact the other side's clients

Incident: `feedback_never-contact-represented-parties.md`, 2026-08-30 — an
e-sign packet was about to be addressed directly to the Champies instead of
their agent, Heather Mutz.

**Not enforced in code today** — confirmed by reading `api/chat.js` and
`api/esign-create.js`: neither has any check on recipient identity against
transaction party roles. **Build:** before `send_email` or any e-sign-create
call resolves its recipient list, classify every recipient against the
transaction's party roles (buyer/seller/buyer's agent/listing agent, from the
Gate 1 source of truth). If a recipient matches a party role that is **not**
the member's own client (i.e., the other side's principal, not their agent),
hard-refuse with a message naming the correct recipient (their agent) instead.
This is a pure data-classification problem — no new infrastructure, just a
lookup that must run before any send path's existing recipient field is
trusted.

### Gate 3 — Never push e-sign into another brokerage's workflow

New this session, not yet in memory — writing it up now. The pattern: when a
document needs the **other side's** signature (buyer's disclosure receipt,
counter-signature on a form their agent controls), the correct artifact to send
them is a **PDF of your own executed copy**, not a DocuSeal (or any other
e-sign platform) invite addressed to their principal. Two reasons stack here,
not one: Gate 2 already forbids addressing anything to their client directly,
and separately, inviting the other side into *your* e-sign envelope puts a
signature from another brokerage's represented party inside a workflow their
own brokerage doesn't control or see — the same shape of problem as driving
their zipForm account (§1.9), just from the signature-request side instead of
the browser-automation side.

**Build:** in the same recipient-classification pass as Gate 2, if a document
being prepared for send has a signer role resolving to the other side's
principal, the only allowed action is "attach a flattened PDF to an email
addressed to their agent" — the e-sign-create tool for that document is not
offered as an option at all, not just blocked after the fact. This should be a
UI-level absence (the "send for e-signature" action never appears for a
document in this state), not only a backend 422, so the member is never shown
a button that would then refuse.

### Gate 4 — Only fully executed documents go to a compliance placeholder

Incident: `feedback_only-upload-executed-documents.md`, 2026-08-30 — the
Seller's Disclosure and On-Site Sewer disclosure were uploaded to KW Command
placeholders while the buyers' receipt sections and per-page initials were
still blank; Heath had to delete both by hand.

**No enforcement point exists yet because the upload capability itself isn't
built (§1.7).** When it is: every document bound for a compliance placeholder
must pass `signature-verifier.js`'s visual pass first — not just a provider
"complete" status, not text extraction (which cannot see an e-signature image
overlay at all, the exact failure mode that produced a blank T-47 on this same
file). A document that is partially executed does not go in the placeholder;
the slot stays empty and the gap is reported with who still has to sign. This
reuses §1.5's existing verification layer; it does not need a new verifier.

### Gate 5 — Draft means draft; naming a recipient is not authorization to send

Incident: `feedback_draft-means-draft-never-send.md`, 2026-08-15 — "send it to
Lily" was read as authorization; a defective envelope reached a real client
before Heath saw it.

**Partially enforced today.** `draft_email` vs `send_email` already exist as
separate tools in `api/chat.js`, which is the right shape — but the model
decides which one to call based on phrasing ("Draft/email/send/write/intro =
draft_email" per `api/chat.js`'s own routing comment at line ~943). That
routing is a prompt instruction, not a hard gate — a sufficiently direct
phrasing can still reach `send_email` on a first message about a brand-new
artifact the member has never actually seen rendered. **Build:** `send_email`
and any e-sign-create call should require that the **specific artifact being
sent** was already shown to the member in this same conversation (a
rendered-document or drafted-email event ID the member's prior turn
acknowledged) — not just that the phrasing sounded like a go-ahead. Approval
attaches to the artifact that was read, never to the task category, and never
carries forward to a revised version (the exact wording of the human rule).

### Gate 6 — One send attempt; a failure may have gone out anyway

Incident: `feedback_never-retry-an-unverified-send.md`, 2026-09-11 — three
retries after `verify_failed` actually meant three real sends.

**Not applicable to today's `send_email`/`esign-create` paths the same way**
(email send success/failure via Resend's API is a reliable signal, unlike the
SMS bubble-detection heuristic that failed here) — but the principle must be
built into any future outbound channel (SMS to counterparties,
`dossie-agent-capability-spec.md` §11) before it ships: if a send's own
verification step is unreliable, the channel does not touch a real client at
all, full stop, rather than shipping with a known-bad verify-then-retry loop.

### Gate 7 — Never alter an executed instrument; corrections go by amendment

Derived from `TEXAS-FORM-EXECUTION-REFERENCE.md` §3 and the
`dossie-agent-capability-spec.md` §13 termination workflow. **Partially
enforced structurally** — `draft_amendment`'s tool description in `api/chat.js`
already states the right boundary ("a signed contract can never be edited... a
name correction is an amendment"), and `api/_lib/pdf-regenerator.js` existing
as a separate code path from the fill engine suggests this distinction is
architecturally real. **Not yet a hard gate:** nothing stops a direct
`update_deal_field`-style edit from silently changing a dossier's stored
contract data (price, closing date) after that transaction's contract document
is marked `executed`. **Build:** once a transaction's contract document is
`execution_status = 'executed'`, any attempt to change a field that document
actually controls (price, closing date, option period, parties) must route to
`draft_amendment` instead of a silent field write — the dossier's own stored
copy of those fields becomes read-only from that point, mirroring the real
legal fact that the paper itself can't be edited either.

### Gate 8 — A filename or a status code proves nothing; open the artifact

Incidents: `feedback_look-at-the-whole-artifact.md` (2026-09-27, reported "end
to end" from fields that were touched, not the whole PDF) and
`acroform-field-names-lie.md` (field names describing the wrong clause
entirely). **Enforced in the verification layer** (`signature-verifier.js`'s
visual pass, §1.3) **but not yet enforced as the only acceptable basis for a
"this works" report.** Build-process rule, not a runtime gate: any new feature
built against this spec gets verified the same way `CLAUDE.md`'s "verify in a
real browser before handoff" section already requires for UI/voice —
rendering the actual output and looking at every page it touches, never a 200
or a field-name match alone.

### Gate 9 — AcroForm field names lie; map by widget rectangle, never by name

Already fully enforced for the 25 built-out TREC/TAR forms (§1.4) —
`buildMappedFieldMap` resolves from the deterministic widget-rect extraction,
never from a field's `/T` name. **This gate extends automatically to Feature 1
of `DOSSIESIGN-FORM-LIBRARY-PLAN.md`** (custom member forms) because that
plan's `suggest_widgets` endpoint deliberately returns raw rectangles only —
no name, no type, no role — and requires the member to assign meaning by
looking at the rendered page, exactly this discipline, already designed in
before this spec was written.

### Gate 10 — An unverifiable value is null and flagged, never a plausible guess

This is the thread running through every gate above, stated as its own rule
because it's the one a model under instruction pressure is most likely to
violate quietly: when two sources disagree, when a document can't be
confirmed executed, when a party's identity can't be traced to the one
contract of record — the answer is never the closest-looking number. It's
`null`, flagged, with the disagreement stated plainly. `feedback_parties-come-
from-the-executed-contract.md`'s own framing — "a number that is merely close
is not a match" — is this gate in one sentence.

---

## 4. What stays the member's — where the agent must stop

Explicit, because the value of this product is as much in knowing where to
stop as in what it automates:

- **Every send to a real client or the other side's agent** — Gate 5. Dossie
  builds, renders, and presents; the member clicks send.
- **Every signature and initial** — the member's own, and (per Gate 2/3) the
  other side's, which Dossie never collects directly at all.
- **Consent and legal elections with real attestation weight** — a checkbox
  that constitutes a legal statement (lead-paint disclosure receipt, HOA
  membership election, financing-right waivers per
  `TEXAS-FORM-EXECUTION-REFERENCE.md` §5) is never defaulted either way; the
  member makes the election, Dossie records it (`acroform-field-names-lie`'s
  own closing line: "never default to checked").
- **Judgment calls with no deterministic right answer** — commission splits,
  protection-period terms, intermediary elections, anything
  `dossie-agent-capability-spec.md`'s field taxonomy calls "deal-specific" as
  opposed to "agent standing preference." Dossie asks; it does not infer from
  precedent on a new deal.
- **"Submit to MC" / any compliance-attesting click** — named explicitly in
  `dossie-compliance-upload-capability.md` as staying human even after the
  upload-matching automation (§1.7, not yet built) exists.
- **Credit applications, loan elections, anything financial beyond the deal's
  own already-computed numbers** — Dossie reads and reports; it never applies
  for, elects, or waives financing terms on anyone's behalf.
- **MLS and brokerage-portal logins, for v1** — per §2.2's recommendation,
  Dossie drafts/detects and the member executes the click, until there's a
  real case for the credential-automation investment.

---

## 5. Build sequence

Ordered by what ships soonest-useful, given what already exists.

1. **Gate 1 + Gate 2 (party/recipient classification).** Smallest real build,
   highest safety payoff — a single shared "who is this transaction's buyer,
   seller, and each one's agent, resolved only from the executed contract"
   function, consumed by `send_email`, `find_contact_email`, and
   `esign-create.js`'s recipient resolution. This closes the two incidents
   that actually reached (or nearly reached) a real third party. Ships before
   anything else in this spec because every later capability sends *something*
   to *someone*.
2. **`render_document_page` tool (§1.3).** Small wrapper around code that
   already exists (`pdf-to-images.js` + `signature-verifier.js`'s render path).
   Unlocks the member asking "show me page 3" / "is this actually signed"
   conversationally — directly the behavior Heath did by hand dozens of times
   this session.
3. **`DOSSIESIGN-FORM-LIBRARY-PLAN.md` Feature 1 (custom form mapping).**
   Already fully scoped, not re-derived here. This is the single highest-value
   chunk in that plan per its own §4 — it fixes "map it once, never again" for
   any brokerage form a member uploads, and Gate 9 is already designed into
   it.
4. **`DOSSIESIGN-FORM-LIBRARY-PLAN.md` Feature 2 (transaction-type bundles),
   steps 1-3 only** (the four bundle types needing no new form assets). Makes
   "pull the right forms for this deal type" conversational without the member
   naming each form.
5. **Gate 4 + Gate 7 (executed-document discipline).** Builds directly on the
   verification layer that already exists; no new infrastructure, just wiring
   the existing visual-pass result into a hard stop at the two places
   (compliance placeholder, post-execution field edit) where it's currently
   advisory-only.
6. **Compliance-portal upload, KW Command first (§1.7), on the option-3 model
   from §2.2** — Dossie matches documents to the checklist and tells the
   member exactly what's ready and what's missing; the member does the actual
   KW Command click until there's a case for more.
7. **MLS status drift detection (`dossie-agent-agent-capability-spec.md` §9)**
   — compare a dossier's own tracked dates against its stage, raise a Dossie
   Ask on divergence. No MLS credential needed at all; this is pure
   read-the-member's-own-data-and-compare, the cheapest item on this list
   relative to its real value (it caught a 4-day-stale MLS status once
   already, by accident).
8. **Net sheet / counteroffer comparison as a named conversational tool.** The
   logic already exists as a one-off process (`received-offer-net-sheet-
   process.md`); productizing it is mostly packaging a tool description
   around transaction fields Dossie already has.
9. **County/CAD and MLS-session automation (§1.6, §1.8)** — deliberately last.
   No existing infrastructure, no per-member credential story solved yet, and
   the jurisdiction-research pattern (`dossie-agent-capability-spec.md` §6) is
   valuable but was done by general web research, not a dedicated API — this
   needs its own scoping pass, not a slot in this sequence.

---

## 6. Honest gap list

What Dossie genuinely cannot do today, and what each would actually take:

- **MLS automation for any member besides Heath.** No public per-user API
  exists (SABOR/MLSGrid access is a vendor agreement, not an OAuth flow);
  real options are a per-member browser-profile investment (§2.2 option 1,
  real infra cost) or staying read-only/detection-only (the recommended v1
  path). Not a code gap — a genuine external-access gap.
- **Brokerage compliance portal upload for any brokerage besides KW City
  View, for anyone besides Heath.** The reference flow is documented
  (`dossie-compliance-upload-capability.md`) but zero of it is coded as a
  product surface; it is Heath's own single-tenant Playwright script today.
  Each additional brokerage (eBrokerHouse, SkySlope, Dotloop, Brokermint,
  Lone Wolf) needs its own checklist-mapping config layer — real, bounded
  work per brokerage, not a generic solve.
- **County/CAD and GIS jurisdiction research as a reusable tool.** Done by
  hand via web search; would need per-county API/scrape targets (BCAD, other
  Texas CADs each have different site structures) — real, unglamorous
  per-county work, not conceptually hard.
- **SMS to counterparties.** Explicitly scoped as "legitimate, not yet built"
  in `dossie-agent-capability-spec.md` §11 — needs Twilio send authorization
  and Gate 6's one-attempt discipline built in from day one, not retrofitted.
  AI-placed phone calls are explicitly flagged as needing Hadley's legal
  review (TCPA, consent-to-record) before any engineering starts — not an
  engineering decision this spec can make.
- **A general "show me page N" chat tool.** The rendering capability exists;
  the chat-tool wrapper does not (§1.3, item 2 in the build sequence).
- **Team-lead/broker-oversight aggregation queries.** `dossie-agent-capability-
  spec.md` §12 scopes this in detail; the per-agent data (`GET
  /api/team/org-dossier-detail`) exists but the team-wide rollup layer and the
  chat-context awareness of "I'm talking to a team lead" do not.
- **A continuously-built transaction timeline from texts and calls.**
  `dossie-agent-capability-spec.md` §15 — email-based timeline-building is a
  generalization of infrastructure that already exists (the inbound watchers);
  texts and calls have no automated capture path at all today (no SMS/call
  integration for a member's personal phone), so that half stays a manual log
  a member types into the same timeline, not an automated one, until/unless a
  phone-level integration is scoped separately.
- **Single shared DocuSeal account at real scale.** Works today; becomes a
  real risk once member count rises enough that one account suspension or
  deliverability flag has cross-member blast radius. Self-hosted DocuSeal is
  the known fix, not yet scheduled.
