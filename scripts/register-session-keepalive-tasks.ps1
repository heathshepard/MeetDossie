# scripts/register-session-keepalive-tasks.ps1
#
# Registers Windows Scheduled Tasks for the 4 session-keepalive scripts.
# Each task runs every 3 days, staggered by 10 minutes, headless. Heath only
# gets pinged after 3 consecutive logged-out detections (and only if
# ATLAS_ALERT_CHAT_ID is not set — otherwise Cole gets the ping silently).
#
# Run once from PowerShell as admin (or normal user, scheduled at user-level):
#   powershell -ExecutionPolicy Bypass -File scripts\register-session-keepalive-tasks.ps1

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$nodeExe = (Get-Command node).Source

# DaysInterval 3 for the keepalives (they launch a browser, so they are
# expensive and rate-limit-sensitive). The credential health probe is DAILY and
# DaysInterval 1: it only copies a cookie SQLite file and reads three plaintext
# columns, so it costs about a second and never touches Chrome. It publishes to
# Supabase credential_health, which is what lets the outcome monitor treat a
# probe that STOPPED RUNNING as a finding — the gap that let Facebook and
# LinkedIn sit logged out for 9 days with the state file on this PC and nowhere
# else. (Atlas, 2026-09-25)
$tasks = @(
    @{ Name = "Dossie IG Session Keepalive";       Script = "scripts\instagram-session-keepalive.js"; Time = "02:30"; Days = 3 },
    @{ Name = "Dossie LinkedIn Session Keepalive"; Script = "scripts\linkedin-session-keepalive.js";  Time = "02:40"; Days = 3 },
    @{ Name = "Dossie Reddit Session Keepalive";   Script = "scripts\reddit-session-keepalive.js";    Time = "02:50"; Days = 3 },
    @{ Name = "Dossie Twitter Session Keepalive";  Script = "scripts\twitter-session-keepalive.js";   Time = "03:00"; Days = 3 },
    @{ Name = "Dossie Credential Health Probe";    Script = "scripts\credential-health-probe.js";     Time = "03:10"; Days = 1 }
)

foreach ($t in $tasks) {
    $action  = New-ScheduledTaskAction -Execute $nodeExe -Argument $t.Script -WorkingDirectory $repoRoot
    $trigger = New-ScheduledTaskTrigger -Daily -DaysInterval $t.Days -At $t.Time
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
    # Remove existing task with the same name so we can re-register idempotently
    Unregister-ScheduledTask -TaskName $t.Name -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-Host ("Registered: {0}  (every {1} day(s) @ {2})" -f $t.Name, $t.Days, $t.Time)
}

Write-Host ""
Write-Host "Done. View tasks: taskschd.msc -> Task Scheduler Library."
Write-Host "To trigger one manually: Start-ScheduledTask -TaskName 'Dossie Reddit Session Keepalive'"
