# scripts/browser-bridge/install-native-host.ps1
#
# One-time installer for the Cole Browser Bridge native messaging host.
# Registers scripts/browser-bridge/native-host/host.bat with Chrome so that
# when the "Cole Browser Bridge" extension calls chrome.runtime.connectNative,
# Chrome launches this host and lets it talk to it over stdio -- the
# standard, documented Chrome Native Messaging mechanism, not a bypass of
# anything (https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).
#
# extension/manifest.json carries a fixed "key" (an RSA public key, not a
# secret -- this is Chrome's own documented mechanism for pinning an
# unpacked extension's ID so it doesn't depend on the load path), so the
# extension ID is the SAME constant every time it's loaded unpacked, on any
# machine: icbfnjkaoiplcfdmjjpdhbkfkimjklij. No copy-paste-the-ID step
# needed -- this script defaults to it. Only pass -ExtensionId if Chrome
# ever shows something different (would mean manifest.json's "key" field
# got edited/dropped).
#
# Usage (after loading the unpacked extension via chrome://extensions ->
# Developer mode -> Load unpacked -> scripts\browser-bridge\extension):
#   cd C:\Users\Heath\Projects\MeetDossie
#   powershell -ExecutionPolicy Bypass -File scripts\browser-bridge\install-native-host.ps1
#
# Idempotent -- re-running overwrites the manifest + registry entry + .env
# copy with fresh values.
#
# What this does NOT do: install the extension itself (Chrome has no
# supported way to silently install an unpacked extension -- that one step
# is genuinely manual, same as any developer-mode extension) or touch any
# system-wide (HKLM) registry location -- everything here is HKCU, scoped to
# Heath's own Windows profile.
#
# Verify after install:
#   Get-ItemProperty 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.shepardventures.browser_bridge'
#   Get-Content "$env:USERPROFILE\.browser-bridge\com.shepardventures.browser_bridge.json"
#
# Uninstall:
#   Remove-Item 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.shepardventures.browser_bridge' -Recurse

param(
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId = 'icbfnjkaoiplcfdmjjpdhbkfkimjklij'
)

$ErrorActionPreference = 'Stop'

$RepoRoot = 'C:\Users\Heath\Projects\MeetDossie'
$HostBat = Join-Path $RepoRoot 'scripts\browser-bridge\native-host\host.bat'
$StateDir = Join-Path $env:USERPROFILE '.browser-bridge'
$ManifestPath = Join-Path $StateDir 'com.shepardventures.browser_bridge.json'
$EnvPath = Join-Path $StateDir '.env'
$HostName = 'com.shepardventures.browser_bridge'

if (!(Test-Path $HostBat)) {
    Write-Host "FATAL: $HostBat not found. Is the repo at $RepoRoot ?" -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Path $StateDir -Force | Out-Null

# ---- 1. native messaging host manifest -------------------------------------
$manifest = @{
    name            = $HostName
    description     = 'Cole Browser Bridge -- lets the live Claude Code / Jarvis session read and act inside an armed Chrome tab.'
    path            = $HostBat
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 5

Set-Content -Path $ManifestPath -Value $manifest -Encoding UTF8
Write-Host "Wrote host manifest -> $ManifestPath" -ForegroundColor Green

# ---- 2. registry entry (HKCU -- current user only) -------------------------
$RegKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Path $RegKey -Force | Out-Null
Set-ItemProperty -Path $RegKey -Name '(Default)' -Value $ManifestPath
Write-Host "Registered $RegKey -> $ManifestPath" -ForegroundColor Green

# ---- 3. copy Supabase credentials from the already-working jarvis-bridge --
# jarvis-bridge's WSL env already holds SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
# (scripts/jarvis-bridge/server.ts uses the exact same values). Reuse them
# instead of asking Heath to paste secrets into a second place -- read them
# through the \\wsl$ UNC bridge Windows exposes for the running WSL distro.
$WslEnvCandidates = @(
    '\\wsl$\Ubuntu\home\heath\.claude\channels\jarvis-bridge\.env',
    '\\wsl.localhost\Ubuntu\home\heath\.claude\channels\jarvis-bridge\.env'
)
$WslEnvFound = $null
foreach ($p in $WslEnvCandidates) {
    if (Test-Path $p) { $WslEnvFound = $p; break }
}

if ($WslEnvFound) {
    $lines = Get-Content $WslEnvFound | Where-Object { $_ -match '^(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)=' }
    if ($lines) {
        Set-Content -Path $EnvPath -Value $lines -Encoding UTF8
        Write-Host "Copied SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY -> $EnvPath" -ForegroundColor Green
    } else {
        Write-Host "WARNING: found $WslEnvFound but it had no SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY lines -- write $EnvPath by hand." -ForegroundColor Yellow
    }
} else {
    Write-Host "WARNING: could not reach jarvis-bridge's env over \\wsl$ or \\wsl.localhost -- WSL may not be running." -ForegroundColor Yellow
    Write-Host "Create $EnvPath by hand with:" -ForegroundColor Yellow
    Write-Host "  SUPABASE_URL=https://pgwoitbdiyubjugwufhk.supabase.co" -ForegroundColor Gray
    Write-Host "  SUPABASE_SERVICE_ROLE_KEY=<value from Vercel env / Bitwarden>" -ForegroundColor Gray
}

# ---- 4. sanity check node.exe is reachable ---------------------------------
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "WARNING: node.exe not found on PATH -- host.bat will fail to launch. Install Node.js or fix PATH." -ForegroundColor Yellow
} else {
    Write-Host "node.exe found at $($node.Source)" -ForegroundColor Green
}

Write-Host ""
Write-Host "OK -- native host registered for extension id $ExtensionId" -ForegroundColor Green
Write-Host ""
Write-Host "Next: reload the extension (chrome://extensions -> reload icon on Cole Browser Bridge)," -ForegroundColor Cyan
Write-Host "then click its toolbar icon on any tab to arm it. Host log: $StateDir\host.log" -ForegroundColor Cyan
