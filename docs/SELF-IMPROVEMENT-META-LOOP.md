# Self-Improvement Meta-Loop — daily cadence

Ridge, 2026-07-01. Owner: Ridge (reliability + observability + self-improvement).

Heath 2026-07-01 07:11 CDT: "I want you to constantly think of ways to improve
your intelligence and usefullness to me. How do we make this a constant and
ongoing pursuit."

Heath 2026-07-01 07:18 CDT: "I think i want it more daily. I dont want you to
grow weekly but daily."

## What this is, in one paragraph

One cron watches how the system worked yesterday, scans for capabilities that
would have unblocked yesterday's punts, and audits the memory-rule stack — all
in a single 5 AM run. Detects friction (Heath corrections, Cole punts, agent
blockers, capability gaps, recurring themes) and drafts concrete proposals —
new memory rules, tool enablements, prompt rewrites. Every proposal shows up
in your 6 AM Telegram brief grouped by category. You reply yes / no / defer.
Nothing self-modifies.

## The change from the original 3-tier design

Original plan (2026-07-01 morning) had a daily/weekly/monthly split. Heath
locked it fully daily at 07:18 CDT. Weekly and monthly views are gone. If a
signal only fires once a week or once a month it still fires daily — the deltas
just come in slower. The point is the loop never sleeps and you never wait
seven days to hear about a broken pattern.

## The single cron

| Cron | Fires | Reads | Writes |
|---|---|---|---|
| `cron-self-improvement-daily.js` | 5 AM CST daily (`0 10 * * *`) | last 24h agent_queue + autonomous_loop_runs + cron_runs + tier-1 signals + rolling 7d candidate history | `self_improvement_signals` (raw) + `self_improvement_candidates` (proposals) with `category` set to one of `conversation_review` / `capability_scan` / `rule_audit` |

Fires one hour before the 6 AM autonomous digest so proposals merge into that
single brief — no extra ping.

## Three checks in one run

### Check 1 — conversation review (yesterday, 24h window)

Signal sources:
1. **`agent_queue` last 24h completions**
   - Explicit `metadata.heath_correction` field (Cole/Jarvis logs Heath's pushback
     verbatim when a task result gets rejected)
   - Pattern-match `result_summary` for punt / permission-ask / hedging language
   - Any `status='blocked'` row → agent hit a wall
2. **`autonomous_loop_runs` last 24h**
   - `skipped_guardrail` reasons — 2+ of the same guardrail = missing memory rule
   - `skipped_stuck` items — need human review
3. **`cron_runs` persistent failures**
   - 3+ crons stuck in error > 6h = observability gap, not a one-cron problem

Pattern matchers (case-insensitive, word-boundary anchored):

| Bucket | Pattern examples | Theme | Severity |
|---|---|---|---|
| Correction | "you should have", "why didn't you" | missed_directive | 5 |
| Correction | "that's wrong", "got it wrong" | wrong_output | 4 |
| Correction | "stop doing", "stop asking" | stop_pattern | 4 |
| Correction | "don't do/ask/say/send" | dont_pattern | 4 |
| Correction | "no," "no." | no_correction | 3 |
| Frustration | "too long/slow/technical/many questions/verbose" | too_much | 4 |
| Frustration | "again?", "still?", "why are you" | repeat_frustration | 5 |
| Frustration | "hurry", "faster", "just do it" | speed | 3 |
| Frustration | "brevity", "shorter" | brevity | 3 |
| Punt | "I don't have access", "no access to" | access_punt | 4 |
| Punt | "can you check/confirm/verify/paste" | asked_heath_to_check | 3 |
| Punt | "want me to", "should I", "OK to proceed" | permission_ask | 3 |
| Punt | "I don't know", "I'm not sure", "might be" | hedging | 2 |

Raw detections land in `self_improvement_signals`. Then the drafter clusters by
theme and rolls each cluster into one `self_improvement_candidates` row with
`category='conversation_review'`.

### Check 2 — capability scan (overnight, 24h window)

Was formerly a weekly-only tier. Now runs daily.

Reads:
1. Tier-1 punt-theme signals from THIS run + last 24h
2. `agent_queue` completions with "would be easier with" language in `result_summary`
3. All `blocked` tasks in the last 24h

The clusterer buckets by keyword hint (gmail, calendar, stripe, docusign,
linkedin, drive, canva, sms, phone, ...). Any bucket with ≥ 2 matches in 24h
becomes one of:

- **`enable_zapier_action`** — when the app already has a Zapier integration.
  Proposal names the exact `mcp__claude_ai_Zapier__enable_zapier_action` call
  Heath approves in the brief; Ridge or Atlas executes.
- **`build_custom_integration`** — when no Zapier fit exists. Proposal scopes
  the build (native API / Playwright / MCP server) but doesn't kick off code.

Writes candidates with `category='capability_scan'`.

### Check 3 — rule audit (rolling 7d window)

Was formerly a monthly-only tier. Now runs daily against a rolling 7-day window.
Cheap enough to run every morning; heavier deltas will still surface on their
own cadence.

Reads the last 7 days of candidates, signals, and per-agent quality stats.
Identifies:

- **Rule not sticking** — approved candidate on theme X, but 5+ new signals on
  theme X still fired that week → the rule's text isn't enforcing behavior.
  Proposal: rewrite as paramount / move to runtime enforcement gate.
- **Drafter false positives** — theme rejected 2+ times → tighten the
  pattern regex.
- **Drafter coverage gap** — theme with ≥ 20 signals in 7d but zero candidates →
  drafter's `switch` doesn't handle it.
- **Agent quality** — agent with >20% blocked rate over 7d → prompt likely
  lacks a capability pointer or process.

Writes candidates with `category='rule_audit'`.

## The 6 AM morning brief — top 3 per category

`api/cron-autonomous-daily-digest.js` fires 6 AM CST (`0 11 * * *`), pulls
pending candidates (up to 30, ordered by `impact_score` desc), groups them by
category, and shows **top 3 per category** in the Telegram brief:

> **Self-improvement — say yes/no:**
>
> *Yesterday's conversation review*
> 1. Lock rule: Heath corrected 3x on "brevity"
>    *why:* Heath issued 3 corrections matching theme "brevity" in the last 24h.
> 2. Reduce punts: 4 "permission_ask" events
>    *why:* Cole/agents punted or asked permission 4x on theme "permission_ask".
> 3. ...
>
> *Overnight capability scan*
> 4. Enable Zapier action: Gmail / send_email (2 gaps in last 24h)
>    *why:* 2 agent tasks in the last 24h either punted or wished for Gmail.
> 5. ...
>
> *Rule audit (7d rolling)*
> 6. Rule not sticking: "no_punt_access" — 7 recurrences in last 7d despite approval
>    *why:* A memory rule on theme "no_punt_access" was approved recently, but 7...
> 7. ...
>
> *Reply "yes 1", "no 2", or "defer 3" — I lock it in.*

Only the shown items (top 3 per category, max 9 total) get
`surfaced_in_brief_at` stamped — the tail sits and re-surfaces next day if
higher-impact items don't crowd it out.

## Why daily over weekly/monthly

1. **Signal loss is immediate.** Auto-summaries drop context by day 2. Waiting
   a week to run the capability scan means Monday's Gmail-punt is unattributable
   by Sunday.
2. **Compounding.** A rule shipped Tuesday changes Wednesday's signals.
   Weekly-only meant Ridge missed a full cycle of "did the rule work?"
3. **One brief, one decision.** Heath reads one Telegram brief in the morning
   and says yes/no to at most 9 things. Less cognitive load than three
   different-cadence briefs.
4. **The loop never sleeps.** If Heath takes a week off, the daily loop still
   catches the pattern the day he returns.

## What gets applied after Heath approves

Heath's approval is the trigger, not auto-drift. Once `heath_decision='approved'`:

- **`new_memory_rule`** — Ridge writes the memory file at `target_path` + adds
  the index entry to `MEMORY.md`, stamps `applied_commit_sha`.
- **`retire_memory_rule` / `rewrite_memory_rule`** — Cole edits the file,
  commits with the candidate id in the message.
- **`enable_zapier_action`** — Ridge calls `enable_zapier_action` with the
  exact payload from `proposed_change`.
- **`build_custom_integration`** — Ridge spawns Atlas or Carter with the
  scoped spec as the brief.
- **`rewrite_agent_prompt`** — Ridge spawns the affected agent to self-edit,
  or Atlas edits directly if the agent is scoped by the request.

## Safety guarantees

- **No self-modification.** Every write to memory / agent prompts / vercel.json
  needs a human `heath_decision='approved'` first.
- **Full audit trail.** Every raw signal, every candidate, every Heath decision
  is stored — nothing lost to auto-summary compaction.
- **Meta-observability.** `self_improvement_runs` records every tick, so the
  meta-loop itself has cron_runs telemetry AND its own success/failure log.
  Mission Watchdog reads both.
- **Rate-limited surface area.** Top 3 per category (max 9) in the daily brief.
  Full detail lives in the table + reliability dashboard for on-demand review.

## Where to watch it

- **Digest**: 6 AM CST daily (existing brief, now includes top 3 per category)
- **Candidate view**:
  ```sql
  select drafted_at, tier, category, change_kind, title, impact_score,
         heath_decision, heath_decided_at
    from self_improvement_candidates
    order by drafted_at desc
    limit 25;
  ```
- **Raw signal review**:
  ```sql
  select detected_at, theme, severity, verbatim_quote, notes
    from self_improvement_signals
    where detected_at > now() - interval '7 days'
    order by severity desc, detected_at desc
    limit 50;
  ```
- **Meta-run health**:
  ```sql
  select run_ts, tier, signals_scanned, candidates_drafted, outcome
    from self_improvement_runs
    order by run_ts desc
    limit 10;
  ```

## Files touched by this build

- `api/cron-self-improvement-daily.js` — single daily cron, three checks
- `api/cron-autonomous-daily-digest.js` — extended with top-3-per-category
- `supabase/migrations/20260701_self_improvement_signals.sql` — three tables
- `vercel.json` — one cron entry + one function budget
- `docs/SELF-IMPROVEMENT-META-LOOP.md` — this file

## Deprecated 2026-07-01

- `api/cron-self-improvement-weekly.js` — deleted, logic merged into daily
- `api/cron-self-improvement-monthly.js` — deleted, logic merged into daily

## Manually firing the daily cron

```powershell
curl -H "Authorization: Bearer $env:CRON_SECRET" `
     https://meetdossie.com/api/cron-self-improvement-daily
```

Never embed the secret in tracked files — per Section 15 of CLAUDE.md.

## Schema note — `category` column

Check 2 and Check 3 rely on a `category` column on `self_improvement_candidates`.
If the migration hasn't landed yet, the daily cron retries the insert without
the column and the digest falls back to reading `title` prefix + `change_kind`.
Migration to add the column safely:

```sql
alter table self_improvement_candidates
  add column if not exists category text
    check (category in ('conversation_review','capability_scan','rule_audit'));

create index if not exists self_improvement_candidates_category_idx
  on self_improvement_candidates (category, heath_decision, impact_score desc);
```
