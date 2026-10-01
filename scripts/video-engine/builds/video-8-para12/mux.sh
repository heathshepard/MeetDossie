set -e
cd /home/heath/mw/v8
DV=33.696667   # composite video length = 33.366667 master + 0.33 outro tail
               # spliced audio + the 0.33 outro decay tail, rounded to a frame
FO=$(python3 -c "print(round($DV-1.9,3))")
# Licence: Media/Music/ is 12 tracks pulled from Pixabay Music under the Pixabay
# Content License -- free for commercial use, no attribution required
# (Media/Music/LICENSE.md). documentary-trust-piano.mp3 is the track
# docs/VIDEO-PRODUCTION-RECIPE.md fixes for this TREC 20-19 series, so the series
# stays sonically consistent. Nothing outside that folder is used.
M=/mnt/c/Users/Heath/Projects/MeetDossie/Media/Music/documentary-trust-piano.mp3

# The voice is padded out to the full runtime and given a short tail fade. The
# final /s/ of "box." and its decay are inside the cut (recovered explicitly in
# sel.py); the fade only guarantees the last 0.1s lands on the floor rather than
# stepping to digital silence in one frame, which reads as truncation.
ffmpeg -nostdin -v error -y -i v8_pic.mp4 -i v8_voice.wav -stream_loop -1 -i "$M" -filter_complex "\
[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,\
highpass=f=80,apad=whole_dur=$DV,afade=t=out:st=33.33:d=0.125,\
atrim=0:$DV,asetpts=PTS-STARTPTS,asplit=2[vx][vk];\
[2:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,\
atrim=0:$DV,asetpts=PTS-STARTPTS,volume=-7dB,\
afade=t=in:st=0:d=1.2,afade=t=out:st=$FO:d=1.9[mu];\
[mu][vk]sidechaincompress=threshold=0.055:ratio=4:attack=12:release=420[md];\
[vx][md]amix=inputs=2:weights=1 0.85:duration=first:normalize=0,\
loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[ao]" \
 -map 0:v -map "[ao]" -c:v copy -c:a aac -b:a 192k -movflags +faststart v8_SPLICED.mp4
ffprobe -v error -show_entries stream=codec_type,width,height,nb_frames -show_entries format=duration -of default=nw=1 v8_SPLICED.mp4
echo mux-ok
