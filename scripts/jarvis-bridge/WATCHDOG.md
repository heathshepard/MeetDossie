# jarvis-bridge watchdog + logging

**Author:** Atlas
**Built:** 2026-08-22
**Driver:** a real outage this date — the jarvis-bridge relay hung mid-`await`
on an unbounded `fetch()`, stayed alive at 0% CPU with zero stderr output,
and Heath was talking to a dead voice channel for 9+ minutes with no signal
anything was wrong. This queue task closes that hole two ways: the process
now watches itself, and a separate Windows-side watchdog watches the process.

---

## What exists now

**Inside `scripts/jarvis-bridge/server.ts` (self-monitoring):**

| Piece | What it does |
|---|---|
| `LOG_FILE` (`~/.claude/channels/jarvis-bridge/server.log`, WSL side) | Every `stderr` write is teed here with a timestamp, independent of how the process was spawned. Rolls itself at 5MB (keeps the newest half) so it can't grow unbounded. |
| `HEARTBEAT_FILE` (`~/.claude/channels/jarvis-bridge/heartbeat.json`) | Written on every completed poll tick: `{ts, pid, uptime_s, status}`. This is what the external watchdog below checks — cheaper than parsing the growing log. |
| `FETCH_TIMEOUT_MS` (existing, 10s default) | Every Storage `fetch()` carries `AbortSignal.timeout` — the specific hole the 2026-08-22 outage went through is closed. |
| Stall watchdog (`STALL_THRESHOLD_MS`, 90s default) | A separate timer checks whether the current poll tick has been in flight too long. If so: logs CRITICAL, sends a push alert, self-terminates (`fatal()`). Insurance against the *next* blocking call someone adds without a timeout. |
| `fatal()` escalation | Also fires on an uncaught exception (Node's own guidance: unsafe to keep running after one) or 5+ unhandled rejections inside 60s. Pushes an alert, then `process.exit(1)` — loud and fast instead of a silent zombie. |

**Outside, on Windows (`scripts/jarvis-bridge/watchdog.ps1` + `register-watchdog.ps1`):**

A Task Scheduler job, `JarvisBridgeWatchdog`, every 5 min:
1. Reads `heartbeat.json` via `wsl.exe -d Ubuntu -- cat ...`.
2. If fresher than 5 min → logs `OK`, done.
3. If stale/missing → checks (again via `wsl.exe ... pgrep`) whether the
   dev-channels Claude Code session and the `bun server.ts` child are even
   running, and sends **one specific Telegram alert** naming which of three
   failure modes it is and the actual fix — not a generic "something's
   wrong." Re-alerts at most every 30 min while still down, and sends a
   recovery message once it comes back.

Telegram token is read from `~/.claude/channels/telegram/.env` (WSL side —
the same file the telegram plugin itself loads), **not**
`MeetDossie/.env.local`. Confirmed 2026-08-22: `.env.local`'s
`TELEGRAM_BOT_TOKEN` is the literal string `"[SENSITIVE]"` — `vercel env
pull`'s placeholder for a write-only var, not a real token. Sending from
there would have silently 400'd forever. Same trap `server.ts`'s own
top-of-file comment already documents for `SUPABASE_SERVICE_ROLE_KEY`.

---

## The honest limitation — this does NOT auto-relaunch the session

Two real, load-bearing reasons, not laziness:

1. `--dangerously-load-development-channels` shows a one-screen interactive
   warning that needs a real keypress on every fresh launch (confirmed
   against the installed CLI — see `MeetDossie.bat`'s own comment block). An
   unattended relaunch would sit at that screen forever — a `claude` process
   would exist (looks alive) while jarvis-bridge never actually attaches. That
   is a *worse*, harder-to-notice silent failure than the one this replaces.
2. The plain Cole/Telegram session already runs as its own always-on process
   (`ColeClaudeCodeSession` / `cole-watchdog.ps1`). Auto-launching a *second*
   `--channels plugin:telegram` session risks the exact `getUpdates` 409
   poller-conflict failure mode CLAUDE.md Section 24 already warns about.

So "watchdog/auto-restart" here means: the in-process side restarts itself
loudly (`fatal()` → alert → exit) instead of hanging silently, and the
external side detects + alerts fast and specifically instead of trying to
silently self-heal something that structurally can't be self-healed
unattended. Recovery today is still: Heath restarts `MeetDossie.bat`,
presses Enter once. This build makes sure he finds out within 5 minutes
instead of whenever he happens to notice Jarvis went quiet.

---

## Files

| Path | Role |
|---|---|
| `scripts/jarvis-bridge/server.ts` | Relay itself — logging, heartbeat, stall watchdog, `fatal()` escalation live here. |
| `scripts/jarvis-bridge/watchdog.ps1` | External check, run every 5 min. Safe to run manually anytime. |
| `scripts/jarvis-bridge/register-watchdog.ps1` | One-time installer for the `JarvisBridgeWatchdog` Task Scheduler entry. Idempotent. |
| `~/.claude/channels/jarvis-bridge/server.log` (WSL) | Rolling log, capped at 5MB. |
| `~/.claude/channels/jarvis-bridge/heartbeat.json` (WSL) | Freshness signal for the external watchdog. |
| `C:\Users\Heath\.claude\jarvis-bridge-watchdog.log` (Windows) | External watchdog's own tick log, capped at 500 lines. |
| `C:\Users\Heath\.claude\jarvis-bridge-watchdog.state.json` (Windows) | Alert dedup state (`ok`/`down`, last alert time). |

## Install (one-time, already done 2026-08-22)

```powershell
cd C:\Users\Heath\Projects\MeetDossie
powershell -ExecutionPolicy Bypass -File scripts\jarvis-bridge\register-watchdog.ps1
```

Verify:
```powershell
Get-ScheduledTask -TaskName 'JarvisBridgeWatchdog' | Format-Table TaskName, State
Get-ScheduledTaskInfo -TaskName 'JarvisBridgeWatchdog' | Select-Object NextRunTime, LastRunTime, LastTaskResult
```

Force a manual tick: `Start-ScheduledTask -TaskName 'JarvisBridgeWatchdog'`

## Known state as of this build

The `bun server.ts` process live on Heath's machine when this was built
(PID from `Aug21`, running since before this session's edits landed on disk)
predates all of the above — it will correctly show as "heartbeat
missing/unreadable" until that Claude Code session is restarted and picks up
the new `server.ts`. That's not a bug in the watchdog; it's the watchdog
correctly reporting a real, pre-existing gap. One real Telegram alert fired
during testing of this build for that reason.

## Known gap (v2 backlog)

If the relay dies in a way that ALSO breaks its own push call (rare — push
uses the same event loop as everything else in that process) *and* the
Windows-side watchdog's Telegram send also fails (bad token, Telegram API
down), there's no third channel. Not fixed here — flagged, same as
`cole-watchdog.ps1`'s own v2 backlog for the parallel MCP-roundtrip-probe gap.
