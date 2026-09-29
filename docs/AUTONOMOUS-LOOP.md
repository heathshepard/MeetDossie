# Autonomous Self-Improvement Loop

Ridge, 2026-07-01. Owner: Ridge (reliability + observability).

> **Related**: The autonomous loop *ships* work. The self-improvement meta-loop
> *watches the loop* and proposes rule / capability / prompt changes. See
> [`docs/SELF-IMPROVEMENT-META-LOOP.md`](SELF-IMPROVEMENT-META-LOOP.md).
> The 6 AM digest now includes the top 3 pending meta-loop candidates for
> Heath's yes/no.

## What it does, in one paragraph

Once a day the loop wakes up, looks at everything that might need attention
(open customer bugs, prod errors, unanswered production alarms, KPI drift, the
two backlog documents, tech debt, Dossie Sign last-mile blockers, agent
idleness), picks the single most important thing, and hands it to the right
agent to build/fix/investigate. Once a day at 6 AM CDT you get a plain-English
morning brief telling you what shipped, what's blocked on your call, and
whether anything scary happened.

## The pieces

| Piece | File | Fires |
|---|---|---|
| The loop | `api/cron-autonomous-loop.js` | Once daily at 11:00 UTC, fanned out from `cron-dispatch-daily-1100.js` |
| Daily digest | `api/cron-autonomous-daily-digest.js` | 6 AM CDT (0 11 * * *) |
| Run log | `autonomous_loop_runs` table | Row per tick |
| Cooldown ledger | `autonomous_loop_signals_seen` table | Row per unique signal |
| Migration | `supabase/migrations/20260701_autonomous_loop_runs.sql` | Already applied |

## Signal sources it reads (in priority order)

1. **Customer bugs** (`support_tickets` with `ticket_type='bug'`) — score 100
2. **Dossie Sign last-mile blockers** (`docs/dossie-sign-last-mile-*.md`,
   confidence <8) — score 100 (customer-bug tier per Heath's directive)
3. **Prod errors** — `cron_runs` in error status >6h + email deliverability
   (Resend complaints/bounces via `email_events`) — score 80
4. **Unanswered alarms** (`alert_state`, fired in the last 48h) — score 70
5. **KPI drift** — `kpi_snapshots` week-over-week diff >±10% — score 60
6. **Urgent tech debt** (🚨 / URGENT items in `docs/TECH-DEBT.md`) — score 50
7. **Backlog items** (`docs/BACKLOG-ENGINEERING.md`, `docs/BACKLOG-BUSINESS.md`)
   — score 35, plus up to +12 for position in the document
8. **Dossie Sign mid-confidence blockers** (confidence >=8) — score 40
9. **Active tech debt** (other items in NOT DONE section) — score 30
10. **Ridge reliability idle** — score 25
11. **Sage / Hadley backlog idle** — score 20
12. **Pierce activation backlog idle** — score 15

Every candidate is scored, sorted, and only THE ONE highest-score item is
picked per tick. If everything is on cooldown, the loop logs "no signal"
and exits quietly (silence = healthy).

### Closed items are skipped (added 2026-09-17)

`docs/TECH-DEBT.md` mixes open and closed work in the same section — closed
entries stay for their history, struck through and annotated. The loop had no
filter for this. It read the first 10 `- ` lines of "NOT DONE / ACTIVE
BLOCKERS", and the first of those was `~~cron-comment-opp-approval never left
staging~~ — RESOLVED 2026-09-09 …`. That item was dispatched to carter on
**2026-09-13 and again on 2026-09-15**, with the word RESOLVED in the task
title, while real work waited behind it.

`api/_lib/backlog-parser.js` now decides what counts as closed:

| Marker | Example |
|---|---|
| `~~strikethrough~~` on the title | `~~Fill-and-sign Phase 2~~ — RESOLVED …` |
| A status word after the title | `— RESOLVED`, `(DONE)`, `: FIXED`, `— LIVE`, `DEPRECATED` |
| A ticked checkbox or leading ✅ | `- [x] …`, `- ✅ …` |
| A closing phrase | `stale entry`, `already built`, `no longer an issue` |

Only the **status region** — the title plus the first sentence after it — is
scanned. The body of an open item routinely mentions completed sub-parts
(`Needs phone capture (done) + opt-in toggle`, `Smithery ✅ live`), and
scanning whole lines wrongly closed both of those. The 10-item cap is also
applied *after* filtering now; before, closed lines consumed slots meant for
real work.

### The two backlog documents (added 2026-09-17)

`docs/BACKLOG-ENGINEERING.md` (88 items) and `docs/BACKLOG-BUSINESS.md` (90
items) were compiled 2026-09-17. Before them, all ten signal sources were
engineering-shaped, which is how 90 business items — lapsed insurance, a
payment webhook that never fired, deadline exposure on a rental — accumulated
unseen while the loop ran.

**Every item carries a `Blocked by` field, and it is binding.** The loop only
picks up items that field marks as agent-completable:

| `Blocked by` value | Pulled? |
|---|---|
| `agent` | yes |
| `agent, Heath gates merge` | yes — the normal staging→main gate every change has |
| `mixed — …` | **no** |
| `Heath …` | **no** |
| `gated on …` | **no** |
| `agent …` with any other Heath dependency | **no** |

The decision is made at parse time, not delegated to the agent that receives
the task. Anything needing a credential, a payment, a legal call, a physical
action, or a message to a real person cannot reach the queue. The rule is
deliberately conservative — an item whose `Blocked by` says
`agent (to diagnose and report). The outreach itself needs a policy decision
from Heath` is withheld even though half of it is agent work.

As of 2026-09-17 that yields **50 of 88** engineering items and **18 of 90**
business items. The business document's own §8 hand-counted 22; the three-item
difference is items conditioned on a Bitwarden session or on pre-approved copy,
which this gate treats as Heath's.

### `alert_state` (added 2026-09-17)

Detection has worked for months; nothing ever looked at the results. Fourteen
keys fired on 2026-09-16/17 — three dead platforms, stale approval queues, and
`linkedin_login_required`, where Heath's personal LinkedIn has failed 20
consecutive times and has never once published — and nothing responded to any
of them.

Alerts fired in the last 48 hours become candidates, routed to **ridge** as
diagnose-and-report. High-cardinality key families collapse to one candidate
(the 17 `linkedin_publish_dead_letter:*` keys are one problem), while
account-scoped keys like `silence:instagram:dossie` and
`silence:instagram:heath-realtor` stay distinct.

The brief explicitly forbids posting, publishing, sending or merging — draining
a stuck publishing queue by publishing it is not a fix.

## Cooldowns (so we don't spawn-loop)

| Signal source | Cooldown |
|---|---|
| customer_bug | 4 hours (fast — customers can't wait) |
| dossie_sign_lastmile | 8 hours |
| prod_error | 8 hours |
| ridge_reliability | 12 hours |
| sage_backlog / hadley_backlog | 12 hours |
| tech_debt | 24 hours |
| kpi_drift | 24 hours |
| pierce_backlog | 24 hours |
| alert_state | 24 hours |
| backlog_engineering / backlog_business | 72 hours |

Cooldowns are looked up in one batched query (`checkCooldownBatch`). The
candidate pool went from ~10 to ~90 when the backlog docs came online, and the
old one-query-per-candidate filter would have meant ~90 sequential round-trips
per tick.

Once a signal is dispatched, it will not be re-picked until its cooldown
expires. If the same signal is dispatched 3+ times without resolution,
the loop marks it "stuck" and Telegrams Heath for human review instead of
looping forever.

## Guardrails (auto-escalate, don't ship)

The loop refuses to dispatch anything that trips these regex patterns.
Instead it Telegrams Heath and logs the run as `skipped_guardrail`:

- **spend** — anything mentioning subscribing/purchasing/upgrading/paid tiers/charging
- **legal** — attorney review required, licensed attorney, court/litigation/subpoena, regulatory filing, CAN-SPAM/GDPR violation
- **strategy_pivot** — pivot product, change target market, kill feature, shut down, change pricing
- **merge_to_main** — merge to main, force merge, skip staging

Everything else the loop ships without asking.

## Dispatch mechanics

For each picked item, the loop:

1. Creates a `jarvis_future_builds` row (so the HUD shows it)
2. Inserts an `agent_queue` row with priority based on signal score:
   - Score ≥80 → priority 1 (critical)
   - Score ≥60 → priority 2 (high)
   - Score ≥40 → priority 3 (normal)
   - Otherwise → priority 4 (low)
3. `cron-agent-queue-dispatch` (already running every 2 min) picks up the
   queued task and executes it against Anthropic — no additional plumbing
4. All existing rules apply: drafter/shipper split (Carter drafts, Atlas
   ships), APV required before merge, Quinn QA gate, etc.

## Where to watch it

- **Live dashboard**: `meetdossie.com/ventures/reliability` — cron health
  including the loop's own last-run status
- **Table view**:
  ```sql
  select run_ts, signal_source, item_picked, agent_dispatched, outcome
  from autonomous_loop_runs
  order by run_ts desc
  limit 20;
  ```
- **Morning brief**: 6 AM CDT daily via Telegram + email

## Safety limits

- Handler bails out at 18 minutes (Vercel max is 20) and logs
  `skipped_stuck` if it exceeds that. Never gets stuck in a hot loop.
- Every dispatch respects the existing `cole-enqueue` dup-build check
  patterns (the loop calls the same tables but doesn't need to re-check
  because it never enqueues "build a privacy policy that already exists"
  style asks).
- All errors soft-fail into `autonomous_loop_runs` with outcome=`error` +
  outcome_reason. The loop never crashes silently.

## Adding a new signal source

To add a new signal (e.g. "posts stuck in `pending_video` status >48h"):

1. Add a `gatherFoo()` async function in `cron-autonomous-loop.js` that
   returns an array of candidate objects:
   ```js
   {
     signal_source: 'stale_video_pipeline',
     signal_key: `stale_video:<post_id>`,   // MUST be unique + stable
     signal_score: 40,                       // decide priority
     title: 'Video stuck in pipeline: <topic>',
     description: 'Full brief for the agent',
     agent: 'atlas',                         // who fixes it
     meta: { post_id, stuck_since },
   }
   ```
2. Add a `SCORE.STALE_VIDEO_PIPELINE` constant at the top
3. Add a `COOLDOWN_HOURS.stale_video_pipeline` entry
4. Call `gatherFoo()` in the `Promise.all` block inside `handler`

That's it — the picker, guardrail, cooldown, and logging handle the rest.

## Manually firing the loop

```powershell
$env:CRON_SECRET | Set-Content -Path .\.tmp\cs.txt -NoNewline
curl -H "Authorization: Bearer $(Get-Content .\.tmp\cs.txt)" `
     https://meetdossie.com/api/cron-autonomous-loop
```

Or ask Heath to fire it from Telegram — never embed the secret in
tracked files (per Section 15 of CLAUDE.md).

## Tests

```bash
node scripts/carter-autonomous-loop-backlog-parser-test.js
```

119 assertions covering the closed-item filter, the `Blocked by` gate, both
real backlog documents, and the loop's gatherers read-only (never `dispatch()`).
The `alert_state` section needs `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
from `.env.local` and skips cleanly without them. Every false positive found
against the real docs is pinned as a regression case.

## Files touched by this build

- `api/cron-autonomous-loop.js` — the loop
- `api/cron-autonomous-daily-digest.js` — the 6 AM morning brief
- `supabase/migrations/20260701_autonomous_loop_runs.sql` — logging + cooldown tables
- `vercel.json` — 2 new cron entries + function budgets (300s for loop, 60s for digest)
- `docs/AUTONOMOUS-LOOP.md` — this file
- `api/_lib/backlog-parser.js` — closed-item filter + `Blocked by` gate (2026-09-17)
- `scripts/carter-autonomous-loop-backlog-parser-test.js` — tests for both (2026-09-17)
