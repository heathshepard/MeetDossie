# SV-ENG-STAGING-WATCHER — Ridge, 2026-06-14

**Mission:** Kill the Cole-as-bottleneck pattern on Carter staging pushes.

**Before:** Every Carter staging push waited for Cole to manually spawn Quinn for QA. 5-15 min latency per ship. Cole was a serial blocking point.

**After:** GitHub poll every 2 min → new Carter commit detected → Quinn auto-dispatched + QA loop auto-fired + Heath gets ONE Telegram with verdict path. Cole's only role is relaying Heath's "merge it" → Carter merges.

---

## Files shipped

- `supabase/migrations/20260614_staging_watcher.sql` — new tables `staging_watch_state` (singleton, last_seen_sha) + `staging_push_events` (audit trail, UNIQUE on commit_sha)
- `api/cron-staging-watcher.js` — the polling cron itself
- `vercel.json` — added schedule `*/2 * * * *` + maxDuration 30s

## How it works

1. Cron fires every 2 min (24/7).
2. Calls GitHub `/repos/heathshepard/MeetDossie/branches/staging` to get current HEAD.
3. Compares HEAD to `staging_watch_state.last_seen_sha`.
4. If new commit(s) found:
   a. Inserts `agent_requests` row with `from_agent='ridge'`, `to_agent='quinn'`, `source_chat_id=TELEGRAM_CHAT_ID`. Existing `cron-process-agent-requests` picks it up within 60s and runs stateless Sonnet Quinn → posts verdict back to Heath's Sage chat.
   b. Fire-and-forget GET to `/api/cron-dossie-qa-loop` (the Playwright scenario suite — already scheduled hourly; we fire it again on-demand for this push).
   c. ONE Telegram via the main bot to Heath: `Carter shipped to staging | sha — message | Quinn auto-dispatched | QA loop fired | Reply "merge it" or "loop back to Carter"`.
   d. Inserts `staging_push_events` row (idempotent on `commit_sha`) for the reliability audit trail.
   e. Advances `last_seen_sha` to the new HEAD.
5. Bootstrap: first poll ever records current HEAD as seen — no dispatch on first run.

## Fail-soft behavior

- Migration not applied → cron returns `{noop: true, reason: 'state_table_unavailable'}` and exits cleanly. Telemetry records 'ok' with warning. No 500s.
- GitHub 5xx / rate-limited → returns 200 with `reason: 'github_unreachable'`. Retries next tick.
- Quinn dispatch fails → Telegram still fires with note `Quinn dispatch FAILED (...)`. Heath knows.
- Force-push / rebase (compare endpoint fails) → falls back to HEAD-only dispatch. Better to over-notify than miss.

## Deploy steps (in order)

1. **Apply migration** — Heath approval required per `feedback_staging_database_safety.md`:
   ```sql
   -- File: supabase/migrations/20260614_staging_watcher.sql
   -- Apply via Supabase MCP or psql to project pgwoitbdiyubjugwufhk
   ```
2. **Push to staging** — Vercel auto-deploys; cron schedule activates.
3. **Verify first poll** — within 2 min, expect a row in `staging_watch_state` with `last_polled_at` populated and `last_seen_sha` = current staging HEAD. NO Telegram on bootstrap.
4. **Verify trigger** — Carter pushes a trivial commit to staging → within 2 min Heath gets the Telegram, Quinn's response follows within ~90s via the Sage bot.

## Limits + non-goals

- Does NOT auto-merge. Heath's "merge it" still gates main per `feedback_heath_final_approval_required.md`.
- Does NOT auto-fix failures. Quinn flags, Carter fixes.
- Does NOT replace session-Quinn (the Cole-spawned Task agent for deep Playwright runs). This is a velocity layer on top.
- Max 10 commits batched per tick. If Carter ships >10 in 2 min the older ones land in metadata only.

## Env vars used

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — required
- `CRON_SECRET` — required for self-fire of agent-dispatch + qa-loop
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — required for the heath ping
- `SELF_BASE_URL` — optional; defaults to https://meetdossie.com
- `GITHUB_TOKEN` — optional; without it we use the public 60 req/h limit. With 30 polls/h we're at 50% of the unauthenticated quota — fine. Add token for safety margin if needed.

## Reliability dashboard hook (followup, not in this ship)

`/ventures/reliability` should grow a "Staging watcher" panel reading:
- `staging_watch_state.last_polled_at` (how fresh is the watcher)
- `staging_watch_state.poll_count` (running counter)
- Last 10 `staging_push_events` (sha, message, Quinn-ok, QA-ok, Telegram-ok)

Filed for next sprint.
