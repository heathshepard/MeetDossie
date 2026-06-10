@echo off
REM run-first-comment-blitz.cmd
REM Wrapper invoked by Windows Task Scheduler "Dossie First Comment Auto-Attach".
REM Captures stdout+stderr to scripts\atlas-runs\first-comment-auto-attach.log.

setlocal
set REPO=C:\Users\Heath Shepard\Desktop\MeetDossie
set SCRIPT=%REPO%\scripts\atlas-fb-first-comments-blitz-v2.js
set LOGDIR=%REPO%\scripts\atlas-runs
set LOG=%LOGDIR%\first-comment-auto-attach.log

if not exist "%LOGDIR%" mkdir "%LOGDIR%"

cd /d "%REPO%"

echo. >> "%LOG%"
echo [%date% %time%] === auto-attach run start === >> "%LOG%"
node "%SCRIPT%" >> "%LOG%" 2>&1
echo [%date% %time%] === auto-attach run end (exit %errorlevel%) === >> "%LOG%"

endlocal
