# Cole Watchdog

**Author:** Atlas
**Built:** 2026-06-17
**Driver:** Heath leaves for France 2026-06-20. We need Cole to stay up without supervision. Today (2026-06-17) Telegram MCP dropped for ~3 hrs and Cole was blind — this exists so that case auto-recovers.

---

## What it does

Two Windows scheduled tasks running on Heath's laptop:

| Task | Cadence | Action |
|------|---------|--------|
| `ColeHeartbeat` | every 1 min | Writes Unix timestamp to `C:\Users\Heath Shepard\.claude\heartbeat.txt` **only if** `claude.exe` is currently running. |
| `ColeWatchdog`  | every 5 min | Runs `scripts/cole-watchdog.ps1`. If `claude.exe` is alive, no-op. If dead, sends Telegram alert, relaunches the MeetDossie Claude Code session, waits 30s, sends confirmation. |

Heartbeat staleness = freshness signal for any external monitor (cloud cron, dashboard tile) — if `heartbeat.txt` mtime is older than ~3 min, Cole is down.

---

## Files

| Path | Role |
|------|------|
| `scripts/cole-watchdog.ps1` | The watchdog logic. Idempotent, safe to run anytime. |
| `scripts/register-cole-watchdog.ps1` | One-time installer. Registers both Task Scheduler entries. Idempotent (unregisters first, then re-registers). |
| `C:\Users\Heath Shepard\.claude\heartbeat.txt` | Updated every 60s by ColeHeartbeat. Contents = single Unix timestamp. |
| `C:\Users\Heath Shepard\.claude\watchdog.log` | Rolling log of every watchdog tick + every restart event. Caps at last 100 lines. |

---

## v1 scope (what we DO catch and what we DON'T)

**Caught (v1):**
- `claude.exe` crashed
- `claude.exe` killed by Windows update / reboot
- Heath closed the terminal by accident
- Claude Code internal panic that takes the process down

**Not caught (v1 — deferred):**
- `claude.exe` alive but Telegram MCP dropped (today's actual incident). Mitigation: cloud cron pings every 15 min as belt-and-suspenders; Heath can manually restart when noticed. v2 will add a roundtrip MCP health probe.
- `claude.exe` alive but Cole-the-LLM is stuck on a long-running tool call and unresponsive on Telegram. Same v2 path.

Trade-off: v1 ships before Saturday. v2 (MCP roundtrip probe) needs an out-of-band side channel and a Cole-side reaction hook — more design, post-France work.

---

## Install (Heath does this once)

```powershell
cd "C:\Users\Heath Shepard\Desktop\MeetDossie"
powershell -ExecutionPolicy Bypass -File scripts\register-cole-watchdog.ps1
```

No admin needed. Tasks run as the logged-in user (Interactive logon type) because the watchdog spawns a PowerShell window to host the new claude.exe session.

After install, verify:

```powershell
Get-ScheduledTask -TaskName "Cole*" | Format-Table TaskName, State
Get-ScheduledTaskInfo -TaskName "ColeHeartbeat" | Select-Object NextRunTime, LastRunTime, LastTaskResult
Get-ScheduledTaskInfo -TaskName "ColeWatchdog"  | Select-Object NextRunTime, LastRunTime, LastTaskResult
```

Both should show `State: Ready` and a `NextRunTime` in the next 5 min.

---

## Verify it's working

```powershell
# Heartbeat freshness (should be within last 60-90 sec):
Get-Item "C:\Users\Heath Shepard\.claude\heartbeat.txt" | Select-Object LastWriteTime
Get-Content "C:\Users\Heath Shepard\.claude\heartbeat.txt"

# Watchdog log (last 20 ticks):
Get-Content "C:\Users\Heath Shepard\.claude\watchdog.log" -Tail 20
```

Force a watchdog tick manually:

```powershell
Start-ScheduledTask -TaskName "ColeWatchdog"
```

---

## Disable / remove

**Pause temporarily:**
```powershell
Disable-ScheduledTask -TaskName "ColeHeartbeat"
Disable-ScheduledTask -TaskName "ColeWatchdog"
```

**Remove fully:**
```powershell
Unregister-ScheduledTask -TaskName "ColeHeartbeat" -Confirm:$false
Unregister-ScheduledTask -TaskName "ColeWatchdog"  -Confirm:$false
```

---

## Telegram messages you should see

When `claude.exe` dies:
1. `Cole was down. Auto-restart triggered at YYYY-MM-DD HH:MM:SS. Relaunching Claude Code now.`
2. (30s later) `Cole back online. PID 12345. Watchdog will keep monitoring.`

If restart fails:
- `Cole auto-restart did NOT succeed. claude.exe still not running 30s after launch. Heath manual intervention needed.`

Bot token + chat ID are pulled from `MeetDossie\.env.local` (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`).

---

## v2 backlog

- MCP roundtrip probe: separate channel (cloud cron) sends silent message Cole reacts to; if no react in 60s, treat as down.
- VPS backup Cole on a Linux box — survives full laptop death (TaskList item #25, France trip insurance).
- Surface heartbeat freshness on Shepard Ventures portfolio dashboard.
