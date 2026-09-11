# scripts/agent-queue-poller-hidden.ps1
#
# Hidden launcher for the AgentQueuePoller scheduled task (Atlas, 2026-09-10).
#
# The task action used to be raw node.exe, which Task Scheduler runs in the
# interactive session with a visible console window -- Heath reported a
# terminal flashing and disappearing periodically, interrupting voice
# dictation. Tracing every "Dossie"/"Agent"/"Cole" scheduled task found this
# one among the culprits (see also claude-code-worker-hidden.ps1,
# cole-session-hidden.ps1, tc-discovery-harvest-hidden.vbs,
# mls-keepalive-hidden.vbs -- same fix, same day).
#
# This script is launched with `powershell.exe -WindowStyle Hidden -File`
# (see register-agent-queue-poller.ps1) rather than wrapped in a
# fire-and-forget WScript.Shell.Run -- that matters because this process is
# LONG-RUNNING and the scheduled task's RestartOnFailure (999x / 1 min) must
# keep supervising the REAL node.exe process, not a detached grandchild.
# Running node in the foreground of this hidden powershell host and
# propagating its exit code preserves that: if node.exe dies, this script
# exits non-zero, Task Scheduler sees the failure and restarts the whole
# action within a minute -- same resilience as before, just invisible.
#
# Manual foreground test (visible, for debugging):
#   cd "C:\Users\Heath\Projects\MeetDossie"
#   node scripts\agent-queue-poller.js

$ErrorActionPreference = 'Stop'

$PollerScript = 'C:\Users\Heath\Projects\MeetDossie\scripts\agent-queue-poller.js'
$RepoDir      = 'C:\Users\Heath\Projects\MeetDossie'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $node)) {
    Write-Error "node.exe not found (checked PATH and default install location)."
    exit 1
}

Set-Location $RepoDir
& $node $PollerScript
exit $LASTEXITCODE
