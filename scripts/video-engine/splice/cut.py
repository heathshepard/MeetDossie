"""Build the spliced master from v7b_plan.json.

Join strategy (the whole point of this rebuild):
  * Every cut lands inside a natural pause (sel.py guarantees prev_end+0.12 /
    next_start-0.12), so there is no word or breath onset at a boundary.
  * VIDEO segments are hard-concatenated at the nominal timestamps -- visible
    cuts are wanted (Heath asked for it to look edited).
  * AUDIO segments are pulled with 30ms of extra bleed on each internal edge and
    joined with a 60ms acrossfade. Because each edge is extended by exactly half
    the crossfade, the crossfades consume precisely the bleed they were given:
        sum = S + 0.06*(n-1)  ->  after n-1 crossfades of 0.06  ->  S
    i.e. the audio comes out the SAME length as the video. A plain acrossfade
    chain without bleed would shorten audio by 0.06*(n-1) and drift out of sync.
  * Takes were recorded minutes apart at identical gain (measured: -19.6/-19.6/
    -19.7 LUFS integrated), so no per-take level match is applied; joins are
    verified afterwards by measuring RMS either side of each boundary.

Speed is applied in EXACTLY ONE place: setpts=PTS/S + atempo=S after concat.
"""
import json, subprocess, sys, os

plan = json.load(open('/home/heath/mw/v7/v7b_plan.json'))
segs = plan['segs']
SPEED = float(sys.argv[1])
OUT = sys.argv[2]
AUDIO_ONLY = len(sys.argv) > 3 and sys.argv[3] == 'audio'

TAKES = ['20260930_160955', '20260930_161136', '20260930_161301']
IDX = {t: i for i, t in enumerate(TAKES)}
BLEED = 0.03
XF = 0.06
VF = 'crop=1080:1920:180:340,setsar=1,format=yuv420p'

parts = []
n = len(segs)
# every pad must exceed the crossfade half-width, or the bleed would reach past
# the silence and pull in the neighbouring word (that bug ate the reveal's "5").
minpad = min(min(s[3], s[4]) for s in segs)
assert minpad >= BLEED + 0.01, 'pad %.3f too small for %.3f bleed' % (minpad, BLEED)
for i, (take, b, e, _hp, _tp) in enumerate(segs):
    src = IDX[take]
    if not AUDIO_ONLY:
        parts.append('[%d:v]trim=start=%.3f:end=%.3f,setpts=PTS-STARTPTS,%s[v%d]' % (src, b, e, VF, i))
    hb = BLEED if i > 0 else 0.0
    tb = BLEED if i < n - 1 else 0.0
    parts.append('[%d:a]atrim=start=%.3f:end=%.3f,asetpts=PTS-STARTPTS,'
                 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a%d]'
                 % (src, max(0.0, b - hb), e + tb, i))

# audio crossfade chain
acc = 'a0'
for i in range(1, n):
    out = 'x%d' % i
    parts.append('[%s][a%d]acrossfade=d=%.3f:c1=tri:c2=tri[%s]' % (acc, i, XF, out))
    acc = out
parts.append('[%s]highpass=f=75,atempo=%.5f,aresample=48000[ao]' % (acc, SPEED))

if not AUDIO_ONLY:
    parts.append(''.join('[v%d]' % i for i in range(n)) +
                 'concat=n=%d:v=1:a=0[vc];[vc]setpts=PTS/%.5f,fps=30[vo]' % (n, SPEED))

fc = ';'.join(parts)
cmd = ['ffmpeg', '-nostdin', '-v', 'error', '-y']
for t in TAKES:
    cmd += ['-i', '/home/heath/mw/v7/src/%s.mp4' % t]
cmd += ['-filter_complex', fc]
if AUDIO_ONLY:
    cmd += ['-map', '[ao]', '-c:a', 'pcm_s16le', '-ar', '48000', OUT]
else:
    cmd += ['-map', '[vo]', '-map', '[ao]', '-c:v', 'libx264', '-crf', '16',
            '-preset', 'medium', '-r', '30', '-c:a', 'pcm_s16le', '-ar', '48000', OUT]

raw = sum(s[2] - s[1] for s in segs)
print('%d segs, raw %.3fs -> /%.3f = %.3fs' % (n, raw, SPEED, raw / SPEED), file=sys.stderr)
r = subprocess.run(cmd, capture_output=True, text=True)
if r.returncode:
    print(r.stderr[-3000:])
    sys.exit(1)

# offset map: source time -> output time (post-speed)
offs = []
acc_t = 0.0
for take, b, e, _h, _t in segs:
    offs.append([take, b, e, round(acc_t / SPEED, 4)])
    acc_t += e - b
meta = {'segs': segs, 'speed': SPEED, 'offsets': offs, 'total': round(acc_t / SPEED, 4),
        'joins': [round(sum(segs[k][2] - segs[k][1] for k in range(i)) / SPEED, 4) for i in range(1, n)],
        'cross_take': [i for i in range(1, n) if segs[i][0] != segs[i - 1][0]]}
json.dump(meta, open(os.path.splitext(OUT)[0] + '.json', 'w'), indent=1)
print('OK %s  total=%.3f' % (OUT, meta['total']))
