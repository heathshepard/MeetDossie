# scripts/register-cole-watchdog.ps1
#
# Cole Watchdog Installer (Atlas, 2026-06-17)
#
# Registers two Windows Task Scheduler entries:
#
#   1. "ColeHeartbeat"  -- every 1 min, writes Unix-timestamp heartbeat file
#                          IF claude.exe is currently running.
#                          Output: C:\Users\Heath Shepard\.claude\heartbeat.txt
#
#   2. "ColeWatchdog"   -- every 5 min, runs cole-watchdog.ps1 which detects
#                          claude.exe death and auto-relaunches MeetDossie
#                          Claude Code, with Telegram pings before/after.
#
# Idempotent: re-running unregisters and re-registers both tasks.
#
# Run as Heath's user (no admin needed -- tasks run as the logged-in user,
# LogonType Interactive, not S4U, because we need to spawn an interactive
# PowerShell window).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/register-cole-watchdog.ps1
#
# Verify after install:
#   Get-ScheduledTask -TaskName "Cole*" | Format-Table TaskName, State
#   Get-ScheduledTaskInfo -TaskName "ColeHeartbeat"
#   Get-ScheduledTaskInfo -TaskName "ColeWatchdog"
#
# Disable / remove:
#   Disable-ScheduledTask    -TaskName "ColeHeartbeat"
#   Disable-ScheduledTask    -TaskName "ColeWatchdog"
#   Unregister-ScheduledTask -TaskName "ColeHeartbeat" -Confirm:$false
#   Unregister-ScheduledTask -TaskName "ColeWatchdog"  -Confirm:$false

$ErrorActionPreference = 'Stop'

$WatchdogScript  = 'C:\Users\Heath Shepard\Desktop\MeetDossie\scripts\cole-watchdog.ps1'
$HeartbeatPath   = 'C:\Users\Heath Shepard\.claude\heartbeat.txt'

if (!(Test-Path $WatchdogScript)) {
    Write-Host "FATAL: $WatchdogScript not found." -ForegroundColor Red
    exit 1
}

# ---- Common settings --------------------------------------------------------

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

# Run interactively as Heath -- needed because the watchdog spawns a PowerShell
# window to host the new claude.exe session.
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

# ============================================================================
# Task A: ColeHeartbeat -- writes Unix timestamp every 1 min if claude.exe up
# ============================================================================

$heartbeatCmd = "if (Get-Process claude -ErrorAction SilentlyContinue) { (Get-Date -UFormat %s) | Out-File '$HeartbeatPath' -Encoding utf8 -Force }"

$heartbeatAction = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"$heartbeatCmd`""

# Trigger: at logon + repeat every 1 min indefinitely.
$heartbeatTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$heartbeatTrigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration ([TimeSpan]::FromDays(3650))).Repetition

# Tear down existing.
if (Get-ScheduledTask -TaskName 'ColeHeartbeat' -ErrorAction SilentlyContinue) {
    Write-Host "Removing existing 'ColeHeartbeat'..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName 'ColeHeartbeat' -Confirm:$false
}

Register-ScheduledTask `
    -TaskName 'ColeHeartbeat' `
    -Description 'Writes Unix timestamp to .claude\heartbeat.txt every 60s if claude.exe is running. Auto-installed by register-cole-watchdog.ps1 (Atlas, 2026-06-17).' `
    -Action $heartbeatAction `
    -Trigger $heartbeatTrigger `
    -Settings $settings `
    -Principal $principal | Out-Null

Write-Host "OK -- 'ColeHeartbeat' registered (every 1 min)" -ForegroundColor Green

# ============================================================================
# Task B: ColeWatchdog -- runs cole-watchdog.ps1 every 5 min
# ============================================================================

$watchdogAction = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$WatchdogScript`""

$watchdogTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$watchdogTrigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration ([TimeSpan]::FromDays(3650))).Repetition

if (Get-ScheduledTask -TaskName 'ColeWatchdog' -ErrorAction SilentlyContinue) {
    Write-Host "Removing existing 'ColeWatchdog'..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName 'ColeWatchdog' -Confirm:$false
}

Register-ScheduledTask `
    -TaskName 'ColeWatchdog' `
    -Description 'Runs cole-watchdog.ps1 every 5 min. Detects claude.exe death, sends Telegram alert, auto-relaunches MeetDossie Claude Code session. Auto-installed by register-cole-watchdog.ps1 (Atlas, 2026-06-17).' `
    -Action $watchdogAction `
    -Trigger $watchdogTrigger `
    -Settings $settings `
    -Principal $principal | Out-Null

Write-Host "OK -- 'ColeWatchdog' registered (every 5 min)" -ForegroundColor Green

# ============================================================================
# Verification
# ============================================================================

Write-Host ""
Write-Host "Registered tasks:" -ForegroundColor Cyan
Get-ScheduledTask -TaskName 'Cole*' | Format-Table TaskName, State -AutoSize

Write-Host "Next run times:" -ForegroundColor Cyan
Get-ScheduledTaskInfo -TaskName 'ColeHeartbeat' | Select-Object TaskName, NextRunTime, LastRunTime, LastTaskResult
Get-ScheduledTaskInfo -TaskName 'ColeWatchdog'  | Select-Object TaskName, NextRunTime, LastRunTime, LastTaskResult

Write-Host ""
Write-Host "Log file:    C:\Users\Heath Shepard\.claude\watchdog.log" -ForegroundColor Gray
Write-Host "Heartbeat:   C:\Users\Heath Shepard\.claude\heartbeat.txt" -ForegroundColor Gray
Write-Host ""
Write-Host "Manual test: Start-ScheduledTask -TaskName 'ColeWatchdog'" -ForegroundColor Yellow
