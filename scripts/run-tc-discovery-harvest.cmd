@echo off
rem Windows Task Scheduler wrapper for the TC discovery comment harvester.
rem The script self-gates its own cadence (+24h / +72h / every 3 days per
rem post), so running this every 6 hours is safe and cheap — no-due-posts
rem runs exit in ~2s without launching Chrome.
cd /d "C:\Users\Heath\Projects\MeetDossie"
node scripts\harvest-tc-discovery-responses.js >> scripts\tc-discovery-harvest.log 2>&1
