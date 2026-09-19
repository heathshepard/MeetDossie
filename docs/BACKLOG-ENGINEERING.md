# Engineering Backlog — unfinished and broken work

**Compiled 2026-09-17.** Scope: engineering and product only. Marketing, the realtor practice,
and app-store/launch status are deliberately excluded — a separate pass covers those.

**What's in here.** Only work that was **started and abandoned**, is **known broken**, or was
**explicitly deferred**, each with evidence you can go look at. Feature ideas, "could be
better," and refactors nobody asked for are not items and are not listed.

**How this was built.** Every claim taken from a memory file or an older doc was re-checked
against current code, current DB state, a live API call, or a current cron run. A lot of it
turned out to be **already fixed** — those are collected at the bottom under "Verified
resolved" so nothing re-opens them. Anything that could not be re-verified says so in its
Confidence line.

**Read `origin/main`, not the checkout.** Production is `origin/main`: **54 cron entries**, 16
of which are fan-out dispatchers expanding to ~101 reachable jobs. The local checkout sits on
`wip/tc-harvest-silence-alarm-preserve-0916` with 99 flat entries and is 65 commits behind.
Auditing the working tree gives the wrong answer (see B12).

**Blocked by** is the field an automated loop reads:
- `agent` — completable with no input from Heath.
- `agent, Heath gates merge` — an agent does all the work; Heath approves the merge under the
  normal staging→main rule. Still pullable by a loop.
- `Heath` — needs a credential, a payment, a legal call, a physical action, or a judgment only
  he can make. Not pullable.

**Total: 94 items — 91 open, 3 resolved and struck through.**
Open by section: A: 6, B: 25, C: 24, D: 12, E: 5, F: 12, G: 7.

**Reconciled 2026-09-17** against what actually shipped that day. Counts below are not estimates
— they are the output of running the real parser (`api/_lib/backlog-parser.js`, the same module
the autonomous loop uses) over this file:

| Category | Count | Pullable by a loop? |
|---|---|---|
| eligible — `Blocked by` reads `agent` or `agent, Heath gates merge` | **54** | yes |
| withheld — `Heath` | 27 | no |
| withheld — `agent, …` with a further Heath dependency | 10 | the engineering half only |
| closed — struck through, skipped at parse time | 3 | no |

So **54 items a loop can legitimately pull today**, up from 50 before this pass — 3 finished
items were removed and 6 real ones (B23-B26, C23, C24) were added.

**⚠️ Closing an item in this file is not free-text.** The loop detects closure from the `###`
**heading only**, and this file's headings begin `### A1.` — whose trailing period truncates the
parser's status region. Appending `— RESOLVED` to an engineering heading therefore does
**nothing**. **Strike the title instead:** `### ~~A1. Title~~ — RESOLVED …`. All three closed
items here use that form. Full mechanics are in E1.

---

## Top 5 across everything

> **⚠️ SUPERSEDED 2026-09-17 — do not pick work from this list.** Four of the five below moved
> the same day this file was compiled, and the list has not been re-ranked. Read the items.
>
> | Was #1-5 | Where it actually stands on 2026-09-17 |
> |---|---|
> | **A1** anon can read the whole DB | **RESOLVED.** Two migrations applied to prod; 19 anon-executable SECURITY DEFINER functions → 1 (token-gated by design). Verified live. |
> | **B17** uncommitted P0 dossier-save fix | **Premise now false, item still open — and still broken in production.** The fix was committed and merged in `Dossie`, but the built bundle was never shipped to `MeetDossie`. Read B17 before touching it; both "it's uncommitted" and "it's done" are wrong. |
> | **C1** real signatures bypass the product | **Agent half RESOLVED.** Write-back shipped; `signature_requests` went 0 → 5 completed. What remains is Heath's, not engineering's. |
> | **B3** regression suite red, alerts swallowed | **RESOLVED and merged.** Alerts are delta-based and now actually fire. |
> | **B1** deadline math wrong in client-facing output | **Half shipped.** Business-day rollover is wired into the chat path and verified live. The survey/HOA builders are still `TODO-SARAH` and still need Heath. |
>
> **What is genuinely most severe now:** **B17** (a member-facing data-loss bug fixed in source
> and still live in production), **B2** (~75 typed fields still not reaching the contract, some
> printing *stale* values the member never typed), and **C23/C24** (contract elections that
> cannot be set at all, on paragraphs headed "check one box only"). **B23** is the reason B17
> could happen silently and will happen again.

1. **[A1] Anyone on the internet can read the entire database.** 19 `SECURITY DEFINER`
   functions are executable by the `anon` role, including `jarvis_run_select(sql_text)`, which
   runs arbitrary SQL. The anon key is published at `meetdossie.com/api/public-config` by
   design. I ran it read-only and got row counts from `sms_messages` (198,634 of Heath's
   personal texts), `transactions` (112 rows, multi-tenant — includes Brittney Barbo's real
   client files), and `profiles`. `remove_org_member`, `update_member_roles` and
   `reassign_transaction` carry the same grant. *Nothing else here is close.*

2. **[B17] A finished fix for "the dossier says saved but was never saved" has sat uncommitted
   for a week.** `Dossie/dossie-app.jsx`, +50/−14, the only dirty file in that repo, marked
   `2026-09-10 CARTER P0 (Quinn)`. Before it, `submitNewDossier` called
   `void persistTransaction(newDeal)` fire-and-forget, then closed the modal, jumped to
   Pipeline and played the celebration card **regardless of whether the insert succeeded**. A
   member could create a dossier that never existed. The fix is written, coherent and shippable.

3. **[C1] Every real signature Heath collects bypasses the product entirely.** DocuSeal holds
   **35 completed** submissions (including five Ridge Bluff amendments, 9/15–9/16). Dossie's
   `signature_requests` holds **33 rows, all `status='sent'`, zero completed**, and the two sets
   have **zero overlap**. The real sends go through `scripts/send-trec-amendment.js`, which
   writes nothing back. So the verification/certificate/audit-trail leg — two weeks of work —
   has never once been handed a real completion, and the DoD gate that would prove DossieSign
   works has no path to flipping.

4. **[B3] The daily regression suite has been failing and the alerts are being swallowed.** It
   runs every day at 09:00 UTC, reports 6/53 failures (severity RED), and its alert path runs
   through a Telegram gate `cron-regression-suite` is not allow-listed on. A genuine PASS→FAIL
   regression on 2026-09-10 went unannounced. Two of the six failures are real dead crons. This
   is the one system built to stop silent failure, failing silently.

5. **[B1] Deadline math is wrong in client-facing output, and two deadlines are never computed
   at all.** `trec-deadline-engine.js:575-576` has the survey and HOA-document builders
   commented out as `TODO-SARAH`, inside the live array. The business-day rollover module is
   imported by 8 files and the chat/email path is not one of them. Heath's 2026-09-10 live run
   produced a Saturday deadline never rolled to Monday and a 9-day option period ending two days
   early, in an email to a client.

*Just below the line, both near-zero effort:* **[G1]** the entire Sawyer codebase is
uncommitted with no git remote — ~2,035 lines on one disk — and **[F2]** 2,240 lines of
finished Rust progression/deload work have been unmerged for 16 days and conflict worse weekly.

---

## A. Platform, security, data integrity (MeetDossie / Supabase)

### ~~A1. `anon` can execute 19 SECURITY DEFINER functions, one of which runs arbitrary SQL~~ — RESOLVED 2026-09-17
- **RESOLUTION (2026-09-17)** — Shipped as **two Supabase migrations applied directly to the
  database**, not as a MeetDossie commit. Do not go looking for a git SHA; there isn't one.
  - `20260917173809_revoke_anon_public_execute_on_security_definer_functions`
  - `20260917182337_fix_mt_acting_user_impersonation` (the org-admin half — the functions that
    took an acting-user id as a *parameter* instead of deriving it from the JWT)
- **Verified live 2026-09-17, after the fact, by re-running the original detection query**
  (`pg_proc` joined against `has_function_privilege('anon', oid, 'EXECUTE')` where `prosecdef`):
  **19 → 1**. The single remaining function is `consume_tc_consent_token`, which is
  token-gated by design — an unauthenticated invitee must be able to redeem a consent token.
  `jarvis_run_select` is no longer anon-executable.
- **Residual** — none for this item. `A5` (PDF blobs in public git history) and `A6` are
  unrelated and still open.
- **What it was** — The `anon` role held EXECUTE on 19 `postgres`-owned `SECURITY DEFINER`
  functions, so they bypassed RLS entirely. `jarvis_run_select(sql_text text)` took raw SQL.
- **Evidence** — `pg_proc` joined against `has_function_privilege('anon', oid, 'EXECUTE')`
  returns 19: `jarvis_run_select`, `jarvis_prune_expired_audio`, `jarvis_current_tenant_id`,
  `create_org_with_founder`, `update_member_roles`, `remove_org_member`,
  `invite_member_with_roles`, `reassign_transaction`, `toggle_tc_authorization`,
  `consume_tc_consent_token`, `create_tc_consent_request`, `cancel_tc_consent_request`,
  `has_active_tc_auth`, `get_my_org_context`, `get_org_roster`, `is_org_admin`,
  `prune_system_diagnostics`, `record_deletion_reminder_sent`, `record_watchdog_incident`.
  Confirmed read-only with the key served at `https://meetdossie.com/api/public-config`:
  `POST /rest/v1/rpc/jarvis_run_select` → `{"sms":198634,"tx":112,"prof":29}`.
- **Impact** — Unauthenticated full read of every table: 198,634 personal SMS, another paying
  customer's real client transactions, `profiles`, `subscriptions`, `stripe_payment_log`. The
  org-management functions take an acting-user id as a *parameter* instead of deriving it from
  the JWT, so a caller asserts their own identity — those are writes, and were not tested.
- **Effort** — Hours. `REVOKE EXECUTE ... FROM anon` on all 19, re-grant to `authenticated` only
  where the browser genuinely calls them (`get_my_org_context`, `is_org_admin`, `get_org_roster`,
  `invite_member_with_roles` are plausible), then a real browser pass to confirm nothing broke.
- **Blocked by** — nothing. Closed.
- **Confidence** — Fix verified live 2026-09-17 by re-running the detection query against
  production. **Not** re-verified through a real browser session, so a regression in the app's
  own use of `get_my_org_context` / `is_org_admin` / `get_org_roster` would not have been
  caught here — that specific check is **unverified**.

### A2. `audit_logs` is dead — 26 rows, nothing written since 2026-07-03
- **Evidence** — `count(*)=26`, `max(created_at)=2026-07-03T15:00:48Z`.
  `grep -rl audit_logs api/` returns exactly one file — `api/cron-regression-suite.js`, the test
  that checks freshness. Zero hits in `Dossie/src`.
- **Impact** — A multi-tenant product holding other people's client transactions has no audit
  trail. Compliance and incident-forensics gap.
- **Effort** — Days.
- **Blocked by** — **Heath** decision (is the audit trail still wanted, at what scope), then agent.
- **Confidence** — Verified now.

### A3. Supabase Storage is 1.37 GB against a 1 GB limit, and growing
- **Evidence** — 24 buckets, 1,372 MB. `documents` 827 objects / 547 MB, `videos` 86 / 393 MB,
  `social-cards` 318 / 126 MB, `screen-recordings` 5 / 95 MB, `system-diagnostics` 246 / 40 MB
  (machine output, no retention policy), `customer-view-digests` 80 / 29 MB, `ventures-files`
  1 object / 27 MB. The 2026-07-28 cleanup left it at 1.18 GB.
- **Effort** — Hours. `api/admin-storage-cleanup.js` already exists (CRON_SECRET-gated, dry-run
  unless `confirm=1`) and runs against a preview URL.
- **Blocked by** — agent.
- **Confidence** — Verified now.

### A4. `dossier_milestones` base64 migration is half-done and the app still writes base64
- **Evidence** — 78 of 122 rows migrated to Storage URLs; **44 still inline `data:` base64, 44 MB**,
  17% of a 274 MB database. Newest base64 row **2026-09-15**. Writer:
  `Dossie/src/components/ClosingCardModal.jsx:222`, plus `api/generate-demo-milestones.js:255`,
  `scripts/generate-milestone-cards.js:249`, `scripts/insert-under-contract-cards.js:114`.
  Reader `Dossie/src/components/MilestonesSection.jsx:68,81,95,133,245` still reads the column
  directly, so it is a coordinated two-repo change.
- **Impact** — Every new closing card adds ~2 MB to the database. The August migration cleaned
  history only; the cause is untouched.
- **Effort** — ~1 day.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### A5. 52 PDF blobs remain in the public repo's git history
- **Evidence** — `git ls-tree -r origin/main .tmp` → 0 (the scrub landed), but
  `git rev-list --all --objects -- .tmp | grep -c '\.pdf$'` → **52**. Remote is
  `github.com/heathshepard/MeetDossie`, public.
- **Impact** — If any hold real client data, that is a live disclosure and untracking did not
  undo it. Same lesson as the 2026-05-06 bypass commit: reverts do not unpublish.
- **Effort** — Hours to inventory; `git filter-repo` plus a force-push to remedy.
- **Blocked by** — **Heath.** Needs his eyes on whether real client data is in them, a
  notification judgment call if so, and a destructive force-push.
- **Confidence** — Verified now.

### A6. TXR/TAR proprietary forms are base64-bundled in the public repo with no vendor licence
- **Evidence** — `api/_assets/t47-affidavit-base64.js` (155 KB),
  `tar-listing-agreement-base64.js` (275 KB), `tar-wire-fraud-base64.js` (131 KB),
  `tar-buyer-rep-base64.js`, `txr-1101-listing-agreement-coords.json` — all under `git ls-files`
  today, served through a paid product.
- **Impact** — The sharpest legal edge in the stack. Flagged 2026-09-01; nobody has moved.
- **Effort** — Not engineering. An interim mitigation (move to a private Storage fetch) is ~1 day.
- **Blocked by** — **Heath** + Hadley → a real Texas attorney.
- **Confidence** — Files verified present now; licence status never checked either way.

### A7. 49 one-time `admin-migrate-*` endpoints are still deployed
- **Evidence** — 49 of 476 routes on `origin/main`. Spot-checked three, plus a full sweep by a
  second pass across all of them and `debug-zernio-accounts.js`: **every one** checks
  `CRON_SECRET` / `ADMIN_SECRET` / an Authorization header. No ungated endpoint is live.
- **Impact** — Low. Clutter and deploy surface, not exposure.
- **Effort** — Hours.
- **Blocked by** — agent.
- **Confidence** — Verified now.

---

## B. Dossie product (app + API)

### B17. The P0 fix for silent dossier-save failure is committed in Dossie and STILL NOT DEPLOYED
- **STATUS CHANGED 2026-09-17 — read this before acting.** The premise of the original item
  ("uncommitted") is now **false**, but the item is **not resolved**. The bug is still live for
  members. Both halves of that sentence matter:
  - The fix **was committed and merged in the `Dossie` repo today** — `f244745`
    *fix(dossiers): stop reporting success when a new dossier never saved*, merged as `a009d08`
    *merge(staging): P0 …*. The `Dossie` working tree is now **clean**; there is no dirty file
    to find.
  - The built bundle **was never rebuilt into `MeetDossie`**. `origin/main` still ships
    `assets/workspace-C_206Lx0.js`, referenced by both `app.html` and `workspace.html`, and
    that file contains **zero** occurrences of `persistResult` — the identifier the fix
    introduces (`Dossie/dossie-app.jsx:6141-6142`, `const persistResult = await
    persistTransaction(newDeal); if (!persistResult.ok) {`). Verified 2026-09-17 by extracting
    `origin/main:assets/workspace-C_206Lx0.js` and grepping it.
  - **Therefore production still runs the fire-and-forget code path.** A member can still
    "create" a dossier that was never written to the database and be shown the celebration card.
- **Why this is a trap for the next agent.** An agent that checks the *Dossie repo* concludes
  "done, clean tree, merged" and closes it. An agent that reads the original wording looks for
  "the only modified file in the Dossie repo" and finds nothing, and may also close it. Neither
  is true. The only check that answers the question is: **does the bundle referenced by
  `app.html` on `MeetDossie origin/main` contain `persistResult`?** Today it does not.
- **What remains** — the standard step 2-4 of CLAUDE.md §3: `cd ../Dossie && npm run build`,
  copy `dist/assets/workspace-*.js` into `MeetDossie/assets/`, update the hash in `app.html`
  and `workspace.html`, `git rm` the old bundle, push to `staging`, Quinn gate, Heath merges.
- **Generalised** — this is one instance of a class. See **B23**.
- **Effort** — Under an hour; it is a build-and-copy, not a code change.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified 2026-09-17 (both repos inspected; bundle content grepped directly).
- **What it was** — The only modified file in the Dossie repo was a complete, coherent fix for a
  member-facing data-loss bug.
- **Evidence** — `Dossie/dossie-app.jsx`, +50/−14, comments dated `2026-09-10 CARTER P0 (Quinn)`.
  Three changes: (a) a client-side guard on `property_address`, Supabase's one NOT-NULL column
  on that table; (b) `void persistTransaction(newDeal)` → `await persistTransaction(newDeal)`
  with a bail on `!persistResult.ok`, leaving the modal open and the member's typed data intact
  — previously *everything* after it (close modal, jump to Pipeline, celebration card) ran
  unconditionally, so a failed insert was indistinguishable on screen from a real save;
  (c) the Create button is disabled during scan.
- **Impact** — Without it, a member can "create" a dossier that was never written to the
  database and never appears in Pipeline, having been told it worked. Textbook
  "confirmations must be earned." The fix exists and is not shipped.
  *(Still true on 2026-09-17 — see the status block at the top of this item. Only the
  "uncommitted" part changed.)*

### B1. Survey and HOA-document deadlines are never computed — ROLLOVER HALF SHIPPED 2026-09-17, builders still open
- **STATUS 2026-09-17 — the rollover half is done; the item stays open on the other half.**
  - **Shipped:** `04a77cab` *fix(deadlines): wire ¶5A(2) rollover into the client-facing chat
    path (B1)* is on `origin/main`. `api/chat.js` now uses `rollForwardYMD` from
    `api/_lib/business-calendar.js`. Reported verified live on production by QA today.
  - **Still open, and still `TODO-SARAH`:** `buildSurveyDeadline` and `buildHOADocDeadline` are
    **still commented out** in `Dossie/src/utils/trec-deadline-engine.js`. A member under
    contract still gets no survey deadline and no HOA-document deadline.
  - **Also still open and worse than the original wording suggests:** the deadline engine does
    not merely *default* to the superseded form — it **rejects** anything else.
    `trec-deadline-engine.js:228-230` reads `else if (inputs.formVersion !== "20-17")` →
    `formVersion '…' is not yet supported. Only '20-17' is implemented.`, and
    `deadlines.js:199` hardcodes `formVersion: "20-17"`. Production contracts are **20-19**.
  - **Found while fixing this, now tracked separately:** the ¶5.A option-fee/earnest-money
    suppression defect — see **B24**.
- **Evidence** — `Dossie/src/utils/trec-deadline-engine.js:575-576`:
  `// TODO-SARAH: buildSurveyDeadline (depends on survey path)` and
  `// TODO-SARAH: buildHOADocDeadline (depends on whether HOA addendum 36-10 attached)` — both
  commented out inside the live `rawDeadlines` array; the engine is wired to production via
  `Dossie/src/utils/deadlines.js:10`. Separately `api/_lib/business-calendar.js`
  (`rollForwardYMD`) is required by 8 files — `scan-contract.js`, `cron-deadline-reminders.js`,
  `interactive-editor-update-field.js`, `dossie-update-and-refill.js` and migration helpers —
  and `api/chat.js` is **not** among them. Heath's 2026-09-10 Pfeiffers Gate run produced a
  Saturday 9/12 deadline not rolled to Monday 9/14 and an option period ending 9/16 instead of
  9/18, in an email addressed to a client. Also `deadlines.js:199` hardcodes
  `formVersion: "20-17"` (`TODO-SARAH`) and `:212` hardcodes `titleCommitmentDays: 20`;
  production contracts are 20-19.
- **Impact** — A member under contract silently gets no survey and no HOA-document deadline, and
  can be handed a wrong date to send a client. The most damaging correctness defect in the product.
- **Effort** — Days.
- **Blocked by** — **Heath** for the domain input (survey-path conventions, 36-10 handling) — the
  `TODO-SARAH` markers mark them as parked pending a TC interview. **The rollover wiring that
  used to be the agent half of this item shipped on 2026-09-17 (`04a77cab`); what is left is
  the Heath-blocked half only.** Do not dispatch an agent at this item expecting the rollover
  to still be missing.
- **Confidence** — Rollover fix verified shipped (commit on `origin/main`). The two commented-out
  builders and the `20-17`-only `formVersion` guard were re-read in `Dossie` on 2026-09-17 and
  are **still present**.

### B2. Defect A2 — SETTLED 2026-09-17: it is real. 90 of 142 typed fields never reached the PDF; ~75 still unmapped
- **VERDICT SETTLED 2026-09-17 — this is no longer an open question, it is open work.** An agent
  drove the demo dossier end to end on production rather than reading code. **142** distinctive
  text values were typed through `/api/interactive-editor-update-field`; **52 reached the
  document, 90 did not.** Identical result through `/api/fill-form` and
  `/api/interactive-editor-download-pdf`, so it is not path-specific. Throughout, `fill_report`
  reported `{complete: true, fields_failed: 0}` — the pipeline's own success signal is worthless
  here.
- **The worst class is STALE values, not blank ones.** Where the editor's key names a blank that
  `fill-form` *also* supplies from the canonical `transactions` column, the canonical value wins.
  Typed `3,100,002` into ¶3C; the PDF printed `647,000`. Same for earnest money, option fee and
  title company. **The member sees their number on screen and the contract carries the old one.**
- **Partial fix exists but is NOT on `origin/main`.** Commit `9885e05f` *fix(trec-20-19): 14
  member-typed fields that never reached the PDF (B2)* lives only on the worktree branch
  `worktree-agent-a90d4cee22798850b`. It maps **14** editor keys onto blanks `fillTrec2019`
  already draws, plus the two genuinely missing ¶7D(2) repair-text coordinates. Local result on
  the same typed input: **48 → 61 landed, 0 regressions.**
  - Also found and fixed there: the editor's `specific_repairs_line1/2` drive the ¶7D(2)
    "As Is provided Seller completes the following specific repairs" checkbox, but the repair
    **text** had no coordinate at all — `drawFieldText` logged "No coordinate for field" and
    dropped it. Every such contract went out with **the box CHECKED and both repair blanks
    EMPTY**: a Seller repair obligation naming no repairs.
- **WHAT REMAINS: roughly 75 field mappings, still unlanded.** 90 missing − 14 fixed ≈ 75. That
  is the actual remaining scope of this item. Every target must be verified by **rendering the
  filled page and reading the printed label the value landed against**, per
  `[[acroform-field-names-lie]]` — never by matching a field name. That method already caught
  one wrong guess in the first 14: `seller_contribution_amount` looked like
  `seller_concessions` (which has no coordinate at all) and is really `settlement_expense_cap`.
- **Next agent: start from `9885e05f`, do not redo those 14.** Rebase it onto `origin/main`
  first; it is unmerged and will conflict with nothing else, but it has never been through
  staging or a Quinn gate.
- **Effort** — Days. It is ~75 individually render-verified mappings, not one fix.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified 2026-09-17 by driving production end to end. The count "~75" is
  arithmetic from the measured 90/142 and the 14 fixed; the exact residue has **not** been
  re-counted against the branch and is **unverified** to ±a few.
- **Superseded evidence (kept for provenance)** — `docs/AUDIT-REMEDIATION-PLAN-2026-09-10.md`
  item 2 marked it "doubted, treat as still-broken." The merge code is present and live:
  `contract_field_drafts` is read by
  `api/fill-form.js`, `api/dossiesign-prepare.js` and `api/_lib/merge-contract-field-drafts.js`
  (commit `cfa0d147`, 2026-09-01), and **112 transactions now carry drafts** (was 3). Heath's
  2026-09-10 live Pfeiffers run still found ~150 typed fields missing from the output.
- **Impact** — Confirmed real: the core promise (type once, it appears on the contract) is broken
  for 90 of 142 measured fields, and silently — worse, it can print a *stale* value the member
  never typed.
  *(The former "UNRESOLVED — code read and live test disagree" confidence line is superseded.
  The live drive on 2026-09-17 settled it in favour of the live test.)*

### ~~B3. Regression suite has been RED continuously and the alert path is gated~~ — RESOLVED 2026-09-17, MERGED
- **RESOLUTION** — Shipped to `origin/main`. `f2cb04b9` *fix(B3): un-gate regression alerts, make
  them delta-based, make alert_sent honest*, merged as `e77aa7d6`. The note further down this
  item saying "on branch `fix/b3-regression-alerting` (not merged, not deployed)" was written
  before the merge and is **stale** — it is now merged and deployed.
- **What that means for anything downstream** — the suite's alert path is live, so a *new*
  regression will now be announced. The suite itself is still RED on its standing failures; that
  is **B4** (two miscalibrated assertions) and **A2**/**D-section** items for the rest, not this
  one. Do not re-open B3 because the suite is still red — red was never what B3 was about.
- **Newly unblocked by this** — wiring more checks into the suite is now worth doing, because a
  failure will actually be heard. That work exists on an unmerged branch; see **B26**.
- **Blocked by** — nothing. Closed.
- **Evidence (as found)** — `regression_runs` (`source='vercel-cron'`): `failed=6, passed=47` every day
  sampled 2026-09-04 → 2026-09-17; the earliest failing run in the table is **2026-07-12**.
  `api/cron-regression-suite.js:22` calls
  `require('./_lib/telegram-gate').install('cron-regression-suite')`; that job name does not
  appear in the `ALWAYS_ALLOW` set at `api/_lib/telegram-gate.js:56-105`. Line `:475` sends on
  RED unconditionally with no delta requirement, and on 2026-09-10 a real PASS→FAIL delta on
  `cron.cron-deadline-reminders` still recorded no alert.
  **Caveat worth stating:** `:444` writes `alert_sent: false` into the row *before* the send is
  attempted and never patches the real value back (it appears only in the HTTP response at
  `:497`), so that column proves nothing on its own — the conclusion rests on the gate wiring.
- **Impact** — A permanently-red suite is indistinguishable from a green one, so a new
  regression lands invisibly. The exact pattern `feedback_silent-failure-is-the-enemy.md` exists
  to prevent, inside the system built to prevent it.
- **Effort** — ~30-60 min for the gate entry plus the `alert_sent` write-back.
- **Blocked by** — agent. The live value of `TELEGRAM_CRON_NOTIFICATIONS` is a Vercel *Sensitive*
  var — **Heath** should read it to learn how much else is suppressed (see D7).
- **Confidence** — Gate wiring and failure history verified now; actual suppression depends on
  that unreadable env value — **unverified**.
- **FIXED 2026-09-17 — originally landed on branch `fix/b3-regression-alerting`; MERGED to
  `origin/main` the same day as `f2cb04b9` → `e77aa7d6`. (The "not merged, not deployed"
  wording that used to be on this line was true for a few hours and is no longer.)**
  Three changes, which only work as one:
  1. `cron-regression-suite` added to `ALWAYS_ALLOW` in `api/_lib/telegram-gate.js`.
  2. Alert policy extracted to `api/_lib/regression-alert-policy.js` and made **delta-based**:
     it fires on a change to the failure set (PASS→FAIL, FAIL→PASS, new-and-failing) or a
     return to green, plus one "still failing" reminder every `REGRESSION_REMINDER_HOURS`
     (default 168h). Replayed against the real 9/06→9/17 rows that is **2 alerts, not 12** —
     the 9/10 regression and the 9/11 recovery. Un-gating without this would have shipped a
     daily 🚨 with an identical body, i.e. the same blindness with extra steps.
  3. `alert_sent` is now truthful: the insert uses `Prefer: return=representation` to get the
     row id, and the real outcome is PATCHed back afterwards — including on failure and on
     gate suppression. `sendTelegram()` no longer treats `res.ok` as delivery; it checks
     `wasSuppressed()`, since the gate returns a fake 200. `notes` carries the reason
     (`alert: failure_set_changed: delivered`, `alert: ... suppressed_by_telegram_gate`, …).
  Tests: `npm run test:regression-alerting` (30 assertions, `node --test`). The gate test
  asserts the outcome across **every** value `parseMode()` recognises, so the answer no longer
  depends on the unreadable env var — the only value that still silences this alert is
  `strict`. That remains the one open unknown, and D7 still stands for everything else.

### B4. Two of the six standing regression failures look miscalibrated, not real
- **Evidence** — `cron.cron-platform-health-checker` fails as "stale: 11.0h ago (max 4h)", but
  the cron is `0 14-23/2 * * *` and last ran ok at 16:00 today — a 4h threshold on a 6h+ job.
  `db.email.morning_brief_recent` fails as "no `morning_brief_email_log` in 30h", but that table's
  newest row is today 12:01 while the suite evaluates at 09:00 UTC. The other four are real:
  `api.health.create_checkout_session` sends a stale plan name and gets
  `400 plan must be 'solo' or 'team'`; `cron.cron-alert-health` has no `cron_runs` row at all;
  `db.freshness.audit_logs` is A2; `db.testimonial.no_stale_drafts` finds 2 genuinely stale rows.
- **Impact** — Miscalibrated assertions are why a red suite got normalised.
- **Effort** — Hours.
- **Blocked by** — agent.
- **Confidence** — Verified now.

### B5. The UI/Playwright tier of the regression suite has no scheduler
- **Evidence** — `scripts/daily-regression-suite/_lib/ui-tests.mjs` (192 lines, 7 tests) runs
  only from `run.mjs`. `grep -rl "daily-regression-suite" --include=*.cmd --include=*.ps1
  --include=*.vbs scripts/` → **empty**. `api/cron-regression-suite.js:5` states the Playwright/UI
  tier is excluded. `regression_runs` rows with `source='local-playwright'` are hand-run and
  irregular (9/08, 9/15, then 4× on 9/17). The manifest targets 117 test points; the cron runs 53;
  all 118 manifest checkboxes are `[ ]`. The richest local run today showed 7/74 failing,
  including `db.orphans.documents_transaction` (**33 orphan documents**) and
  `db.orphans.action_items_transaction` (3) — real data-integrity failures on the same swallowed
  alert path.
- **Effort** — ~1 hour for a scheduled `.cmd`.
- **Blocked by** — agent writes it; **Heath** registers the Windows scheduled task.
- **Confidence** — Verified now.

### B6. No Playwright/Vitest CI gate — the memory claim is confirmed
- **Evidence** — `.github/workflows/` contains exactly one file, `trec-validator-tests.yml`.
  `package.json` has no `test` script. `playwright` is a dependency with no CI job.
- **Impact** — Self-improvement item #2 ("regression CI gate that blocks failures on every
  merge") was specced in July and never built.
- **Effort** — Days.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### B7. `api/approve-heath-action.js` marks actions done without executing anything
- **Evidence** — `api/approve-heath-action.js:73` — `// TODO: trigger downstream action wiring
  based on action_type.` sits directly after the row is set to
  `status:'done', approved_at, completed_at`, then returns `{success:true}`. A second, competing
  route `api/heath-actions-approve-execute.js` genuinely executes `send_email` via Resend and
  returns 501 at `:195/:197/:199` for `send_telegram`, `process_refund`, `execute_purchase`.
- **Impact** — Internal Jarvis ops. Tapping Approve records completion and does nothing.
- **Effort** — Hours (pick the surviving route, delete the other).
- **Blocked by** — agent, after confirming which route the Jarvis PWA calls.
- **Confidence** — Stub verified now. **Which route is live is unverified** — the HTML grep timed
  out twice against the WSL/NTFS mount.

### B8. Timeline drops `esign` and `showingtime` notes — two paid add-ons write invisible entries
- **Evidence** — `Dossie/dossie-app.jsx:10855` filters `notesLog` on `n?.source === "email"`;
  the same filter repeats at `:7088, :10641, :10643, :10875, :13407`.
- **Impact** — Customers paying for Email Integration and ShowingTime see nothing from them in
  the activity feed. Flagged 2026-08-31, untouched.
- **Effort** — One-line class.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### B9. `help-pages.js` and `whats-new.js` have zero consumers
- **Evidence** — Both routes exist in `api/`. Grep across `Dossie/dossie-app.jsx` and
  `Dossie/src` returns zero references to either.
- **Impact** — 8 finished help articles no member can reach.
- **Effort** — Hours to a day.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### B10. `EmptyStateHint.jsx` is built and never rendered
- **Evidence** — `Dossie/src/components/EmptyStateHint.jsx` — the only reference to its own name
  across `src/`, `dossie-app.jsx`, `main.jsx` and `marketing-os*.jsx` is its own `export default`
  on line 3. From commit `0e9bdfb` "SV-ENG-ACTIVATION-001-v1-frontend: EmptyStateHint + HelpView
  + help articles" — HelpView shipped, this never got mounted. Same half-landed activation push
  as B9.
- **Effort** — Hours.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### B11. In-app roadmap contradicts itself on Compliance Vault
- **Evidence** — `Dossie/dossie-app.jsx:6844` lists "Compliance Vault (add-on)" in the ✓
  works-today list; `:6882` lists `{ quarter: "Q4 2026", item: "Compliance Vault + MLS
  integration" }`. (The 2026-08-31 audit cited `:6659`/`:6697`; the lines moved, the
  contradiction did not.)
- **Effort** — One line.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### B12. The tree the Windows Task Scheduler runs from is 65 commits behind production
- **Evidence** — `git log HEAD..origin/main --oneline | wc -l` → **65** (52 against local `main`).
  `scripts/run-tc-discovery-harvest.cmd` does `cd /d "C:\Users\Heath\Projects\MeetDossie"` then
  runs ~9 node scripts from this tree. Stale vs `main`: `scripts/fb-group-commenter.js` −124
  lines; `scripts/_lib/auto-reply-kill-switch.js` −170 lines, and the tree's copy is
  **file-backed** (`.auto-reply-kill-switch.json`) while `main`'s is **DB-backed**
  (`public.ops_flags`, key `auto_reply`) — two sources of truth for a safety switch;
  `run-tc-discovery-harvest.cmd` −32 lines and **missing Step 10 entirely**, which is
  `node scripts\detect-scheduled-script-drift.js` — the detector written 2026-09-16 for exactly
  this failure. `api/_lib/cron-sanity.js`, `social-goals.js` and `social-goals-progress.js`
  exist on `main` but not here, so `node -e "require('./api/_lib/silence-alarm.js')"` throws
  `MODULE_NOT_FOUND` (tested).
- **Impact** — Every locally-scheduled FB/LinkedIn/listing automation runs last week's code,
  including a kill switch reading the wrong store. Production (Vercel, built from `main`) is fine.
- **Effort** — Minutes to fix, but it is a branch switch on a tree with 1,201 dirty entries.
- **Blocked by** — **Heath.** Do not let an agent check out `main` here unattended.
- **Confidence** — Verified now.

### B13. One finished, uncommitted test guarding a real 2026-09-14 incident
- **Evidence** — `git diff --stat main -- scripts/daily-regression-suite/` →
  `_lib/api-tests.mjs +47`, `manifest.md +1`; `node --check` passes. The test
  `unit.video_only_gate.blocks_text_only_all_platforms` asserts `checkVideoOnlyGate()` blocks
  text-only and static-image posts across all 6 platforms. Not on `main`. It guards the incident
  where facebook/twitter/linkedin published text-only daily because the gate was an
  Instagram-only allow-list.
- **Effort** — Minutes (via a worktree or cherry-pick — the tree is fragile, see B12).
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### B14. The `wip:` rescue commit was never rebased or reviewed
- **Evidence** — `63609cc0` (2026-09-16), 323 insertions across 6 files, its own message reads
  *"Needs rebase onto current origin/staging and review before merge — not evaluated for
  correctness here."* Its base is 65 commits behind `origin/main`, and
  `api/_lib/silence-alarm.js` has changed again on `main` since (`0f128301`, 2026-09-17), so it
  will conflict. A parallel check found the remaining staged files are either byte-identical to
  `main` or **older** than it (net −292 lines) — so most of the "uncommitted WIP" is a stale-tree
  artifact, not pending work.
- **Effort** — Hours (rebase, diff against `main`, keep or drop).
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### B15. Three abandoned branches with unmerged commits
- **Evidence** — MeetDossie `claude/content-engine-sage-editor-02dua8` (2026-08-06, 4 unmerged),
  MeetDossie `merge-work-main` (2026-08-22, 1), Dossie `tmp-merge-test2` (2026-08-13, 3).
  Everything else on MeetDossie is 2026-09-16/17 and active. Plus ~24 `worktree-agent-*` scratch
  branches, `main-tmp`, `merge-final`, `atlas-push-0916`, `fix-staging-bundle`, and 73 leftover
  directories under `.claude/worktrees/`.
- **Effort** — Minutes to triage.
- **Blocked by** — agent proposes; **Heath** approves the deletions.
- **Confidence** — Verified now.

### B16. Script sprawl — 1,440 files in `scripts/`, 743 `brokerage-*`, ~500 untracked
- **Evidence** — `ls scripts/ | wc -l` → 1,440; `grep -c '^brokerage-'` → 743 (memory recorded
  669 on 2026-09-10 — still growing); 1,103 untracked under `scripts/`, including 80 disposable
  `wc-cma-*.js` one-offs.
- **Impact** — Every new deal restarts at probe 01 and rediscovers the same UI. Heath explicitly
  **PARKED** this until the insurance shopping finishes; tracked as `jarvis_todos`
  `fe750c05-938c-4e68-8b31-31180ef4d336`.
- **Effort** — Days.
- **Blocked by** — **Heath** (explicitly parked — do not start unasked). Note step 1 of that plan
  (persistent-profile login in `_lib`) is already done; see "Verified resolved."
- **Confidence** — Verified now.

### B18. `api/reply-monitoring-status.js` carries a stale warning that will cause a bad call
- **Evidence** — Its block comment on `main` says the cron "only ever watches ONE mailbox
  (heath.shepard@kw.com, hardcoded)… do not grant this add-on to a real paying customer." That
  is obsolete: `api/cron-email-to-dossier.js:19` is marked "MULTI-TENANT (2026-08-22)", with
  `runForCustomer({userId, email})` at `:212`, per-user checkpoints at `:71-85` and per-user deal
  loads at `:107-109`. A 2026-09-16 edit to `reply-monitoring-status.js` carried the stale
  warning forward untouched.
- **Impact** — A comment in the codebase currently tells any agent not to sell a $15/mo add-on
  that appears to work. The genuinely open question is C21 (Google CASA), which is Heath-only.
- **Effort** — Minutes.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### B19. `/workspace` is a byte-identical duplicate of `/app`
- **Evidence** — `app.html` and `workspace.html` reference the same bundle filename
  (`workspace-C_206Lx0.js` on `origin/main`).
- **Impact** — `/workspace` is positioned as a team surface and is not one.
- **Effort** — Days.
- **Blocked by** — agent builds; **Heath** decides what `/workspace` should be.
- **Confidence** — Verified now.

### B20. CMA generation is not built for members
- **Evidence** — No CMA route anywhere in `api/`; confirmed unchanged since the 2026-08-31
  capability audit.
- **Impact** — Explicitly deferred capability. The shippable half ("upload your MLS sold-comps
  export → Dossie does the analysis") reuses the `scan-contract.js` pattern and needs no MLS
  data licence.
- **Effort** — ~1 week for the shippable half.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### B21. Brokerage compliance submission is still email-a-packet only
- **Evidence** — Only `api/send-compliance-packet.js` and `api/send-compliance-email.js` exist;
  no KW Command integration. The full flow and reference architecture are already captured in
  `dossie-compliance-upload-capability.md` (Joe Sloan's verbatim steps, `.tmp/command-recon/`).
- **Impact** — Heath named this a product capability on 2026-08-29; it is the most-delegated part
  of a TC's job and the concrete form of the Door-A pitch.
- **Effort** — ~1 week for the "brokerage-checklist-named ZIP" half.
- **Blocked by** — agent, Heath gates merge. ("Submit to MC" stays a human click by design.)
- **Confidence** — Verified now.

### B22. Member SMS capture is not built
- **Evidence** — No Twilio/Telnyx dependency anywhere in either repo.
- **Impact** — Explicitly deferred. The manual "log a text exchange" path is buildable now; a
  real deal line needs 10DLC registration per member (1-3 weeks, carrier-side), so the clock has
  to start early. Full design and compliance gates are in
  `dossie-client-texting-build-2026-09-14.md`.
- **Effort** — Days for the manual-log path; ~11.5 engineering days for the full build.
- **Blocked by** — **Heath.** The TREC legal call, the Hiscox E&O call, and the per-member vs
  one-Dossie-brand 10DLC decision are all open and all his.
- **Confidence** — Verified now.

### B23. Dossie source and the deployed bundle drift, and nothing detects it
- **Added 2026-09-17.** Found while reconciling B17, which is the live instance of this class.
- **What** — The two-repo deploy (build in `Dossie`, ship a built bundle from `MeetDossie`) has
  **no check that the shipped bundle was built from current `Dossie` source**. A fix can be
  written, reviewed, committed and merged in `Dossie` — with a clean tree and a green history —
  and still not be running for a single member, because step 3 of CLAUDE.md §3 (copy the bundle)
  was never done.
- **Evidence** — 2026-09-17: `Dossie` `main` contains the P0 dossier-save fix (`f244745`, merged
  `a009d08`), working tree clean. `MeetDossie` `origin/main` ships
  `assets/workspace-C_206Lx0.js`, referenced by `app.html` and `workspace.html`, and that file
  contains **zero** occurrences of `persistResult`, the identifier the fix introduces. A
  member-facing data-loss fix was merged and is not deployed, and nothing anywhere reported that.
- **Impact** — This silently converts "merged" into "shipped" in every status report, including
  this document's own. It is `feedback_silent-failure-is-the-enemy.md` applied to the deploy
  path itself: the gap is invisible from either repo alone.
- **What to build** — A check that fails loudly when the two disagree. The cheapest honest
  version: a regression-suite assertion (the suite's alerts now actually fire — see B3) that
  rebuilds `Dossie` and compares the output hash against the bundle `app.html` references, or
  at minimum records `Dossie` HEAD in the bundle at build time and asserts it matches
  `Dossie origin/main`.
- **Effort** — Hours for the recorded-HEAD version; ~a day for a real rebuild-and-compare.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified 2026-09-17 (bundle extracted from `origin/main` and grepped; both
  repos inspected).

### B24. ¶5.A option-fee / earnest-money reminders suppress on self-report — fix written, NOT merged, migration NOT run
- **Added 2026-09-17.** Found incidentally by the B1 deadline agent, then confirmed and fixed.
- **What** — `cron-deadline-reminders` stopped chasing the TREC ¶5.A option fee as soon as
  `option_fee_paid_at` was set. That column is **not a receipt** — the workspace stamps it with
  the *upload time* whenever an executed contract is scanned and ¶5.A shows any option fee
  amount. So the reminder went quiet on day zero, before anything was delivered. Earnest money
  had the identical defect: suppression was `(deposited_at || confirmed_at)`, and `deposited_at`
  is the same upload-time auto-stamp, so the self-reported half always won.
- **Why it matters** — This is the Low Oak shape (`friday-execution-option-fee-trap.md`, $5,200).
  In Texas a late option fee costs the buyer the unrestricted right to terminate. Dossie went
  quiet exactly when an agent most needed chasing.
- **Also uncovered** — the *test* asserted suppression on `option_fee_receipt_date`, which is a
  TREC 20-19 AcroForm field key on the page-11 receipt block, **not a column on
  `public.transactions`**. Naming it in a PostgREST select is what 500'd this cron on every run
  for a week (`fe4311b2`) — **zero deadline reminders for all 10 active customers**. The spec
  and the `20260903` migration comment both stated it was a column; that false claim is what
  propagated into shipped code.
- **State** — Fix is commit `dbe64c50` *fix(deadline-guardian): suppress ¶5.A funds reminders on
  confirmed receipt only*, on worktree branch `worktree-agent-a00ceddc509a284e8`. **Not on
  `origin/main`. Not deployed. Not migrated.** Tests 19/19.
- **Three things must land together, and the commit says so explicitly:**
  1. Merge `dbe64c50`.
  2. Run `api/admin-migrate-option-fee-confirmed-at` (migration `20260917e`, adds
     `transactions.option_fee_confirmed_at`) **before or with** the deploy.
  3. The workspace UI field for `option_fee_confirmed_at` **lives in the `Dossie` repo and is
     still outstanding** — without it there is no way for a member to record confirmed receipt,
     so suppression can only ever come from `scan-contract`'s automatic promotion of the
     OPTION FEE RECEIPT box.
- **Effort** — Hours to merge and migrate; the Dossie UI field is a small separate change.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified 2026-09-17 (commit read in full; confirmed absent from `origin/main`).

### B25. Chat panel leaves stale off-screen Send buttons in the DOM; a click landed in the Generate+Sign modal
- **Added 2026-09-17.** Found by QA while verifying the B1 deadline fix on production (demo
  account, dossier #011). Tracked in `jarvis_todos` the same day.
- **What** — The chat panel's DOM returns multiple stale/off-screen `Send` buttons from earlier
  scrollback. A click intended for the live Send button mis-fired into a **Generate + Sign**
  modal. No data was touched and nothing was sent in that instance.
- **Impact** — Beyond the automation that found it: if a stray click can land in a signing flow,
  a member's thumb can do the same on a phone, and the destination modal starts document
  generation and signature collection. That is not a harmless place to land a misdirected click.
- **Effort** — Small — unmount or aria-hide scrolled-out chat rows, or scope the Send handler to
  the live composer.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified 2026-09-17 by QA on production. **Not** re-reproduced during this
  reconciliation pass — **unverified** by me directly.

### B26. Today's contract-safety tests are not wired into the daily suite — branch unmerged
- **Added 2026-09-17.** This is the alarm half of the contract work done today, and it is the
  half that rots first if left.
- **What** — Neither the pre-existing TREC tests nor the 35-test election-gate suite (see C23)
  run from the daily regression suite, so a future edit to a rules file can silently disarm the
  contract safety gate.
- **State** — `e58f7378` *feat(regression): wire contract-safety checks into the daily suite
  (53 → 63)* on branch `feat/wire-contract-safety-into-daily-regression`. **Not merged.**
- **Dependency** — This only became worth doing because **B3** landed today: before that, a
  failure in these checks would have been swallowed by the Telegram gate like everything else.
  Wiring tests into an unwatched suite would have been theatre.
- **Effort** — Small — the work is written; it needs staging, a Quinn gate and a merge.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified 2026-09-17 (branch and commit confirmed present and unmerged).

---

## C. DossieSign / e-sign

*Most of the point-in-time e-sign docs are stale **in Dossie's favour** — the Send button, the
packet, the initials geometry, the audit-trail storage and the draft merge all shipped between
8/16 and 9/11. The remaining problems are different and sharper than the docs say.*

### C1. Real signatures now reach the product — WRITE-BACK SHIPPED 2026-09-17; the DoD gate is still Heath's
- **STATUS 2026-09-17 — the agent half is done and verified; the item stays open on Heath's half.**
  - **Shipped to `origin/main`:** `003616c7` *feat(esign): write real CLI signature sends back
    into Dossie [C1]*, merged as `f8c03d1e`, plus migration
    `20260917213805_signature_requests_suppress_notifications` (the webhook notification guard,
    so backfilled rows don't fire member-facing notifications).
  - **Verified live 2026-09-17, after the fact:** `signature_requests` grouped by status now
    reads **33 `sent`, 5 `completed`**. It was **33 `sent`, 0 `completed`** when this item was
    written. The verification leg has now been handed real completions for the first time —
    the five Ridge Bluff amendments.
  - **Still open, and it is not engineering:** Heath consenting to route one real deal through
    the product path end to end, and the `real_deal_closed` rows in `dossie_sign_dod_progress`
    flipping. All 8 red DoD rows remain the human-gated ones.
- **Do not re-dispatch an agent at the write-back.** It exists. The only thing left on C1 needs
  Heath.
- **Evidence (as found, before the fix)** — Live DocuSeal API (read-only GET, this session): **35 submissions
  `status=completed`**, including Heath's five Ridge Bluff amendments 9/15–9/16 (submission
  `11272607` completed 2026-09-16 21:51, audit-log PDF present). Live Supabase:
  `signature_requests` = **33 rows, all `status='sent'`, 0 completed**;
  `documents where document_type='signing_certificate'` = **0**. Cross-referencing the 35
  DocuSeal completion ids against all 33 tracked `docuseal_submission_id` values gives **zero
  overlap**. Five tracked submissions were spot-checked at DocuSeal (`11078767`, `11079150`,
  `10496882`, `9320887`, `9231951`) — all genuinely still pending, all addressed to
  `heath.shepard@kw.com`, `quinn-qa-*` or `demo@meetdossie.com`. They are test sends nobody
  finished. Separately, `dossie_sign_dod_progress` reads 64 green / 8 red, and all 8 reds are the
  human-gated `real_deal_closed` rows.
- **Impact** — The webhook/verify/certificate leg is not proven broken; it has simply **never been
  handed a completion**. The differentiating capability — independent verification that a
  document was really signed — has never run on a real signed document. Meanwhile
  `scripts/send-trec-amendment.js` collects real signatures daily and writes no
  `signature_requests` row, so the product learns nothing: no executed PDF in Storage, no
  certificate, no gate movement.
- **Effort** — The ~0.5 day write-back is **done**. What is left is not engineering effort.
- **Blocked by** — **Heath.** He consents to routing one real deal through the product path and
  flips `real_deal_closed`. *(This field used to read "agent for the write-back; Heath …". The
  agent half shipped 2026-09-17, so that wording would now send an agent at finished work.)*
- **Confidence** — Original finding verified (live DocuSeal API + live DB, cross-referenced).
  Fix verified live 2026-09-17 by re-querying `signature_requests` (0 → 5 completed).

### C2. No envelope lifecycle — no resend, void, remind, expire, or signing order
- **Evidence** — Full e-sign route list on `origin/main`: `esign-create`, `esign-status`,
  `esign-download`, `esign-webhook`, `esign-templates`, `esign-verify-document`,
  `esign-draft-handoff`, `esign-send-handoff`, plus `dossiesign-*` map endpoints. Grep for
  `esign-remind|void|cancel|resend` → zero. The `esign-create.js` submission body sends no
  `order` field, while `scripts/send-trec-amendment.js:126` does pass `order: 'random'`.
- **Impact** — A stuck signer has no recourse short of Heath opening DocuSeal by hand — the exact
  situation that cost a day on 2026-08-30.
- **Effort** — ~1 week.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### C3. Seller-side send is impossible in the main flow
- **Evidence** — `Dossie/src/components/DossieSignModal.jsx:360-410, 449-471` builds signers as
  Buyer + Co-Buyers + optional Agent. `grep -ic seller` on that file → **0**.
- **Impact** — Blocks every listing-side use of the one working send path. Heath's own business is
  listing-heavy.
- **Effort** — ~1 day.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### C4. Per-agent contract defaults are not built
- **Evidence** — Zero hits for `contract_defaults` / `default_option_fee` in `api/` on
  `origin/main`; zero contract-defaults UI in the Dossie repo. `api/fill-form.js:4234-4300` reads
  `profiles` only for identity and brokerage (name, phone, email, licence, broker block, Wire
  Fraud footer). None of the 8 standing preferences in `dossie-per-agent-contract-defaults.md`
  (survey 25 days, title at Seller's expense, 2.5%/3% commission, 49-1 Option 3, TPFA
  30yr/1% cap/15 days, ¶7 As-Is, possession on closing+funding, water 14 days) has storage, a
  settings surface, or an engine read.
- **Impact** — Better than feared: the 20-19 engine is explicit-value-only, so members are **not**
  silently getting Heath's defaults. The real cost is that every member retypes everything on
  every deal.
- **Effort** — ~1 week.
- **Blocked by** — agent for the build; **Heath** signs off the taxonomy.
- **Confidence** — Verified now.

### C5. No bulk "initial every page" tool in the field-placement UI
- **Evidence** — `Dossie/src/components/EsignModal.jsx:89` has a single `initials` field type,
  placed one at a time. No `all pages` / `allPages` / `bulk` / `every page` string in that file or
  in `dossieSign/FieldOverlay.jsx`.
- **Impact** — Initials are required on every page for every signer
  (`esign-packet-send-playbook.md`). This is the slowest part of prepping a packet, and the
  Authentisign pattern Heath explicitly asked to mirror.
- **Effort** — ~2 days.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### C6. The pre-send field audit blocks on text fields only — checkbox elections are never blocked
- **Evidence** — `api/_lib/pre-send-field-audit.js` plus `api/fill-form.js:4461-4486` implement a
  real 422 block. But the audit's own header (`:22-36`) states coverage is limited to fields
  `fill-trec-20-19.js` draws with a stable semantic name; **checkbox elections
  (`financing_type`, `title_policy_paid_by`, ¶7 branches) are reported `untracked` and never
  blocked.**
- **Impact** — Checkbox elections are exactly where the false-attestation class lives, and exactly
  what `feedback_verify-contract-elections-before-execution.md` exists for (the Pfeiffers contract
  executed with ¶7D blank). The guard does not cover the dangerous half.
- **Effort** — 2-3 days.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### C7. The e-sign field-map regression scripts are invoked from nowhere
- **Evidence** — `scripts/regression-esign-field-maps.js` (hash-pins each form's blank PDF
  sha256, checks initials coverage, exercises the 422 gate) and
  `scripts/regression-trec-20-19-esign-coords.js` appear in no `package.json` script, not in
  `scripts/daily-regression-suite/manifest.md`, and on no cron. The only repo reference is a
  comment at `api/esign-create.js:294`.
- **Impact** — Product gate #2 from `acroform-field-names-lie.md` — a build-time check that a
  mapping's widget rect actually sits beside its claimed printed label — was written and never
  wired. The day TREC republishes a form, the field map silently goes stale again. That is the
  failure class that produced the false legal attestation.
- **Effort** — ~1 hour to add both to the suite/CI.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### C8. Semantic field maps are one form deep
- **Evidence** — The only human-reviewed semantic map is
  `api/_lib/trec-20-19-transaction-field-map.js`, plus `txr-1101` coords. The other ~23 AcroForm
  maps in `api/_assets/` are geometry only, so `InteractiveEditor` exposes roughly one editable
  key (`property_address`) on almost every addendum.
- **Impact** — Gap #1 of the productization plan. A member can generate an addendum but barely
  edit it.
- **Effort** — Days per form family.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### C9. A superseded TREC 20-18 template id is still live in `esign-create.js`
- **Evidence** — `api/esign-create.js:169` — `const RESALE_TEMPLATE_ID = 4018208;` with a
  comment at `:167` saying it is "kept as a legacy id in case a caller still…". `:2001` says
  "Resale contracts NO LONGER route through template 4018208 (Path B rollback)", yet `:2079`
  still branches on `Number(effectiveTemplateId) === RESALE_TEMPLATE_ID`.
  `api/_assets/docuseal-prefill.js:17-18` still maps `'resale-contract' → 4018208` and is
  `require()`d at `api/fill-form.js:27` — though the `fill-form.js` path is dead (see Verified
  resolved).
- **Impact** — If any caller still reaches the legacy branch, a member sends a superseded
  promulgated form. That is a TREC compliance problem, not tidiness.
- **Effort** — ~2 hours to trace and remove.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Code state verified now; **live reachability not traced** — treat as
  can't-tell until it is.

### C10. `backup-contract` fills one revision and previews another
- **Evidence** — `api/fill-form.js:90, 269-274, 4044` fills TREC **11-8**;
  `api/_lib/resolve-blank-template-pdf.js:49` serves the **11-9** blank for preview. The same bug
  class was already fixed for 23-20, 24-20 and 25-17 — this one was missed.
- **Impact** — A member previews one revision and signs another.
- **Effort** — ~1 hour.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### C11. `tar-buyer-rep-base64.js` is a 1,325-byte placeholder shipping as the real TAR 1501
- **Evidence** — The asset is 1,325 bytes (the other TAR assets are 131-275 KB).
  `api/fill-form.js:178` — "Replace … with the real TAR 1501 PDF." `fillBuyerRepAgreement`
  (`fill-form.js:2784`) and DocuSeal template `4984939` both ship as if it were real.
- **Impact** — A member generating a buyer representation agreement gets a blank stub.
- **Effort** — ~1 hour once the licensed PDF exists.
- **Blocked by** — **Heath** (access to the licensed TAR form — which is also A6).
- **Confidence** — Verified now.

### C12. `fillT47Affidavit` field names are self-declared best-guess
- **Evidence** — `api/fill-form.js:2870` states the field names were never verified against the
  real AcroForm.
- **Impact** — Same class as the 16 mismapped 9-17 fields in `acroform-field-names-lie.md`. A T-47
  affidavit is a sworn statement.
- **Effort** — ~2 hours (render the page, read the widget rects).
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### C13. DocuSeal template leak — a clone per send, no reaper
- **Evidence** — `api/esign-create.js:1359` — `// TODO(atlas): add a cron to reap
  completed-envelope clones.` The live account carries 100+ templates (paginated). The fast-path
  script adds one per amendment too (`send-trec-amendment.js:105`).
- **Impact** — Cost, plus a template list nobody can navigate.
- **Effort** — ~3 hours.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now (live API).

### C14. Three `DOCUSEAL_TEMPLATE_*` env vars are set in production and read by no code
- **Evidence** — `DOCUSEAL_TEMPLATE_AMENDMENT`, `DOCUSEAL_TEMPLATE_OPTION_EXT`,
  `DOCUSEAL_TEMPLATE_PRICE_CHANGE` are set in Vercel Prod (CLAUDE.md §19) but referenced by zero
  lines. Only `DOCUSEAL_TEMPLATE_RESALE_ID`, `DOCUSEAL_API_KEY` and `DOCUSEAL_WEBHOOK_SECRET` are
  read. `api/esign-templates.js:21-23` documents them as optional-with-stub; the reads were removed.
- **Impact** — Dead config. Changing one does nothing, silently.
- **Effort** — 15 minutes.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### C15. There is no observability on the DocuSeal webhook
- **Evidence** — No `*_webhook_events` table exists for DocuSeal (only `stripe_webhook_events`).
  If the webhook URL were unregistered or failing, nothing would surface anywhere.
- **Impact** — Directly against `feedback_silent-failure-is-the-enemy.md`, on the one integration
  that carries legal weight. It also means C1 cannot be diagnosed further without guessing.
- **Effort** — Hours.
- **Blocked by** — agent for the logging. **Heath** must confirm the webhook is registered —
  DocuSeal's `/webhooks` API returns 404, it is dashboard-only.
- **Confidence** — Schema absence verified now; webhook registration **unverified**.

### C16. Roughly 1,900 lines of e-sign code are built and unreachable
- **Evidence** — Each checked against the deployed bundle (`assets/workspace-*.js`) and by
  repo-wide grep:
  - `api/esign-draft-handoff.js` (249 lines) + `api/esign-send-handoff.js` (219) — bundle grep 0,
    no in-repo caller. This is the three-gate "send the executed document to the counterparty
    agent, only with approved wording, only if signatures verified" workflow. The highest-value
    orphan on the list.
  - `Dossie/src/components/DossieSignEditor.jsx` + `dossieSign/{FieldOverlay,FieldSidebar,
    FieldToolbar}.jsx` (~720 lines) — the route `/dossie-sign/editor?job_id=…` exists
    (`main.jsx:14`) but nothing links to it, and its Approve handler (`:275-296`) posts to
    `api/dossiesign-approve-field-map.js`, which is a deliberate **410 Gone** (`:63-70`).
  - `Dossie/src/components/dossieSign/GapWizardVoice.jsx` (434 lines) — zero imports repo-wide.
  - `api/fill-form-via-docuseal.js` — bundle grep 0; only regression scripts call it; `:344`
    "Only resale-contract is supported for now."
  - `api/esign-download.js` — bundle grep 0, no in-repo caller.
  - `api/admin-dossiesign-auto-map-preview.js` — no caller; its own docstring says the admin UI
    "is a follow-up" that was never built.
  - `api/dossiesign-auto-map.js` returns 410 Gone but is still listed in `vercel.json:371`.
- **Impact** — Each needs one decision: wire it or delete it. Leaving them is how a codebase stops
  being legible, and the handoff pair is genuinely valuable.
- **Effort** — Days across all of them.
- **Blocked by** — agent, Heath gates merge (he decides whether the handoff workflow ships).
- **Confidence** — Verified now. Whether `esign-draft-handoff` / `esign-send-handoff` are called
  by anything **outside** this repo is unverified.

### C17. `EditorFieldSidebar` ships a "coming soon" Phase 2 placeholder to live members
- **Evidence** — `Dossie/src/components/dossieSign/EditorFieldSidebar.jsx:356`
  `{/* Phase 2 will replace this stub with the context-aware Ask Dossie chat. */}` and `:360`
  "Chat-driven edits are coming soon."
- **Impact** — Live UI text promising an unbuilt feature. Against
  `dossie-demo-must-match-real-capability.md`.
- **Effort** — Hours (remove it, or build it).
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### C18. The DossieSign DoD loop has run 5,691 times to accomplish nothing
- **Evidence** — `dossie_sign_dod_runs`: **5,691 runs**, 504 in the last 7 days, last
  2026-09-17 17:00. All 72 gates: 64 green, 8 red — and **all 8 reds are the human-gated
  `real_deal_closed` rows the loop is explicitly designed never to dispatch against**
  (`docs/DOSSIE-SIGN-DOD.md:89`). It also still tracks superseded **TREC-20-18** and **TREC-39-10**.
- **Impact** — A cron firing every 20 minutes for months with no reachable work, on a board that
  tracks two dead form revisions.
- **Effort** — Hours (pause it, or repoint it at the current form set).
- **Blocked by** — **Heath** decides whether to pause or repoint; agent executes.
- **Confidence** — Verified now.

### C19. Form-version integrity is not actually checked
- **Evidence** — `api/cron-trec-scanner.js:71,308` hashes **HTML page text only**, never a form
  PDF's bytes. `form_templates.trec_effective_date` is populated on **1 of 29 rows** — identical
  to the 2026-08-15 figure, so no movement in a month.
- **Impact** — The mechanism meant to notice TREC republishing a form cannot notice a PDF change,
  which is the only change that matters. Pairs with C7.
- **Effort** — ~2 days.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### C20. One shared personal DocuSeal account serves every member
- **Evidence** — A single `DOCUSEAL_API_KEY`, no per-tenant provisioning anywhere in `api/`.
- **Impact** — One suspension takes down every member's legal record. Not urgent at 10 paying
  customers; it must exist before scale.
- **Effort** — Subsystem.
- **Blocked by** — **Heath** (account tier / self-hosting spend).
- **Confidence** — Verified now. *Related and unresolved:* the 2026-09-01 integration plan §8.1
  warned the account was a Developer Sandbox that must be upgraded before any real signer. A real
  counterparty completed submission `11272607` on 9/16, so signing works — but the tier could not
  be read via API. **Heath should confirm it in the dashboard**; a sandbox banner on a client's
  signing page is a 30-second check worth making.

### C21. Google CASA verification status is unconfirmed on a $15/mo paid add-on
- **Evidence** — `docs/AUDIT-REMEDIATION-PLAN-2026-09-10.md` item 15. The Gmail/Outlook Connect
  buttons and OAuth backend are live in production; the consent-screen publishing status for
  `gmail.readonly` / `gmail.send` / `gmail.compose` has never been checked either way.
- **Impact** — A paid add-on that may hit a hard Google cap around ~100 connected accounts. CASA
  assessment takes weeks, so it is a calendar dependency that has to start early.
- **Effort** — Not engineering.
- **Blocked by** — **Heath** (Google Cloud Console, his account).
- **Confidence** — **Unverified** — inherited, not re-checked.

### C22. TREC 20-19 has no CI coverage; the only workflow covers the superseded 20-18
- **Evidence** — `.github/workflows/trec-validator-tests.yml` is the sole workflow, titled "TREC
  20-18 validator tests", with `paths:` filters naming only `trec-20-18-*` / `trec-validator` /
  `fill-form.js` artifacts. Production contracts are 20-19, so a change to 20-19 geometry or
  rules triggers no CI at all.
- **Effort** — Hours to extend the filters; days to write real 20-19 golden cases.
- **Blocked by** — agent for the wiring; **Heath** owns the golden-case expected values (the
  workflow header names them his source of truth).
- **Confidence** — Verified now.

### C23. Five TREC 20-19 elections have no editor control at all; the pre-send gate is written but unmerged
- **Added 2026-09-17**, from the two contract audits run today.
- **Still completely unreachable from the editor — no control of any kind exists.** These are not
  mis-mapped fields; there is nothing for a member to click:
  **¶7B(2)**, **¶4C(1)**, **¶4B fixture leases**, **¶7I water disclosure** (the backend is ready
  and waiting; only the UI control is missing), **¶12B commission**.
- **Worst finding, and it is shipping right now.** A member who ticks ¶7B(1) *"Buyer has received
  the Seller's Disclosure Notice"* and nothing else gets a contract with **all three ¶7B boxes
  empty** — on a paragraph headed "check one box only." Reproduced through the real path and
  rendered. Cause: the editor's key names are *character-for-character identical* to the `fv`
  keys `fillTrec2019` reads, so every previous audit concluded "matches by name, nothing to do."
  They do not match by **value**: `CheckboxField.jsx` sends the **string** `'true'` and
  `fillTrec2019` gates on strict `=== true`. The identical-name case is exactly what hid it.
  This is the Pfeiffers Gate failure (`feedback_verify-contract-elections-before-execution.md`,
  29046 Pfeiffers Gate executed 2026-09-09 with ¶7D blank) in a different paragraph.
- **Partly fixed on an unmerged branch.** `49d87851` *fix(trec-20-19): 7 contract elections
  unsettable or silently dropped* on `audit/trec-20-19-unreachable-elections` fixes ¶7B,
  ¶6A(8)(i), ¶4A, ¶4C, ¶4C(2) (including a blank with no coordinate), and the ¶3B Loan
  Assumption / Seller Financing addendum boxes. Result on the same typed input: **17 → 23 of 61
  boxes correctly checked**, and with no input at all the output is byte-for-byte unchanged — no
  box auto-ticks. All four TREC 20-19 regression suites pass. **Not merged.**
- **The gate that would have caught all of this is also written and also unmerged.** `fe0b6900`
  *feat(trec): election gate — block a contract whose required box is blank* on
  `feat/contract-election-gate`. `esign-create.js` called **no** contract validator at all;
  `fill-form`'s was opt-in behind `body.strict_validate`. The gate is now wired into
  `esign-create` (both packet and single-document paths, before the DocuSeal call), `fill-form`
  (not opt-in), and the editor's persist/Send and readiness paths. Rules existed only for 20-18;
  20-19 was added. 35 new tests. Exactly two rules **block** (both ¶7D); ¶7B, ¶7I, ¶6C, ¶6E,
  ¶6A, ¶6A(8), ¶12B and ¶4C **warn**, deliberately — blocking a box nobody can check is a trap
  with no remedy, and a send stopped at 4:59pm on the last day of an option period costs a
  client their termination right just as surely as a blank box does.
  **Those warn-only rules become block-eligible once the missing controls in this item exist.**
- **A design rule both commits hold to, which any follow-up must keep** — never write `false`.
  An unticked box sends the string `'false'`, so a blanket truthy pass would have ticked the
  *opposite* election on every contract where the member left the paragraph alone. A wrong box
  is worse than a blank one: nobody looks twice at a box already ticked.
- **Needs Heath, and is deliberately NOT part of this item** — the ¶22 improvement-district row.
  The editor exposes `addendum_improvement_district_assessment`, but this 20-19 revision has no
  such addendum row; the widget sits on the *"following utility, water, drainage, public
  improvement, and other district notices"* line. Ticking it from a boolean would assert that
  district notices are attached while naming none. That is a judgment about what the control
  means, not a mapping. See **C24** for why a control exists for a row the form doesn't have.
- **Effort** — Days: five new editor controls in the `Dossie` repo, each render-verified, plus
  merging the two branches above.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified 2026-09-17 (both commits read in full; branches confirmed unmerged).
  The ¶7B reproduction is the commit author's, render-verified there, and was **not** re-driven
  by me — **unverified** at second hand.

### C24. The editor's field inventory is a never-QA'd July auto-map run, and it does not match the form being filled
- **Added 2026-09-17.** This is the *root cause* sitting under B2 and C23, which is why it is its
  own item rather than a line in either.
- **What** — The Phase 1 Interactive Editor does not hardcode its field list. It ships its whole
  field inventory — the key names it sends — straight from **one cached Fable5 auto-map row**,
  `dossiesign_auto_map_runs` id `8e3bc446-eb01-43b9-8447-6da9de22bcc7`. `FieldGroup.jsx` /
  `RadioField.jsx` render generically off whatever `key` each row carries. Documented at the top
  of `api/_lib/trec-20-19-editor-field-translate.js`.
- **That row, read live 2026-09-17:** created **2026-07-03**, `doc_name`
  `TREC-Resale-Contract-1780103076276.pdf`, `page_count` 11, `field_count` 219,
  **`requested_form_number` NULL**, **`qa_status` `awaiting_hadley_qa`**.
  - It has **never been QA-approved** — 76 days in `awaiting_hadley_qa`.
  - It **does not record which form revision it mapped.** There is no field in the row that says
    20-18 or 20-19. So the editor's entire field vocabulary has no recorded provenance.
- **Evidence that it genuinely mismatches the form being filled** — today's audit found the
  editor exposes a control, `addendum_improvement_district_assessment`, for a paragraph-22
  "Notice of Obligation to Pay Improvement District Assessment" addendum row **that does not
  exist in the 20-19 revision being filled**. A control for a row the form does not have is only
  possible if the inventory was taken from a different artefact than the one being filled.
- **Why it keeps producing defects** — the 2026-08-19 checkbox rewrite (`9aab37d6`) changed the
  key names `fill-trec-20-19.js` reads for several sections, but the July auto-map row was never
  updated, so those sections went silently blank — or, for Possession, silently *wrong*, because
  the backend defaults to `'closing'` whenever the key is absent.
  `trec-20-19-editor-field-translate.js` exists **solely** to paper over that drift, one hand-
  written mapping at a time. B2's ~75 missing fields and C23's unreachable elections are both
  downstream of this. Fixing them one by one treats symptoms.
- **What to do** — re-run the auto-map against the *actual* live 20-19 blank asset, record the
  form revision and PDF hash on the run, put it through the Hadley QA it never had, and make the
  editor point at the approved run. Then the translate module should shrink rather than grow.
- **Note on the QA step** — `qa_status: awaiting_hadley_qa` refers to the **Hadley agent
  persona**, not a person, so re-running and approving the map is agent work end to end. If that
  turns out to be wrong in practice, correct the `Blocked by` line below rather than working
  around it.
- **Effort** — Days.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — The auto-map row's contents, age and `qa_status` were read live from Supabase
  2026-09-17. The ¶22 mismatch is quoted from today's audit commit. **Which revision the run was
  actually taken against is unrecorded and remains unverified** — the 20-19 asset has been in
  the repo since 2026-06-03, so a July run *could* have used it; the row does not say, and
  nobody should assume either way.

---

## D. Crons and pipeline reliability

### D1. Six of seven screen recordings 400 from the bucket — every Instagram/TikTok render fails
- **Evidence** — `api/cron-render-videos.js:63-77` `RECORDING_MAP` names 7 files; 6 return HTTP
  400 (only `draft-emails-desktop-2026-05-26-b.mp4` = 200). All four mobile recordings are gone.
  The pre-uploaded frame path (`social-cards/screen-frames/<stem>-frame.jpg`, `:79-80`) is **7/7
  400**, so `resolveFrameUrl()` (`:158-177`) always falls through to a dead URL.
- **Impact** — The per-post video path is dead. `instagram:dossie` last posted 2026-08-25,
  `tiktok:dossie` 2026-08-18 (one post ever), `youtube` never. The silence alarms fire daily —
  detection works, the pipeline does not.
- **Effort** — Hours once the files exist.
- **Blocked by** — **Heath.** The source MP4s are not in Supabase, not in the 2026-07-28 backup,
  and not in `Media/screen-recordings/` — they likely died with the old PC. He must re-record.
- **Confidence** — Verified now (all 14 URLs curled).

### D2. `linkedin_personal` has never posted once — 20 failures, generator still running
- **Evidence** — `social_posts`: 20 `failed`, 4 `approved`, **0 `posted`**, ever. Every failure is
  `locator.waitFor: Timeout 10000ms exceeded — waiting for getByRole('button', { name: 'Post' })`,
  3 attempts each. `alert_state.linkedin_login_required` fired today 04:15 — "DossieBot profile
  redirected to login/authwall." Approved rows for 9/15, 9/16 and 9/17 sit unpublished with
  `linkedin_publish_attempts=0` and `zernio_account_id=null`; `api/cron-publish-approved.js:56`
  already names them as known zombie rows "flagged separately for cleanup," never cleaned.
  `cron-generate-heath-linkedin` (`0 11 * * 1-5`) keeps minting more.
- **Impact** — Heath's personal LinkedIn, his highest-authority channel, has produced zero posts
  while the system reported approvals.
- **Effort** — Small for the selector, small for the login.
- **Blocked by** — **Heath** for the LinkedIn re-login on the DossieBot profile; agent for the
  selector and the zombie-row cleanup.
- **Confidence** — Verified now.

### D3. The stale-video alarm watches a status value that does not exist
- **Evidence** — `api/_lib/silence-alarm.js:281` queries
  `video_library?status=eq.pending_heath_review`; the writer `api/cron-video-approval.js:94`
  writes `status: 'pending_approval'`. Live statuses are `posted` (23), `pending_approval` (9),
  `failed` (1) — **zero** rows have ever held `pending_heath_review`.
- **Impact** — Nine videos have waited up to 25 days and the monitor built to catch exactly that
  is a permanent no-op.
- **Effort** — One-line string change.
- **Blocked by** — agent for the fix; **Heath** for the 9 pending approvals.
- **Confidence** — Verified now.

### D4. Two crons dead 23 days on an external scheduler, with no Vercel-side alarm
- **Evidence** — `api/cron-process-agent-requests.js` (drainer for `agent_requests`) and its
  watchdog `cron-agent-requests-stale-check` appear only in the `functions` block of
  `vercel.json:314`, not in `crons` — by design, per the file header: "every 1 minute via
  cron-job.org (Vercel cron cap reached)." Both last fired **2026-08-25 23:34Z / 23:37Z**.
- **Impact** — The queue they drain has grown to 978 rows, and the watchdog died in the same
  minute as the thing it watches.
- **Effort** — Small once the account is reachable.
- **Blocked by** — **Heath** (cron-job.org login), then agent for a Vercel-side alarm.
- **Confidence** — Verified now.

### D5. Three more crons have been returning 401 to that external caller for 34-56 days
- **Evidence** — `cron_runs.last_meta`: `cron-pierce-activation` → `http_401`, last run
  2026-07-23 (56 days); `cron-daily-fb-posts` → `http_401`, 2026-08-09 (39 days);
  `cron-generate-pages` → `http_401`, 2026-08-14 (34 days). None appear in `vercel.json` on
  `main` — all invoked externally with a credential Vercel now rejects.
- **Impact** — Activation outreach, daily FB posting and page generation have recorded nothing but
  auth failures for over a month.
- **Effort** — Small.
- **Blocked by** — **Heath** (cron-job.org credential), then agent.
- **Confidence** — Verified now.

### D6. Seven production crons have no telemetry — including both outage alarms
- **Evidence** — Reachable on `main` with no `cron-telemetry` import and no `cron_runs` row ever:
  `alert-health` (*/5), `cron-pc-heartbeat-check` (*/5), `cron-engagement-review` (*/20),
  `cron-deletion-reminders` (30 13), `cron-stale-action-escalation` (0 15),
  `cron-storage-retention` (30 4), `cron-friday-action-summary` (0 22 * * 5).
- **Impact** — It cannot be confirmed any of them has ever run. `alert-health` and
  `cron-pc-heartbeat-check` are the two jobs on the Telegram `ALWAYS_ALLOW` floor — the outage
  alarms — and they are the least observable jobs in the system. The regression suite's
  `cron.cron-alert-health` failure is this.
- **Effort** — Trivial per file (wrap in `withTelemetry`).
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### D7. `TELEGRAM_CRON_NOTIFICATIONS` is set but its value cannot be read
- **Evidence** — Present in Vercel Production (set 23 days ago) as a *Sensitive* var.
  `api/_lib/telegram-gate.js:119-137`: if the value is `off`/`0`/`false`/empty, every scheduled
  Telegram push outside the 12-job `ALWAYS_ALLOW` floor is suppressed and replaced with a fake
  200; `strict` suppresses even the floor.
- **Impact** — Determines whether dozens of digests and alerts — including B3 — reach Heath at
  all. Everything downstream is guesswork until it is read.
- **Effort** — One dashboard lookup.
- **Blocked by** — **Heath.**
- **Confidence** — **Unverifiable by design** — write-only var.

### D8. `warm_touch_queue` — 625 pending rows, no drainer
- **Evidence** — 625 pending, oldest 2026-08-14, newest today. `cron-warm-touch-populate` runs
  `0 12 * * 1-5` and fills it; nothing consumes it.
- **Effort** — Days (build the consumer, or stop the producer).
- **Blocked by** — **Heath** decision on whether warm-touch outreach is still wanted; then agent.
- **Confidence** — Verified now.

### D9. `content_pipeline_queue` frozen since 2026-08-13
- **Evidence** — 6 rows stuck at `researching`, 4 `failed`, all frozen 2026-08-13; 21 items were
  promoted before that.
- **Impact** — The nightly guide/answer page generation in `docs/CONTENT-PIPELINE.md` stopped a
  month ago and nothing said so.
- **Effort** — Hours to diagnose.
- **Blocked by** — agent.
- **Confidence** — Verified now.

### D10. Assorted stuck queues needing triage
- **Evidence** — `group_posts`: 41 draft, 26 of them >30 days old (oldest 2026-06-11).
  `video_library`: 9 `pending_approval`, oldest 2026-05-27. `comment_opportunities`: 2 approved
  but never posted (2026-09-14, 09-15). `social_posts`: 1 `video_failed` from 2026-07-08.
- **Effort** — Hours.
- **Blocked by** — agent for the stale triage; **Heath** for the 9 video approvals.
- **Confidence** — Verified now.

### D11. 35 orphan `cron-*.js` on main; five genuinely abandoned since early July
- **Evidence** — 35 files in `api/` are reachable from no cron entry. Seven have never recorded a
  run: `cron-agent-worker-tick`, `cron-daily-listing-posts`, `cron-engagement-candidates-cleanup`,
  `cron-sage-external-trend-research`, `cron-sage-fb-digest`, `cron-sage-intelligence-update`,
  `cron-sage-intelligence`, `cron-warm-touch-queue`. Five are abandoned since early July:
  `cron-coverage-check`, `cron-sage-trends`, `cron-sage-autonomous-review`,
  `cron-engagement-summary`, `cron-generate-skit`. Several other orphans still fire from
  cron-job.org and are current, so orphan ≠ dead here.
  `cron-sage-external-trend-research` is a documented permanent no-op — gated at `:108` on
  `SAGE_EXTERNAL_TREND_RESEARCH_ENABLED === 'true'`, a var not set in Vercel.
- **Effort** — Hours.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### D12. `RELEVANCE_WATCHER_NOTIFY` value unknown — `cron-relevance-watcher` may be permanently dry-run
- **Evidence** — Set in Vercel but hidden. `api/cron-relevance-watcher.js:65,540` — unless it is
  exactly `'1'`, the `*/15` job runs dry-run forever. Memory records that Heath never picked a
  notify channel or frequency.
- **Effort** — Minutes once known.
- **Blocked by** — **Heath** (read the value, pick the channel).
- **Confidence** — **Unverifiable by design** — write-only var.

---

## E. Agent queue and the autonomous loop

*This is the machinery that will consume this backlog, so defects here multiply.*

### ~~E1. The autonomous loop re-dispatches tech-debt items already marked RESOLVED~~ — RESOLVED 2026-09-17, MERGED
- **RESOLUTION** — `9404868e` *fix(autonomous-loop): skip closed tech debt, add backlog +
  alert_state signals*, merged as `40559f6b`. Both on `origin/main`.
- **What shipped** — A new pure module `api/_lib/backlog-parser.js` with three exported
  functions: `classifyClosed(line)`, `parseTechDebt(text)` and `parseBacklogDoc(text)`. Closed
  items are now filtered out *before* the 10-item cap, not after, so a struck-through entry can
  no longer eat a slot from real work. Two new signal sources were added at the same time:
  **these two backlog documents** and `alert_state`.
- **⚠️ CONSEQUENCE — THIS FILE IS NOW A DISPATCH SOURCE.** As of `40559f6b`, the loop reads
  `docs/BACKLOG-ENGINEERING.md` and `docs/BACKLOG-BUSINESS.md` every tick and dispatches from
  them. Two mechanics that anyone editing these files must know:
  1. **Closure is detected from the `###` heading ONLY** (`finalizeBacklogItem` calls
     `classifyClosed(cur.heading)`). A "RESOLVED" note in the body does **nothing**.
  2. In this file, headings are `### A1. Title` — and `classifyClosed`'s status region stops at
     the first `.` followed by whitespace, which is the `A1.`. So appending `— RESOLVED` to an
     engineering heading is **not** detected. **Strike the title instead**
     (`### ~~A1. Title~~ — RESOLVED …`), which is matched by the separate title-region
     strikethrough rule. Every closed item in this file uses that form deliberately.
  3. `Blocked by` is parsed from the **first** `- **Blocked by**` bullet in the item. Anything
     not starting with `agent` is withheld; `agent, Heath gates merge` is eligible; any *other*
     mention of Heath after `agent` disqualifies it.
- **Blocked by** — nothing. Closed.
- **Evidence (as found)** — `api/cron-autonomous-loop.js:292-296` takes the first 10 lines starting with
  `- ` from the "NOT DONE / ACTIVE BLOCKERS" section of `docs/TECH-DEBT.md`; the only skip filters
  are for `URGENT` and Heath-personal patterns — **none for `~~strikethrough~~` or "RESOLVED"**.
  `autonomous_loop_runs` shows
  `item_picked = "Tech debt: ~~cron-comment-opp-approval never left staging~~ — RESOLVED
  2026-09-09..."` dispatched to carter on **2026-09-13 and 2026-09-15**. The word RESOLVED is
  literally in the dispatched title.
- **Impact** — The loop spends Anthropic budget and agent capacity re-fixing closed items, and
  crowds out real work — it dispatches exactly one item per tick. Directly undermines any backlog
  fed to it, including this one.
- **Effort** — Hours (skip lines matching `~~` or `RESOLVED`; better, read a structured source).
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now (code plus dispatch history).

### E2. `docs/TECH-DEBT.md` is materially stale — at least three entries are false
- **Evidence** — (a) "Fill-and-sign remaining generators — HOA Addendum (36-11), Lead-Based Paint
  (OP-L), Seller's Disclosure (OP-H) … no JS generators" — all three exist on `origin/main`:
  `fillHoaAddendum` at `api/fill-form.js:2299`, `fillLeadPaintAddendum` at `:2384`,
  `fillSellersDisclosure` at `:2469`, dispatched at `:4026/4027/4030`, with coord maps
  `trec-36-11-coords.json` and `op-l-coords.json`. (b) "TREC 49-1 … not in library/generators" —
  `fillAppraisalTermination` at `:2817`, dispatched at `:4033`, plus
  `api/_assets/trec-49-1-coords.json`. The dispatch table at `:3997-4057` covers **31 form
  types**; 32 fill functions exist. (c) The `cron-comment-opp-approval` line is annotated RESOLVED
  and is still parsed as active (E1).
- **Impact** — This file is the loop's signal source (priority 5, score 50) and is feeding it
  false work. It is also what a human reads to decide what to build next.
- **Effort** — Hours.
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### E3. `/api/cole-write-context` was built and is called by nothing
- **Evidence** — `api/cole-write-context.js` exists and is complete. Grep across `api/`,
  `scripts/`, `.claude/` and `docs/` finds no caller outside the file itself and its spec docs.
  Live: `jarvis_project_context`'s newest row is `kw-docusign-migration-2026-07-09`, dated
  **2026-07-09** — 70 days stale.
- **Impact** — Self-improvement item #1 ("cross-session Jarvis memory mirror"), listed as urgent
  in TECH-DEBT, is half-built: the endpoint exists, nothing writes to it, so context still dies on
  session drops — the exact problem it was built to solve.
- **Effort** — Days (pick the trigger — a hook on memory writes is the obvious one — and wire it).
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — Verified now.

### E4. `agent_requests` holds 978 pending rows, 976 of them self-generated QA spam still being produced
- **Evidence** — 978 pending, 6 complete, 0 failed. Oldest 2026-06-10, newest today; 66 added in
  the last 7 days. **976 are `ridge → quinn` "Carter pushed to staging, please QA" messages**
  generated by `api/cron-staging-watcher.js:257`, which runs `*/5` and is still minting them. The
  other 2 are `sage → carter` from June/July. The handler writes a terminal `failed` status on
  every error branch (`:174-225`), so 978 rows at `pending` with 0 `failed` proves the drainer
  never ran against them — consistent with D4.
- **Impact** — The queue is meaningless as a signal, and naively restarting the drainer would fire
  ~978 model calls and ~978 Telegram messages at Heath.
- **Effort** — Hours (stop the producer, bulk-close the backlog).
- **Blocked by** — **Heath** approves the bulk close — it is a destructive DB write, and the right
  fix is arguably to stop `cron-staging-watcher` writing them at all.
- **Confidence** — Verified now.

### E5. 42 `self_improvement_candidates` awaiting a decision, oldest 2026-07-03
- **Evidence** — 42 undecided rows drafted 2026-07-03 → 2026-09-10, all awaiting `heath_decision`.
- **Impact** — The meta-loop that proposes rule and capability changes has produced 42 proposals
  and none has been accepted or rejected.
- **Blocked by** — **Heath** (they are decisions by definition; per
  `feedback_one-item-at-a-time.md`, surface them one at a time, not as a punch list).
- **Confidence** — Verified now.

### E6. The merge queue is hardcoded to MeetDossie — Rust and Sawyer can never appear in it
- **Evidence** — `supabase/migrations/20260622_merge_queue.sql` has `branch_from`/`branch_to` and
  **no repo or project column**. `api/cron-staging-watcher.js:69` hardcodes
  `GITHUB_REPO = 'heathshepard/MeetDossie'`; the same constant is in
  `cron-merge-queue-backfill.js:51` and `merge-to-main.js:36`. `merge-queue-list.js` additionally
  requires `quinn_qa_status='pass'`. `jarvis-pwa.html:2844` renders the Rust venture card as a
  hardcoded `untracked` placeholder.
- **Impact** — Any multi-project autonomous loop is blind to two of the three codebases.
- **Effort** — Days (project column, multi-repo polling, per-project QA gate).
- **Blocked by** — agent, Heath gates merge.
- **Confidence** — **Inherited from 2026-08-13, not re-verified this pass.**

---

## F. Rust fitness app

### F1. A regression check on `main` is RED and was committed that way
- **Evidence** — `npm run check:equipment-presets` →
  `FAIL commercial_gym: Legs: only 26 distinct exercises across 32 generations (floor 27)`.
  `api/__checks__/equipment-presets.mjs:200` sets `commercial_gym: 0.75`. None of
  `src/lib/workout-generator.ts`, `equipmentPresets.ts`, `equipmentCatalog.ts` or
  `fixtures/exercise-library.json` has changed since `121254a` (2026-09-12) — the commit titled
  *"fix(equipment-presets): the variety floor was unsatisfiable, not the preset."* The other 14
  checks and `tsc --noEmit` pass.
- **Impact** — Either commercial-gym Legs really does recycle 26 movements, or the floor is off by
  one. Either way the suite is no longer usable as a gate.
- **Effort** — 1-2 hours.
- **Blocked by** — agent.
- **Confidence** — Verified now (check executed).

### F2. `feat/percentage-progression-and-deload` — 2,240 lines finished, unmerged 16 days
- **Evidence** — Tip `57b45eb`, last commit 2026-09-01. Two commits, +2240/−166 across
  `src/lib/workout-generator.ts` (+821), `src/pages/Workout.tsx`, `src/pages/Today.tsx`,
  `api/chat.ts`, a new `api/_lib/weight-display.ts` and three new check scripts
  (`workout-deload.mjs`, `workout-first-time.mjs`, `workout-load-progression.mjs` — 961 lines of
  tests). `git merge-tree` → conflicts in `package.json`, `src/pages/Today.tsx`,
  `src/pages/Workout.tsx`.
- **Impact** — The largest finished-but-unshipped asset in any repo: percentage double
  progression, real deload weeks, strength-standards first-time load estimates. Workout.tsx has
  moved a lot in 16 days, so the conflict cost compounds weekly.
- **Effort** — 1-2 days.
- **Blocked by** — agent does the merge; **Heath** preview-tests before merge per the
  preview-link-first rule.
- **Confidence** — Verified now.

### F3. `feat/intra-workout-autoregulation` — 1,057 lines abandoned, plus a migration collision
- **Evidence** — Tip `43b38fd`, 2026-09-14. Adds `src/lib/autoregulation.ts` (227),
  `src/components/LoadAdjustSheet.tsx` (139), `api/__checks__/autoregulation.mjs` (263) and
  `migrations/029_workout_load_adjustments.sql` — **`main` already has `029_waitlist.sql`**.
  `git merge-tree` → conflicts in `package.json` and `src/pages/Workout.tsx`.
- **Impact** — Overlaps F2 heavily; both rewrite load logic in the same two files. They need
  sequencing, not parallel merges. The duplicate migration number will break a fresh apply.
- **Effort** — ~1 day after F2; renumber to 032.
- **Blocked by** — agent; **Heath** preview-tests.
- **Confidence** — Verified now.

### F4. Terms and Privacy are unreachable from inside the app; the fix has been local-only a month
- **Evidence** — `grep -in "privacy\|terms" src/pages/Settings.tsx` on `main` → **zero hits**.
  `public/` holds both `privacy.html` and `privacypolicy.html` (duplicate/orphan). Branch
  `fix/legal-links-orphan-page` (`6134be3`, 2026-08-16) adds the Settings links and merges the two
  pages — **never pushed**, conflicts with `main` in `Settings.tsx`. A duplicate of the same work
  also sits in `git stash@{0}` (WIP on `feat/custom-exercises`, same day).
- **Impact** — A shipping app with no in-app route to its legal documents.
- **Effort** — 1-2 hours (and drop the stash deliberately).
- **Blocked by** — agent.
- **Confidence** — Verified now.

### F5. In-app purchases are built, tested and merged — and switched off with no path to on
- **Evidence** — `bde9722` "shipped dark", merged at `59b8f93`. Three gates in
  `src/lib/billing.ts`: `app_versions.purchases_enabled` (defaults **false** in
  `migrations/030_subscriptions_iap_columns.sql`); `VITE_REVENUECAT_IOS_API_KEY` /
  `VITE_REVENUECAT_ANDROID_API_KEY` at `:213` (neither in `.env.local`); and a real priced store
  offering. `npm run check:billing-native-gates` passes, confirming the gates work.
- **Impact** — No native revenue is possible. The code is not the blocker.
- **Effort** — ~30 minutes of wiring once the inputs exist.
- **Blocked by** — **Heath.** RevenueCat account and API keys, plus the decision to apply
  migration 030 against the live database.
- **Confidence** — Verified now.

### F6. A yoga pose is marked complete before the DB insert, and the failure is swallowed
- **Evidence** — `src/pages/Yoga.tsx:150` calls
  `setCompletedPoses(prev => new Set(prev).add(idx))` *before* the `workout_logs` insert at `:154`;
  `:163` is `if (error) console.error(...)` with no user-visible signal and no retry. Same pattern
  at `:87`, `:192`, `:205`.
- **Impact** — A yoga session can read as logged on screen while nothing was written. Same class
  as B17.
- **Effort** — 2-3 hours.
- **Blocked by** — agent.
- **Confidence** — Verified now.

### F7. Cardio duration reaches the coach as reps
- **Evidence** — `src/lib/workout-generator.ts:1085-1089` emits a cardio finisher as
  `{ muscle_group:'cardio', sets:1, reps:20, weight_display:'Cardio' }` with no `is_timed`.
  `src/components/CoachChat.tsx:455` sends `isTimed: ex.is_timed || undefined`, so a 20-minute row
  is narrated to the model as "20 reps."
- **Impact** — The coach gives wrong advice about cardio volume. Same class as the timed-hold bug
  already fixed.
- **Effort** — 3-5 hours.
- **Blocked by** — agent.
- **Confidence** — Verified now (listed in `rust-feature-backlog.md`, re-confirmed still open).

### F8. A timed hold inside a superset gets a plain reps stepper instead of the hold timer
- **Evidence** — `src/pages/Workout.tsx:2067` gates the Start-Hold UI on
  `isTimedHold(currentExercise)`. A superset partner renders through `renderSetRow` (`:1590`),
  whose body (lines 1590-1790) contains zero hits for `is_timed|isTimedHold|Hold|duration`.
- **Impact** — Functional: seconds get typed into an unlabelled reps field.
- **Effort** — 4-6 hours.
- **Blocked by** — agent.
- **Confidence** — Verified now.

### F9. Superset partner sets 2+ render with no heading
- **Evidence** — `src/pages/Workout.tsx:2508` —
  `{partnerExercise && setNum === 0 && (...renderExerciseHeader(partnerExercise)...)}`. Partner
  rows are interleaved for every `setNum`, so sets 2+ appear under the primary exercise's heading.
  `fix/superset-partner-missing-controls` (merged, `ad18e51`) fixed the controls, not this.
- **Impact** — Cosmetic, but it is what Heath personally reported as confusing on 2026-09-09.
- **Effort** — 1-2 hours.
- **Blocked by** — agent.
- **Confidence** — Verified now.

### F10. Plate breakdown is dropped whenever a weight is edited by hand
- **Evidence** — `src/components/CoachChat.tsx:26-35`, `liveWeightDisplay()` returns
  `` `${weight} lb` `` with no plate math; its own comment says the generator's formatter needs
  the equipment map "which the chat has no reason to load."
- **Impact** — Cosmetic. The number is right, the "(45 + 5 per side)" caption is lost.
- **Effort** — 2-4 hours.
- **Blocked by** — agent.
- **Confidence** — Verified now.

### F11. Photo-scan equipment setup — explicitly deferred, not started
- **Evidence** — `rust-feature-backlog.md` §1, Heath's words: *"Yes but I dont want to forget
  it."* Verified not started: no `@capacitor/camera` in `package.json`, no camera code in
  `src/pages/EquipmentSetup.tsx`.
- **Effort** — 1-2 days; works against the existing Anthropic key (~$0.005/scan) and the 121-item
  `src/constants/equipmentCatalog.ts`.
- **Blocked by** — agent.
- **Confidence** — Verified now.

### F12. Eleven stale worktree directories for branches already merged
- **Evidence** — Of 13 Rust worktrees, 11 sit on branches already merged into `main`
  (`Rust-ios-scaffold`, `-coachchat`, `-daypick`, `-done-button`, `-elapsed-timer`, `-iap`,
  `-readiness`, `-review-fix`, `-superset-controls`, `-tips`, `-workout-edit`), all with clean
  working trees. Only `Rust-wt-machine-base-weight` (`feat/machine-base-weight`) and
  `.worktrees/rust-connect-guide` (`feat/connect-guide`) are genuinely in flight — both committed
  today, both merge cleanly, both awaiting Heath's preview test.
- **Effort** — Minutes (`git worktree remove`).
- **Blocked by** — agent.
- **Confidence** — Verified now.

---

## G. Sawyer

### G1. The entire codebase is uncommitted with no git remote
- **Evidence** — `git remote -v` → **empty**. `git log` → **2 commits total**, newest `14cb0fd`,
  2026-08-04. `git status --porcelain` → 15 untracked paths (`api/`, `app/`, `systems/`,
  `scripts/`, `supabase/`, `docs/`, `package.json`, `vercel.json`) plus 5 modified tracked files.
  ~2,035 lines of JS/JSX/SQL exist only on this disk; newest mtime 2026-08-10.
- **Impact** — One `git clean -fd`, one bad checkout, or one drive failure destroys the watchdog
  system, the Teamwork connector, the dashboard and the migrations. The highest
  risk-to-effort ratio on this entire list.
- **Effort** — Minutes to commit.
- **Blocked by** — **Heath.** The remote must be **private** — `.gitignore` warns the repo "holds
  other people's business data" — so he creates it or approves the account.
- **Confidence** — Verified now (commands run directly).

### G2. The Teamwork connector is fully coded and has never run against a live account
- **Evidence** — `systems/connectors/teamwork/README.md`: "Status: unverified against a live
  account." `src/index.js` header: "UNVERIFIED… have never been called against a real account."
  `clients/callie-roberson/config.json` → `blocked_on: ["Teamwork login/API credentials — Callie
  offered, Heath has not asked yet"]`, `site_name: null`.
- **Impact** — The entire Sawyer pipeline is unproven end to end.
- **Effort** — Hours once credentials exist.
- **Blocked by** — **Heath.** He has to ask Callie; she already offered.
- **Confidence** — Verified now.

### G3. QuickBooks and GoHighLevel connectors do not exist
- **Evidence** — `systems/connectors/` contains only `teamwork/`. `api/cron-watchdog.js:60` —
  `const CONNECTORS = ['teamwork']; // extend when quickbooks/gohighlevel ship`. Both are named in
  the `connector_configs` check constraint in `supabase/migrations/0001_core_schema.sql`.
  `systems/scorecard-automation/README.md`: "Not built yet: QuickBooks / GHL."
- **Impact** — Two of the four scorecard buckets cannot be built.
- **Effort** — Days each.
- **Blocked by** — **Heath.** QuickBooks needs OAuth and the edition is unconfirmed (Desktop has
  no usable API, per `clients/callie-roberson/notes.md:185`); GHL needs their $297/mo plan.
- **Confidence** — Verified now.

### G4. The dashboard renders hardcoded sample data
- **Evidence** — `app/src/lib/scorecard.js` — `getScorecardData()` returns a literal `SAMPLE`
  object; its own header names the swap point. One component total (`ScorecardView.jsx`, 107
  lines), no auth, no routing.
- **Impact** — Demo-only. Showing it as live would violate
  `dossie-demo-must-match-real-capability.md`.
- **Effort** — Small, but blocked behind G2 and G5.
- **Blocked by** — agent, after G2/G5.
- **Confidence** — Verified now.

### G5. No Supabase project, no Vercel project, no Telegram bot exists for Sawyer
- **Evidence** — `docs/WATCHDOG.md` "What's actually built vs. blocked" items 1-3.
  `npx vercel project ls` shows only `rust`, `meet-dossie`, `dossie-app`. `vercel.json` has only
  the cron entry, no build config for `app/`.
- **Impact** — Nothing in the repo can run at all.
- **Effort** — Hours of setup.
- **Blocked by** — **Heath.** Paid Supabase project (~$10/mo), Vercel project, bot token.
- **Confidence** — Verified now.

### G6. The watchdog self-healing loop has never run
- **Evidence** — `docs/WATCHDOG.md`: "None of it has run against real infrastructure yet." Tiers
  1-3 plus agent_queue dispatch are substantial real code, not stubs.
- **Blocked by** — **Heath** (G5 first).
- **Confidence** — Code existence verified now; the never-run claim is **inherited from the doc**.

### G7. `invoices` and `deals` tables exist in the schema with no code touching them
- **Evidence** — `supabase/migrations/0001_core_schema.sql:78` and `:91`, RLS at `:148`/`:151`.
  `grep -rn "from('invoices')\|from('deals')"` → nothing.
- **Impact** — Schema-only lag confirming G3. Not a runtime bug.
- **Blocked by** — agent, after G3.
- **Confidence** — Verified now.

---

## Verified resolved — do not re-open

Each of these is asserted as broken somewhere in memory or in `docs/TECH-DEBT.md` and was
confirmed **fixed** against current code, live data or a live API call this pass. Listed so the
autonomous loop and the next audit stop spending on them (see E1/E2).

| Claim | Source | Actual state |
|---|---|---|
| Agent dispatcher frozen on a yearly `0 0 1 1 *` cron | `agent-queue-parked-since-july.md` | `*/2 * * * *`; ran today 17:00 ok. **Zero** crons on `origin/main` use the freeze pattern — the July cost-freeze is fully lifted. |
| 55 stranded tasks in the agent queue | same | `agent_queue` = 605 completed, 145 cancelled, 78 blocked, **0 pending**. The real backlog is `agent_requests` (E4) and it is QA spam, not work. |
| Content-engine kill switch #1 — `posting_schedule.is_active=false` on all 42 rows | `content-engine-shutdown-2026-07-12.md` | 42 active / 7 inactive. |
| Content-engine kill switch #2 — `cron-generate-posts` scheduled yearly | same | Runs `0 11 * * *` via `cron-dispatch-daily-1100`; last run today 11:02 ok. |
| `group_posts` approve taps 400 on a missing `auto_post_at` column | `feedback_silent-failure-is-the-enemy.md` | Column exists. |
| `social_posts` approve writes the string `"telegram"` into a uuid | same | `api/telegram-webhook.js:1725-1734` leaves it null; the two remaining literal writes target `text` columns. |
| No retry for failed Telegram sends | same | `cron-retry-unsent-approvals` runs `*/30`, ran today 16:30; 0 drafts >24h unsent. |
| Generator keeps minting unpublishable IG/TikTok rows | same | `575ddbad` (2026-09-16) added `GENERATION_DISABLED_PLATFORMS`; zero IG/TikTok/YouTube rows created today; stuck backlog fell 36 → 4. |
| `cron-comment-opp-approval` never left staging | `docs/TECH-DEBT.md` | Registered and ticking; ran today 16:30. |
| `/calculator` cites superseded TREC 20-17 | Audit item 19 | Live page cites 20-19 throughout (`calculator.html:39,44,49,54,196,282,306`). |
| Production bundle built from unmerged `carter/dossiesign-packets` | Audit item 8 | Merged. All four Dossie remote branches are 0 commits ahead of `main`; prod bundle `workspace-C_206Lx0.js` matches `origin/main` exactly. |
| Send Packet button 400s on every click (Defect A1) | Gap analysis | Fixed by `01875850` (9/01); `SendPacketButton.jsx:10,130` bakes a PDF and posts `documentIds`. |
| Typed field drafts never read (Defect A2, the *code* half) | Gap analysis | Fixed by `cfa0d147` (9/01); read by `fill-form.js`, `dossiesign-prepare.js`, `_lib/merge-contract-field-drafts.js`. 112 transactions now carry drafts (was 3). **The live-behaviour half is still open — see B2.** |
| N emails per offer, no packet | Gap analysis | Fixed by `f0d9b822` (9/08); `DossieSignModal.jsx:390-414` sends one envelope with ordered `documentIds`. |
| Addenda get 0 initials | Gap analysis | Fixed by `47efabf9` (9/08); 23 forms of verified signing geometry in `api/_assets/esign-field-maps.json` plus a generalized 422 gate. |
| DocuSeal audit log never fetched / no certificate | Gap analysis §4 | Fixed; `api/esign-webhook.js:253-278, 696-703` downloads `audit_log_url`, stores a `signing_certificate` document, records `audit_log_sha256`. **Never exercised — 0 certificates exist (C1).** |
| AcroForm checkbox making a false legal attestation | `acroform-field-names-lie.md` | Fixed on `main` since `c2aa73af` (9/01). `api/fill-form.js:3160-3174` correctly identifies the widget as §4.B(1) Natural Resource Leases and only sets it when `fv.natural_resource_leases_delivered === true`. No default check. **The recurrence guard was never wired — that is C7.** |
| Superseded 20-18 reachable through `fill-form.js` | Audit item 11 | Dead on that path: `api/fill-form.js:3960-3966` — every entry in `DOCUSEAL_FORMS` is commented out, so `prefillDocuSealTemplate` can never fire from there. **`esign-create.js` still holds the legacy id — that is C9, still open.** |
| No JS generators for HOA 36-11, OP-L, OP-H, TREC 49-1 | `docs/TECH-DEBT.md` | All four exist: `fill-form.js:2299, :2384, :2469, :2817`, dispatched at `:4026/4027/4030/4033`. 31 form types in the dispatch table. |
| `fable5-field-mapper.js` gap | productization plan gap #2 | File deleted. |
| `dossiesign-approve-field-map` gap | gap #3 | Deliberate 410 Gone. |
| No pre-send verification | gap #4 | Built (`pre-send-field-audit.js` + a real 422). **Coverage is text-only — that is C6.** |
| TREC 55-0 / 55-1 revision split | gap #5 | Fixed; `fill-form.js:62-67` and `resolve-blank-template-pdf.js:37` both serve 55-1. |
| Stale local `DOCUSEAL_API_KEY` | integration plan §8.4 | Fixed; the `.env.local` key returned HTTP 200 this session. |
| `cron-esign-events` hardcoded to Heath's mailbox | memo | Fixed; `api/cron-esign-events.js:716-745` loops `listEmailIntegrationCustomers()`. (Only 1 customer has the add-on enabled — an activation fact, not an engineering gap. See B18 for the stale comment.) |
| `email_queue` fills but never drains | `cold-email-queue-fills-but-never-drains.md` | Wrong table. `email_queue` = 13 rows, all `sent`. `outbound_email_queue` = 838 sent, 0 pending — it drained fine. The program was **stopped** 2026-08-27; 593 addresses now suppressed. |
| Nothing in `scripts/_lib` uses a persistent browser profile | `script-consolidation-parked.md` step 1 | Six `_lib` files use `launchPersistentContext`/`userDataDir`, including `brokerage-browser.js` (5 hits) and `zipform-session.js` (2) on `origin/main`. Step 1 is done. |
| `transactions` and other tables lack RLS | `transactions-table-is-multi-tenant.md` | All ~200 public tables have `rls_enabled: true`. Zero ERROR-level Supabase advisors. (The real exposure is A1, which bypasses RLS entirely.) |
| Ungated temp/debug endpoints left in production | recent commit pattern | Sweep of 476 routes found one `debug-*` route and 49 `admin-migrate-*`; **every one** checks `CRON_SECRET`/`ADMIN_SECRET`/Authorization. The `temp: read-only RLS audit endpoint` was correctly removed. |
| `.tmp` PDFs tracked on `main` | `tmp-pdfs-tracked-in-public-repo.md` | 0 tracked on `origin/main` — the scrub landed. **History exposure remains — that is A5.** |
| Gmail token refresh blocked on an unmerged branch | `kw-gmail-api-access.md` | `api/gmail-refresh.js` merged 2026-08-04; lazy-refresh verified working. |
| `founding_applications` stuck in pending | assorted | 4 approved, 1 rejected, 0 pending. |
| `MeetDossie-scheduler` / `wix-site-check` hold abandoned work | — | Both clean. `MeetDossie-merge-1789571808` is a dead directory whose worktree was pruned — disk cleanup, not a backlog item. |

---

## Open questions this pass could not settle

- **B2** — ~150 typed fields not reaching the PDF. A code read and a live test disagree. Needs one
  real transaction driven end to end.
- **B7** — which approve route the Jarvis PWA actually calls (the grep timed out twice against the
  WSL/NTFS mount).
- **C9** — whether any live caller still reaches the legacy 20-18 template id in `esign-create.js`.
- **C15** — whether the DocuSeal webhook is registered at all (dashboard-only, no API).
- **C16** — whether `esign-draft-handoff` / `esign-send-handoff` are called by anything outside
  this repo.
- **C20** — the DocuSeal account tier (sandbox banner on a client's signing page).
- **C21** — Google CASA verification status. Never checked either way.
- **D7 / D12** — `TELEGRAM_CRON_NOTIFICATIONS` and `RELEVANCE_WATCHER_NOTIFY` are write-only Vercel
  vars. How much alerting is currently suppressed is unknown until Heath reads them.
- **E6** — merge queue is MeetDossie-only. Inherited from 2026-08-13, not re-verified.
- **Audit item 21** — Team plan `$349/mo` nav hidden by `display:none`. Three `display:"none"`
  sites exist in `dossie-app.jsx` (`:9564`, `:13127`, `:14160`) but none was traced to Team-plan
  nav. Still can't-tell. Needs a live Team-plan login.
- **Subscriptions reconciliation** — the live table holds 10 `active` founding rows; `CLAUDE.md`
  §5 says 8 members and §6 says 11. Stripe was **not** called (read-only pass), so the
  `no-dunning-process-failed-payments.md` claim that the DB says `active` while Stripe says
  `past_due` is **still unverified**. This is real money and belongs in the business backlog, not
  this one.
- **~43 findings from the 2026-08 full-site QA sweep** exist only inside a claude.ai artifact that
  is no longer fetchable. A fresh sweep is the right move, not artifact recovery.
