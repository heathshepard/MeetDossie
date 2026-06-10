# register-first-comment-auto-attach-task.ps1
#
# Registers Windows Task Scheduler entry "Dossie First Comment Auto-Attach".
# Runs scripts\run-first-comment-blitz.cmd every 2 hours from 08:00 to 20:00
# local time, every day. The .cmd wrapper invokes node + the blitz script
# and appends to a log file.
#
# The blitz script is idempotent: skips rows that already have
# first_comment_posted_at set. Safe to run as often as we like.
#
# Idempotent: removes any existing task with the same name before creating.

$ErrorActionPreference = 'Stop'

$TaskName  = 'Dossie First Comment Auto-Attach'
$RepoRoot  = 'C:\Users\Heath Shepard\Desktop\MeetDossie'
$Wrapper   = Join-Path $RepoRoot 'scripts\run-first-comment-blitz.cmd'

if (-not (Test-Path $Wrapper)) {
    Write-Error "Wrapper not found: $Wrapper"
    exit 1
}

$Action = New-ScheduledTaskAction -Execute $Wrapper -WorkingDirectory $RepoRoot

# Daily trigger at 08:00, repeated every 2 hours for 12 hours -> runs at
# 08, 10, 12, 14, 16, 18, 20 (7 times/day).
$Trigger = New-ScheduledTaskTrigger -Daily -At '8:00AM'
$RepetitionTrigger = New-ScheduledTaskTrigger -Once -At '8:00AM' `
    -RepetitionInterval (New-TimeSpan -Hours 2) `
    -RepetitionDuration (New-TimeSpan -Hours 12)
$Trigger.Repetition = $RepetitionTrigger.Repetition

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -MultipleInstances IgnoreNew

# Run as current user, interactive logon so PyAutoGUI/UIA work
$Principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

# Wipe any existing task with this name
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "Removed existing task: $TaskName"
}

$desc = 'Dossie: every 2h (8AM-8PM), run first-comment auto-attach blitz. Idempotent.'

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Description $desc | Out-Null

Write-Output "Task registered: $TaskName"
Write-Output "Cadence: every 2 hours, 08:00 to 20:00 daily (7 runs/day)"
