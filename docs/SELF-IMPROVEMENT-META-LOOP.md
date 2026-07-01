# Self-Improvement Meta-Loop

Ridge, 2026-07-01. Owner: Ridge (reliability + observability + self-improvement).

Heath 2026-07-01 07:11 CDT: "I want you to constantly think of ways to improve
your intelligence and usefullness to me. How do we make this a constant and
ongoing pursuit."

## What this is, in one paragraph

Three crons watch how the system worked yesterday, this week, and this month.
They detect friction (Heath corrections, Cole punts, agent blockers, capability
gaps, recurring themes) and draft concrete proposals — new memory rules, tool
enablements, prompt rewrites, rule retirements. Every proposal shows up in
your 6 AM Telegram brief. You reply yes / no / defer. Nothing self-modifies.

## The three tiers

| Tier | Cron | Fires | Reads | Writes |
|---|---|---|---|---|
| **Daily** | `cron-self-improvement-daily.js` | 5 AM CST (`0 10 * * *`) | last 24h agent_queue + autonomous_loop_runs + cron_runs | `self_improvement_signals` (raw) + `self_improvement_candidates` (proposals) |
| **Weekly** | `cron-self-improvement-weekly.js` | Sundays 6 AM CST (`0 11 * * 0`) | last 7d access-punt signals + blocked tasks + wishlist language | `self_improvement_candidates` (capability enablements) |
| **Monthly** | `cron-self-improvement-monthly.js` | 1st @ 8 AM CST (`0 13 1 * *`) | last 30d candidates + signals + agent stats | `self_improvement_candidates` (consolidations / retirements / rewrites) |

## Tier 1 — daily conversation-review scan

Every day at 5 AM CST (one hour before the 6 AM autonomous digest, so proposals
merge into that single brief — no extra ping).

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
theme and rolls each cluster into one `self_improvement_candidates` row.

**Nothing auto-modifies memory or agent files.** Every candidate is proposed only.

## Tier 2 — weekly capability radar

Every Sunday at 6 AM CST. Reads:

1. Tier-1 signals tagged with a punt theme (access_punt, permission_ask, hedging)
2. `agent_queue` completions with "would be easier with" language in `result_summary`
3. All `blocked` tasks in the last 7 days

The clusterer buckets these by keyword hint (gmail, calendar, stripe, docusign,
linkedin, drive, canva, ...). Any bucket with ≥ 2 matches becomes one of:

- **`enable_zapier_action`** — when the app already has a Zapier integration.
  Proposal names the exact `mcp__claude_ai_Zapier__enable_zapier_action` call
  Heath approves in the brief; Ridge or Atlas executes.
- **`build_custom_integration`** — when no Zapier fit exists. Proposal scopes
  the build (native API / Playwright / MCP server) but doesn't kick off code.

## Tier 3 — monthly meta-loop review

1st of every month at 8 AM CST. Reads the last 30 days of candidates, signals,
and per-agent quality stats. Identifies:

- **Rule not sticking** — approved candidate on theme X, but 5+ new signals on
  theme X still fired that month → the rule's text isn't enforcing behavior.
  Proposal: rewrite as paramount / move to runtime enforcement gate.
- **Drafter false positives** — theme rejected 2+ times → tighten the tier-1
  pattern regex.
- **Drafter coverage gap** — theme with ≥ 20 signals but zero candidates →
  drafter's `switch` doesn't handle it.
- **Agent quality** — agent with >20% blocked rate → prompt likely lacks a
  capability pointer or process.

All monthly drafts land in `self_improvement_candidates` with `tier='monthly'`.

## How the daily 6 AM brief surfaces candidates

`cron-autonomous-daily-digest.js` (existing) now queries pending candidates
across all tiers, orders by `impact_score` desc, and shows the top 3:

> **Self-improvement — say yes/no:**
> 1. Lock rule: Heath corrected 3x on "brevity"
>    *why:* Heath issued 3 corrections matching theme "brevity" in the last 24h.
> 2. Reduce punts: 4 "permission_ask" events
>    *why:* Cole/agents punted or asked permission 4x on theme "permission_ask".
> 3. Enable Zapier action: Gmail / send_email (2 gaps this week)
>    *why:* 2 agent tasks in the last 7 days either punted or wished for Gmail.
>
> *Reply "yes 1", "no 2", or "defer 3" — I lock it in.*

Each shown candidate gets `surfaced_in_brief_at` stamped so it doesn't get
re-shown day after day. Heath's yes/no lands in `heath_decision` (approved /
rejected / deferred / superseded) via Cole's inbound handler.

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
- **Rate-limited surface area.** Top 3 candidates only in the daily brief.
  Full detail lives in the table + reliability dashboard for on-demand review.

## Where to watch it

- **Digest**: 6 AM CST daily (existing brief, now includes top 3 candidates)
- **Table view**:
  ```sql
  select drafted_at, tier, change_kind, title, impact_score,
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

- `api/cron-self-improvement-daily.js` — tier 1
- `api/cron-self-improvement-weekly.js` — tier 2
- `api/cron-self-improvement-monthly.js` — tier 3
- `api/cron-autonomous-daily-digest.js` — extended with top-3 candidate section
- `supabase/migrations/20260701_self_improvement_signals.sql` — three tables
- `vercel.json` — 3 new cron entries + 3 function budgets
- `docs/SELF-IMPROVEMENT-META-LOOP.md` — this file
- `docs/AUTONOMOUS-LOOP.md` — updated with cross-link

## Manually firing each tier

```powershell
curl -H "Authorization: Bearer $env:CRON_SECRET" `
     https://meetdossie.com/api/cron-self-improvement-daily

curl -H "Authorization: Bearer $env:CRON_SECRET" `
     https://meetdossie.com/api/cron-self-improvement-weekly

curl -H "Authorization: Bearer $env:CRON_SECRET" `
     https://meetdossie.com/api/cron-self-improvement-monthly
```

Never embed the secret in tracked files — per Section 15 of CLAUDE.md.
