set -e
cd /home/heath/mw/v8/cards
# HOOK: NO fade-in. Fully opaque at frame 0 -- a fade once shipped a video whose
# first frame was empty, and frame 0 is the thumbnail. Clears at 2.55s, before
# the 3s inspection point; captions are suppressed until then so two large-type
# layers never stack.
ffmpeg -nostdin -v error -y -loop 1 -framerate 30 -i hook8.png -t 2.55 \
  -vf "format=rgba,fade=t=out:st=2.18:d=0.37:alpha=1,format=argb" \
  -c:v qtrle -r 30 hook8.mov
# CTA: 28.95 -> 33.785 (4.835s). Overlaid at y=944, the position fixed in v7c
# after the card landed on his head twice.
ffmpeg -nostdin -v error -y -loop 1 -framerate 30 -i cta8.png -t 4.835 \
  -vf "format=rgba,fade=t=in:st=0:d=0.28:alpha=1,format=argb" \
  -c:v qtrle -r 30 cta8.mov
ffprobe -v error -show_entries format=duration -of default=nw=1 hook8.mov
ffprobe -v error -show_entries format=duration -of default=nw=1 cta8.mov
echo mov-ok
