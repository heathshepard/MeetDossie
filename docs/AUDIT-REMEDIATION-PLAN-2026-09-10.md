# Audit Remediation Plan — 2026-09-10

**Purpose.** Mine every open finding from the last month of Dossie audits, verify each one against
the code actually running today (not the report), and put every still-real finding somewhere it
will resurface instead of getting lost the way Heath described. Nothing in this document was
fixed as part of writing it, except the tracking rows themselves (explicitly in scope per the
task).

**Sources mined:** `docs/DOSSIESIGN-GAP-ANALYSIS-2026-09-01.md`, `docs/DOSSIE-CAPABILITY-AUDIT-2026-08-31.md`,
the 51-bug full-site QA sweep (`jarvis_todos` row `4d03fedb`, artifact
`claude.ai/code/artifact/f9ac99a2-...`), and `docs/TECH-DEBT.md`. **The QA-sweep artifact is
no longer fetchable** — `curl` returns a Cloudflare bot-challenge page, and a headless-browser
fetch (Playwright, no claude.ai session available in this environment) returns "Page not found."
Per the no-fabrication rule, only the 8 findings named in the `jarvis_todos` row detail are
verified and tracked below; the other ~43 (of 51) are flagged as needing a fresh audit pass,
not guessed at. See "What's unverifiable" at the end.

---

## Addendum (2026-09-10, later same night) — found by driving the product, not reading the code

Heath drove a real production dossier (Pfeiffers Gate) through Dossie tonight and found seven
defects in one session. His question: how many were already in the three audits this plan is
built on? Matched precisely against `DOSSIESIGN-GAP-ANALYSIS-2026-09-01.md`,
`DOSSIE-CAPABILITY-AUDIT-2026-08-31.md`, and the QA sweep (the 8 findings recoverable from it) —
not a vague topic match, the specific defect:

| # | Tonight's finding | Previously reported? | Match |
|---|---|---|---|
| 1 | Client-facing email computes wrong dates: no weekend/holiday roll (Sat 9/12 not rolled to Mon 9/14) + option period miscounted (9/16 instead of 9/18 for a 9-day option from 9/9) | **NOT REPORTED** | No audit mentions deadline-math correctness. A correct rollover module (`api/_lib/business-calendar.js`, `rollForwardYMD`) already exists and is wired into `scan-contract.js`/`cron-deadline-reminders.js`/`interactive-editor-update-field.js` — but not, apparently, into whatever computes the dates in this client email (candidate: `api/chat.js`, which has its own `option_expiration`-adjacent logic and was never audited). Same "built correctly in one place, not wired into another" pattern as Defect A1/A2 and the Gmail button — but a brand-new instance of it, not a previously-flagged one. |
| 2 | Computed dates never populate the dossier's Key Dates fields (appraisal, survey, HOA docs, loan approval blank) while Possession (a literal contract date, not computed) fills fine | **NOT REPORTED** | Closest prior text is Capability Audit §4a's note that `transactions` has "~40 discrete `*_at` columns" that are "state, not history" — that's about history being overwritten, not about these specific derived fields failing to populate at all. Different defect. |
| 3 | "0 days" written for Option Period and Financing Days instead of null | **NOT REPORTED (this exact instance)** | Adjacent to a *related, already-fixed* bug: commit `deb4743` (2026-08-27) fixed the *New Dossier form* defaulting `optionDays` to a fabricated `7` instead of blank. Same bug **class** (a real zero/default value asserted where nothing was actually told to Dossie), but a different code path — that fix was for manual entry, tonight's finding is on **scan-derived** fields. Not the same bug, same lesson. |
| 4 | Option Period fields (option fee, earnest money, escrow agent) not prefilling despite being on the contract | **NOT REPORTED** | Gap analysis discusses fill *quality* being capped at canonical columns once a value exists, not extraction *failing* to land these specific fields from a scan. No audit named these three fields. |
| 5 | Title Company officer name not prefilling from ¶5A | **NOT REPORTED** | Same category as #4 — scan/fill accuracy on a specific field never named in any audit. |
| 6 | ~150 member-typed fields never reach the generated PDF, live in production | **PREVIOUSLY REPORTED — Defect A2**, gap analysis §1 ("~170 of ~200 fields... never reach any document that actually goes out"). **This is the important one.** Earlier tonight's verification pass in this same document read `fill-form.js` and `dossiesign-prepare.js` and concluded A2 was **fixed** on `main` (both files now reference `contract_field_drafts`). Heath's live test on a real file says it is still broken in practice. One of two things is true: the merge-drafts code has a bug that a code read didn't catch, or Pfeiffers Gate went through a fill path the fix doesn't cover. Either way, **the "already-fixed" verdict in this document's own table for Defect A2 is now unconfirmed and should be treated as still-broken until re-verified live.** |
| 7 | Scan audit panel shows a ¶3B financing misread *and* a green "no initial issues" summary directly contradicting an initials warning displayed above it | **NOT REPORTED** | Gap analysis describes `pre-send-field-audit.js` as generally honest about what it can't attribute — no audit flagged a self-contradicting summary panel, and no audit catalogued a ¶3B misread specifically. |

**Score: 1 of 7 previously known (and that one is now in doubt), 6 of 7 net new.**

**Why the audits missed six of seven.** All three prior audits — including the two-week push that
produced the DossieSign fixes verified as live above — were **code-reading and live-DB-query
exercises.** That method is good at finding "this button posts a payload the API doesn't accept"
(Defect A1) or "this table has 32 rows all status=sent" (never-proven). It is structurally blind
to "this specific paragraph on this specific contract produces the wrong date," because that
defect only exists at the intersection of real contract data, the actual computation path it
triggers, and a human reading the output against what the contract says. No amount of grepping
`api/_lib/fill-trec-20-19.js` finds a ¶3B misread; you have to scan an actual ¶3B and look at
what came out.

**What this changes about the next audit.** Code-reading audits remain the right tool for
reachability, contract-shape, and dead-code questions (they found A1/A2/the packet gap/the
20-18 geometry bug, all real, all confirmed). They are the wrong tool, on their own, for
correctness questions — anything where "does the math work" or "does the field prefill" can only
be answered by actually running a real file through the product and checking the output against
the source document, field by field. **Every future Dossie audit should include at minimum one
real transaction driven end-to-end (scan → fill → deadlines → client email → e-sign), with
a human checking every number and date against the source contract — not as a supplement to the
code read, as a mandatory second pass with equal standing.** Tonight is the proof: it found six
things three code-reading passes over the same feature area did not.

---

## The single highest-leverage fix — and why it isn't what the gap analysis assumed

The 2026-09-01 gap analysis's own recommendation was "fix the Send button (Defect A1)." **That
recommendation is already three weeks stale — it shipped.** Reading the actual commit history
between 2026-09-01 and 2026-09-08 (all real, verified against code, not summaries) shows an
enormous amount of exactly the Tier-1 work the gap analysis called for already happened:

| Gap-analysis defect | Status found | Evidence |
|---|---|---|
| A1 — Send button 400s every time | **FIXED**, live in production | `SendPacketButton.jsx` now posts `{transactionId, documentIds, signers}`; `esign-create.js` accepts it. Verified the exact fix string is in the bundle `meetdossie.com/app` is serving right now (`workspace-BVgACcOi.js`). |
| A2 — typed drafts never reach the sent doc | **FIXED**, live in production | `fill-form.js` and `dossiesign-prepare.js` both now read `transactions.contract_field_drafts` at fill time. |
| Gap 1 — 20-18 geometry used on 20-19 forms | **FIXED**, live in production | `esign-create.js` now loads `trec-20-19-esign-coords.json` (real 20-19 geometry), not the 20-18 map. |
| Gap 2 — addenda get 0 initials | **FIXED**, live in production | commit `47efabf9` — "wire verified per-form signing geometry for 23 TREC forms + generalize the 422 gate." |
| Gap 3 — no packet, N emails per offer | **FIXED**, live in production | commit `f0d9b822` (2026-09-08) — one DocuSeal submission, one email, per-document field sets, page offsets. |
| §4 legal gap — no stored audit trail / certificate / hash | **FIXED**, live in production | same commit — `esign-webhook.js` now downloads DocuSeal's `audit_log_url`, sha256-hashes every returned document, stores a `signing_certificate` row. |

**So what is the actual highest-leverage fix left?** Not more send-path engineering — it's this:

**Zero signature envelopes have ever completed, and none has even been *sent* since
2026-08-25** (verified live against `signature_requests` today: 31 rows, all `status='sent'`,
newest is 2026-08-25 — three days *before* the fixes above shipped). All of that engineering
work — probably two full weeks of it — has never been exercised by a real send, let alone a
real signature. It is sitting there, done, unverified, and — this is the Heath-in-his-own-words
part — **he almost certainly doesn't know it happened**, because nothing surfaced it to him.

**The fix is not code. It's one real verification pass + telling Heath it's done:**
1. Send one real test envelope through the *current* production Send Packet button (Playwright,
   signed in as a real or demo account) and confirm it actually reaches a signer and can be
   completed — this is the live-browser verification CLAUDE.md already requires before anything
   is called done, and it has never been run against this feature.
2. Then run one real deal through it (DoD gate `real_deal_closed` — still unflipped).
3. Only then can "DossieSign works" be reported as fact instead of "the code looks right."

This single verification pass is the fix that unblocks the most, because everything downstream
— seller-side recipients, reminders, per-agent defaults, the whole "replace zipForm" pitch —
is worthless to build further on top of a send path nobody has watched work end to end.

**A second, equally cheap, equally overlooked finding sits right next to it:** the production
bundle serving `meetdossie.com` right now was explicitly **built from an unmerged Dossie feature
branch** (`carter/dossiesign-packets`, per commit `4b80b44da2`'s own message: "Built from
Dossie@392145f"), not from Dossie's `staging` or `main`. Dossie's own `main`/`staging` branches
still have the *old, broken* Send button, the *old* "Coming Soon" Gmail/Outlook buttons, and lack
the packet/audit-trail work — all of which **is already live in production**. If anyone runs the
documented "standard workflow" (§3 of `CLAUDE.md`: checkout Dossie `staging`, `npm run build`,
copy the bundle) without first merging that feature branch into Dossie `staging`, **the next
deploy silently reverts all of it** — Send Packet, the packet/audit-trail feature, the dates-fix,
the morning-brief-urgent-count fix, and the already-wired (but unverified) Gmail/Outlook OAuth
buttons. This is exactly the "we did the work and then lost track of it" pattern, one layer
down: the work isn't lost, but the map to it (the git history Carter/Heath would trust) is wrong.
**Merge `carter/dossiesign-packets` into Dossie `staging` (then `main`, on Heath's go-ahead)
before anything else touches this code.**

---

## Sequenced plan

**Tier 0 — before any new engineering (hours, this week)**
1. Merge `Dossie:carter/dossiesign-packets` → `staging` → (Heath's call) `main`, so the source of
   record matches what's deployed. *Depends on nothing. Prevents a silent regression on the next
   ordinary rebuild.*
2. Playwright-verify a real Send Packet → signer flow on the current production bundle. *Depends
   on nothing. This is the fact-check the whole DossieSign investment has been missing.*
3. Fix the four Tier-0 integrity items the 8/31 capability audit already scoped as "hours" and
   which are **still untouched** three weeks later (verified today, unchanged since the audit):
   - `EmailActivityFeed` still hard-filters `notesLog` to `source === "email"` — the `esign` and
     `showingtime` notes two paid add-ons are sold on are still written and still invisible.
   - `api/help-pages.js` (8 finished articles) and `api/whats-new.js` still have **zero
     consumers** in the app — confirmed today, unchanged.
   - The in-app roadmap still self-contradicts: Compliance Vault is listed under "works today"
     (`dossie-app.jsx:6659`) **and** under "Q4 2026 roadmap" (`:6697`) simultaneously — same live
     bug the 8/31 audit found, not touched since.
4. Kill the calculator's superseded-form citation: `/calculator` still cites **TREC 20-17**
   (verified live on `meetdossie.com/calculator` today) — two versions behind the current 20-19,
   on a public lead-gen page. One-line-class fix.

**Tier 1 — make the one proven send path trustworthy (days)**
5. Seller-side recipients in `DossieSignModal` — still buyer-only (verified: zero "Seller" string
   in the component today). Blocks any listing-side use of the one working send path.
6. Envelope lifecycle: reminders, expiration, void/cancel, resend — still entirely absent
   (verified: no `esign-resend`/`esign-void`/`esign-remind` route exists). A stuck signer today
   has no recourse short of Heath doing it by hand in DocuSeal, same as the 8/30 incident.
7. Confirm/kill the superseded-20-18 escape hatch: `docuseal-prefill.js`'s
   `DOCUSEAL_TEMPLATES['resale-contract'] → 4018208` and `fill-form.js:3970`'s
   `prefillDocuSealTemplate` call both still exist. Trace whether either is reachable from any
   live UI path; if so, a member can still send a superseded promulgated form.

**Tier 2 — stop being right only for Heath (about a week)**
8. Per-agent contract-term default store, and make the fill engine read it. Still entirely
   unbuilt (verified: zero `contract_defaults`/`default_option_fee`/etc. anywhere in `api/`).
   Every non-Heath member gets Heath's implicit defaults or nothing.

**Tier 3 — the connected-inbox + legal-hardening layer (mixed engineering + external clock)**
9. The Gmail/Outlook "Connect" buttons and their OAuth wiring are **already built and already
   live in production** (verified in the current bundle) — but Google's CASA verification status
   for the `gmail.readonly`/`gmail.send`/`gmail.compose` restricted scopes has never been
   confirmed either way. This is sold today at $15/mo. Heath needs to check the Google Cloud
   Console consent-screen publishing status before this scales past ~100 connected accounts —
   this is a calendar dependency, not engineering, and it's the long pole.
10. Self-hosted DocuSeal / per-tenant accounts — still one shared personal `DOCUSEAL_API_KEY`
    for every member (verified unchanged). Not urgent at 11 real customers; becomes urgent before
    it scales, and it's also the fix for the "one suspension takes down every member's legal
    record" risk.
11. TXR/TAR proprietary form licensing. **Confirmed still true and unresolved:**
    `api/_assets/t47-affidavit-base64.js`, `tar-buyer-rep-base64.js`,
    `tar-listing-agreement-base64.js`, `tar-wire-fraud-base64.js` are still bundled in this
    **public** GitHub repo with no vendor license. This is a business/legal call for Heath +
    Hadley/an attorney, not an engineering ticket — but it's the sharpest legal edge in the
    product and nobody has moved on it since it was first flagged 2026-09-01.

**Tier 4 — the "shippable half" of the genuinely hard capabilities (each ~1 week, no MLS/infra dependency)**
12. CMA: still **not built** for members (confirmed, no route/UI). Ship "upload your MLS
    sold-comps export → Dossie does the comp analysis" — reuses the `scan-contract.js` pattern,
    needs no MLS data license.
13. Brokerage compliance: still only email-a-packet + hand-a-ZIP (confirmed unchanged). Ship a
    "brokerage-checklist-named ZIP" using the KW Command vocabulary already recon'd in
    `.tmp/command-recon/` — captures most of the value with none of the per-member-session
    problem.
14. Member SMS capture: still nothing built (confirmed — no Twilio/Telnyx dependency anywhere).
    Ship the manual-log-a-text-exchange path first; treat a Twilio "deal line" as separate,
    later, and start A2P 10DLC registration early if it's ever greenlit — that's a calendar
    dependency too.
15. Bulk "initial every page" tool in the manual field-placement UI (`EsignModal`/`FieldOverlay`)
    — still absent (confirmed, no "all pages"/"bulk" string in either file).

---

## What's already fixed (verified, keep visible — this is half the value of this document)

| Finding | Source | Verified fixed |
|---|---|---|
| Send Packet button 400s on every click (Defect A1) | Gap analysis §1, Step 2 Path A | Live in prod bundle `workspace-BVgACcOi.js`. Commit `9c4e6b4`/`4b80b44d`. |
| Typed field drafts never reach sent doc (Defect A2) | Gap analysis §1, Step 2 Path A | ⚠️ **DOUBTED as of 2026-09-10 addendum** — code reads `contract_field_drafts` on `origin/main`, but Heath's live Pfeiffers Gate test tonight found ~150 typed fields still not reaching the generated PDF. Treat as still-broken until re-verified against a real file. |
| 20-18 geometry used for 20-19 sends | Gap analysis §1 Step 3, Capability audit §2 Gap 1 | `esign-create.js` loads `trec-20-19-esign-coords.json` on `origin/main`. |
| Addenda get 0 initials | Gap analysis §1 Step 3, Capability audit §2 Gap 2 | Commit `47efabf9`, 23 forms generalized + 422 gate. |
| N emails per offer, no packet | Gap analysis §1 Step 3 Gap 3, Capability audit §2 Gap 3 | Commit `f0d9b822`, one-envelope packets live. |
| No stored DocuSeal audit trail / cert / hash | Gap analysis §4 item 4 | `esign-webhook.js` now stores `signing_certificate` + sha256 on `origin/main`. |
| Stripe test-mode links on `/agents` + `/coordinators` (real buyers charged $0) | QA sweep, top finding | Live on `meetdossie.com/agents` today: real Checkout Session, comment dated 2026-08-27. |
| Videos not playing sitewide (missing `Accept-Ranges`) | QA sweep | Tested live: `accept-ranges: bytes` present, range request returns 206. Could not reproduce today. |
| New dossiers fabricate placeholder effective/closing dates | QA sweep | Commit `deb4743`, on `origin/main` — blank by default now, no `addDays(0)/addDays(30)`. |
| "What's urgent today" always says clear | QA sweep | Commit `88b8a0b`, on `origin/main` — overdue/escalated items now counted. |
| PostHog never initializes | QA sweep | `/api/public-config` returns a real key; app bundle calls `posthog.init`. Not re-verified with a live event in PostHog's dashboard. |

---

## Full finding table

Legend — **Status:** still-broken / already-fixed / can't-tell. **Severity:** revenue-blocking /
core-workflow / cosmetic-or-legal-adjacent. **Effort:** one-line / days / subsystem.

| # | Finding | Source | Status | Severity | Effort | Notes |
|---|---|---|---|---|---|---|
| 1 | Send Packet button 400s (Defect A1) | Gap analysis | **already-fixed** | was revenue | — | Live in prod, see above |
| 2 | Typed drafts never ship (Defect A2) | Gap analysis | **⚠️ doubted — treat as still-broken** | core-workflow | days (re-verify against a real file, then fix whatever it finds) | Code read said fixed; Pfeiffers Gate live test 2026-09-10 says otherwise — see addendum |
| 3 | 20-18 geometry on 20-19 sends | Gap analysis / Cap audit | **already-fixed** | was core-workflow | — | Live in prod |
| 4 | Addenda get 0 initials | Gap analysis / Cap audit | **already-fixed** | was core-workflow | — | Live in prod, 23 forms |
| 5 | N emails per offer, no packet | Gap analysis / Cap audit | **already-fixed** | was core-workflow | — | Live in prod, `f0d9b822` |
| 6 | No stored audit trail/cert/hash | Gap analysis §4 | **already-fixed** | was legal | — | Live in prod |
| 7 | **Zero envelopes ever completed; none sent since 8/25** | Gap analysis / Cap audit / this pass | **still-broken** | revenue-blocking | one-line (verification) then subsystem (fix whatever it surfaces) | The real remaining gate — see leverage section |
| 8 | Prod bundle built from unmerged Dossie branch, main/staging behind | This pass (new) | **still-broken** | revenue-blocking (regression risk) | one-line | Merge `carter/dossiesign-packets` |
| 9 | No seller-side recipients in DossieSignModal | Gap analysis / Cap audit | **still-broken** | core-workflow | days | Verified: 0 "Seller" hits |
| 10 | No reminders/expiration/void/resend | Gap analysis / Cap audit | **still-broken** | core-workflow | days | Verified: no route exists |
| 11 | Superseded 20-18 escape hatch (docuseal-prefill / prefillDocuSealTemplate) | Gap analysis / Cap audit | **can't-tell** | core-workflow/legal | days | Code exists; live reachability not traced this pass |
| 12 | Per-agent contract-term defaults not built | Cap audit §5 | **still-broken** | core-workflow | subsystem | Verified: zero hits repo-wide |
| 13 | Single shared personal DocuSeal account | Gap analysis §3/§5 | **still-broken** | scale risk | subsystem | Unchanged |
| 14 | TXR/TAR forms base64 in public repo, no license | Gap analysis §4.6 | **still-broken** | legal | not engineering | Verified files still present |
| 15 | Google OAuth CASA verification status unconfirmed | Cap audit §4b | **can't-tell** | blocks paid add-on scale | not engineering | Backend + button both live; publishing status unverified |
| 16 | Timeline drops esign/showingtime `notes_log` entries | Cap audit §4a | **still-broken** | core-workflow (paid add-on) | one-line | Verified filter unchanged |
| 17 | `help-pages.js`/`whats-new.js` built, zero consumers | Cap audit §7 | **still-broken** | cosmetic/discoverability | one-line/day | Verified unchanged |
| 18 | Roadmap self-contradiction (Compliance Vault) | Cap audit §7 | **still-broken** | cosmetic/trust | one-line | Verified unchanged (`:6659` vs `:6697`) |
| 19 | `/calculator` cites superseded TREC 20-17 | QA sweep | **still-broken** | cosmetic/compliance-trust | one-line | Verified live |
| 20 | `/workspace` duplicates `/app` (not a real team URL) | QA sweep | **still-broken** | cosmetic/architecture | days | Verified: identical bundle hash both pages |
| 21 | Team plan $349/mo nav unreachable (`display:none`) | QA sweep | **can't-tell** | possible revenue | half day | No matching dead code found in source; needs a live Team-plan login to confirm/deny |
| 22 | No bulk "initial all pages" tool | Gap analysis / Cap audit | **still-broken** | core-workflow | days | Verified: no such string in either component |
| 23 | CMA generation not built (member-facing) | Cap audit §1 | **still-broken** | not built | 1 week (shippable half) | Verified unchanged |
| 24 | Brokerage compliance upload not built (real integration) | Cap audit §3 | **still-broken** | not built | 1 week (shippable half) | Verified unchanged |
| 25 | Member SMS capture not built | Cap audit §4c | **still-broken** | not built | days (manual-log path) | Verified: no Twilio/Telnyx dep |
| 26 | 43 of 51 QA-sweep findings unverifiable this pass | QA sweep artifact | **can't-tell** | unknown | re-audit | Artifact link dead (Cloudflare-gated / "Page not found") |

---

## What's unverifiable, and why

The QA-sweep artifact (`claude.ai/code/artifact/f9ac99a2-b91c-4643-88b3-c5d8f2f4a780`) could not
be retrieved in this session:
- `curl` (direct and follow-redirect) hits a Cloudflare bot-challenge page, not content.
- A headless Playwright fetch of the same URL returns a rendered "Page not found" — this artifact
  view requires an authenticated claude.ai session this environment doesn't have.

Only the 8 findings named in the `jarvis_todos` row detail (the 5 "top revenue-impacting" plus 3
more named under "Also:") could be pulled forward and verified. **29 broken − (items already
named/verified) − 18 cosmetic − 4 suggestions leaves roughly 43 findings that exist only inside
that artifact and are currently untracked anywhere durable.** Recommendation: re-run the full-site
QA sweep fresh rather than trying to recover the old artifact — three weeks have passed, some of
what it found may already be stale, and a fresh pass will itself get written to `jarvis_todos`
this time instead of an artifact link.

---

## Weekly resurfacing digest — proposal, not built

**Extend `api/cron-weekly-digest.js`**, not a new cron. It already runs weekly (Monday, 8AM CST),
already sends a single Telegram digest to Heath, and already has the exact aging pattern needed —
it flags stale leads whose `lastContact` is more than 7 days old. The same pattern applied to
open `jarvis_todos` rows sourced from this audit:

- Query `jarvis_todos` where `done = false` and `detail` carries our source tag (see row format
  below), order by `created_at` ascending (oldest first) then by encoded severity.
- Render oldest-and-most-severe first, with age in days inline (e.g. "40d — revenue-blocking").
- Aging should make items *louder*, not quieter: bold/emoji-escalate anything crossing 14 and 30
  days open, exactly as Heath asked.

**One dependency worth flagging before building this:** `cron-weekly-digest.js`'s own header
says it runs "via cron-job.org (JOB-007)," the same class of external scheduler that
`docs/DOSSIE-CAPABILITY-AUDIT-2026-08-31.md` §6 found silently dead for `agent_requests`
(`cron-process-agent-requests`, last fired 2026-08-25, six days before that audit). **Confirm
`cron-weekly-digest` is actually still firing on cron-job.org before building on top of it** —
otherwise this digest inherits the exact "we set it up and it silently stopped" failure mode it's
meant to prevent.

---

## Sources

Verified this session by reading current code (both repos, `origin/main` and `origin/staging`
unless noted) and live production: `api/esign-create.js`, `api/esign-webhook.js`,
`api/fill-form.js`, `api/dossiesign-prepare.js`, `api/_assets/docuseal-prefill.js`,
`Dossie/src/components/dossieSign/phase1/SendPacketButton.jsx`, `Dossie/dossie-app.jsx`
(timeline filter, help-pages/whats-new consumers, roadmap panel, Team nav gating, Gmail/Outlook
buttons), `agents/index.html`, `coordinators/index.html`, `calculator.html`, `app.html`,
`workspace.html`, git history on both repos (`git log -S`, `merge-base --is-ancestor`) across
`main`/`staging`/`carter/dossiesign-packets`. Live checks: `curl` against
`meetdossie.com/{agents,calculator,app}` and the Supabase Storage video CDN
(`accept-ranges`/range-request test), live `signature_requests` table via Supabase REST
(service-role, read-only).

**Not verified this session (inherited from prior audits, treat as still-real pending a
recheck if picked up):** items 14 (form-name-map generalization details beyond the 20-19),
17-18 broader "help system" claims beyond the two zero-consumer checks re-run here, and anything
in the capability audit not explicitly re-checked in the table above.
