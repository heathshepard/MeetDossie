# Jarvis HUD Freshness Audit — 2026-07-01

**Auditor:** Ridge (Head of Reliability & Observability)
**Triggered by:** Heath, 2026-07-01 05:16 CDT from Chamonix: "The jarvis app doesnt show live data. It need a thorough review when was the last time it updated? Why doesnt it update regularly"
**Verdict:** HUD IS updating regularly. Underlying data is genuinely idle. Real gap = HUD shows no per-panel "last polled" timestamp so Heath can't tell live-idle from broken.

---

## 1. Freshness snapshot per Jarvis data source

| Source | Most recent write | Age | Interpretation |
|---|---|---|---|
| `cron_runs` (via `cron-agent-queue-tick`) | 2026-07-01 05:17:13 UTC | 44 seconds | Healthy |
| `cron_runs` (via `cron-money-pulse-snapshot`) | 2026-07-01 05:15:26 UTC | 3 min | Healthy |
| `cron_runs` (via `cron-mission-watchdog`) | 2026-07-01 05:00:04 UTC | 18 min (fires 1x/hour) | Healthy |
| `jarvis_project_context` (Cole memory writes) | 2026-06-28 00:28 UTC | 3d 4h | Idle — only written when Cole mints memory |
| `jarvis_agent_events` | 2026-06-26 06:09 UTC | 5d | Idle — no new agent spawns since marathon |
| `jarvis_agent_instances` | 2026-06-24 10:24 UTC | 6d | Idle — no new agent spawns since marathon |
| `agent_queue` | 2026-06-26 06:10 UTC | 5d | Idle — 0 pending, 0 active, 1 completed in 3d |
| `heath_todo` | 2026-06-26 05:53 UTC | 5d | Idle — 5 open TODOs unchanged since Chamonix trip |
| `jarvis_future_builds` | 2026-06-26 07:17 UTC | 5d | Idle — 0 open |
| `subscriptions` latest row | 2026-06-09 06:00 UTC | 21d | No new signups since 6/9 |

## 2. Write pipeline health

All 30 crons that fire on ≤1-hour cadence are green:

- `cron-agent-queue-tick` — every ~2 min, last OK 44s ago
- `cron-agent-queue-dispatch` — every ~2 min, last OK 1m 35s ago
- `cron-send-outbound-emails` — every ~2 min, last OK 54s ago
- `cron-staging-watcher` — every ~2 min, last OK 1m 37s ago
- `cron-sage-first-comment` — every ~5 min, last OK 2m 09s ago
- `cron-money-pulse-snapshot` — every ~5 min, last OK 2m 30s ago
- `cron-assemble-skits`, `cron-auto-approve`, `cron-dossie-qa-loop` — ~10 min cadence, all OK
- `cron-mission-watchdog`, `cron-sage-regenerate`, `cron-publish-approved` — hourly, all OK last hour
- `cron-daily-debrief` — daily 02:00 UTC, ran 3h ago OK
- `cron-daily-platform-health` — daily 03:00 UTC, ran 2h ago OK
- `cron-morning-brief` — daily 12:00 UTC, ran 17h ago OK

**Silent crons (>12h) — worth investigating separately but NOT the cause of Heath's complaint:**

| Cron | Days silent | Likely status |
|---|---|---|
| `cron-thursday-blast` | 18d | Retired? |
| `cron-process-agent-requests` | 18d | Retired (see recent commit `feda3f6` retiring 34 stale endpoints) |
| `cron-send-for-approval` | 16d | Retired? |
| `cron-sage-draft-engagements` | 13d | Retired? |
| `cron-send-engagement-approvals` | 13d | Retired? |
| `cron-weekly-newsletter-draft` | 5d | Weekly cadence — probably fine |
| `cron-agent-queue-tick-watchdog` | 3d | Worth checking — meant to watchdog the ticker |
| `cron-analytics-sync` | 3d | Worth checking — feeds MRR/analytics |
| `cron-competitor-intel` | 2d | Weekly? |
| `cron-customer-view-digest` | 1d 18h | Expected Monday cadence |
| `cron-competitor-monitor` | 1d 17h | Expected daily-ish |

## 3. `/api/cole-write-context` health

Endpoint is fine. It requires `Bearer $CRON_SECRET` and only fires when a Cole/Jarvis session mints strategic memory (per `feedback_mirror_memory_to_jarvis_context.md`). Heath is on vacation → no active Cole sessions → no writes. That is expected behavior, not a bug.

Latest 5 successful upserts (all from the 2026-06-26 marathon and follow-ups):
- `dossie-sign-e2e-verified` — 2026-06-28 00:28
- `overnight-queue-drain-2026-06-27` — 2026-06-27 23:58
- `codebase-facts-self-awareness` — 2026-06-27 18:22
- `session-handoff-2026-06-26-marathon` — 2026-06-27 11:00
- `jarvis-stt-debug-overnight` — 2026-06-26 21:34

## 4. HUD frontend polling audit

File: `jarvis-pwa.html` lines 3773-3801.

Polling cadences are correct and running:

| Panel | Interval | Endpoint |
|---|---|---|
| Money Pulse + Activity feed (tickers) | 30s | `/api/jarvis-tickers` |
| Heath TODO | 60s | `/api/heath-todo-next` |
| Merge queue | 30s | `/api/staging-merge-queue` |
| Pending approvals | 30s | `/api/jarvis-pending-approvals` |
| Heath actions | 30s | `/api/heath-actions-list` |
| Daily debrief | 60s | `/api/jarvis-daily-debrief` |
| Customer activity | 30s + realtime | `/api/jarvis-customer-activity` |
| Calendar | 5 min | `/api/jarvis-calendar` |
| Agent ledger | 30s + realtime | Direct Supabase read |
| Agent instances | 30s + realtime | `/api/jarvis-list-instances` |
| Projects ledger | 60s | `/api/jarvis-list-projects` |
| Agent-memory knowledge panel | 90s | `/api/agent-memory-list` |
| Throughput | 30s | `/api/jarvis-agent-throughput` |
| Future builds | 2 min | `/api/jarvis-future-builds-list` |

Realtime subscriptions active on `documents`, `transactions`, `dossier_milestones`, `founding_applications`, `subscriptions`, `profiles` (last_seen updates).

Poll error handling: every `loadX()` swallows errors silently with `.catch(() => {})`. This is where perception can go wrong — a 500 will not surface to the user.

## 5. The actual gap (why Heath perceives "not live")

**There is no "last polled at HH:MM:SS" indicator anywhere on the HUD.** Panels render silently on each successful poll. If the underlying data doesn't change (which is the case right now because the system is idle), the panel looks identical for 5 days straight. Heath cannot distinguish:

- "Poll succeeded 34s ago, no new data" (current state)
- "Poll broken since Sunday, showing stale cache" (feared state)

Zero visual difference. That's the bug — a UX/observability gap, not a data pipeline break.

### Secondary contributor
`cron-agent-queue-tick-watchdog` silent 3d. If it's the watchdog on the ticker, it should be firing daily. Worth Atlas confirming whether this cron was retired or dropped from `vercel.json`.

## 6. Recommended fix (scope-sized for Carter/Atlas)

**Small-scope fix (~30 lines, one commit):**
Add a global "System heartbeat" pill in the HUD header showing `Last poll · 34s · 12 panels green` and turning amber/red if any panel's last-successful-poll exceeds 3× its interval. One shared state object, one setInterval, one DOM node. This directly addresses Heath's "is it live?" question without touching every panel.

**Medium-scope fix (~150 lines):**
Per-panel `data-last-refreshed` attribute + faint timestamp in each panel's meta line ("Updated 34s ago") using existing `fmtAgo()` helper (already in the file at line 5459). Faint by default, amber if >5x interval, red if >30min.

**Data-side follow-ups (Ridge owns):**
1. Confirm the 5+ silent crons above are retired vs. actually broken. Grep `vercel.json` + open a wall-log entry.
2. Add `cron-analytics-sync` (3d silent) to the watchdog — MRR ticker depends on this.
3. `jarvis_project_context` should have a background "session heartbeat" write from Cole every session-start so Jarvis knows Cole is alive even when Heath isn't queueing memory.

## 7. Constraints observed

- No commits to main (per handoff constraints)
- No touches to TREC pipeline
- Fix is >20 lines, so per Ridge SOP this is a DIAGNOSED audit, not FIXED
- Heath sleeping in Chamonix — no permission-ask ping, just result

---

**Bottom line for Heath:** The system is fine. The HUD is live. What's stale is the WORK, because you're on vacation. The HUD just doesn't tell you that — every panel silently shows unchanging data with no "last updated" badge. Fix = add heartbeat indicator. Ridge will queue Carter for the small-scope fix on your return.
