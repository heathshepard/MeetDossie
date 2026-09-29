' scripts/tc-discovery-harvest-hidden.vbs
'
' Silent launcher for the "Dossie TC Discovery Harvest" scheduled task.
' WSHShell.Run's third argument (0 = hidden window style, True = wait for
' completion) suppresses the cmd.exe console window that would otherwise
' flash on screen every time Task Scheduler fires it (every 30 min, see
' register-tc-discovery-harvest-task.ps1). Most ticks have nothing due and
' exit in ~2s -- exactly the "flashes for a second and disappears" pattern
' Heath reported interrupting his voice dictation. Added 2026-09-10 (Atlas),
' same fix/day as sms-poller-hidden.vbs (2026-08-27) applied here plus to
' the other node/wsl-driven tasks that were still running visibly.
'
' Does NOT hide the headed DossieBot-Sage Chrome window the wrapped scripts
' launch when there IS approved content to post -- that window is a separate,
' expected, occasional GUI surface (register-tc-discovery-harvest-task.ps1
' notes headed Chrome is required here), not the console flash being fixed.
'
' Behavior is otherwise unchanged: same wrapper script, same log files.
'
' 2026-09-16 (Atlas): self-locates via WScript.ScriptFullName instead of a
' hardcoded C:\Users\Heath\Projects\MeetDossie literal, so this exact
' tracked file works unmodified from either the dev tree or the separate
' MeetDossie-scheduler checkout (see docs/SCHEDULER-CHECKOUT.md).

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

Set WshShell = CreateObject("WScript.Shell")
cmd = "cmd.exe /c """ & scriptDir & "\run-tc-discovery-harvest.cmd"""
WshShell.Run cmd, 0, True
