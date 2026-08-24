# scripts/jarvis-bridge/register-watchdog.ps1
#
# One-time installer for the jarvis-bridge external watchdog (Atlas,
# 2026-08-22). Registers a Windows Task Scheduler entry that runs
# watchdog.ps1 every 5 minutes, independent of the Claude Code session it's
# watching (so it keeps working even if that session is the thing that
# died).
#
# Idempotent -- re-running unregisters and re-registers.
#
# Usage (Heath runs this once):
#   cd C:\Users\Heath\Projects\MeetDossie
#   powershell -ExecutionPolicy Bypass -File scripts\jarvis-bridge\register-watchdog.ps1
#
# Verify after install:
#   Get-ScheduledTask -TaskName 'JarvisBridgeWatchdog' | Format-Table TaskName, State
#   Get-ScheduledTaskInfo -TaskName 'JarvisBridgeWatchdog'
#
# Force a manual tick:
#   Start-ScheduledTask -TaskName 'JarvisBridgeWatchdog'
#
# Disable / remove:
#   Disable-ScheduledTask    -TaskName 'JarvisBridgeWatchdog'
#   Unregister-ScheduledTask -TaskName 'JarvisBridgeWatchdog' -Confirm:$false

$ErrorActionPreference = 'Stop'

$WatchdogScript = 'C:\Users\Heath\Projects\MeetDossie\scripts\jarvis-bridge\watchdog.ps1'

if (!(Test-Path $WatchdogScript)) {
    Write-Host "FATAL: $WatchdogScript not found." -ForegroundColor Red
    exit 1
}

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 3)

# Interactive logon, not S4U -- needs to invoke wsl.exe against the same WSL
# instance Heath's interactive session runs in.
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$WatchdogScript`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration ([TimeSpan]::FromDays(3650))).Repetition

if (Get-ScheduledTask -TaskName 'JarvisBridgeWatchdog' -ErrorAction SilentlyContinue) {
    Write-Host "Removing existing 'JarvisBridgeWatchdog'..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName 'JarvisBridgeWatchdog' -Confirm:$false
}

Register-ScheduledTask `
    -TaskName 'JarvisBridgeWatchdog' `
    -Description 'Every 5 min: checks the jarvis-bridge relay heartbeat (WSL, via wsl.exe cat) and Telegram-alerts Heath if it is stale or the process is down, with a specific diagnosis. Does NOT auto-relaunch -- see scripts/jarvis-bridge/WATCHDOG.md for why. Installed by register-watchdog.ps1 (Atlas, 2026-08-22).' `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal | Out-Null

Write-Host "OK -- 'JarvisBridgeWatchdog' registered (every 5 min)" -ForegroundColor Green
Write-Host ""
Get-ScheduledTask -TaskName 'JarvisBridgeWatchdog' | Format-Table TaskName, State -AutoSize
Get-ScheduledTaskInfo -TaskName 'JarvisBridgeWatchdog' | Select-Object TaskName, NextRunTime, LastRunTime, LastTaskResult
Write-Host ""
Write-Host "Log file:   $env:USERPROFILE\.claude\jarvis-bridge-watchdog.log" -ForegroundColor Gray
Write-Host "Manual test: Start-ScheduledTask -TaskName 'JarvisBridgeWatchdog'" -ForegroundColor Yellow
