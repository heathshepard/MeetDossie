# scripts/register-agent-queue-poller.ps1
#
# Agent Queue Poller Installer (Atlas, 2026-06-17)
#
# Registers a Windows Task Scheduler entry that runs scripts/agent-queue-poller.js
# continuously as Heath. The poller is a long-running Node.js process that
# claims tasks from agent_queue and spawns the matching agent via the `claude`
# CLI in --print mode. See scripts/agent-queue-poller.js header for full spec.
#
# Idempotent: re-running unregisters and re-registers.
#
# Resilience layers:
#   1. The poller process itself loops + catches errors; one bad task does NOT
#      crash it.
#   2. Task Scheduler restarts the process if it ever exits (RestartCount 999).
#   3. ColeWatchdog (separate task) is unaffected.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/register-agent-queue-poller.ps1
#
# Verify after install:
#   Get-ScheduledTask -TaskName 'AgentQueuePoller' | Format-Table TaskName, State
#   Get-ScheduledTaskInfo -TaskName 'AgentQueuePoller'
#   Get-Content "C:\Users\Heath Shepard\.claude\agent-poller.log" -Tail 30
#
# Disable / remove:
#   Disable-ScheduledTask    -TaskName 'AgentQueuePoller'
#   Unregister-ScheduledTask -TaskName 'AgentQueuePoller' -Confirm:$false
#
# Manual run (foreground, for testing):
#   cd "C:\Users\Heath Shepard\Desktop\MeetDossie"
#   node scripts\agent-queue-poller.js

$ErrorActionPreference = 'Stop'

$PollerScript = 'C:\Users\Heath Shepard\Desktop\MeetDossie\scripts\agent-queue-poller.js'
$RepoDir      = 'C:\Users\Heath Shepard\Desktop\MeetDossie'
$LogPath      = 'C:\Users\Heath Shepard\.claude\agent-poller.log'
$EnvLocal     = Join-Path $RepoDir '.env.local'
$EnvFallback  = 'C:\Users\Heath Shepard\.claude\agent-poller.env'

if (!(Test-Path $PollerScript)) {
    Write-Host "FATAL: $PollerScript not found." -ForegroundColor Red
    exit 1
}

# ---- Sanity-check CRON_SECRET is reachable -----------------------------------

$cronSecretFound = $false
foreach ($p in @($EnvLocal, $EnvFallback)) {
    if (Test-Path $p) {
        $hit = Get-Content $p -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\s*CRON_SECRET\s*=' }
        if ($hit) { $cronSecretFound = $true; break }
    }
}
if (-not $cronSecretFound) {
    Write-Host "WARN: CRON_SECRET not found in $EnvLocal or $EnvFallback." -ForegroundColor Yellow
    Write-Host "      Poller will refuse to start until you add it. To fetch from Vercel:" -ForegroundColor Yellow
    Write-Host "        cd `"$RepoDir`"; npx vercel env pull .env.local" -ForegroundColor Yellow
    Write-Host "      Or paste it manually into either env file." -ForegroundColor Yellow
}

# ---- Settings ---------------------------------------------------------------

# Restart on failure (poller should run continuously; if Node exits, scheduler
# relaunches). ExecutionTimeLimit 0 = no time cap.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0)

# Run as Heath interactively (so spawned `claude` instances inherit a usable
# environment + can hit user-level keychains for Anthropic auth).
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

# ---- Action -----------------------------------------------------------------

# Use cmd.exe wrapper so we can redirect stderr->stdout into the log on top of
# the poller's own logging (belt + suspenders for early-crash visibility).
#
# `node scripts\agent-queue-poller.js`
$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodePath) {
    Write-Host "FATAL: node.exe not on PATH. Install Node.js 18+ first." -ForegroundColor Red
    exit 1
}

$action = New-ScheduledTaskAction `
    -Execute $nodePath `
    -Argument "`"$PollerScript`"" `
    -WorkingDirectory $RepoDir

# ---- Trigger: at logon + repeat-on-failure restart handles continuity -------

$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

# ---- Tear down existing -----------------------------------------------------

if (Get-ScheduledTask -TaskName 'AgentQueuePoller' -ErrorAction SilentlyContinue) {
    Write-Host "Removing existing 'AgentQueuePoller'..." -ForegroundColor Yellow
    Stop-ScheduledTask     -TaskName 'AgentQueuePoller' -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName 'AgentQueuePoller' -Confirm:$false
}

Register-ScheduledTask `
    -TaskName 'AgentQueuePoller' `
    -Description 'Long-running Node process that claims agent_queue tasks and spawns the matching subagent via claude --print. Auto-installed by register-agent-queue-poller.ps1 (Atlas, 2026-06-17).' `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal | Out-Null

Write-Host "OK -- 'AgentQueuePoller' registered (runs at logon, auto-restarts on crash)" -ForegroundColor Green

# ---- Verification -----------------------------------------------------------

Write-Host ""
Write-Host "Registered task:" -ForegroundColor Cyan
Get-ScheduledTask -TaskName 'AgentQueuePoller' | Format-Table TaskName, State -AutoSize

Write-Host "Status:" -ForegroundColor Cyan
Get-ScheduledTaskInfo -TaskName 'AgentQueuePoller' | Select-Object TaskName, NextRunTime, LastRunTime, LastTaskResult

Write-Host ""
Write-Host "Log file:    $LogPath" -ForegroundColor Gray
Write-Host "State file:  C:\Users\Heath Shepard\.claude\agent-poller.state.json" -ForegroundColor Gray
Write-Host ""
Write-Host "Manual start:  Start-ScheduledTask -TaskName 'AgentQueuePoller'" -ForegroundColor Yellow
Write-Host "Manual test:   cd `"$RepoDir`"; node scripts\agent-queue-poller.js" -ForegroundColor Yellow
Write-Host "Tail log:      Get-Content `"$LogPath`" -Tail 30 -Wait" -ForegroundColor Yellow
