@echo off
REM scripts/brokerage-mls-keepalive.cmd
REM Windows Task Scheduler wrapper for the connectMLS keep-alive.
REM Runs the headless keep-alive under Windows node with the repo as cwd.
REM Registered as scheduled task "Dossie-MLS-KeepAlive" (see brokerage-mls-keepalive.js --install-help).
REM Independent of the dead PC poller / cron-process-agent-requests.
cd /d C:\Users\Heath\Projects\MeetDossie
node scripts\brokerage-mls-keepalive.js --quiet >> scripts\atlas-runs\mls-keepalive.log 2>&1
