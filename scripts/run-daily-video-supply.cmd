@echo off
rem scripts/run-daily-video-supply.cmd
rem
rem Windows Task Scheduler -> WSL bridge for the daily video supply loop
rem (scripts/daily-video-supply.js). Called as Step 11 of
rem scripts/run-tc-discovery-harvest.cmd, i.e. on the same 30-min tick; the
rem Node script self-gates to once per calendar day, so 47 of every 48 calls
rem exit in about a second without touching Chrome, ffmpeg or ElevenLabs.
rem
rem WHY WSL AND NOT PLAIN `node scripts\...` LIKE STEPS 1-10:
rem   Every other step is pure Node + Playwright, which runs fine under Windows
rem   node.exe. This one ends in an ffmpeg composite driven by Python
rem   (scripts/build-shortform-video.py). The proven toolchain for that -
rem   ffmpeg with libass, python3, and the Playwright chromium used for the
rem   screenshot-loop capture - is the WSL one. docs/CONTENT-FORMAT-LIBRARY.md
rem   §1 records that ffmpeg here has no drawtext filter and that all text goes
rem   through libass; that is the WSL build. Windows has an ffmpeg.exe but it
rem   is a different build and the Store python.exe stub is not a real
rem   interpreter, so running this half of the pipeline natively would be a
rem   second, unproven toolchain.
rem
rem SELF-LOCATING: %~dp0 means this exact tracked file works unmodified from
rem the dev tree OR the MeetDossie-scheduler checkout (docs/SCHEDULER-CHECKOUT.md).
rem The C:\ -> /mnt/c/ rewrite below is done in batch rather than by shelling
rem `wslpath`, because that would cost an extra WSL start per tick and it is a
rem two-substitution job on a path that is always on C:.
rem
rem DOSSIE_MEDIA_ROOT pins every producer AND the queue scanner at the ONE real
rem Media/ library. Media/ is gitignored, so the -scheduler checkout has none of
rem the music beds and none of the watch folders; without this a scheduled
rem render dies on a missing bed, or worse, quietly queues into a folder
rem nothing scans.

setlocal

for %%I in ("%~dp0..") do set "REPO_WIN=%%~fI"
set "REPO_WSL=%REPO_WIN:C:\=/mnt/c/%"
set "REPO_WSL=%REPO_WSL:\=/%"

set "MEDIA_WSL=/mnt/c/Users/Heath/Projects/MeetDossie/Media"

wsl.exe -d Ubuntu -- bash -lc "cd '%REPO_WSL%' && DOSSIE_MEDIA_ROOT='%MEDIA_WSL%' node scripts/daily-video-supply.js"

endlocal
