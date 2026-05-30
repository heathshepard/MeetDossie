@echo off
REM ============================================================
REM Italy Founder Story v4 - WITH AUDIO
REM Key change from v3: selfie clips keep Heath's mic audio (-an removed)
REM Only the screen splice remains muted (product demo, no mic audio)
REM
REM Assembly order (Sage directed - same as v3):
REM   1-9: selfie clips (with audio)
REM   [screen splice: pipeline-mobile-2026-05-29.mp4 t=9s, 8s, muted]
REM   10-15: selfie clips (with audio)
REM
REM Run from MeetDossie root: scripts\build-italy-v4.bat
REM ============================================================

set ITALY=C:\Users\Heath Shepard\Desktop\MeetDossie\Media\Selfie\Italy
set SCREEN=C:\Users\Heath Shepard\Desktop\MeetDossie\Media\screen-recordings\pipeline-mobile-2026-05-29.mp4
set OUT=C:\Users\Heath Shepard\Desktop\MeetDossie\Media\finished-videos\italy-selfie-v4-2026-05-29.mp4
set INT=%ITALY%\intermediates_v4

echo.
echo ============================================================
echo ITALY FOUNDER STORY v4 - WITH AUDIO
echo ============================================================
echo.

REM Pre-flight checks
if not exist "%ITALY%\1.mp4" (
  echo ERROR: Italy clips not found at %ITALY%
  echo Expected: 1.mp4 through 15.mp4
  pause
  exit /b 1
)
if not exist "%SCREEN%" (
  echo ERROR: Screen recording not found: %SCREEN%
  pause
  exit /b 1
)

REM Create fresh intermediates_v4 directory
if exist "%INT%" rmdir /s /q "%INT%"
mkdir "%INT%"
if not exist "C:\Users\Heath Shepard\Desktop\MeetDossie\Media\finished-videos" mkdir "C:\Users\Heath Shepard\Desktop\MeetDossie\Media\finished-videos"

echo Step 1: Re-encoding selfie clips WITH audio...
echo (Each clip trimmed 0.3s head and tail, HEVC -> H.264 1080x1920 30fps)
echo.

REM Clip 1 - Hook: Italy, TC quit
echo [1/15] Clip 1 - Hook...
ffmpeg -y -ss 0.3 -i "%ITALY%\1.mp4" -t 999 -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" -c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p -c:a aac -b:a 128k "%INT%\s01.mp4"
if errorlevel 1 (echo ERROR on clip 1 && pause && exit /b 1)

REM Clip 2 - Stakes: option period
echo [2/15] Clip 2 - Option period...
ffmpeg -y -ss 0.3 -i "%ITALY%\2.mp4" -t 999 -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" -c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p -c:a aac -b:a 128k "%INT%\s02.mp4"
if errorlevel 1 (echo ERROR on clip 2 && pause && exit /b 1)

REM Clip 3 - Stakes: title company
echo [3/15] Clip 3 - Title company...
ffmpeg -y -ss 0.3 -i "%ITALY%\3.mp4" -t 999 -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" -c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p -c:a aac -b:a 128k "%INT%\s03.mp4"
if errorlevel 1 (echo ERROR on clip 3 && pause && exit /b 1)

REM Clip 4 - Stakes: lender/appraisal
echo [4/15] Clip 4 - Lender/appraisal...
ffmpeg -y -ss 0.3 -i "%ITALY%\4.mp4" -t 999 -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" -c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p -c:a aac -b:a 128k "%INT%\s04.mp4"
if errorlevel 1 (echo ERROR on clip 4 && pause && exit /b 1)

REM Clip 5 - Situation: 9 time zones
echo [5/15] Clip 5 - 9 time zones...
ffmpeg -y -ss 0.3 -i "%ITALY%\5.mp4" -t 999 -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" -c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p -c:a aac -b:a 128k "%INT%\s05.mp4"
if errorlevel 1 (echo ERROR on clip 5 && pause && exit /b 1)

REM Clip 6 - Situation: hotel Wi-Fi
echo [6/15] Clip 6 - Hotel Wi-Fi...
ffmpeg -y -ss 0.3 -i "%ITALY%\6.mp4" -t 999 -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" -c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p -c:a aac -b:a 128k "%INT%\s06.mp4"
if errorlevel 1 (echo ERROR on clip 6 && pause && exit /b 1)

REM Clip 7 - Situation: restaurant
echo [7/15] Clip 7 - Restaurant...
ffmpeg -y -ss 0.3 -i "%ITALY%\7.mp4" -t 999 -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" -c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p -c:a aac -b:a 128k "%INT%\s07.mp4"
if errorlevel 1 (echo ERROR on clip 7 && pause && exit /b 1)

REM Clip 8 - Emotional peak: built business around someone who could leave
echo [8/15] Clip 8 - Emotional peak...
ffmpeg -y -ss 0.3 -i "%ITALY%\8.mp4" -t 999 -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" -c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p -c:a aac -b:a 128k "%INT%\s08.mp4"
if errorlevel 1 (echo ERROR on clip 8 && pause && exit /b 1)

REM Clip 9 - The build: so I built something
echo [9/15] Clip 9 - So I built something...
ffmpeg -y -ss 0.3 -i "%ITALY%\9.mp4" -t 999 -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" -c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p -c:a aac -b:a 128k "%INT%\s09.mp4"
if errorlevel 1 (echo ERROR on clip 9 && pause && exit /b 1)

echo.
echo Step 2: Re-encoding screen splice (MUTED - product demo, no mic audio)...
ffmpeg -y -ss 9.0 -i "%SCREEN%" -t 8.0 -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" -c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p -an "%INT%\screen_splice.mp4"
if errorlevel 1 (echo ERROR on screen splice && pause && exit /b 1)

echo.
echo Step 3: Re-encoding remaining selfie clips WITH audio...
echo.

REM Clip 10 - Feature: morning brief
echo [10/15] Clip 10 - Morning brief...
ffmpeg -y -ss 0.3 -i "%ITALY%\10.mp4" -t 999 -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" -c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p -c:a aac -b:a 128k "%INT%\s10.mp4"
if errorlevel 1 (echo ERROR on clip 10 && pause && exit /b 1)

REM Clip 11 - Feature: deadlines coming
echo [11/15] Clip 11 - Deadlines coming...
ffmpeg -y -ss 0.3 -i "%ITALY%\11.mp4" -t 999 -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" -c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p -c:a aac -b:a 128k "%INT%\s11.mp4"
if errorlevel 1 (echo ERROR on clip 11 && pause && exit /b 1)

REM Clip 12 - Feature: what's already handled
echo [12/15] Clip 12 - What's handled...
ffmpeg -y -ss 0.3 -i "%ITALY%\12.mp4" -t 999 -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" -c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p -c:a aac -b:a 128k "%INT%\s12.mp4"
if errorlevel 1 (echo ERROR on clip 12 && pause && exit /b 1)

REM Clip 14 - Feature: follow-up emails (note: source is 14.mp4 per Sage's order)
echo [13/15] Clip 14 - Follow-up emails...
ffmpeg -y -ss 0.3 -i "%ITALY%\14.mp4" -t 999 -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" -c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p -c:a aac -b:a 128k "%INT%\s13.mp4"
if errorlevel 1 (echo ERROR on clip 14 && pause && exit /b 1)

REM Clip 15 - Outcome: no 4:30am
echo [14/15] Clip 15 - No 4:30am...
ffmpeg -y -ss 0.3 -i "%ITALY%\15.mp4" -t 999 -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" -c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p -c:a aac -b:a 128k "%INT%\s14.mp4"
if errorlevel 1 (echo ERROR on clip 15 && pause && exit /b 1)

REM Clip 13 - CTA: $29/mo, 38 spots (source is 13.mp4 per Sage's order)
echo [15/15] Clip 13 - CTA...
ffmpeg -y -ss 0.3 -i "%ITALY%\13.mp4" -t 999 -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" -c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p -c:a aac -b:a 128k "%INT%\s15.mp4"
if errorlevel 1 (echo ERROR on clip 13 && pause && exit /b 1)

echo.
echo Step 4: Writing concat list...
REM NOTE: Screen splice is MUTED and inserted between s09.mp4 and s10.mp4
REM All selfie clips include audio. Final concat uses stream copy.
REM The concat demuxer requires all segments to have the same codec/channels.
REM Selfie clips: H.264 + AAC. Screen splice: H.264 + silent AAC track.
REM We need to add a silent audio track to the screen splice so stream copy works.

echo Adding silent audio track to screen splice for concat compatibility...
ffmpeg -y -i "%INT%\screen_splice.mp4" -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -shortest -c:v copy -c:a aac -b:a 128k "%INT%\screen_splice_audio.mp4"
if errorlevel 1 (echo ERROR adding silent audio to screen splice && pause && exit /b 1)

(
echo file '%INT:\=/%/s01.mp4'
echo file '%INT:\=/%/s02.mp4'
echo file '%INT:\=/%/s03.mp4'
echo file '%INT:\=/%/s04.mp4'
echo file '%INT:\=/%/s05.mp4'
echo file '%INT:\=/%/s06.mp4'
echo file '%INT:\=/%/s07.mp4'
echo file '%INT:\=/%/s08.mp4'
echo file '%INT:\=/%/s09.mp4'
echo file '%INT:\=/%/screen_splice_audio.mp4'
echo file '%INT:\=/%/s10.mp4'
echo file '%INT:\=/%/s11.mp4'
echo file '%INT:\=/%/s12.mp4'
echo file '%INT:\=/%/s13.mp4'
echo file '%INT:\=/%/s14.mp4'
echo file '%INT:\=/%/s15.mp4'
) > "%INT%\concat_v4.txt"

echo.
echo Step 5: Final concat (stream copy)...
ffmpeg -y -f concat -safe 0 -i "%INT%\concat_v4.txt" -c copy "%OUT%"
if errorlevel 1 (echo ERROR on final concat && pause && exit /b 1)

echo.
echo ============================================================
echo BUILD COMPLETE
echo Output: %OUT%
echo.
echo Next steps:
echo 1. Review the video (check audio + screen splice transition)
echo 2. Upload to Submagic for captions
echo 3. Or upload to media-studio.html for the posting pipeline
echo ============================================================
echo.
pause
