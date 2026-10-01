set -e
cd /home/heath/mw/v8
# Cover is built WITHOUT the burned-in captions (they are a motion device, not a
# poster element) and with the hook card dropped to y=700 so the whole hook
# survives the 1:1 centre crop, which keeps y 418-1498. A cover whose text only
# reads in 9:16 is half a cover.
# T=20.5: the payoff beat -- all three 12B highlights are up and BOTH callout
# chips are on screen (sage 16.80-20.90, coral 19.40-20.90).
T=20.5
ffmpeg -nostdin -v error -y -ss $T -i bg8.mp4 -frames:v 1 chk/cov_bg.png
ffmpeg -nostdin -v error -y -ss $T -i v8_master.mov -frames:v 1 chk/cov_rgb.png
ffmpeg -nostdin -v error -y -ss $T -i alpha8.mkv -frames:v 1 chk/cov_a.png
ffmpeg -nostdin -v error -y -i chk/cov_bg.png -i chk/cov_rgb.png -i chk/cov_a.png -i cards/hook8.png \
 -filter_complex "\
[1:v]format=rgba[rgb];[2:v]format=gray[al];[rgb][al]alphamerge[subj];\
[subj]scale=w=500:h=889:flags=bicubic[sc];\
[0:v][sc]overlay=x='W-w-50':y='H-h'[v1];\
[v1][3:v]overlay=x=0:y=700,format=yuv420p[vo]" \
 -map "[vo]" -frames:v 1 cards/cover8.png
# true 1:1, keeping y 418-1498
ffmpeg -nostdin -v error -y -i cards/cover8.png -vf "crop=1080:1080:0:418" cards/cover8_square.png
ffprobe -v error -show_entries stream=width,height -of default=nw=1 cards/cover8.png
ffprobe -v error -show_entries stream=width,height -of default=nw=1 cards/cover8_square.png
echo cover-ok
