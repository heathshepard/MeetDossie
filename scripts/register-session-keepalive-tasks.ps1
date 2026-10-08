# scripts/register-session-keepalive-tasks.ps1
#
# Registers the session keep-alive + credential-health tasks, and re-times the
# TC Discovery Harvest task off its 15-minute metronome.
#
# REWRITTEN 2026-09-25 (Atlas). The previous version registered four per-platform
# keep-alive scripts every 3 days at fixed clock times (02:30/02:40/02:50/03:00)
# and HAD NEVER BEEN RUN -- none of its tasks existed in Task Scheduler and
# credential_health had zero rows, which is why a 9-day logout went unnoticed.
#
# WHAT CHANGED AND WHY
#   * Jitter is now real. Each trigger carries a PT90M RandomDelay, so Windows
#     itself smears the fire time by up to 90 minutes. Fixed 02:30-every-3-days
#     is exactly the machine-shaped cadence that got the sessions invalidated.
#   * Keep-alive touches happen in DAYTIME windows (08:00 / 14:00 / 20:00 +/- 90m).
#     A browser that only ever wakes at 2am is its own tell.
#   * One task replaces four. scripts/session-keepalive-gentle.js handles every
#     channel in one run, in randomised order with random gaps between them.
#   * The credential probe runs every 6 hours. It is an offline SQLite read --
#     no Chrome, no network to the platforms -- so frequency costs nothing here,
#     and it keeps last_probe_at well inside the 48h `credential_probe_fresh`
#     expectation window.
#
# RUN AS: elevated PowerShell (Run as Administrator).
#   powershell -ExecutionPolicy Bypass -File scripts\register-session-keepalive-tasks.ps1
#
# LOGON TYPE -- DO NOT CHANGE TO S4U.
# Every task here is registered Interactive (-LogonType Interactive). S4U tasks
# run without the user's credential blob loaded, which breaks Windows DPAPI --
# and Chrome's cookie encryption key is DPAPI-protected. An S4U-registered task
# cannot decrypt the very cookies these scripts exist to preserve, and has taken
# stored credentials with it before. (memory: s4u-tasks-break-windows-dpapi)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$nodeExe  = (Get-Command node).Source
$wscript  = "$env:SystemRoot\System32\wscript.exe"

Write-Host "Repo root : $repoRoot"
Write-Host "node      : $nodeExe"
Write-Host ""

# Interactive, highest available. Never S4U -- see the header.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Highest

function New-JitteredDailyTriggers {
    param([string[]] $Times, [string] $RandomDelay = 'PT90M')
    $triggers = @()
    foreach ($t in $Times) {
        $trg = New-ScheduledTaskTrigger -Daily -At $t
        # The whole point: Windows adds a uniform random 0..RandomDelay before
        # firing, so the real touch time moves every single day.
        $trg.RandomDelay = $RandomDelay
        $triggers += $trg
    }
    return $triggers
}

function Register-Task {
    param(
        [string] $Name,
        $Action,
        $Triggers,
        [int] $LimitMinutes = 30,
        [string] $Description = ""
    )
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
        -ExecutionTimeLimit (New-TimeSpan -Minutes $LimitMinutes) `
        -MultipleInstances IgnoreNew
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $Name -Action $Action -Trigger $Triggers `
        -Settings $settings -Principal $principal -Description $Description | Out-Null
    Write-Host ("  registered: {0}" -f $Name)
}

# ---------------------------------------------------------------------------
# 1. Gentle session keep-alive -- 3x/day, +/- 90 min of jitter each.
# ---------------------------------------------------------------------------
# The script self-gates to the 07:00-11:00 / 13:00-17:00 / 19:00-22:30 windows
# and refuses to touch the same channel twice inside 150 minutes, so even if
# two jittered triggers land close together only one touch happens.
Register-Task -Name "Dossie Session Keepalive" `
    -Action (New-ScheduledTaskAction -Execute $nodeExe `
        -Argument "scripts\session-keepalive-gentle.js" -WorkingDirectory $repoRoot) `
    -Triggers (New-JitteredDailyTriggers -Times @("08:00", "14:00", "20:00")) `
    -LimitMinutes 30 `
    -Description "Gentle jittered browser-session keep-alive (FB/LinkedIn/IG). Loads the logged-in feed, confirms an authenticated element, leaves. Never logs in, never posts, never force-kills Chrome."

# ---------------------------------------------------------------------------
# 2. Credential health probe -- every 6h, offline SQLite read, no Chrome.
# ---------------------------------------------------------------------------
$probeTrigger = New-ScheduledTaskTrigger -Once -At "03:10" `
    -RepetitionInterval (New-TimeSpan -Hours 6)
$probeTrigger.RandomDelay = 'PT20M'
Register-Task -Name "Dossie Credential Health Probe" `
    -Action (New-ScheduledTaskAction -Execute $nodeExe `
        -Argument "scripts\credential-health-probe.js" -WorkingDirectory $repoRoot) `
    -Triggers $probeTrigger `
    -LimitMinutes 10 `
    -Description "Writes per-channel auth freshness to Supabase credential_health. Read-only cookie-DB inspection; never launches Chrome. A row that stops updating is itself the alarm."

# ---------------------------------------------------------------------------
# 3. LinkedIn posting -- moved OFF the 15-minute harvest chain.
# ---------------------------------------------------------------------------
# Channel cap is 1 post/calendar day, so 3 jittered opportunities is ample.
Register-Task -Name "Dossie LinkedIn Social" `
    -Action (New-ScheduledTaskAction -Execute $wscript `
        -Argument "`"$repoRoot\scripts\run-hidden.vbs`" run-linkedin-social.cmd" `
        -WorkingDirectory "$repoRoot\scripts") `
    -Triggers (New-JitteredDailyTriggers -Times @("09:20", "15:40", "19:50")) `
    -LimitMinutes 20 `
    -Description "Publishes approved linkedin_personal posts. 3x/day with +/-90min jitter (was every 15 min as Step 7 of the harvest chain). Cap is 1 post/day regardless."

# ---------------------------------------------------------------------------
# 4. Re-time the harvest task: 15 min -> 30 min.
# ---------------------------------------------------------------------------
# XML export/edit/re-import ON PURPOSE. `schtasks /Change /TR` prompts for
# Heath's password and then rejects it, and Set-ScheduledTask cannot edit a
# repetition interval in place reliably. Export -> string-replace -> re-register
# is the route that actually works. (memory: windows-shell-command-traps)
$harvest = "Dossie TC Discovery Harvest"
$existing = Get-ScheduledTask -TaskName $harvest -ErrorAction SilentlyContinue
if ($null -eq $existing) {
    Write-Host "  SKIP: '$harvest' not registered - nothing to re-time."
} else {
    $xml = Export-ScheduledTask -TaskName $harvest
    if ($xml -match '<Interval>PT15M</Interval>') {
        $new = $xml -replace '<Interval>PT15M</Interval>', '<Interval>PT30M</Interval>'
        Unregister-ScheduledTask -TaskName $harvest -Confirm:$false
        Register-ScheduledTask -TaskName $harvest -Xml $new -User "$env:USERDOMAIN\$env:USERNAME" | Out-Null
        Write-Host "  re-timed: $harvest  15 min -> 30 min"
    } elseif ($xml -match '<Interval>PT30M</Interval>') {
        Write-Host "  already 30 min: $harvest"
    } else {
        Write-Host "  WARNING: could not find a PT15M interval in '$harvest' - left untouched. Check it by hand."
    }
}

Write-Host ""
Write-Host "Done. Verify:  Get-ScheduledTask -TaskName 'Dossie *' | Format-Table TaskName,State"
Write-Host "Probe now  :  Start-ScheduledTask -TaskName 'Dossie Credential Health Probe'"
Write-Host ""
Write-Host "NOTE: the profiles are logged out right now. Keep-alive cannot revive a"
Write-Host "dead session and will not try. Log in by hand once, in Chrome, on:"
Write-Host "  C:\Users\Heath\DossieBot                      (LinkedIn, Instagram)"
Write-Host "  C:\Users\Heath\AppData\Local\DossieBot-Sage   (Facebook)"
