# scripts/claude-code-worker-hidden.ps1
#
# Hidden launcher for the ClaudeCodeWorker scheduled task (Atlas, 2026-09-10).
# Same fix and same reasoning as agent-queue-poller-hidden.ps1 -- see that
# file's header for the full explanation. Runs node.exe in the foreground of
# a hidden powershell.exe host (launched via -WindowStyle Hidden -File, see
# register-claude-code-worker.ps1) so Task Scheduler's RestartOnFailure
# (999x / 1 min) still supervises the real process and the console never
# flashes on screen.
#
# Manual foreground test (visible, for debugging):
#   cd "C:\Users\Heath\Projects\MeetDossie"
#   node scripts\claude-code-worker.js --once

$ErrorActionPreference = 'Stop'

$WorkerScript = 'C:\Users\Heath\Projects\MeetDossie\scripts\claude-code-worker.js'
$RepoDir      = 'C:\Users\Heath\Projects\MeetDossie'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $node)) {
    Write-Error "node.exe not found (checked PATH and default install location)."
    exit 1
}

Set-Location $RepoDir
& $node $WorkerScript
exit $LASTEXITCODE
