# Dossie Capability Extraction — 2026-09-10

**Method:** [[teaching-pipeline-cole-to-dossie]] — real deal → Cole's mistake → memory rule →
enforced gate in the product. A rule Cole must *follow* is a gate Dossie *enforces*.

**Source day:** 2026-09-10. Three active listings, one closing, one contract executed, an
earnest-money dispute, a security-deposit claim, a seller-financing LOI, a five-channel marketing
launch, and four separate systems failing instructively. Every requirement below traces to a
concrete incident with a dollar or deadline consequence attached.

**Verification standard:** code claims in this document were checked by reading the files, not
inferred. Where something was not verified, it says so.

---

## The five highest-leverage items

Ranked by (harm prevented × frequency) ÷ build cost.

### 1. The election validator already exists, is mis-grouped, enforces the wrong cardinality, and isn't in the send path

**This is the single most valuable finding in the document.** Four independent defects stack on
the same code, and all four are cheap to fix.

The Pfeiffers Gate contract executed 2026-09-09 with **¶7D blank — neither As-Is box checked**.
That paragraph decides whether the sellers owe repairs. It reached four signatures and a title
company that way.

Dossie has a validator for exactly this. `api/_lib/trec-validator.js` documents "Mutex groups: at
most one checkbox true," and `api/_lib/trec-20-18-field-rules.json` defines
`MUTEX(accept_as_is)` and `MUTEX(accept_as_is_with_repairs)` — that *is* ¶7D. It did not fire,
for four reasons:

| # | Defect | Evidence |
|---|---|---|
| 1 | **The pair is split across two mutex groups.** `MUTEX(accept_as_is)` and `MUTEX(accept_as_is_with_repairs)` are different keys, so each group has exactly one member and they are never compared to each other. Contrast the correct form: `MUTEX(rep_buyer_only,rep_intermediary,rep_seller_only)` lists all members under one key. | `trec-20-18-field-rules.json` |
| 2 | **Cardinality is "at most one," not "exactly one."** Enforcement is `if (trues.length > 1)`. Zero checked passes silently. TREC's own instruction is "Check one box only." | `trec-validator.js:180-190` |
| 3 | **The validator is wired into the fill path, not the send path.** `trec-validator.js` is required by `api/fill-form.js`. `api/esign-create.js` runs its own separate 422 gates (field count, signer assignment) and never calls it. A document can be filled elsewhere and sent without ever passing this check. | `grep -rln "trec-validator" api/` |
| 4 | **Rules exist only for TREC 20-18.** There is no `trec-20-19-field-rules.json`. Pfeiffers executed on **20-19**; Wild Cherry was **20-17**. The rules file covers a form version neither live deal used. | `ls api/_lib/ \| grep 20-19` |

Defect 1 is not limited to ¶7D. **Eight paired elections are split the same way** and are
therefore entirely unenforced:

`accept_as_is` / `accept_as_is_with_repairs` · `hoa_is_subject` / `hoa_is_not_subject` ·
`option_fee_credited_box` / `option_fee_not_credited_box` · `listing_fee_dollar_box` /
`listing_fee_percent_box` · `repairs_none_box` / `repairs_specified_box` ·
`survey_area_amended` / `survey_area_not_amended` · `title_expense_buyer` /
`title_expense_seller`

Every one of those decides money or obligation.

- **Workflow attachment:** the existing 422 gate in `esign-create.js`, immediately alongside
  `assertPlausibleMappedFieldCount`. Members already see 422s there with plain-language reasons;
  this adds a reason, not a new interruption.
- **Type: GATE.** This is the narrow case blocking is for — an unexecutable or ambiguous legal
  instrument reaching real signatures is irreversible.
- **Build cost: small, and mostly data.** Merge paired keys in the rules JSON; add a
  `required: true` flag and an `exactly-one` branch in the mutex loop (~15 lines); call the
  validator from `esign-create.js`; author `trec-20-19-field-rules.json`. The last item is the
  real work and it is transcription, not engineering.
- **Layer:** the mutex/cardinality engine is **vertical-agnostic core**. The rules JSON is
  **Texas/TREC config**. This is the architecture working exactly as CLAUDE.md §1 intends.

### 2. Signer-slot validation before release

The Nopalito TXR-1404 price amendment went out 2026-09-10 at 21:02 UTC to Barry and Jennifer
Whyte — **without Heath slotted as a signer at all**. He is the listing broker's associate and a
party to the listing agreement being amended. Nobody noticed until he opened zipForm himself.

`esign-create.js` already validates that signers who *are* on a packet get correctly assigned
fields. Nothing validates that everyone who *should* be on it is.

- **Workflow attachment:** same 422 gate cluster, evaluated before the DocuSeal call.
- **Type: GATE** for a missing required party; **PROMPT** for an unexpected extra.
- **Build cost: small-to-medium.** Requires a per-form `requiredSignerRoles` map (listing
  amendment → all sellers + listing agent; resale contract → all buyers + all sellers).
  Mechanically trivial; the roster data is the work.
- **Layer:** role-cardinality engine is **core**; the per-form role map is **config**.

### 3. Poll the system of record, never a notification

Cole reported the Nopalito amendment unsigned because no Authentisign email had arrived. Heath
opened zipForm and found it complete. Cole had working zipForm access at that moment and checked
email instead.

Compounding it: KW's Google Workspace began rejecting inbound mail with
`550 5.7.1 Message rejected due to administrative security policy` at some point between
2026-09-09 22:39 (last Authentisign notification successfully delivered) and 2026-09-10. Client
email and e-sign notifications both stopped. **The sender gets the bounce; the recipient gets
nothing.**

The lesson generalizes past e-sign: **any status derived from an email notification is a status
you do not actually have.**

- **Workflow attachment:** `api/cron-esign-events.js` (749 lines, already scheduled in
  `vercel.json`) already watches the inbox. Add authoritative polling of the provider API as the
  primary source and demote email to a latency optimization.
- **Type: BACKGROUND JOB**, plus a **PROMPT** when a member's notification channel appears dead
  (no provider events received for N days while envelopes are outstanding).
- **Build cost: medium.** DocuSeal polling is straightforward. The genuinely valuable addition is
  **notification-channel health detection** — noticing the member has gone deaf. Nothing like it
  exists.
- **Layer:** **core**. Every vertical has a counterparty system of record and a notification
  channel that can silently fail.

### 4. Deadline chains generated at execution

Heath's Pfeiffers deadline chain was built by hand on 2026-09-10 — earnest money and option fee
(rolled from Saturday 9/12 to Monday 9/14 under the contract's own extension clause), option
expiry 9/18, financing/appraisal/HOA 9/30, closing 10/16 — and placed on his calendar manually.

The 24-hour MLS status rule is the same shape: LERA MLS Rules §4.1 and §1.5 require status
changes reported **within 24 hours of the change occurring**, measured from the effective date.
Cole had to look that rule up mid-deal. DOM does not reset on withdrawal/relist (§1.5), which is
the fact that actually decides whether delaying is worth anything — it isn't.

`api/cron-deadline-reminders.js` exists and is scheduled, reading `contract_effective_date`,
`option_expiration_date`, and `closing_date`. What's missing is **generation** — deriving the
full chain from the effective date at execution, including weekend/holiday rolls.

- **Workflow attachment:** fires on the transaction's transition to executed; writes to the
  existing deadline fields the reminder cron already reads.
- **Type: BACKGROUND JOB** with a **PROMPT** to confirm the derived dates once.
- **Build cost: small.** The date math is contract-clause arithmetic. Existing consumer already
  built.
- **Layer:** the chain engine is **core**; clause definitions and the Legal Holiday roll rule are
  **Texas/TREC config**. MLS reporting windows are **per-MLS config** (LERA ≠ every MLS).

### 5. Present-value analysis of creative-finance offers

Michael Blair's LOI on 130 Senisa: **$400,000 nominal** — $12,000 down, $900/month, 7-year
balloon. Discounted at 7%, its present value is **$309,669**. It is a $310k offer wearing a $400k
hat, and the letter stated **no interest rate and no balloon amount**, so the year-7 figure was
uncomputable as written.

The structural defect mattered more than the discount: **$12,000 down does not cover the
~$261,545 owed to Sonora Bank, and the LOI never said who keeps paying it.** Blair's own
track-record attachment is heavy on subject-to deals — which is precisely where due-on-sale
lives.

- **Workflow attachment:** the offer-analysis path that already produces net sheets
  (`api/_lib/net-sheet-calc.js`, 82 lines, proven — nine price/commission cases reconciled to
  $0.00 today).
- **Type: PROMPT.** Never a gate — a member may rationally accept a below-PV structure.
- **Build cost: small.** PV math is a few lines. The valuable part is the **structural checklist**:
  is there an underlying lien, who services it, is a rate stated, is the balloon defined.
- **Layer:** **core.** Seller financing is not Texas-specific; due-on-sale is federal
  (Garn-St Germain).

---

## What is blocked on DossieSign

Per `docs/DOSSIESIGN-GAP-ANALYSIS-2026-09-01.md`: 32 `signature_requests`, **all `sent`, zero
completed**. The full-featured editor's Send button 400s (`esign-create.js` requires `documentId`,
`SendPacketButton.jsx` posts `transactionId`), and ~170 of ~200 typed fields never reach an
outgoing document.

**Blocked until send works end to end:**

- Signer-slot validation (#2) — validates a send path that cannot complete
- Pre-send election validation (#1) — *partially*. The validator can be fixed and wired now and
  will protect the fill path immediately; its value at send is gated
- Void / resend / correct-and-reissue — no product path exists (the 2026-08-30 archived-link
  incident was handled by hand in DocuSeal)
- Envelope status dashboard — the doc badge is set client-side once and never refreshed
- Reminders on outstanding envelopes — the existing crons are *transaction deadline* reminders,
  not envelope nudges

**NOT blocked — buildable today:**

- Deadline chain generation (#4) — pure date math over existing fields
- PV and structural analysis of offers (#5) — analysis, no signing
- Compliance checklist gap surfacing — read-only
- Security deposit disposition — landlord workflow, no e-sign dependency
- Notification-channel health detection (#3) — independent of whether sending works
- Election validator fixes on the **fill** path — independent of send

**Honest sequencing note:** the fix for the 400 is small (accept `transactionId`, coerce `fields`
to an array). What it unblocks is large. It should precede every requirement in the blocked list.

---

## What is already built and simply unrouted

This section is the cheapest value in the document. Several 2026-09-10 capabilities map to code
that already exists.

| Capability | Status | Gap |
|---|---|---|
| **MLS status staleness detection** | **Built and scheduled.** `api/cron-mls-status-staleness.js` is in `vercel.json`. Its header documents a verified-against-real-data design decision (stage comparison doesn't work; it's a pure date check) | Fires only on option-period-expired. Today's need — a 24-hour clock from contract execution — is the natural second trigger |
| **Post-completion signature verification** | **Built.** `api/_lib/signature-verifier.js` (447 lines), AcroForm probe + visual pass, "VISUAL WINS on is-it-blank". Has already caught a provider-reported completion that was actually partial | **Pre-send** verification is the missing half — read back what was written before it goes out |
| **Net sheet calculation** | **Built and proven.** `api/_lib/net-sheet-calc.js` | Not reachable from a member-facing surface for sell-vs-hold or PV-of-offer analysis |
| **Mutex/election validation** | **Built.** `trec-validator.js` | Mis-grouped, wrong cardinality, wired to fill not send, rules only for 20-18. See #1 |
| **Inbound e-sign watcher** | **Built and scheduled.** `api/cron-esign-events.js` (749 lines) | Trusts email; needs provider polling as primary |
| **Deadline reminders** | **Built and scheduled.** `api/cron-deadline-reminders.js` | Reminds on dates; nothing *generates* the chain |
| **Compliance vault add-on** | **Built** (`compliance-vault-addon-status.js`, checkout, cancel) | Not connected to a brokerage-checklist gap report |

---

## Requirements by member workflow stage

### Stage 1 — Listing

**1.1 Listing agreement existence check — GATE**
702 Fawndale went live in the MLS at $330,000 (MLS 2015607) with **no listing agreement in
existence**. 130 Senisa has been actively listed since 2026-07-05 at $389,000 and its executed
TXR-1101 could not be located anywhere — not zipForm, not OneDrive, not Gmail. Two of four live
files, unsupported.
*Attachment:* the moment a member marks a property listed. *Cost:* small — a required-document
precondition. *Layer:* core (every listing needs an agreement); form identity is config.

**1.2 Agent-owned disclosure propagation — GATE**
Heath owns both Fawndale and Senisa. TRELA requires written disclosure of license status.
Today it had to be manually threaded into MLS remarks, every social post, and the listing
agreement's Special Provisions — and a compliance gate had to be written by hand to enforce it.
*Attachment:* a single `is_agent_owned` flag on the transaction that propagates to every
downstream artifact. *Cost:* small. *Layer:* the propagation mechanism is core; the disclosure
text is TREC config.

**1.3 Comps graded by condition from photos — GATE on the CMA**
The first 702 Fawndale CMA returned **$275,000 as-is / $318,000 after a $5,500 make-ready**, from
eight comps matched on beds/baths/sqft/DOM. No photo was ever opened. Heath caught it.
Photo-verified rerun: **$310–325k as-is, $330,000 list** — a **$55,000 error**, and the make-ready
ROI claim collapsed from 7–8× to 2–3× because the house had never left the renovated bucket.
Condition-bucketed price/sqft: original **$106.90**, partially updated **~$144**, renovated
**$196.17**.
Already written as [[feedback_cma-comps-must-be-photo-verified]].
*Attachment:* CMA generation. *Type:* **GATE** — refuse to emit a CMA with ungraded comps.
*Cost:* medium (needs photo retrieval + a grading pass). *Layer:* core.

**1.4 Virtual-staging disclosure — GATE**
Two Fawndale photos were virtually staged. Cole initially excluded them as a compliance risk;
**Heath corrected that — disclosure is the requirement, not exclusion**, and the photos went back
in labeled. A real correction worth encoding: the rule is *label it*, not *drop it*.
*Attachment:* any image entering a listing or marketing artifact. *Cost:* small — a per-image
flag that forces a caption. *Layer:* core.

**1.5 Recurring listing marketing with rotation and caps — BACKGROUND JOB**
Heath: *"the marketing of our listings isn't just a one and done."* Built today
(`listing_marketing_status`, `listing_marketing_rotation`, compliance gate, Telegram approval).
The non-obvious constraint: **daily posting of the same listing to the same venue gets the account
throttled** — his profile was shadowbanned in June. The design answer is rotation across listing ×
angle × venue, hard caps in code, and **auto-pause driven by live MLS status, not the queue**.
*Cost:* built. *Layer:* core rotation engine; venue rules are per-market config.

**1.6 Tenant-privacy screening on listing photos — PROMPT**
Senisa's photographer set: every interior living shot contained tenants' belongings — a TV
mid-broadcast, family photos, laundry. An agent excluded them unprompted. Also caught: two files
in the same folder were **preliminary architect's renderings** stamped "NOT FOR CONSTRUCTION" for
a possible future addition, showing a floor plan that does not exist.
*Attachment:* photo selection. *Cost:* medium (vision pass). *Layer:* core.

### Stage 2 — Offer / Under Contract

**2.1 Election validator** — see #1. **GATE.**

**2.2 Signer-slot validation** — see #2. **GATE.**

**2.3 Deadline chain generation** — see #4. **BACKGROUND JOB.**

**2.4 Document-identity verification on every inbound version — BACKGROUND JOB**
Andy Ramirez emailed University Title "**29046 Pfeiffers Gate- New Contract**" describing it as
*"conventional loan and for me to live in"* — language suggesting different terms from what the
sellers executed. Title replied "You got it!!" and proceeded. An MD5 comparison against the
OneDrive executed copies proved **byte-for-byte identical**; his wording was loose.
Same day, three versions of the same offer arrived within 24 hours (9:19am, 10:23am, plus the
prior evening), **two with identical filenames** — the second silently overwrote the first on
download.
*Attachment:* inbound document ingestion. *Cost:* small — hash on receipt, compare to the
executed baseline, flag divergence. *Layer:* core.

**2.5 Term-diff on every revision — PROMPT**
Between offer versions Andy changed the BAC to 2.25% and dropped the appraisal floor to $645,000
— both disclosed. He also silently added **¶11 "Patio furniture and all appliances will be
included and stay in the house"** and changed the origination cap 2% → 1%. Heath believed only the
BAC had moved. The gate caught it and the packet was correctly held.
*Attachment:* any new version of a document already under negotiation. *Cost:* medium (structured
field extraction + diff). *Layer:* core engine, TREC field map config.

**2.6 Present-value + structural analysis** — see #5. **PROMPT.**

**2.7 Underlying-lien check before seller financing — GATE on the recommendation**
*Attachment:* whenever a proposed structure involves seller carry or subject-to. *Cost:* small
once payoff data exists. *Layer:* core.

**2.8 Leverage-reframing on credit requests — PROMPT**
The 507 Ridge Bluff seller flatly refused a $15,000 credit. Reframed: **$15,000 ≈ $100/month** at
the contract's 7% ceiling, against a $140 option fee to walk and ~$6,375 earnest money not at
risk. The claimed alternative — 3622 Hunters Dream at $605,000 — was **never offered to anyone**
and is not cheaper: **$218.38/sqft vs $218.92/sqft**, functionally identical, full ask, 7 DOM,
estate sale.
The better ask was specificity, not amount: the **deck and balcony rot** (no footings, missing
joist hangers) is a defect with structural teeth, and cheaper for a seller than cash.
*Attachment:* offer-negotiation analysis. *Cost:* small. *Layer:* core.

**2.9 Comparative-alternative verification — GATE on any claim about a competing property**
Do not let an un-offered price appear in writing to a cooperating agent. *Cost:* small.
*Layer:* core.

### Stage 3 — Closing

**3.1 Compliance checklist surfaced at listing, not at closing — PROMPT, escalating**
The Wild Cherry crunch in full: the compliance folder was **returned** 2026-09-09 at 1:44pm over a
page-11 broker license number. Then the Closed checklist showed three required slots empty —
Disbursement Authorization, MLS Agent Report showing Sold, Commission Breakdown. The DA had never
been issued, and the likely reason surfaced only on inspection: **Offers & Commissions showed
"Contract Price $0.00" and "there are no offers for this deal."** The commission request was never
entered, so no DA could generate.
Meanwhile Pfeiffers had 2 of 27 slots filled while under contract, Nopalito 4 of 27, Senisa 0.
*Attachment:* a per-transaction checklist view populated at listing and aged forward. *Cost:*
medium. *Layer:* core checklist engine; per-brokerage slot maps are config (KW Command first, per
[[dossie-compliance-upload-capability]]).

**3.2 Only executed documents into compliance slots — GATE**
Already [[feedback_only-upload-executed-documents]]. Reconfirmed today: nine documents uploaded
across two files, **each verified executed by re-rendering after reload** — not by trusting a
status label.
*Cost:* the verifier exists (`signature-verifier.js`). Routing is the gap.

**3.3 MLS status reporting inside the required window — PROMPT with a hard deadline**
Pfeiffers went Active Option within the 24-hour window. Heath's instinct was to wait for the
receipted contract — which would have blown it, because **the clock runs from the effective date,
not from title's receipt**. And DOM does not reset (§1.5), so waiting buys nothing.
*Attachment:* extend `cron-mls-status-staleness.js` with an execution-triggered 24-hour countdown.
*Cost:* small — the cron exists. *Layer:* core; MLS windows are per-MLS config.

### Stage 4 — Post-Closing

**4.1 Post-closing document chase — BACKGROUND JOB**
Wild Cherry closed 2026-09-09. The final settlement statement and receipted contract had to be
requested by email the next day. The DA still had not issued.
*Attachment:* on closing, open a tracked expectation list with owners (title / brokerage /
cooperating agent). *Cost:* small. *Layer:* core.

**4.2 Earnest-money release preparation — PROMPT**
2822 Low Oak settled at **$2,500 to the seller, $2,700 back to the buyers** of $5,200 held at
Stewart Title, plus the inspection report — negotiated down from a $4,200 counter. The **$250
option fee was never addressed** in the final acceptance, which is exactly how a release reopens.
*Attachment:* termination/release flow ([[dossie-agent-capability-spec]] workflow #13).
*Cost:* small. *Layer:* core logic; the Release of Earnest Money is a **zipForm-library form, not
TREC-promulgated** — it needs its own Dossie template. That distinction is already flagged in the
capability spec and was reconfirmed today.

### Stage 5 — Landlord / Portfolio

**Dossie has no landlord concept today.** A grep for `security_deposit`, `deposit_disposition`,
or `landlord` returns nothing. Heath ran three landlord workflows today, all manually. This is a
genuine product surface, not an edge case — and it is the natural bridge between "agent" and
"investor-agent," which is what a large share of Texas REALTORS actually are.

**5.1 Security deposit disposition — GATE on the statutory deadline**
702 Fawndale: lease ended 2026-09-04, forwarding address **6211 Meadow Grove, Windcrest** received
2026-09-10. Texas Property Code **§92.104** requires an itemized deduction list within **30 days**
— roughly **2026-10-10**. §92.109 exposure for bad-faith retention is **3× the deposit + $100 +
attorney's fees**.
The substance is as important as the date. Chargeable: tenant damage and failure to clean.
Not chargeable: normal wear and tear. Today Cole initially advised dropping the cracked dirt,
broken curb, and pavers as indefensible — **Heath corrected it**: the tenants drove a vehicle over
the curb and across the lawn (vehicle damage), and installed the gravel and pavers **without
authorization**. Bobbye Joe then produced the clause that decides it:

> **§2.5.7 No Alterations** — "...adding, changing, or removing appliances, fixtures, shelving,
> wallpaper, or wall paint... **If Tenant violates this provision, Tenant will return the Property
> to its original condition at Tenant's sole cost and expense.**"

Also established: **the deposit is not a cap** — deduct from it and pursue the excess. And a repair
need not be performed to be charged, but the amount must reflect real damages, which is why a
documented bid matters when the owner elects not to restore (Heath's decision on the gravel).
*Attachment:* a lease/tenancy object with a move-out event. *Type:* **GATE** on the 30-day
deadline; **PROMPT** on wear-and-tear classification. *Cost:* medium — new object, new workflow.
*Layer:* the deadline engine is core; §92.104/§92.109 and the clause library are **Texas config**.

**5.2 Move-in condition baseline — the evidence that makes 5.1 enforceable**
Heath's claim rests on having patched and painted every wall before move-in. The proof is the
**Inventory and Condition Form** plus dated photos. He photographed the damage himself at Cole's
prompting.
*Attachment:* tenancy start — capture baseline; tenancy end — capture comparison.
*Cost:* small. *Layer:* core.

**5.3 Sell-vs-hold modeling — PROMPT**
Fawndale, fully worked today: basis **$116,233.90**, loan ~$275,500, market $330,000. Net at 2.5%
self-represented commission **$32,181**; **true monthly cash flow −$555 to −$1,044**; breakeven to
whole ~**$417,000**, roughly **8 years** at 3% appreciation — against **BCAD assessed value that
has fallen three consecutive years**. Recommendation: sell, by a ~$15,128 margin.
The structural insight a member would miss: **the loan has no escrow account**, so taxes and
insurance hit as separate out-of-pocket bills. That is why it *felt* worse than the spreadsheet.
*Attachment:* a portfolio view per owned property. *Cost:* medium; `net-sheet-calc.js` exists.
*Layer:* core.

**5.4 Basis reconstruction — BACKGROUND JOB**
Fawndale's basis took three passes and two wrong answers before landing. First pass concluded
renovation was financed inside the seller's hard-money loan; second concluded Heath had bought a
50% interest for $10. **Both wrong.** The truth, from source documents Heath produced: he **lent**
ReNenz CMB LLC $82,000 (2023-10-16) plus $20,000 by amendment (2023-11-09) = **$102,000**, no
interest, 50/50 net profit split — then his LLC bought the property outright for **$370,000** on
2024-11-19. All-in **$116,233.90**.
**The lesson is the failure mode, not the number:** reconstructing basis from email produced two
confident wrong answers. The source documents settled it in one pass.
*Attachment:* property acquisition record. *Cost:* medium. *Layer:* core.

**5.5 Unreleased partnership interests — PROMPT**
That same agreement grants ReNenz CMB LLC **50% of net profits after repayment** and contains **no
termination or release clause** — on its face it runs until the property sells. Nena relinquished
by text in July 2024 (*"Whatever we make off the sale, you get all of it, i'll take my loss"*),
but **Rene Gonzalez, the other signer, never released anything**, and a full sweep of 9,390
messages across both numbers found no signed release.
Moot at today's value — nothing to split $40k below the purchase price — and live if he holds.
*Attachment:* surface at listing time, when it becomes relevant. *Cost:* small. *Layer:* core.

---

## Cross-cutting: operational rules that are also product requirements

**C.1 One automation per member session — GATE**
Two agents were dispatched onto one exclusive Chrome profile; the second waited silently forever.
Later, two scripts collided and killed an authenticated session Heath had signed into by hand.
**He typed his zipForm password three times today.** Already written as
[[feedback_self-detect-stalls-dont-wait-for-heath]].
*Product form:* Dossie must never let two automations contend for one member credential, and must
surface a stalled job rather than waiting to be asked. *Cost:* small — a lease/lock per credential.
*Layer:* core.

**C.2 Session-persistence reality — an architecture constraint worth recording**
Attempting to persist the zipForm session via Playwright `storageState` **failed and caused
collateral damage**: the snapshot captured 0 storage origins (zipForm keeps client state in
localStorage/sessionStorage) and only session-lifetime cookies, and loading that whole-session
snapshot on every launch **overwrote live connectMLS cookies with stale ones**, breaking a working
integration. Reverted after verification.
What did work: **direct credential entry**, which bypasses Chrome's password manager and therefore
never triggers the Windows Hello modal. Proven on two cold starts.
*This is the strongest possible evidence for the existing architecture note:* do not build Dossie
as browser automation against members' zipForm accounts. Route through DocuSeal with Dossie's own
templates. Today cost hours re-learning that.

**C.3 Notification-channel health — PROMPT**
See #3. Two independent channels (client email, Authentisign) failed silently in the same window
via a policy change on the member's own mail provider. **Only the sender learns.** Dossie is
uniquely positioned to notice.

**C.4 Never fabricate a competing offer or urgency — GATE on outbound copy**
Enforced in the marketing compliance gate built today; equally applicable to negotiation
correspondence.

---

## Architecture summary

| Concern | Layer |
|---|---|
| Mutex/cardinality engine, signer-role cardinality, deadline-chain engine, PV math, hash/diff, checklist engine, notification-health, credential leasing, rotation engine | **Vertical-agnostic core** |
| TREC form field rules + form versions (20-17 / 20-18 / 20-19), required-signer role maps per form, Legal Holiday roll rule, §92.104/§92.109, lease clause library, TRELA disclosure text | **Texas config** |
| Per-MLS reporting windows and status codes (LERA §4.1/§1.5), per-brokerage compliance slot maps (KW Command first), per-venue social posting rules | **Per-market / per-brokerage config** |

The 20-18-vs-20-19 rules gap is the clearest proof the config layer is real and currently
under-populated. Form-version coverage is transcription work with outsized return: solve a form
once, every Texas member benefits permanently.

---

## Recommended sequence

1. **Fix the election validator** (#1) — four small defects, eight unenforced elections, mostly data
2. **Fix the `esign-create` 400** — small, and it unblocks the entire blocked list
3. **Deadline chain generation** (#4) — consumer already built and scheduled
4. **Provider polling + notification-channel health** (#3) — extends a running cron
5. **Signer-slot validation** (#2) — meaningful once send works
6. **Compliance checklist at listing** (3.1) — the Wild Cherry crunch, structurally
7. **Landlord workflow** (5.x) — a new surface; sequence deliberately, not opportunistically

---

*Extraction performed 2026-09-10. Code claims verified by reading source. Incidents are drawn from
the live session and are dated. Where a claim was not independently verified, the text says so.*
