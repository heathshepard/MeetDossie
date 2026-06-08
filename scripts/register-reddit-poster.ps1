# register-reddit-poster.ps1
# Run this ONCE as Administrator to register the Task Scheduler entry.
# Right-click PowerShell -> "Run as administrator", then paste:
#   & "C:\Users\Heath Shepard\Desktop\MeetDossie\scripts\register-reddit-poster.ps1"

$batPath = "C:\Users\Heath Shepard\Desktop\MeetDossie\scripts\run-reddit-poster.bat"
$workDir = "C:\Users\Heath Shepard\Desktop\MeetDossie"

$action = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c `"$batPath`"" `
    -WorkingDirectory $workDir

$trigger = New-ScheduledTaskTrigger `
    -RepetitionInterval (New-TimeSpan -Minutes 15) `
    -Once `
    -At (Get-Date)

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

Register-ScheduledTask `
    -TaskName "DossieBot-Reddit-Poster" `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -RunLevel Highest `
    -Force

Write-Host "DossieBot-Reddit-Poster registered. Runs every 15 minutes."
Get-ScheduledTask -TaskName "DossieBot-Reddit-Poster" | Select-Object TaskName, State
