# scripts/register-sage-fb-scanner-task-24x7.ps1
#
# SV-FB-VETO-001 (Atlas, 2026-06-11)
#
# Re-registers the Windows Scheduled Task "Dossie FB Comment Scanner" with a
# 24/7 cadence. Replaces the prior Mon-Fri 8 AM-6 PM schedule.
#
# New cadence:
#   - Hourly 08:00-20:00 LOCAL TIME (CDT), EVERY day (Mon-Sun) -- 13 runs/day
#   - Overnight at 23:00 + 02:00 + 05:00 LOCAL TIME, EVERY day -- 3 runs/day
#   - Total: 16 runs/day, 112 runs/week
#
# Why: Sage Texas RE agents post on weekends too -- the prior Mon-Fri cadence
# missed peak Saturday/Sunday volume. Overnight runs catch posts made by
# East Coast / Hawaii agents while Heath sleeps so the auto-veto pipeline
# can decide on them by the time he's up.
#
# Run once (elevated PowerShell from MeetDossie repo root):
#   powershell -ExecutionPolicy Bypass -File scripts\register-sage-fb-scanner-task-24x7.ps1
#
# Idempotent: unregisters any existing task with the same name first.

$ErrorActionPreference = "Stop"

$repoRoot   = (Resolve-Path "$PSScriptRoot\..").Path
$nodeExe    = (Get-Command node).Source
$taskName   = "Dossie FB Comment Scanner"
$scriptPath = "scripts\sage-fb-comment-scanner.js"

$action = New-ScheduledTaskAction `
    -Execute $nodeExe `
    -Argument $scriptPath `
    -WorkingDirectory $repoRoot

# Build the triggers.
# Hourly 08:00 - 20:00 every day (13 hourly slots).
# Overnight at 23:00, 02:00, 05:00 every day (3 slots).
$triggers = @()
$everyDay = "Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"

foreach ($hour in 8..20) {
    $time = "{0:D2}:00" -f $hour
    $triggers += New-ScheduledTaskTrigger -Weekly -DaysOfWeek $everyDay -At $time
}

# Overnight slots
foreach ($time in @("23:00","02:00","05:00")) {
    $triggers += New-ScheduledTaskTrigger -Weekly -DaysOfWeek $everyDay -At $time
}

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
    -MultipleInstances IgnoreNew `
    -WakeToRun

# Idempotent re-register
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $triggers `
    -Settings $settings `
    -Description "SV-FB-VETO-001 24/7 cadence: hourly 8 AM-8 PM CDT every day + overnight 11 PM/2 AM/5 AM. Scans Texas RE Facebook groups + RE coach pages. Writes scoring posts to engagement_candidates. The auto-veto cron (cron-engagement-veto-mode) takes it from there." `
    -Force | Out-Null

Write-Host ("Registered: {0}" -f $taskName)
Write-Host "Schedule: hourly 08:00-20:00 every day + 23:00 + 02:00 + 05:00 every day (16 runs/day, 112 runs/week)"
Write-Host ""
Write-Host "Verify:"
Write-Host "  Get-ScheduledTask -TaskName '$taskName' | Get-ScheduledTaskInfo"
Write-Host ""
Write-Host "Trigger manually:"
Write-Host "  Start-ScheduledTask -TaskName '$taskName'"
