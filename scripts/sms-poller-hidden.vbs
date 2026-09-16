' scripts/sms-poller-hidden.vbs
'
' Silent launcher for the SmsPoller scheduled task. WSHShell.Run's third
' argument (0 = hidden window style, True = wait for completion) suppresses
' the console window that wsl.exe would otherwise flash on screen every time
' Task Scheduler fires it (every 12 min, see register-sms-poller.ps1). Added
' 2026-08-27 (Atlas) after Heath reported a terminal window popping up and
' disappearing periodically -- traced to this task running wsl.exe as a bare
' task action with no hidden flag.
'
' Behavior is otherwise unchanged: same bash wrapper, same log file.

Set WshShell = CreateObject("WScript.Shell")
cmd = "wsl.exe -d Ubuntu -- bash -lc ""bash '/mnt/c/Users/Heath/Projects/MeetDossie/scripts/run-sms-poller.sh' >> /mnt/c/Users/Heath/.claude/sms-poller.log 2>&1"""
WshShell.Run cmd, 0, True
