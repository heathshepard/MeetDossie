# scripts/register-claude-code-worker.ps1
#
# Claude Code CLI Worker Installer (Atlas, 2026-07-07)
#
# Registers a Windows Task Scheduler entry that runs scripts/claude-code-worker.js
# continuously as Heath. This worker claims batch-script-gen tasks queued by
# api/claude-code-enqueue.js and runs their handlers locally. Handlers that
# need LLM calls shell out to `claude --print` — which runs on Heath's Max
# subscription (free at the margin). See scripts/claude-code-worker.js header
# for full spec.
#
# COMPANION to register-agent-queue-poller.ps1 — that one spawns full Claude
# Code SUBAGENTS. This one runs structured JS handlers. They run side-by-side
# safely (the workers filter to different subsets of the queue).
#
# Idempotent: re-running unregisters and re-registers.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/register-claude-code-worker.ps1
#
# Verify:
#   Get-ScheduledTask -TaskName 'ClaudeCodeWorker' | Format-Table TaskName, State
#   Get-Content "C:\Users\Heath Shepard\.claude\claude-code-worker.log" -Tail 30
#
# Disable / remove:
#   Disable-ScheduledTask    -TaskName 'ClaudeCodeWorker'
#   Unregister-ScheduledTask -TaskName 'ClaudeCodeWorker' -Confirm:$false
#
# Manual foreground test:
#   cd "C:\Users\Heath Shepard\Desktop\MeetDossie"
#   node scripts\claude-code-worker.js --once     # one-shot drain
#   node scripts\claude-code-worker.js            # continuous loop

$ErrorActionPreference = 'Stop'

$WorkerScript = 'C:\Users\Heath Shepard\Desktop\MeetDossie\scripts\claude-code-worker.js'
$RepoDir      = 'C:\Users\Heath Shepard\Desktop\MeetDossie'
$LogPath      = 'C:\Users\Heath Shepard\.claude\claude-code-worker.log'
$EnvLocal     = Join-Path $RepoDir '.env.local'
$EnvFallback  = 'C:\Users\Heath Shepard\.claude\claude-code-worker.env'

if (!(Test-Path $WorkerScript)) {
    Write-Host "FATAL: $WorkerScript not found." -ForegroundColor Red
    exit 1
}

$cronSecretFound = $false
foreach ($p in @($EnvLocal, $EnvFallback)) {
    if (Test-Path $p) {
        $hit = Get-Content $p -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\s*CRON_SECRET\s*=' }
        if ($hit) { $cronSecretFound = $true; break }
    }
}
if (-not $cronSecretFound) {
    Write-Host "WARN: CRON_SECRET not found in $EnvLocal or $EnvFallback." -ForegroundColor Yellow
    Write-Host "      Worker will refuse to start until you add it." -ForegroundColor Yellow
}

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0)

$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodePath) {
    Write-Host "FATAL: node.exe not on PATH. Install Node.js 18+ first." -ForegroundColor Red
    exit 1
}

$action = New-ScheduledTaskAction `
    -Execute $nodePath `
    -Argument "`"$WorkerScript`"" `
    -WorkingDirectory $RepoDir

$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

if (Get-ScheduledTask -TaskName 'ClaudeCodeWorker' -ErrorAction SilentlyContinue) {
    Write-Host "Removing existing 'ClaudeCodeWorker'..." -ForegroundColor Yellow
    Stop-ScheduledTask     -TaskName 'ClaudeCodeWorker' -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName 'ClaudeCodeWorker' -Confirm:$false
}

Register-ScheduledTask `
    -TaskName 'ClaudeCodeWorker' `
    -Description 'Claims batch-script-gen tasks from agent_queue (metadata.task_type set) and runs their handlers locally. LLM steps run under Heath Max subscription via claude --print. Auto-installed by register-claude-code-worker.ps1 (Atlas, 2026-07-07).' `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal | Out-Null

Write-Host "OK -- 'ClaudeCodeWorker' registered (runs at logon, auto-restarts on crash)" -ForegroundColor Green

Write-Host ""
Write-Host "Registered task:" -ForegroundColor Cyan
Get-ScheduledTask -TaskName 'ClaudeCodeWorker' | Format-Table TaskName, State -AutoSize

Write-Host "Status:" -ForegroundColor Cyan
Get-ScheduledTaskInfo -TaskName 'ClaudeCodeWorker' | Select-Object TaskName, NextRunTime, LastRunTime, LastTaskResult

Write-Host ""
Write-Host "Log file:    $LogPath" -ForegroundColor Gray
Write-Host "State file:  C:\Users\Heath Shepard\.claude\claude-code-worker.state.json" -ForegroundColor Gray
Write-Host ""
Write-Host "Manual start:   Start-ScheduledTask -TaskName 'ClaudeCodeWorker'" -ForegroundColor Yellow
Write-Host "One-shot test:  cd `"$RepoDir`"; node scripts\claude-code-worker.js --once" -ForegroundColor Yellow
Write-Host "Tail log:       Get-Content `"$LogPath`" -Tail 30 -Wait" -ForegroundColor Yellow
