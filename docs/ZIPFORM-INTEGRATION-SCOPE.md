# ZipForm Data-Pull — Scope (not built)

Carter, 2026-08-24. Requested to scope a real ZipForm data-pull to kill "duplicate-entry" as a churn cause.

## 0. Assumption check — flag before building anything

"Duplicate-entry churn" is not yet a confirmed cause in our own data. `REASON_OPTIONS` on the
Settings > Billing cancel flow (`api/cancel-subscription.js`) are `too_expensive`,
`missing_feature`, `switched_tool`, `not_using_enough`, `technical_issues`, `other` — no
duplicate-entry option, and `cancellation_feedback` (free-text `reason_detail`) is a table Carter
built **today** (2026-08-24, commit context: `admin-migrate-cancellation-feedback.js`), so it has
zero rows from real cancellations yet — Miki/Amanda's cancellations today predate the table's
existence. Zelda/Jennifer/Terry churned before it existed too. **We have no direct customer quote
on record saying "I had to re-enter the same deal twice."** It's a reasonable inference (TCs build
the deal in zipForm for e-sign, then would separately need it in Dossie for coordination), not a
verified fact. Recommend: let `cancellation_feedback.reason_detail` accumulate for the next few
cancels before treating this as confirmed — cheap to wait, expensive to build against a guess.

## 1. Current state (verified in repo)

Dossie has **no live connection to a customer's zipForm account today.** Transaction data enters
two ways:
- Manual form entry in the Dossie UI.
- `api/scan-contract.js` — customer uploads a PDF (typically the executed TREC 20-17 + addenda),
  Claude Haiku/Sonnet extracts ~50 structured fields (price, dates, parties, addenda, deadlines —
  see the full schema in that file) into `transactions`. This already solves "don't retype a
  signed contract by hand" for the *initial* import. It does not touch zipForm's live system, and
  it doesn't re-sync when the deal changes there (an amendment, a new addendum, an updated closing
  date) — each of those would currently need a fresh manual re-entry or a second scan pass creating
  a duplicate row rather than patching the existing one.

Separately, `scripts/brokerage-*.js` + `.claude/agents/brokerage.md` already do real Playwright
automation of zipForm — but that's Heath's **personal brokerage** login (his own KW zipForm
account, a single dedicated Chrome profile, one-time hand-login through MFA/Windows Hello). It is
not a multi-tenant customer integration and the pattern doesn't extend to "log into 200 different
customers' zipForm accounts headlessly" without hitting the constraints in §2 below.

## 2. What a *real* zipForm data-pull actually requires — verify before scoping further

zipForm Plus / zipForm Transactions Edition is owned by **Lone Wolf Technologies** (zipLogix
legacy). There is no public, self-serve API for a third-party SaaS to pull a customer's transaction
data — access to any Lone Wolf integration surface has historically required a formal
technology-partner relationship (business agreement, likely NDA + certification + possibly a
revenue arrangement), not an API key you sign up for. **This has not been confirmed directly with
Lone Wolf for the current state of their partner program** — that confirmation is a human action
(a BD conversation, not something an agent can complete) and is the real fork in this scope: if a
partner API exists and is reachable, options change completely.

**Escalating this as the one genuinely human-only step:** Heath (or whoever owns partner
relationships) needs to contact Lone Wolf/zipForm partner developer relations and ask (a) does a
transaction-data-pull API exist for third-party partners, (b) what's the approval process and
timeline, (c) any cost. Nothing below should be built against assumption C until that comes back.

## 3. Three paths, ranked by cost vs. value

**A. Expand the existing PDF-extraction pipeline (cheap, ship now, no ToS risk)**
The TC/agent already has a "download/export the packet" action in zipForm they use to send docs to
title/lender — reuse that same export as the "pull," just human-initiated instead of API-initiated.
Close two real gaps in `scan-contract.js` + `transactions.js` today:
  1. **Batch upload** — accept the whole exported packet (contract + all addenda) in one pass
     instead of one document at a time.
  2. **Patch, don't duplicate** — when a document is re-scanned against an *existing* transaction
     (an amendment, updated closing date), merge the new extracted fields into that transaction row
     instead of creating a second dossier. `transactions.js` currently only exposes DELETE in what
     was read; the create/update path needs a "target existing transaction ID" mode.
This doesn't require Lone Wolf's cooperation at all and directly answers "why do I have to type
this twice" — it just needs the upload UX to feel like one step, not two separate ones.

**B. Per-customer Playwright automation against zipForm (not recommended)**
Same technique as the personal `brokerage-browser.js` profile, but for every customer. Rejected:
requires each customer to hand Dossie their zipForm password, fragile against any zipForm markup
change (silent breakage across every customer at once), and scripted/automated access at this
scale is very likely a zipForm/TAR Terms of Service violation for a multi-tenant product — this is
a legal-risk problem, not just an engineering-fragility one. Do not build this.

**C. Real Lone Wolf partner API (long-lead, gated on §2)**
Only worth scoping in detail once the BD conversation in §2 confirms an API exists and is reachable
for a company our size. If confirmed: likely OAuth-per-customer-account, webhook or polling for
transaction changes, mapped into the same `transactions` schema `scan-contract.js` already
populates (reuse the field schema, don't reinvent it).

## 4. Recommendation

1. Ship **A** — it's the only path that's actually in Carter's control, has no partner dependency,
   no ToS exposure, and reuses a proven extraction engine. Rough size: medium, ~1 sprint (batch
   upload endpoint + merge-into-existing-transaction mode + UI affordance for "update this dossier
   from a new document").
2. Heath: start the Lone Wolf partner conversation (§2) in parallel — zero engineering cost to ask,
   and it determines whether C is ever worth planning.
3. Don't build B.
4. Before committing sprint time to A, it's worth pulling 2-3 more `cancellation_feedback` entries
   to confirm duplicate entry is a real, named pain — not required, but cheap insurance against
   building the right feature for the wrong stated reason.

## Open questions for Heath

- Does he already have a Lone Wolf/zipForm partner contact, or does outreach start cold?
- Any existing customer (Brittney, Cecilia, etc.) who's said "I had to enter this twice" in a call
  or Telegram thread that didn't make it into `CUSTOMERS.md`? That would upgrade §0 from inference
  to evidence.
