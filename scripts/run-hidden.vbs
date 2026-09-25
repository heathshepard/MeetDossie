' scripts/run-hidden.vbs
'
' Generic silent launcher: runs any .cmd in this same scripts\ folder with no
' console window. Added 2026-09-25 (Atlas) so new scheduled tasks stop needing
' their own bespoke copy of the same six lines -- tc-discovery-harvest-hidden.vbs
' and sms-poller-hidden.vbs are each a one-off of exactly this.
'
' Heath dictates by voice all day; a cmd window stealing focus every time a
' scheduled task fires interrupts Wispr Flow mid-sentence. WSHShell.Run's third
' argument (0 = hidden, True = wait) is what suppresses it.
'
' Usage from Task Scheduler:
'   wscript.exe "<repo>\scripts\run-hidden.vbs" run-linkedin-social.cmd
'
' Self-locates via WScript.ScriptFullName, so the same tracked file works from
' the dev tree or the separate MeetDossie-scheduler checkout.

If WScript.Arguments.Count < 1 Then
  WScript.Quit 2
End If

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

target = scriptDir & "\" & WScript.Arguments(0)

If Not fso.FileExists(target) Then
  WScript.Quit 3
End If

Set WshShell = CreateObject("WScript.Shell")
WScript.Quit WshShell.Run("cmd.exe /c """ & target & """", 0, True)
