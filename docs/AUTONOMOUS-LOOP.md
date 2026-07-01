# Autonomous Self-Improvement Loop

Ridge, 2026-07-01. Owner: Ridge (reliability + observability).

## What it does, in one paragraph

Every 4 hours a cron wakes up, looks at everything that might need attention
(open customer bugs, prod errors, KPI drift, tech debt, Dossie Sign last-mile
blockers, agent idleness), picks the single most important thing, and hands
it to the right agent to build/fix/investigate. Once a day at 6 AM CDT you
get a plain-English morning brief telling you what shipped, what's blocked
on your call, and whether anything scary happened.

## The pieces

| Piece | File | Fires |
|---|---|---|
| The loop | `api/cron-autonomous-loop.js` | Every 4 hours (0 */4 * * *) |
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
4. **KPI drift** — `kpi_snapshots` week-over-week diff >±10% — score 60
5. **Urgent tech debt** (🚨 / URGENT items in `docs/TECH-DEBT.md`) — score 50
6. **Dossie Sign mid-confidence blockers** (confidence >=8) — score 40
7. **Active tech debt** (other items in NOT DONE section) — score 30
8. **Ridge reliability idle** — score 25
9. **Sage / Hadley backlog idle** — score 20
10. **Pierce activation backlog idle** — score 15

Every candidate is scored, sorted, and only THE ONE highest-score item is
picked per 4h tick. If everything is on cooldown, the loop logs "no signal"
and exits quietly (silence = healthy).

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

## Files touched by this build

- `api/cron-autonomous-loop.js` — the 4-hour loop
- `api/cron-autonomous-daily-digest.js` — the 6 AM morning brief
- `supabase/migrations/20260701_autonomous_loop_runs.sql` — logging + cooldown tables
- `vercel.json` — 2 new cron entries + function budgets (300s for loop, 60s for digest)
- `docs/AUTONOMOUS-LOOP.md` — this file
