set -e
cd /home/heath/mw/v8
D=33.696667

# Layer order: bg -> matted subject -> captions -> hook -> CTA.
# Standard rule 4: alpha from the 640px RVM pass upscaled to 1080x1920, RGB from
# the 1080 master, joined with alphamerge. Nothing here re-times anything --
# speed was applied once, inside cut.py.
#
# Subject width SNAPS at story beats rather than easing, landing on the frames
# the background changes on:
#   10.30  the reveal / clause highlight   440 -> 420  (document has to read)
#   16.60  the payoff, 12B(1) highlighted  420 -> 452
#   20.90  the stake + re-hook, doc static 452 -> 500  (he is the focus)
#   28.95  the CTA card comes up           500 -> 450  (keeps the panel clear
#                                                       of his face)
# x = W-w-50 keeps his right edge anchored as the width changes.
SW="if(lt(t,10.30),440,if(lt(t,16.60),420,if(lt(t,20.90),452,if(lt(t,28.95),500,450))))"

ffmpeg -nostdin -v error -y \
 -i bg8.mp4 -i v8_master.mov -i alpha8.mkv \
 -itsoffset 0     -i cards/hook8.mov \
 -itsoffset 28.95 -i cards/cta8.mov \
 -filter_complex "\
[1:v]format=rgba[rgb];[2:v]format=gray[al];[rgb][al]alphamerge[subj];\
[subj]scale=w='trunc(($SW)/2)*2':h='trunc(($SW)*16/9/2)*2':eval=frame:flags=bicubic[sc];\
[0:v][sc]overlay=x='W-w-50':y='H-h':eof_action=pass[v1];\
[v1]subtitles=v8.ass:fontsdir=/home/heath/.local/share/fonts[v2];\
[v2][3:v]overlay=x=0:y=80:eof_action=pass[v3];\
[v3][4:v]overlay=x=0:y=944:eof_action=pass,format=yuv420p,\
tpad=stop_mode=clone:stop_duration=0.33[vo]" \
 -map "[vo]" -t $D -c:v libx264 -crf 17 -preset medium -r 30 -pix_fmt yuv420p v8_pic.mp4
ffprobe -v error -show_entries stream=width,height,nb_frames -show_entries format=duration -of default=nw=1 v8_pic.mp4
echo comp-ok
