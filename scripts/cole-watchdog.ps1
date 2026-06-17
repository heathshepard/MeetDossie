# scripts/cole-watchdog.ps1
#
# Cole Watchdog (Atlas, 2026-06-17)
#
# Detects when Cole (claude.exe) has died and auto-relaunches the MeetDossie
# Claude Code session. Designed to be invoked every 5 minutes by Windows Task
# Scheduler (see scripts/register-cole-watchdog.ps1).
#
# Logic:
#   1. Check if claude.exe is running.
#   2. If YES -> log "alive" and exit 0 (no-op).
#   3. If NO  -> Telegram alert -> relaunch claude.exe -> verify -> Telegram confirm.
#
# Companion: Component 1 (heartbeat) is registered as a separate task by
# register-cole-watchdog.ps1. The heartbeat task writes
# C:\Users\Heath Shepard\.claude\heartbeat.txt every 60s while claude.exe runs.
#
# Logs to C:\Users\Heath Shepard\.claude\watchdog.log (rolling, last 100 entries).

$ErrorActionPreference = 'Stop'

$LogPath        = 'C:\Users\Heath Shepard\.claude\watchdog.log'
$HeartbeatPath  = 'C:\Users\Heath Shepard\.claude\heartbeat.txt'
$EnvPath        = 'C:\Users\Heath Shepard\Desktop\MeetDossie\.env.local'
$MeetDossieDir  = 'C:\Users\Heath Shepard\Desktop\MeetDossie'

# ---- Logging helper ---------------------------------------------------------

function Write-WatchdogLog {
    param([string]$Message)
    $ts = Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'
    $line = "[$ts] $Message"
    Add-Content -Path $LogPath -Value $line -Encoding utf8
    # Roll: keep last 100 lines.
    try {
        $lines = Get-Content $LogPath -Encoding utf8 -ErrorAction SilentlyContinue
        if ($lines.Count -gt 100) {
            $lines | Select-Object -Last 100 | Set-Content -Path $LogPath -Encoding utf8
        }
    } catch { }
}

# ---- Telegram helper --------------------------------------------------------

function Send-TelegramAlert {
    param([string]$Text)

    if (!(Test-Path $EnvPath)) {
        Write-WatchdogLog "WARN: .env.local missing at $EnvPath -- skipping Telegram alert"
        return
    }

    $botToken = $null
    $chatId   = $null
    Get-Content $EnvPath | ForEach-Object {
        if ($_ -match '^\s*TELEGRAM_BOT_TOKEN\s*=\s*"?([^"\r\n]+)"?\s*$') { $botToken = $Matches[1] }
        if ($_ -match '^\s*TELEGRAM_CHAT_ID\s*=\s*"?([^"\r\n]+)"?\s*$')   { $chatId   = $Matches[1] }
    }
    if (-not $botToken) { Write-WatchdogLog "WARN: TELEGRAM_BOT_TOKEN missing -- skipping alert"; return }
    if (-not $chatId)   { $chatId = '7874782923' }  # Heath's chat ID fallback

    $url = "https://api.telegram.org/bot$botToken/sendMessage"
    $body = @{ chat_id = $chatId; text = $Text } | ConvertTo-Json -Compress

    # Use curl.exe rather than Invoke-RestMethod -- matches the mission-watchdog
    # pattern and dodges PS5 + Task-Scheduler-NonInteractive TLS handshake issues.
    # IMPORTANT: write UTF-8 *without* BOM. PowerShell 5's -Encoding utf8 prepends
    # a BOM which Telegram's JSON parser rejects with 400 "message text is empty".
    $bodyFile = Join-Path $env:TEMP "cole-watchdog-tg-$([Guid]::NewGuid().ToString('N')).json"
    [System.IO.File]::WriteAllText($bodyFile, $body, [System.Text.UTF8Encoding]::new($false))
    try {
        $resp = & 'C:\Windows\System32\curl.exe' -sS -H 'Content-Type: application/json' -X POST --data-binary "@$bodyFile" $url 2>&1
        if ($resp -match '"ok":true') {
            Write-WatchdogLog "Telegram sent: $Text"
        } else {
            Write-WatchdogLog "Telegram response not OK: $resp"
        }
    } catch {
        Write-WatchdogLog "Telegram ERROR: $($_.Exception.Message)"
    } finally {
        Remove-Item -Path $bodyFile -Force -ErrorAction SilentlyContinue
    }
}

# ---- Main -------------------------------------------------------------------

Write-WatchdogLog "watchdog tick"

$claudeProc = Get-Process claude -ErrorAction SilentlyContinue
if ($claudeProc) {
    Write-WatchdogLog "claude.exe alive (PID $($claudeProc.Id -join ','))"
    exit 0
}

# ---- Cole is down -- relaunch ---------------------------------------------

Write-WatchdogLog "claude.exe NOT running -- auto-restart triggered"

$nowReadable = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Send-TelegramAlert "Cole was down. Auto-restart triggered at $nowReadable. Relaunching Claude Code now."

# Launch the MeetDossie Claude Code session in a new minimized PowerShell.
# Mirrors the .bat file in CLAUDE.md Section 24.
$launchCmd = "cd `"$MeetDossieDir`"; claude --continue --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions"

try {
    Start-Process powershell -ArgumentList '-NoExit', '-Command', $launchCmd -WindowStyle Minimized
    Write-WatchdogLog "Start-Process powershell launched"
} catch {
    Write-WatchdogLog "FATAL: Start-Process failed: $($_.Exception.Message)"
    Send-TelegramAlert "Cole auto-restart FAILED at $nowReadable -- $($_.Exception.Message). Heath manual intervention needed."
    exit 1
}

# Wait 30s and verify.
Start-Sleep -Seconds 30
$claudeProc = Get-Process claude -ErrorAction SilentlyContinue
if ($claudeProc) {
    Write-WatchdogLog "Restart confirmed -- claude.exe PID $($claudeProc.Id -join ',')"
    Send-TelegramAlert "Cole back online. PID $($claudeProc.Id -join ','). Watchdog will keep monitoring."
    exit 0
} else {
    Write-WatchdogLog "Restart FAILED -- claude.exe not running 30s after launch"
    Send-TelegramAlert "Cole auto-restart did NOT succeed. claude.exe still not running 30s after launch. Heath manual intervention needed."
    exit 1
}
