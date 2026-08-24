# scripts/jarvis-bridge/watchdog.ps1
#
# Jarvis-bridge external watchdog (Atlas, 2026-08-22).
#
# The jarvis-bridge relay (scripts/jarvis-bridge/server.ts) runs as a stdio
# MCP child of the "dev-channels" Claude Code session (see MeetDossie.bat --
# --dangerously-load-development-channels server:jarvis-bridge). server.ts
# now self-detects a stalled poll loop or a fatal error and self-terminates
# with a push alert (see the `fatal()` function in that file) -- but that
# only covers the case where the process is still alive enough to run its
# own JS. It does nothing for:
#   - the whole dev-channels claude session getting killed (crash, reboot,
#     Heath closing the terminal)
#   - the bun child dying in a way that doesn't route through Node's own
#     exception handlers (OOM-killed, WSL itself restarting, etc)
#   - server.ts hanging in a way that ALSO blocks push (rare, but the push
#     fetch shares the same event loop as everything else in that process)
#
# This script is the outside eye for exactly those cases: it runs on the
# WINDOWS side (Task Scheduler, independent of WSL/claude/bun all dying
# together) and checks the heartbeat file server.ts writes on every
# completed poll tick, via `wsl.exe -d Ubuntu -- cat ...` (no \\wsl$ UNC
# dependency -- confirmed working directly against a live WSL instance
# 2026-08-22, and it doesn't assume a specific Windows/WSL UNC provider).
#
# IMPORTANT, HONEST LIMITATION: this watchdog does NOT auto-relaunch the
# dev-channels session. Two hard reasons, not laziness:
#   1. --dangerously-load-development-channels shows a one-screen interactive
#      warning that needs a real keypress every fresh launch (confirmed
#      against the installed CLI -- see MeetDossie.bat's own comment block).
#      An unattended relaunch would sit at that screen forever, LOOKING
#      alive (a claude process exists) while jarvis-bridge never actually
#      attaches -- a worse silent failure than what this replaces.
#   2. The plain Cole/Telegram session (no dev-channels flag) already polls
#      Telegram on a separate always-on process (see cole-watchdog.ps1 /
#      ColeClaudeCodeSession). Blindly launching a SECOND
#      --channels plugin:telegram session risks the exact getUpdates 409
#      "webhook/poller conflict" failure mode CLAUDE.md Section 24 already
#      warns about.
# So instead of a fake auto-restart, this alerts Heath immediately and
# specifically -- "so a hang never silently strands Heath again" is solved
# by making the failure LOUD (Telegram, within one watchdog cycle) instead
# of by pretending it can be silently healed unattended. See WATCHDOG.md.
#
# Run every 5 min via Task Scheduler (scripts/jarvis-bridge/
# register-watchdog.ps1). Safe to run manually any time:
#   powershell -ExecutionPolicy Bypass -File scripts\jarvis-bridge\watchdog.ps1

# NOTE: deliberately NOT 'Stop'. With $ErrorActionPreference = 'Stop', any
# native command (wsl.exe, curl.exe) whose stderr is captured via `2>&1`
# gets wrapped into a terminating ErrorRecord by PowerShell itself -- and
# `cat: file not found` / `pgrep` no-match are both EXPECTED, routine
# outcomes here, not exceptional ones. Confirmed hitting this firsthand
# 2026-08-22: with 'Stop' set, the very first "heartbeat file doesn't exist
# yet" case (the most common one right after this watchdog is installed)
# crashed the whole script before it could even send the alert it exists to
# send. Every risky block below checks $LASTEXITCODE / uses its own
# try/catch instead of relying on a global trap.
$ErrorActionPreference = 'Continue'

$LogPath      = Join-Path $env:USERPROFILE '.claude\jarvis-bridge-watchdog.log'
$StatePath    = Join-Path $env:USERPROFILE '.claude\jarvis-bridge-watchdog.state.json'
$HeartbeatWslPath = '/home/heath/.claude/channels/jarvis-bridge/heartbeat.json'
# Telegram bot token deliberately read from the WSL-side channel env file
# (same one the telegram plugin itself loads), NOT MeetDossie\.env.local.
# Confirmed 2026-08-22: TELEGRAM_BOT_TOKEN in .env.local is the literal
# string "[SENSITIVE]" -- `vercel env pull`'s placeholder for a write-only
# var, never a real token -- so alerts sent from here would have silently
# 400'd against a fake token forever. This file is real, curated, and
# already proven working (it's what actually sends Cole's Telegram messages
# today). Same class of bug server.ts's own top-of-file comment already
# documents for SUPABASE_SERVICE_ROLE_KEY -- .env.local is not a trustworthy
# secrets source for anything that also gets `vercel env pull`'d.
$TelegramEnvWslPath = '/home/heath/.claude/channels/telegram/.env'

# Fresher than this = healthy. Generous vs. the in-process stall threshold
# (default 90s) and the poll interval (default 1.5s) -- covers Task
# Scheduler jitter and a slow tick without false-alarming.
$STALE_SECONDS = 300
# Don't re-alert every 5 min while still down -- once, then every 30 min.
$REALERT_SECONDS = 1800

New-Item -ItemType Directory -Force -Path (Split-Path $LogPath) | Out-Null

function Write-WatchdogLog {
    param([string]$Message)
    $ts = Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ'
    Add-Content -Path $LogPath -Value "[$ts] $Message" -Encoding utf8
    try {
        $lines = Get-Content $LogPath -Encoding utf8 -ErrorAction SilentlyContinue
        if ($lines.Count -gt 500) { $lines | Select-Object -Last 500 | Set-Content -Path $LogPath -Encoding utf8 }
    } catch { }
}

function Get-WatchdogState {
    if (Test-Path $StatePath) {
        try { return Get-Content $StatePath -Raw | ConvertFrom-Json } catch { }
    }
    return [pscustomobject]@{ status = 'ok'; lastAlertUnix = 0 }
}

function Save-WatchdogState {
    param($State)
    $State | ConvertTo-Json -Compress | Set-Content -Path $StatePath -Encoding utf8
}

function Send-TelegramAlert {
    param([string]$Text)

    $botToken = $null
    $envRaw = & wsl.exe -d Ubuntu -- cat $TelegramEnvWslPath 2>$null
    if ($LASTEXITCODE -eq 0 -and $envRaw) {
        foreach ($line in ($envRaw -split "`n")) {
            if ($line -match '^\s*TELEGRAM_BOT_TOKEN\s*=\s*"?([^"\r\n]+)"?\s*$') { $botToken = $Matches[1] }
        }
    }
    if (-not $botToken) { Write-WatchdogLog "WARN: could not read TELEGRAM_BOT_TOKEN from $TelegramEnvWslPath -- skipping alert"; return }
    $chatId = '7874782923' # Heath's chat ID, same fallback cole-watchdog.ps1 uses (no per-chat secret needed here)

    $url = "https://api.telegram.org/bot$botToken/sendMessage"
    $body = @{ chat_id = $chatId; text = $Text } | ConvertTo-Json -Compress
    # BOM-free UTF8 write + curl.exe -- Telegram's JSON parser rejects a BOM
    # (same lesson as cole-watchdog.ps1: PS5 -Encoding utf8 prepends one).
    $bodyFile = Join-Path $env:TEMP "jarvis-bridge-watchdog-tg-$([Guid]::NewGuid().ToString('N')).json"
    [System.IO.File]::WriteAllText($bodyFile, $body, [System.Text.UTF8Encoding]::new($false))
    try {
        $resp = & 'C:\Windows\System32\curl.exe' -sS -H 'Content-Type: application/json' -X POST --data-binary "@$bodyFile" $url 2>&1
        if ($resp -match '"ok":true') { Write-WatchdogLog "Telegram sent: $Text" }
        else { Write-WatchdogLog "Telegram response not OK: $resp" }
    } catch {
        Write-WatchdogLog "Telegram ERROR: $($_.Exception.Message)"
    } finally {
        Remove-Item -Path $bodyFile -Force -ErrorAction SilentlyContinue
    }
}

function Test-WslProcess {
    param([string]$Pattern)
    $out = & wsl.exe -d Ubuntu -- pgrep -af $Pattern 2>&1
    return -not [string]::IsNullOrWhiteSpace(($out -join ''))
}

# ---- Main -------------------------------------------------------------------

$state = Get-WatchdogState
$nowUnix = [int][double]::Parse((Get-Date -UFormat %s))

$heartbeatRaw = & wsl.exe -d Ubuntu -- cat $HeartbeatWslPath 2>&1
$heartbeatOk = $LASTEXITCODE -eq 0
$ageSeconds = $null
if ($heartbeatOk) {
    try {
        $hb = ($heartbeatRaw -join '') | ConvertFrom-Json
        $hbTime = [datetime]::Parse($hb.ts).ToUniversalTime()
        $ageSeconds = [int]((Get-Date).ToUniversalTime() - $hbTime).TotalSeconds
    } catch {
        Write-WatchdogLog "WARN: heartbeat file present but unparseable: $heartbeatRaw"
        $heartbeatOk = $false
    }
}

if ($heartbeatOk -and $ageSeconds -lt $STALE_SECONDS) {
    Write-WatchdogLog "OK -- heartbeat ${ageSeconds}s old"
    if ($state.status -ne 'ok') {
        Send-TelegramAlert "Jarvis voice channel is back. Heartbeat fresh again (${ageSeconds}s old). Watchdog will keep monitoring."
        Write-WatchdogLog "Recovery alert sent."
    }
    Save-WatchdogState -State ([pscustomobject]@{ status = 'ok'; lastAlertUnix = 0 })
    exit 0
}

# ---- Unhealthy: figure out WHICH failure so the alert tells Heath the
# actual fix instead of a generic "something's wrong" -----------------------

$devChannelsUp = Test-WslProcess -Pattern 'dangerously-load-development-channels'
$bridgeChildUp = Test-WslProcess -Pattern 'bun server.ts'

if (-not $heartbeatOk) {
    $detail = "heartbeat file missing/unreadable at $HeartbeatWslPath"
} else {
    $detail = "heartbeat is ${ageSeconds}s old (stale threshold ${STALE_SECONDS}s)"
}

if (-not $devChannelsUp) {
    $diagnosis = "Jarvis dev-channels Claude Code session is NOT running at all."
    $fix = "To restore voice: run MeetDossie.bat and press Enter once at the dev-channels warning prompt (needs you at the keyboard -- this can't be automated safely). Telegram/typed Cole may still be fine on the separate always-on session."
} elseif (-not $bridgeChildUp) {
    $diagnosis = "The Claude Code session is up, but the jarvis-bridge relay process itself is NOT running -- it likely crashed and self-terminated."
    $fix = "Check ~/.claude/channels/jarvis-bridge/server.log for a FATAL line, then restart that Claude Code session to relaunch the relay."
} else {
    $diagnosis = "Both the session and the relay process appear to be running, but the relay hasn't reported a heartbeat -- possibly hung despite its own stall watchdog."
    $fix = "Recommend restarting that Claude Code session. Check ~/.claude/channels/jarvis-bridge/server.log for the last few lines first."
}

Write-WatchdogLog "DOWN -- $detail. devChannelsUp=$devChannelsUp bridgeChildUp=$bridgeChildUp. $diagnosis"

$shouldAlert = ($state.status -ne 'down') -or (($nowUnix - [int]$state.lastAlertUnix) -gt $REALERT_SECONDS)
if ($shouldAlert) {
    Send-TelegramAlert "Jarvis voice channel is down. $diagnosis $fix ($detail)"
    Save-WatchdogState -State ([pscustomobject]@{ status = 'down'; lastAlertUnix = $nowUnix })
} else {
    Save-WatchdogState -State ([pscustomobject]@{ status = 'down'; lastAlertUnix = $state.lastAlertUnix })
}
exit 1
