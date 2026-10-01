set -e
cd /home/heath/mw/v8
DV=33.696667
FO=$(python3 -c "print(round($DV-1.9,3))")
M=/mnt/c/Users/Heath/Projects/MeetDossie/Media/Music/documentary-trust-piano.mp3

# Render the two stems exactly as mux.sh builds them, pre-amix, so the ducking
# depth can be measured rather than asserted. Standard: music sits ~18-19 dB
# under the voice while he is speaking.
ffmpeg -nostdin -v error -y -i v8_voice.wav -stream_loop -1 -i "$M" -filter_complex "\
[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,\
highpass=f=80,apad=whole_dur=$DV,afade=t=out:st=33.33:d=0.125,\
atrim=0:$DV,asetpts=PTS-STARTPTS,asplit=2[vx][vk];\
[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,\
atrim=0:$DV,asetpts=PTS-STARTPTS,volume=-7dB,\
afade=t=in:st=0:d=1.2,afade=t=out:st=$FO:d=1.9[mu];\
[mu][vk]sidechaincompress=threshold=0.055:ratio=4:attack=12:release=420[md]" \
 -map "[vx]" -c:a pcm_s16le stem_voice.wav -map "[md]" -c:a pcm_s16le stem_music.wav

echo "--- windows chosen inside continuous speech (from sp/tr_c.json) ---"
for W in "11.5 1.5" "18.3 1.5" "26.0 1.5"; do
  set -- $W
  V=$(ffmpeg -nostdin -v info -ss $1 -t $2 -i stem_voice.wav -af volumedetect -f null - 2>&1 | grep mean_volume | sed 's/.*mean_volume: //;s/ dB//')
  MU=$(ffmpeg -nostdin -v info -ss $1 -t $2 -i stem_music.wav -af volumedetect -f null - 2>&1 | grep mean_volume | sed 's/.*mean_volume: //;s/ dB//')
  python3 -c "print('t=%5s  voice %7s dB   ducked music %7s dB   music is %5.1f dB under voice' % ('$1','$V','$MU', $V-($MU)))"
done
