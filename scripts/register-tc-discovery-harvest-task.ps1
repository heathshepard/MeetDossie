# register-tc-discovery-harvest-task.ps1
#
# Registers Windows Task Scheduler entry "Dossie TC Discovery Harvest".
# Runs scripts\run-tc-discovery-harvest.cmd every 6 hours. The harvester
# self-gates the real cadence per post (+24h, +72h, then every 3 days,
# stopping 45 days after the post), so the 6-hour tick just gives it enough
# chances to hit those windows. No-op ticks exit without launching Chrome.
#
# Why Task Scheduler and not a Vercel cron: the harvester drives the local
# DossieBot-Sage Chrome profile (Heath's live FB session) — serverless can't
# reach it, and the agent-queue poller / cron-process-agent-requests are dead.
# Same mechanism as fb-session-keepalive / poll-and-post-approved-groups /
# first-comment auto-attach.
#
# Idempotent: removes any existing task with the same name before creating.
# Run once (no admin needed):
#   powershell -ExecutionPolicy Bypass -File "C:\Users\Heath\Projects\MeetDossie\scripts\register-tc-discovery-harvest-task.ps1"

$ErrorActionPreference = 'Stop'

$TaskName = 'Dossie TC Discovery Harvest'
$RepoRoot = 'C:\Users\Heath\Projects\MeetDossie'
$Wrapper  = Join-Path $RepoRoot 'scripts\run-tc-discovery-harvest.cmd'

if (-not (Test-Path $Wrapper)) {
    Write-Error "Wrapper not found: $Wrapper"
    exit 1
}

$Action = New-ScheduledTaskAction `
    -Execute 'cmd.exe' `
    -Argument "/c `"$Wrapper`"" `
    -WorkingDirectory $RepoRoot

# Every 6 hours, indefinitely.
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddHours(8) `
    -RepetitionInterval (New-TimeSpan -Hours 6) `
    -RepetitionDuration ([TimeSpan]::MaxValue)

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 45) `
    -MultipleInstances IgnoreNew

# Interactive logon so the headed Chrome window can render (headless on this
# profile has falsely reported logged-out — see the harvester header).
$Principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal | Out-Null

Write-Host "$TaskName registered. Runs every 6 hours; harvester self-gates the per-post cadence."
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
