set -e
cd /home/heath/mw/v8
M=/mnt/c/Users/Heath/Projects/MeetDossie/Media/screen-recordings

# One cutaway to the real clause screen-recording, as a bordered band over a
# scrimmed document, landing exactly on "Those are the contract's words, shall
# not change." (14.20-16.56) -- the beat where showing the actual promulgated
# form matters most.
#
# Only the settled tail of the clip is usable: it spends its first ~7s zooming
# from a full-page view. crop=1080:420:0:850 drops the grey bars above the page
# and the burned-in navy caption card below it, so nothing competes with our own
# captions, and keeps just the highlighted 12.B block.
#   source 8.00-10.20 -> output 14.30-16.50
ffmpeg -nostdin -v error -y \
 -i bgdoc.mp4 \
 -i "$M/trec-12b-brokerage-compensation-mobile-2026-09-30.mp4" \
 -filter_complex "\
[1:v]trim=8.00:10.20,setpts=PTS-STARTPTS+14.30/TB,crop=1080:420:0:850,setsar=1,\
drawbox=x=0:y=0:w=1080:h=420:color=0xC9A96E@0.95:t=6[b1];\
[0:v]drawbox=x=0:y=0:w=1080:h=1920:color=black@0.55:t=fill:enable='between(t,14.30,16.50)'[dk];\
[dk][b1]overlay=x=0:y=300:enable='between(t,14.30,16.50)':eof_action=pass,\
format=yuv420p,fps=30[v]" \
 -map "[v]" -an -c:v libx264 -crf 16 -preset medium -r 30 -t 33.366667 bg8.mp4
ffprobe -v error -show_entries stream=width,height -show_entries format=duration -of default=nw=1 bg8.mp4
echo bg-ok
