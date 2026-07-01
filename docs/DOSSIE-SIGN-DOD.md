# Dossie Sign — Definition of Done

**Owned by:** Ridge (Head of Reliability & Observability)
**Loop:** `api/cron-dossie-sign-completion-loop.js`
**Cadence:** every 20 minutes (dedicated — separate from the general 4h autonomous loop)
**Dashboard:** [`/admin-dossie-sign-progress.html`](../admin-dossie-sign-progress.html)
**Rule locked:** 2026-07-01 by Heath

Dossie Sign is the highest-priority feature in the roadmap. Per `feedback_dossie_sign_must_work_before_new_ships.md`, no new Dossie feature merges to main until this DoD passes end-to-end.

This document explains what "done" means, how the loop advances it, and how you view progress.

---

## The nine gates

Every one of the eight TREC forms must pass all nine gates. That is `8 x 9 = 72` gates total. Mission complete only when all 72 are green.

| # | Gate | What it means | Weight | Human-gated? |
|---|---|---|---|---|
| 1 | `fill_accuracy` | The rendered PDF has the right values in the right positions on every page | 40 | no |
| 2 | `hadley_signed_pass` | Hadley has read the rendered PDF page-by-page and written a `FINAL VERDICT: PASS` report | 60 | no |
| 3 | `send_button_works` | The "Send for signature" button fires end-to-end from the app | 100 | no |
| 4 | `multi_signer` | Buyer + seller + co-buyer + co-seller all work | 80 | no |
| 5 | `signer_email_collect` | The email-collection UI works for this form's signer roles | 80 | no |
| 6 | `envelope_status` | After sending, envelope status shows in the customer dashboard | 60 | no |
| 7 | `audit_trail` | Every signed contract has a Certificate of Completion (signer, time, IP, hash chain) | 60 | no |
| 8 | `signed_pdf_stored` | Signed PDFs stored permanently in Supabase Storage and retrievable | 60 | no |
| 9 | `real_deal_closed` | Brittney (or another founder) completes a real deal end-to-end | 999 | **yes — Heath flips this** |

Weight determines which red gate the loop picks first. Higher weight = more urgent. Gate 9 is human-gated — the loop will never dispatch work against it. Heath flips it to green after a real founder closes a real deal.

---

## The eight forms

Per `project_docuseal_template_ids.md`:

| Form code | Label | DocuSeal template ID |
|---|---|---|
| `TREC-20-18` | One to Four Family Residential Contract (Resale) | 4018208 |
| `TREC-40-11` | Third Party Financing Addendum | 4023463 |
| `TREC-49-1`  | Right to Terminate Due to Lender's Appraisal | 4023472 |
| `TREC-OP-H`  | Seller's Disclosure Notice | 4023470 |
| `TREC-36-11` | HOA Addendum | 4111321 |
| `TREC-39-10` | Amendment to Contract | 4111320 |
| `TREC-11-7`  | Backup Contract Addendum | 4023578 |
| `TREC-OP-L`  | Lead-Based Paint Addendum | 4023469 |

If a ninth form ever needs to be added, insert it into `dossie_sign_dod_progress` (nine rows, one per gate) and it gets picked up on the next tick automatically.

---

## How the loop works — one tick

Every 20 minutes the loop runs `api/cron-dossie-sign-completion-loop.js`:

1. **Read current state** from `dossie_sign_dod_progress` (72 rows).
2. **Refresh gate state from evidence** without dispatching anything:
   - Scan `docs/hadley-pass-report-trec-*-*.md` for `FINAL VERDICT: PASS` or `FAIL` — flips `fill_accuracy` and `hadley_signed_pass` gates.
   - Read `signature_requests` completed rows — flips `envelope_status`, `signed_pdf_stored`, `audit_trail` when evidence lands.
   - Read `agent_queue` completed rows tagged with `metadata.dossie_sign_form_code` + `metadata.dossie_sign_gate_key` — flips `send_button_works`, `multi_signer`, `signer_email_collect` when the completed task carries `metadata.quinn_apv_pass=true`.
3. **Count buckets** — green, yellow, red.
4. **Mission complete check** — if all 72 rows are green, send a celebration Telegram (once), log the tick, exit.
5. **Pick the ONE lowest-hanging red gate** — sorted by `gate_weight DESC`, tiebreak by lowest `dispatch_count`, then by form code. Human-gated rows and rows on cooldown are excluded. Rows dispatched more than 6 times without moving to green are marked stuck.
6. **Guardrail check** on the picked gate's brief. If it trips a guardrail (spend, DocuSeal template rebuild, contacting a founder, merge-to-main, licensed-attorney flag), the loop pauses that gate for 24h and Telegrams Heath instead of shipping.
7. **Dispatch** to the right agent via `agent_queue` insert + create a `jarvis_future_builds` row for HUD visibility.
8. **Stamp cooldown** on the row (`cooldown_until = now + 60 min`) so the same gate is not re-dispatched next tick while an agent is working on it.
9. **Log the tick** to `dossie_sign_dod_runs`.

The general 4h `cron-autonomous-loop` reads the same `dossie_sign_dod_progress` table and does NOT dispatch anything with `signal_source='dossie_sign_lastmile'` while this dedicated loop is active. This prevents thrashing.

---

## Agent routing per gate

The routing table lives in `routeGateToAgent()` inside the loop file. Summary:

| Gate | Agent | What Ridge asks the agent to do |
|---|---|---|
| `fill_accuracy` | Carter (draft) | Read the latest Hadley defect list, draft a field-map fix. Do NOT push. |
| `hadley_signed_pass` | Hadley | Re-run the v3-FHA master prompt, render page-by-page, write a new PASS/FAIL report. |
| `send_button_works` | Atlas | Playwright signed-in APV — full send flow, capture screenshots, mark `quinn_apv_pass=true`. |
| `multi_signer` | Atlas | Playwright 4-signer round trip with test emails, per-signer status screenshots. |
| `signer_email_collect` | Atlas | Playwright the collection UI per form type, verify role fields. |
| `envelope_status` | Atlas | Send + poll — confirm dashboard shows sent → viewed → in_progress → completed. |
| `audit_trail` | Carter (draft) | Draft webhook code that extracts Certificate of Completion from DocuSeal payload. |
| `signed_pdf_stored` | Atlas | Playwright end-to-end signed retrieval test. |
| `real_deal_closed` | HUMAN — Heath | Loop never dispatches. Heath flips manually after a real founder closes a real deal. |

---

## Guardrails — what the loop will NOT do

Per `feedback_verify_features_before_promoting.md`, `feedback_dossie_sign_must_work_before_new_ships.md`, and `feedback_no_permission_asks_ship_missions.md`, the loop pauses (does not ship) when:

- **Spend** — anything requiring a paid tier upgrade, new subscription, or credit-card charge.
- **DocuSeal template rebuild** — templates require Heath's account to modify. Escalate.
- **Contacting a founder** — Brittney, Miki, or any other founder outreach is Heath's customer-contact gate. Escalate.
- **Merge-to-main** — Atlas can push to staging; only Heath's word merges to main.
- **Licensed-attorney flag** — Hadley may surface issues she cannot advise on without a barred attorney.

When any of these hit, the loop Telegrams Heath, cooldowns the gate for 24h, logs `skipped_guardrail`, and picks a different gate on the next tick.

---

## Frozen files

Per `feedback_hadley_apv_is_fillform_merge_gate.md`, these files are frozen. Ridge's loop dispatches Carter to READ them (for inventory) but Carter must NOT modify them without an explicit lift of the freeze:

- `scripts/trec-*`
- `api/_lib/trec-*`
- `api/fill-form*.js`

Work goes through the DocuSeal prefill path per `project_docuseal_template_ids.md` instead.

---

## When does the loop tell Heath something

Ridge is quiet. The loop pings Heath only for:

1. **Mission complete** — all 72 gates green. Celebration ping + tag prompt.
2. **Guardrail hit** — a picked gate tripped a guardrail. Needs Heath's decision.
3. **All reds stuck** — every eligible red has been dispatched more than 6 times without moving to green. Needs human review.
4. **24h no progress** — the green count did not move in 24 hours. Something is genuinely stuck.
5. **Daily rollup** — 6 am CDT: "Overnight the Dossie Sign loop fixed X. N of 72 gates now green (was M). Blockers: [top 5]."

The loop does NOT ping Heath for:

- Individual small fixes.
- Same-tick test failures that get resolved same run.
- Intermediate progress inside a single form.
- Cooldown skips.

Silence = healthy.

---

## Viewing progress

**Dashboard:** [`/admin-dossie-sign-progress.html`](../admin-dossie-sign-progress.html)

Shows all 8 forms x 9 gates as a grid of green/yellow/red pills. Hover any cell to see dispatch count, last-dispatched agent, evidence pointer, cooldown state. Auto-refreshes every 60 seconds.

Also shows the last 20 loop ticks — what was picked, what agent got dispatched, what the outcome was.

**Raw queries:**

- Current state: `select form_code, gate_key, status, dispatch_count from dossie_sign_dod_progress order by gate_weight desc, form_code`
- Recent ticks: `select * from dossie_sign_dod_runs order by run_ts desc limit 50`
- Blocker inventory: `select form_code, gate_label, dispatch_count, last_dispatched_agent, last_evidence from dossie_sign_dod_progress where status='red' and human_gated=false order by gate_weight desc`

---

## Manual controls

Force-fire the loop once (bypasses schedule):

```
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://meetdossie.com/api/cron-dossie-sign-completion-loop
```

Flip a gate green manually (Heath only — used for the `real_deal_closed` gate):

```sql
update dossie_sign_dod_progress
   set status='green',
       last_evidence='manual: Brittney closed 123 Main St 2026-07-15',
       last_checked_at=now(),
       updated_at=now()
 where form_code='TREC-20-18' and gate_key='real_deal_closed';
```

Reset a stuck gate (Heath only — after resolving the underlying issue):

```sql
update dossie_sign_dod_progress
   set dispatch_count=0,
       cooldown_until=null,
       updated_at=now()
 where form_code='TREC-20-18' and gate_key='fill_accuracy';
```

---

## Related memory rules

- `feedback_dossie_sign_must_work_before_new_ships.md` — no new features until DoD passes
- `feedback_hadley_apv_is_fillform_merge_gate.md` — Hadley PASS gates any fill-form merge
- `feedback_verify_features_before_promoting.md` — APV every fix before customer-facing
- `feedback_no_permission_asks_ship_missions.md` — no permission-asks for mechanical steps
- `feedback_telegram_plain_english.md` — plain English in Heath pings
- `project_docuseal_template_ids.md` — Heath's DocuSeal template mappings

---

**Files that make this work:**

- `api/cron-dossie-sign-completion-loop.js` — the loop
- `supabase/migrations/20260701_dossie_sign_dod_progress.sql` — state + run tables (seeds 72 rows)
- `admin-dossie-sign-progress.html` — the grid dashboard
- `docs/DOSSIE-SIGN-DOD.md` — this file
- `vercel.json` — cron schedule entry (every 20 min)
