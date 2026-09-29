# scripts/cole-session-hidden.ps1
#
# Hidden launcher for the ColeClaudeCodeSession scheduled task (Atlas,
# 2026-09-10). Same fix and reasoning as agent-queue-poller-hidden.ps1 -- see
# that file's header. The task action used to be raw wsl.exe, which pops a
# visible console host window (and flashes it repeatedly if the WSL/claude
# process is crash-looping) -- one of several culprits behind Heath's
# "terminal flashes and disappears, interrupts my dictation" report.
#
# Launched via `powershell.exe -WindowStyle Hidden -File` (see
# register-cole-claude-code-session.ps1) so this process's own window stays
# hidden. wsl.exe runs in the FOREGROUND of this script (not fire-and-forget)
# so Task Scheduler's RestartOnFailure (999x / 1 min) keeps supervising the
# real session and still relaunches Cole if it dies -- this is the main
# Telegram bot session, do not detach it from Scheduler's failure tracking.
#
# Manual foreground test (visible, for debugging):
#   wsl.exe -d Ubuntu -- bash -lc "cd /mnt/c/Users/Heath/Projects/MeetDossie && claude --continue --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions"

$ErrorActionPreference = 'Stop'

$bashLc = "cd /mnt/c/Users/Heath/Projects/MeetDossie 2>/dev/null || { echo 'MeetDossie repo not found'; exit 1; }; exec claude --continue --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions"

& 'C:\Windows\system32\wsl.exe' -d Ubuntu -- bash -lc $bashLc
exit $LASTEXITCODE
