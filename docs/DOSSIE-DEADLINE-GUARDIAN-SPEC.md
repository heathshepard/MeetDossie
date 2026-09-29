# Dossie Deadline Guardian — Spec + Story

Status: SPEC. No code shipped for this doc. Written per the teaching-pipeline method
([[teaching-pipeline-cole-to-dossie]]) — a real deal, a real mistake, a memory rule, and
now the product gate that rule should become.

Source rule: `friday-execution-option-fee-trap` memory, 2026-09-02.

---

## Part 1 — What happened (anonymized)

This is a real transaction. No names, no brokerage, no address appear below or should be
added later — this section must stay safe to read aloud or hand to a prospect. The dispute
is active; treat every fact here as a fact about the *pattern*, not evidence in the case.

A resale contract was executed on a Friday at 1:23 PM. Under the TREC form, the buyers had
three calendar days to get the option fee and earnest money to the title company.

None of what follows was one bad actor making one bad decision. It was eight small,
individually forgivable things, each done by a busy person on a Friday afternoon, that
compounded into a $5,200 loss:

1. **The contract reached title six hours and forty-five minutes late.** Executed at 1:23
   PM, it wasn't sent to the title company until 8:08 PM — after their office had already
   closed for the weekend. Nobody was trying to slow anything down; it just wasn't the
   first thing on anyone's list that afternoon.
2. **The weekend ate the runway, and nothing extended it.** Days 1 and 2 of the 3-day
   window were Saturday and Sunday — title was closed both days. The deadline itself landed
   on Monday, a normal business day, so none of the weekend-rollover language in the
   contract applied. The buyers, in practice, had one business morning.
3. **Nobody obtained an amendment extending delivery past the weekend.** That's ordinary,
   available, cheap paperwork — a short amendment moving the delivery deadline to Tuesday
   or Wednesday. It's buyer-side work, and on this file it never got done.
4. **The Notices paragraph's "To Buyer(s) at:" block was blank.** No address, phone, or
   email for the buyers anywhere on the executed contract. Title had no way to reach them
   directly and had to ask a third party for their contact information three days *after*
   execution — by which point more than half the delivery window was already gone.
5. **Wire instructions went out on the deadline day itself.** Not two days early, not with
   any cushion — the same day the funds were due.
6. **The buyers were told "within three days," not a specific date and time.** The
   available record shows exactly one passive mention of the deadline, and it landed on the
   due date, not before it. A vague window is not the same as being told "your money must
   be at title by 5:00 PM Monday."
7. **Funds arrived on day five, two days after the deadline.** Under the contract's
   ¶5.D language, missing that window doesn't just make the payment late — it forfeits the
   buyers' unrestricted right to terminate.
8. **The seller demanded the full $5,200 earnest money.** The brokerage's own internal
   review of the file agreed the buyers were unlikely to recover it in full, and named the
   one thing that would have prevented all of it: an amendment extending the delivery
   deadline into the following week.

Every one of these eight steps is completely ordinary. A contract that goes out at the end
of a Friday instead of the top of the afternoon. A notices block nobody thinks to fill in
because the agent fields above it are filled. A deadline relayed in a group text as "get it
in by early next week" instead of a timestamp. None of it is negligence in the way that
word usually gets used. **That is exactly the argument for building this into software
instead of leaving it to memory** — the failure doesn't come from any one person being
careless once. It comes from the fact that a five-step chain, each step individually
reasonable, only has to break once to cost real money, and nothing in a normal Friday
workflow stops that chain from forming.

Separately worth stating precisely, because it matters for how a member should be advised
if this ever happens to them: losing the ¶5 right to terminate is *not* the same thing as
forfeiting the earnest money outright. The seller still has to establish default and pursue
remedies under a separate paragraph. That distinction is where any actual negotiating room
lives in a dispute like this — Dossie should know it too, not just the deadline math.

---

## Part 2 — The gates

Format: **trigger → what Dossie does → what it prevents.** Each gate is labeled **HARD
BLOCK** (refuses to proceed) or **RECOMMENDATION** (surfaces + drafts, member approves).
Over-blocking a working agent is how a product gets routed around, so the labels below are
deliberately conservative — only the two gates with an unambiguous "this is objectively
wrong, there is no legitimate reason to send it" case are hard blocks.

### 1. Business-calendar deadline computation — RECOMMENDATION (foundational; not itself a block)

**Trigger:** `contract_effective_date` is set or changed on a transaction.
**What Dossie does:** Computes every date-driven deadline on the file — option fee,
earnest money, option expiry, financing approval, appraisal termination, survey, closing —
against a real business calendar, not naive calendar-day addition. That calendar must
include Saturdays, Sundays, and Texas Legal Holidays as defined by Gov't Code §662.003(a)
(confirmed via `answers/is-earnest-money-due-on-weekends-texas` — this list is *not*
identical to federal holidays; it adds Juneteenth and the Friday after Thanksgiving and
excludes Texas-only observances like Confederate Heroes Day).
Critically: the weekend/Legal-Holiday rollover in ¶5A(2) applies **only** to earnest money,
option fee, and additional earnest money deadlines. It does **not** apply to option
expiration, title review, survey, financing, appraisal, or closing dates — those are fixed
calendar dates even when they land on a weekend. Getting this distinction backwards is its
own failure mode (granting an extension that doesn't exist, or missing one that did) and
the computation must encode it explicitly per deadline type, not as one blanket rule.
**What it prevents:** every downstream gate below depends on this being right. Get this
wrong and gates 2 and 3 recommend or state the wrong date with full confidence — worse than
not having them.

### 2. Compressed-window recommendation — RECOMMENDATION

**Trigger:** Gate 1's computation shows fewer than two business days between the effective
date and the option-fee/earnest-money delivery deadline (this is exactly the Wed–Fri
execution pattern the source memory names, worst case Friday).
**What Dossie does:** Proactively surfaces a named next action on the file — not a passive
badge — with the reasoning stated in plain language: *"This executes Friday. Your buyer has
one business morning to get funds to title. Extend delivery to Wednesday?"* It then
**drafts the extension amendment itself**, pre-filled with a proposed new date, ready for
the member to review and approve. The member's job is to say yes, not to write it.
**What it prevents:** exactly failure #3 above. This was "buyer-side work" that fell
through a normal Friday because nobody stopped to do it — the fix is that Dossie stops and
does the first draft.
Why RECOMMENDATION not HARD BLOCK: an agent may have a legitimate reason to proceed without
the amendment (buyer already confirmed same-day wire capability, cash deal with no lender
involved, etc.) — the product shouldn't assume it knows better than the person on the file
in every case. It should make the safe path the fast, obvious, one-click path instead.

### 3. Deadline stated as a date and time — HARD BLOCK on the vague form; RECOMMENDATION doesn't apply here, this is a rendering rule

**Trigger:** any client-facing surface (email, in-app card, reminder text, dossier
timeline) renders a delivery deadline.
**What Dossie does:** always renders a specific calendar date, day of week, and time —
"Monday, August 24 by 5:00 PM," never "within three days" or "by early next week." This is
a template-level constraint, not a judgment call, so it's effectively a hard block on the
vague phrasing existing anywhere in the codebase's client-facing copy.
**What it prevents:** failure #6 — the single passive mention on the due date that the
brokerage's own review treated as inadequate notice.

### 4. ¶21 party-block gate — HARD BLOCK

**Trigger:** an e-sign packet is about to be sent for buyer or seller signature.
**What Dossie does:** refuses with a 422 if the buyer or seller "To Buyer(s) at:" / "To
Seller(s) at:" Notices blocks are blank — no address, phone, or email captured for the
party the notice is supposed to reach. Same pattern already proven in
`api/esign-create.js`'s `assertPlausibleResaleFieldCount()`, which throws a 422 today when
a signature/initial widget count is implausible for a document's page count — same
"refuse, don't warn" shape, applied to a different field.
**What it prevents:** failure #4, which was the load-bearing failure of the whole chain —
title literally had no channel to reach the buyers directly and lost three of five days
finding out who they were.
Why HARD BLOCK: there is no legitimate reason to send a contract for signature with the
party the title company needs to contact left blank. This is the same class of defect as
the field-count check that already blocks today — not a judgment call, an objective defect.

### 5. Escalating delivery reminders — RECOMMENDATION (a scheduling behavior, not a user-facing choice, so effectively always-on — but graded here as recommendation since it surfaces rather than refuses anything)

**Trigger:** from effective date until funds are confirmed received at title, on the option
fee / earnest money delivery deadline specifically.
**What Dossie does:** reminds the buyer-side (and the agent) on a schedule that tightens as
the deadline approaches — not a single mention on the due date itself. Existing
`api/cron-deadline-reminders.js` already does T-7/T-1/T-0 reminders, but its
`DEADLINE_FIELDS` list today covers option expiration, closing, appraisal, survey, HOA,
loan approval, and possession — **it does not currently include an option-fee or
earnest-money delivery deadline at all**, because no such deadline column/date currently
exists on `transactions` (only `option_fee_amount`, `earnest_money_amount`,
`option_fee_receipt_date`, `earnest_money_deposited_at` — amounts and *receipt* timestamps,
no *due-date* field to remind against). This is the first concrete build item — see the
checklist.
**What it prevents:** failure #6, same as gate 3 but on the notification side — one
passive mention isn't notice; a tightening reminder schedule is.

### 6. Confirmed receipt, not assumed — HARD BLOCK on conflating the two states; RECOMMENDATION on the escalation itself

**Trigger:** wire instructions are sent to the buyer.
**What Dossie does:** tracks "wire instructions sent" and "funds received at title" as two
separate, explicit states — never infers the second from the first. If funds aren't marked
received by the day before the delivery deadline, escalates directly to the agent (not just
a quiet countdown the agent has to notice). The hard-block half of this gate is narrower
than it sounds: the product must never *render* "delivered" or auto-clear a deadline based
on instructions-sent alone — that state confusion is not allowed to exist in the UI, full
stop. The escalation timing itself is a recommendation-style behavior (tunable, not a
refusal).
**What it prevents:** failure #5 combined with #7 — instructions went out on the deadline
day itself with nobody watching whether they were acted on in time.

### 7. Counterparty timestamp trail — RECOMMENDATION (record-keeping, nothing to block)

**Trigger:** an executed contract is delivered to a title company / escrow agent.
**What Dossie does:** records when delivery happened and by whom, at the time it happens —
not reconstructed afterward from an email search. On this real file, the six-hour-45-minute
delay in getting the contract to title turned out to be the buyer's single strongest fact
in the dispute, and it only existed because someone went back through email after the fact
to reconstruct it.
**What it prevents:** the buyer having a live, contemporaneous record instead of a
forensic one built under pressure during an active dispute.

---

## Part 3 — Sales framing

Use as-is or trim. Every claim below is checked against the live repo as of 2026-09-03 —
gates are explicitly marked BUILT or SPECIFIED-BUT-NOT-BUILT and that split should not
blur in any external-facing draft pulled from this section.

> A transaction coordinator costs $400 a file and still relies on somebody remembering to
> check a calendar on a Friday afternoon. Dossie computes the calendar itself, flags a
> compressed delivery window at the moment the contract is signed, drafts the extension
> amendment before anyone has to ask for one, and won't let a contract go out for signature
> with the buyer's own contact information missing from the page that's supposed to carry
> it.

**What's BUILT today, verified against the repo:**
- The underlying TREC ¶5A(2) rollover rule (weekend/Legal-Holiday extension applies to
  earnest money/option fee only, not to option period/title/survey/financing/closing) is
  correctly documented in `answers/is-earnest-money-due-on-weekends-texas/index.html` —
  currently marketing content, not application logic.
- `contract_effective_date` and `option_days` already exist as real columns on
  `transactions`, and `api/_lib/trec-20-19-transaction-field-map.js` already reads
  `option_fee_amount`, `earnest_money_amount`, `option_fee_receipt_date`, and
  `earnest_money_deposited_at` — the raw data a due-date computation and a receipt-tracking
  gate would both build on already exists.
- `api/cron-deadline-reminders.js` runs daily, T-7/T-1/T-0, against a real deadline table
  (`deadline_reminders`) for `option_expiration_date`, `closing_date`,
  `appraisal_deadline`, `survey_deadline`, `hoa_document_deadline`,
  `loan_approval_deadline`, `possession_date` — the reminder infrastructure and pattern
  exist and are proven; the option-fee/earnest-money deadline just isn't in that list yet.
- `assertPlausibleResaleFieldCount()` in `api/esign-create.js` is a live, proven hard-block
  (422) pattern — refuses to send an e-sign packet when the signature/initial field count
  is implausible for the document. This is the exact mechanism Gate 4 (¶21 party blocks)
  would extend, not a new pattern to invent.
- `api/_lib/pre-send-field-audit.js` is a live, proven pattern for a different kind of
  gate — blocking a send when a required *value* silently failed to land on the rendered
  PDF. Doesn't cover ¶21 today (not in `fill-form-required-fields.js`'s required-field
  list), but is the second proven mechanism this work would extend.
- `api/draft-amendment.js` is a live, general-purpose amendment-drafting endpoint (accepts
  a free-text `amendmentType`) — the drafting infrastructure Gate 2 needs already exists in
  some form; it does not yet have a specific "delivery extension" type or auto-trigger.

**What's SPECIFIED-BUT-NOT-BUILT — do not claim these as live features:**
- Business-calendar deadline computation as an actual function (Gate 1). Today's
  deadline reminders use naive calendar-day arithmetic (`addDaysYMD` in
  `cron-deadline-reminders.js`) — no holiday table, no weekend-rollover logic exists in
  code anywhere. The correct rule is written down (the answers page); it is not wired to a
  computation.
- The compressed-window proactive recommendation + pre-filled amendment draft (Gate 2).
- The date-and-time-only rendering rule for client-facing deadline copy (Gate 3) — not
  audited or enforced anywhere today.
- Option-fee/earnest-money delivery deadline as a tracked, reminder-eligible date at all
  (Gate 5) — the amount and receipt-timestamp columns exist; the due-date itself isn't in
  the reminder cron's field list.
- The ¶21 party-block-specific hard block (Gate 4) — the *mechanism* it would reuse is
  built and proven; the specific check is not.
- Wire-instructions-sent vs. funds-received as two tracked states with day-before
  escalation (Gate 6) — `send-wire-fraud-warning.js` sends and logs a warning email; it
  does not track receipt confirmation or escalate an unconfirmed deadline.
- Counterparty delivery timestamp trail (Gate 7) — not tracked anywhere today.

No invented customer testimonials or metrics belong in this section or any pitch drawn
from it. The $5,200/eight-step chain above is real and verifiable against
`friday-execution-option-fee-trap` and is the only concrete number to cite, and only in
anonymized form.

---

## Implementation checklist, ordered by value-per-effort

1. **Add `option_fee_due_date` / `earnest_money_due_date` to the reminder field list** —
   cheapest possible win. Even naive calendar-day math (what already exists) wired into
   `cron-deadline-reminders.js`'s `DEADLINE_FIELDS` immediately turns "one passive mention"
   into T-7/T-1/T-0 reminders for the two deadlines that actually caused this loss. Ships
   before the business-calendar work below and is strictly additive to it.
2. **Business-calendar computation module (Gate 1)** — the one dependency everything else
   sits on. Needs: a Texas Legal Holiday table per Gov't Code §662.003(a) (fixed dates +
   the two floating ones, Juneteenth and Thanksgiving Friday, already correctly documented
   on the answers page — port the list from there, don't re-derive it), and a per-deadline-
   type flag for whether ¶5A(2) rollover applies (earnest money/option fee: yes; everything
   else: no).
3. **¶21 party-block hard block (Gate 4)** — highest leverage single gate relative to
   effort, because the mechanism (`assertPlausibleResaleFieldCount`'s throw-422 pattern) is
   already proven in the same file. This is closest to "extend an existing function," not
   new infrastructure.
4. **Compressed-window recommendation + pre-filled amendment draft (Gate 2)** — depends on
   #2. The drafting half is close to done (`draft-amendment.js` already exists generically);
   the new work is the trigger condition and a delivery-extension amendment type/template.
5. **Deadline rendering rule (Gate 3)** — an audit-and-fix pass across every client-facing
   template that renders a deadline, not a new system. Low effort, easy to defer, but cheap
   enough it should ride along with #1.
6. **Wire-sent vs. funds-received state tracking + escalation (Gate 6)** — needs a new
   explicit state field and the escalation trigger; `send-wire-fraud-warning.js` is a
   related but distinct surface (it warns about fraud risk, it doesn't confirm receipt).
7. **Counterparty delivery timestamp (Gate 7)** — lowest urgency; nice-to-have
   record-keeping that helps in a dispute but doesn't prevent one on its own.

### Open question: where does deadline computation live?

**Recommendation: a new `api/_lib/business-calendar.js` module, not an extension of
`scheduling.js`.**

Reasoning: `api/_lib/scheduling.js` (196 lines, read in full for this doc) computes
*showing-slot occupancy* — a completely different domain (per-owner time-of-day windows,
not contract-deadline date arithmetic) with no shared logic beyond "both touch dates."
Bolting Texas Legal Holiday tables and ¶5A(2) rollover rules onto a showing-scheduler module
would make that file harder to reason about for a problem it wasn't built for, and would
put contract-legal date math one grep away from getting confused with showing-availability
math during a future edit. A dedicated module is also the more reusable shape: the holiday
table and rollover logic need to be called from at least three places (the reminder cron,
the compressed-window recommendation trigger, and any future closing-date-adjacent gate) —
a small, single-purpose, well-named module is easier to import consistently from all three
than a corner of a scheduling file. The cost of a new file is trivial; the cost of a wrong
shared home compounds every time someone touches either concern.

---

## Related

[[friday-execution-option-fee-trap]], [[teaching-pipeline-cole-to-dossie]],
[[feedback_required-contract-fields-checklist]], [[dossie-esign-productization-plan]].
