# scripts/register-sage-fb-scanner-task.ps1
#
# Registers the Windows Scheduled Task "Dossie FB Comment Scanner".
# Runs scripts/sage-fb-comment-scanner.js hourly from 8 AM to 6 PM local
# (= CDT), Monday through Friday. Headless Playwright -- safe to run while
# Heath uses Chrome (separate browser instance, mobile UA, m.facebook.com).
#
# Idempotent: unregisters any existing task with the same name first.
#
# Run once:
#   powershell -ExecutionPolicy Bypass -File scripts\register-sage-fb-scanner-task.ps1

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$nodeExe = (Get-Command node).Source
$taskName = "Dossie FB Comment Scanner"
$scriptPath = "scripts\sage-fb-comment-scanner.js"

# Action: node scripts/sage-fb-comment-scanner.js, cwd = repo root
$action = New-ScheduledTaskAction `
    -Execute $nodeExe `
    -Argument $scriptPath `
    -WorkingDirectory $repoRoot

# Trigger: hourly at 8 AM-6 PM, Mon-Fri (11 runs per day).
# Build 11 daily triggers, one per hour from 08:00 through 18:00.
$triggers = @()
foreach ($hour in 8..18) {
    $time = "{0:D2}:00" -f $hour
    $trig = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At $time
    $triggers += $trig
}

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
    -MultipleInstances IgnoreNew

# Idempotent re-register
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $triggers `
    -Settings $settings `
    -Description "Scans Texas RE Facebook groups + RE coach pages hourly (8 AM - 6 PM CDT, Mon-Fri) for engagement candidates. Writes scoring posts to engagement_candidates. Sage drafts replies via the existing cron pipeline." `
    -Force | Out-Null

Write-Host ("Registered: {0}" -f $taskName)
Write-Host "Schedule: hourly 08:00-18:00 Mon-Fri (11 runs/day, 55 runs/week)"
Write-Host ""
Write-Host "Verify:"
Write-Host "  Get-ScheduledTask -TaskName '$taskName' | Get-ScheduledTaskInfo"
Write-Host ""
Write-Host "Trigger manually:"
Write-Host "  Start-ScheduledTask -TaskName '$taskName'"
